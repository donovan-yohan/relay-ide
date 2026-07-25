import path from 'node:path';
import Database from 'better-sqlite3';
import type { WebSession } from './types.js';
import {
  capAgentSessionTranscriptV2,
  type AgentSessionV2,
} from '../shared/agent-chat-protocol-v2.js';
import {
  normalizeControlStateSummary,
  type ControlStateSummary,
} from '../shared/control-state.js';
import { createLogger } from './logger.js';
import type { AgentRole } from '../shared/agent-roster.js';

const logger = createLogger('relay-state-db');

let db: Database.Database | null = null;
let upsertWebStmt: Database.Statement | null = null;
let deleteWebStmt: Database.Statement | null = null;
let markStatusStmt: Database.Statement | null = null;
let loadAllWebStmt: Database.Statement | null = null;
let reapCandidatesStmt: Database.Statement | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
/**
 * Resolver for session ids the reaper must never delete: those live in the
 * in-memory session map AND those still bound to an open channel. Registered by
 * the wiring layer (server/index.ts) which owns both the session map and the
 * channel-binding store; relay-state-db cannot reach either directly. Until it
 * is registered the timer-driven reap fails safe (no-op) rather than risk
 * dropping a resume anchor. Reset on close for test isolation.
 */
let reapProtectedIdsProvider: (() => Iterable<string>) | null = null;
let warnedNoReapProvider = false;

// ── Storage-hygiene tunables (#1243) ──────────────────────────────────────
/**
 * Cap the WAL high-water mark. A single multi-MB blob transaction otherwise
 * pins the WAL to its size until a full checkpoint runs; journal_size_limit
 * makes SQLite truncate the WAL back to this bound after each checkpoint.
 */
const JOURNAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;
/**
 * Age-reap window (#1248). A web_session whose `last_activity` predates this is
 * evicted regardless of status EXCEPT `archived` (a deliberate user keep backing
 * the archive browse/restore lane). The v2 reducer derives an idle session to
 * status `active` — never `disconnected` — so a status-scoped reaper leaks idle
 * rows forever; gating on age instead bounds total row count over time. This is
 * what makes restoring ALL non-archived rows on boot safe (count stays bounded
 * without a restore LIMIT). Live/connected and still-channel-bound sessions are
 * excluded via {@link reapProtectedIdsProvider} even when old, so resume anchors
 * are never dropped.
 */
const WEB_SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Periodic checkpoint + freelist-reclaim + reap cadence. */
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS web_sessions (
  id                    TEXT PRIMARY KEY,
  vendor                TEXT NOT NULL,
  vendor_session_id     TEXT,
  cwd                   TEXT NOT NULL,
  repo_path             TEXT,
  worktree_path         TEXT,
  branch_name           TEXT,
  display_name          TEXT,
  workspace_id          TEXT,
  agent_session_v2_json TEXT NOT NULL,
  meta_json             TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  last_activity         INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('active', 'disconnected', 'archived'))
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_vendor_session
  ON web_sessions(vendor, vendor_session_id);
CREATE INDEX IF NOT EXISTS idx_web_sessions_status_activity
  ON web_sessions(status, last_activity);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
];

const UPSERT_SQL = `
INSERT INTO web_sessions (
  id, vendor, vendor_session_id, cwd, repo_path, worktree_path, branch_name,
  display_name, workspace_id, agent_session_v2_json, meta_json,
  created_at, last_activity, status
) VALUES (
  @id, @vendor, @vendorSessionId, @cwd, @repoPath, @worktreePath, @branchName,
  @displayName, @workspaceId, @agentSessionV2Json, @metaJson,
  @createdAt, @lastActivity, @status
)
ON CONFLICT(id) DO UPDATE SET
  vendor                = excluded.vendor,
  vendor_session_id     = excluded.vendor_session_id,
  cwd                   = excluded.cwd,
  repo_path             = excluded.repo_path,
  worktree_path         = excluded.worktree_path,
  branch_name           = excluded.branch_name,
  display_name          = excluded.display_name,
  workspace_id          = excluded.workspace_id,
  agent_session_v2_json = excluded.agent_session_v2_json,
  meta_json             = excluded.meta_json,
  last_activity         = excluded.last_activity,
  status                = excluded.status
`;

/** Fields restored alongside the agent session blob. */
export interface WebSessionMeta {
  type: string;
  agent: string;
  role?: AgentRole;
  spawnedBySessionId?: string;
  repoName?: string;
  customCommand: string | null;
  runtimeOwnership: 'spawned' | 'attached';
  hookToken: string;
  adapterType: string;
  needsBranchRename?: boolean;
  additionalDirs?: string[];
  controlState?: ControlStateSummary;
}

export interface LoadedWebSessionRow {
  id: string;
  vendor: string;
  vendorSessionId: string | null;
  cwd: string;
  repoPath: string | null;
  worktreePath: string | null;
  branchName: string | null;
  displayName: string | null;
  workspaceId: string | null;
  agentSessionV2: AgentSessionV2;
  meta: WebSessionMeta;
  createdAt: number;
  lastActivity: number;
  status: 'active' | 'disconnected' | 'archived';
}

export function initRelayStateDb(configDir: string): void {
  if (db) closeRelayStateDb();

  const dbPath = path.join(configDir, 'relay-state.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Reclaim the freelist to the OS instead of letting it grow unbounded
  // (issue #1243: ~15MB of orphaned overflow pages never returned). A
  // pre-existing db created with auto_vacuum=NONE (0) only adopts the new mode
  // after a one-time VACUUM — gate that on the current mode so it runs at most
  // once (VACUUM flips the pragma to 2), never on every boot.
  try {
    const autoVacuum = db.pragma('auto_vacuum', { simple: true }) as number;
    if (autoVacuum !== 2) {
      db.pragma('auto_vacuum = INCREMENTAL');
      // Must run outside any transaction; nothing is open here yet.
      db.exec('VACUUM');
    }
  } catch (err) {
    logger.warn('auto_vacuum conversion failed: %s', err);
  }
  db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`);

  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`
  );
  const row = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined;
  let currentVersion = row?.version ?? 0;
  const hadRow = row !== undefined;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      const ver = migration.version;
      db.transaction(() => {
        db!.exec(migration.sql);
        if (hadRow || currentVersion > 0) {
          db!.prepare('UPDATE schema_version SET version = ?').run(ver);
        } else {
          db!
            .prepare('INSERT INTO schema_version (version) VALUES (?)')
            .run(ver);
        }
      })();
      currentVersion = ver;
    }
  }

  upsertWebStmt = db.prepare(UPSERT_SQL);
  deleteWebStmt = db.prepare('DELETE FROM web_sessions WHERE id = ?');
  markStatusStmt = db.prepare(
    'UPDATE web_sessions SET status = ?, last_activity = ? WHERE id = ?'
  );
  // Restore ALL non-archived rows on boot (#1248), oldest-first so display-name
  // counter sync and ordering match historical behaviour. There is deliberately
  // no LIMIT: a restore cap silently dropped older sessions from the in-memory
  // map, which broke channel-agent resume (the binder respawned a fresh session
  // with a new providerSession) and orphaned direct sessions past the cap. The
  // per-session transcript cap already bounds each row's memory; total row count
  // is bounded instead by the age-reaper below.
  loadAllWebStmt = db.prepare(
    `SELECT id, vendor, vendor_session_id, cwd, repo_path, worktree_path,
            branch_name, display_name, workspace_id, agent_session_v2_json,
            meta_json, created_at, last_activity, status
     FROM web_sessions
     WHERE status != 'archived'
     ORDER BY last_activity ASC`
  );
  reapCandidatesStmt = db.prepare(
    `SELECT id FROM web_sessions
      WHERE status != 'archived' AND last_activity < @cutoff`
  );

  // Boot-time reclaim keeps the WAL checkpointed + freelist returned. Reaping is
  // deferred to the periodic timer, NOT run here: at boot the in-memory session
  // map is empty and the protected-id provider is not yet registered, so an
  // eager reap could delete a stale-but-wanted row that restore is about to
  // bring back / rebind. By the first interval tick, restore and provider
  // registration have completed and the reap consults the live protection set.
  runRelayStateDbMaintenance();
  maintenanceTimer = setInterval(() => {
    reapStaleWebSessions();
    runRelayStateDbMaintenance();
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();
}

/**
 * Register (or clear with `null`) the resolver for session ids the reaper must
 * never delete. Production supplies the union of live in-memory session ids and
 * session ids still referenced by an open channel binding, so a recent OR still-
 * bound session survives even when its `last_activity` is older than the window.
 */
export function setReapProtectedSessionIdsProvider(
  provider: (() => Iterable<string>) | null
): void {
  reapProtectedIdsProvider = provider;
}

/**
 * Delete web_session rows whose `last_activity` predates {@link
 * WEB_SESSION_IDLE_TTL_MS}, regardless of status EXCEPT `archived`. Protected
 * ids — live/connected sessions and sessions still bound to an open channel —
 * are excluded so resume anchors are never dropped. Returns the count removed.
 *
 * Protection resolves from `options.protectedIds` when given (tests), otherwise
 * from the registered provider (production). With neither available the reap is
 * a no-op: failing safe beats risking deletion of a live or still-bound session.
 */
export function reapStaleWebSessions(options?: {
  protectedIds?: Iterable<string>;
  nowMs?: number;
}): number {
  if (!db || !reapCandidatesStmt || !deleteWebStmt) return 0;

  let protectedIds: Set<string>;
  if (options?.protectedIds !== undefined) {
    protectedIds = new Set(options.protectedIds);
  } else if (reapProtectedIdsProvider) {
    try {
      protectedIds = new Set(reapProtectedIdsProvider());
    } catch (err) {
      logger.warn('reap protected-id provider threw: %s', err);
      return 0;
    }
  } else {
    if (!warnedNoReapProvider) {
      warnedNoReapProvider = true;
      logger.warn('reap skipped: no protected-id provider registered');
    }
    return 0;
  }

  const cutoff = (options?.nowMs ?? Date.now()) - WEB_SESSION_IDLE_TTL_MS;
  try {
    const candidates = reapCandidatesStmt.all({ cutoff }) as Array<{
      id: string;
    }>;
    const doomed = candidates
      .map((row) => row.id)
      .filter((id) => !protectedIds.has(id));
    if (doomed.length === 0) return 0;
    const reap = db.transaction((ids: string[]) => {
      for (const id of ids) deleteWebStmt!.run(id);
    });
    reap(doomed);
    logger.info('reaped %d stale web session(s) by age', doomed.length);
    return doomed.length;
  } catch (err) {
    logger.warn('reap failed: %s', err);
    return 0;
  }
}

/**
 * Truncate the WAL and return freed pages to the OS. Mirrors the
 * `wal_checkpoint(TRUNCATE)` pattern in analytics.ts; `incremental_vacuum`
 * reclaims the freelist that auto_vacuum=INCREMENTAL accumulates.
 */
export function runRelayStateDbMaintenance(): void {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* best-effort */
  }
  try {
    db.pragma('incremental_vacuum');
  } catch {
    /* best-effort */
  }
}

export function closeRelayStateDb(): void {
  flushAllPendingWrites();
  archivedIds.clear();
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
  // Drop the reaper protection resolver so a re-init (and test isolation) starts
  // from a clean slate rather than a provider closed over a stale session map.
  reapProtectedIdsProvider = null;
  warnedNoReapProvider = false;
  if (db) {
    // Final reclaim so a clean shutdown leaves a truncated WAL + returned
    // freelist rather than the ~15MB high-water marks issue #1243 documented.
    runRelayStateDbMaintenance();
    db.close();
    db = null;
    upsertWebStmt = null;
    deleteWebStmt = null;
    markStatusStmt = null;
    loadAllWebStmt = null;
    reapCandidatesStmt = null;
  }
}

// ── Throttled write scheduler ─────────────────────────────────────────────

/**
 * Idle-debounce window: collapse a quiet-period burst into one write.
 */
const DEBOUNCE_MS = 1000;
/**
 * Hard cap on how long a session may go without being persisted while patches
 * are still flowing. Pure debounce never fires under continuous streaming;
 * this guarantees a snapshot lands on disk at least every {@link MAX_WAIT_MS}.
 */
const MAX_WAIT_MS = 1000;

const pendingTimers = new Map<string, NodeJS.Timeout>();
const pendingPayloads = new Map<string, () => void>();
const firstScheduledAt = new Map<string, number>();
/**
 * Session ids whose row was explicitly archived. Subsequent upserts must not
 * overwrite the archived status with a status derived from `live.status`,
 * which would silently revive the session on the next patch.
 */
const archivedIds = new Set<string>();

/**
 * Schedule a debounce-with-maxWait upsert. The timer resets on each call
 * (debounce) but is capped so the write always fires within {@link MAX_WAIT_MS}
 * of the first scheduled call in a burst — protects against streams that
 * never go quiet.
 */
export function scheduleWebSessionUpsert(session: WebSession): void {
  if (!db || !upsertWebStmt) return;

  const id = session.id;
  pendingPayloads.set(id, () => writeUpsert(session));

  const now = Date.now();
  const firstAt = firstScheduledAt.get(id) ?? now;
  if (!firstScheduledAt.has(id)) firstScheduledAt.set(id, now);

  const existing = pendingTimers.get(id);
  if (existing) clearTimeout(existing);

  const elapsed = now - firstAt;
  const remainingCap = Math.max(0, MAX_WAIT_MS - elapsed);
  const delay = Math.min(DEBOUNCE_MS, remainingCap);

  const timer = setTimeout(() => {
    pendingTimers.delete(id);
    firstScheduledAt.delete(id);
    const fn = pendingPayloads.get(id);
    pendingPayloads.delete(id);
    if (fn) fn();
  }, delay);
  pendingTimers.set(id, timer);
}

/**
 * Immediate write, bypassing debounce. Use on structural events
 * (session create, vendor session id assignment, status change, shutdown).
 */
export function upsertWebSessionNow(session: WebSession): void {
  if (!db || !upsertWebStmt) return;

  const timer = pendingTimers.get(session.id);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(session.id);
    pendingPayloads.delete(session.id);
    firstScheduledAt.delete(session.id);
  }
  writeUpsert(session);
}

export function flushAllPendingWrites(): void {
  for (const [id, timer] of pendingTimers.entries()) {
    clearTimeout(timer);
    const fn = pendingPayloads.get(id);
    if (fn) {
      try {
        fn();
      } catch (err) {
        logger.warn('flush write failed for %s: %s', id, err);
      }
    }
  }
  pendingTimers.clear();
  pendingPayloads.clear();
  firstScheduledAt.clear();
}

function writeUpsert(session: WebSession): void {
  if (!upsertWebStmt) return;

  // Bound the transcript before it hits disk (#1243). Capping at the persist
  // boundary — the single ≤1/s sink both debounced and immediate writes flow
  // through — bounds the on-disk blob AND, by writing the trimmed structure
  // back into the live session, the in-memory transcript (and thus the
  // boot-time restore rss). Doing it here rather than per-append also keeps the
  // reducer's immutable `[...items, item]` rebuild off an ever-growing array.
  const cappedAgentSessionV2 = capAgentSessionTranscriptV2(
    session.agentSessionV2
  );
  if (cappedAgentSessionV2 !== session.agentSessionV2) {
    session.agentSessionV2 = cappedAgentSessionV2;
  }

  const vendor = cappedAgentSessionV2.provider;
  const vendorSessionId = pickVendorSessionId(cappedAgentSessionV2);

  const meta: WebSessionMeta = {
    type: session.type,
    agent: session.agent,
    ...(session.role !== undefined ? { role: session.role } : {}),
    ...(session.spawnedBySessionId !== undefined
      ? { spawnedBySessionId: session.spawnedBySessionId }
      : {}),
    ...(session.repoName ? { repoName: session.repoName } : {}),
    customCommand: session.customCommand ?? null,
    runtimeOwnership: session.runtimeOwnership,
    hookToken: session.hookToken,
    adapterType: session.adapterType,
    ...(session.needsBranchRename ? { needsBranchRename: true as const } : {}),
    ...(session.additionalDirs?.length
      ? { additionalDirs: session.additionalDirs }
      : {}),
    controlState: normalizeControlStateSummary(session.controlState),
  };

  try {
    upsertWebStmt.run({
      id: session.id,
      vendor,
      vendorSessionId,
      cwd: session.cwd,
      repoPath: session.repoPath ?? null,
      worktreePath: session.worktreePath ?? null,
      branchName: session.branchName ?? null,
      displayName: session.displayName ?? null,
      workspaceId: session.workspaceId ?? null,
      agentSessionV2Json: JSON.stringify(cappedAgentSessionV2),
      metaJson: JSON.stringify(meta),
      createdAt: toEpochMs(session.createdAt),
      lastActivity: toEpochMs(session.lastActivity),
      status: deriveStatus(session),
    });
  } catch (err) {
    logger.warn('upsert failed for %s: %s', session.id, err);
  }
}

export function deleteWebSession(id: string): void {
  if (!db || !deleteWebStmt) return;
  const timer = pendingTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(id);
    pendingPayloads.delete(id);
    firstScheduledAt.delete(id);
  }
  archivedIds.delete(id);
  try {
    deleteWebStmt.run(id);
  } catch (err) {
    logger.warn('delete failed for %s: %s', id, err);
  }
}

export function markWebSessionStatus(
  id: string,
  status: 'active' | 'disconnected' | 'archived'
): void {
  if (!db || !markStatusStmt) return;
  if (status === 'archived') {
    archivedIds.add(id);
    const timer = pendingTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      pendingTimers.delete(id);
      pendingPayloads.delete(id);
      firstScheduledAt.delete(id);
    }
  } else {
    archivedIds.delete(id);
  }
  try {
    markStatusStmt.run(status, Date.now(), id);
  } catch (err) {
    logger.warn('markStatus failed for %s: %s', id, err);
  }
}

export function loadAllWebSessions(): LoadedWebSessionRow[] {
  if (!db || !loadAllWebStmt) return [];

  const rows = loadAllWebStmt.all() as Array<{
    id: string;
    vendor: string;
    vendor_session_id: string | null;
    cwd: string;
    repo_path: string | null;
    worktree_path: string | null;
    branch_name: string | null;
    display_name: string | null;
    workspace_id: string | null;
    agent_session_v2_json: string;
    meta_json: string;
    created_at: number;
    last_activity: number;
    status: 'active' | 'disconnected' | 'archived';
  }>;

  const out: LoadedWebSessionRow[] = [];
  for (const row of rows) {
    try {
      // Cap the parsed blob before it is cloned into the live session (#1243).
      // A row persisted before this fix landed can still be the observed 14.9MB
      // blob; capping here bounds the restore-time JSON.parse + structuredClone
      // burst, and the next persist rewrites the trimmed blob so disk
      // self-heals.
      const agentSession = capAgentSessionTranscriptV2(
        JSON.parse(row.agent_session_v2_json) as AgentSessionV2
      );
      const meta = JSON.parse(row.meta_json) as WebSessionMeta;
      out.push({
        id: row.id,
        vendor: row.vendor,
        vendorSessionId: row.vendor_session_id,
        cwd: row.cwd,
        repoPath: row.repo_path,
        worktreePath: row.worktree_path,
        branchName: row.branch_name,
        displayName: row.display_name,
        workspaceId: row.workspace_id,
        agentSessionV2: agentSession,
        meta,
        createdAt: row.created_at,
        lastActivity: row.last_activity,
        status: row.status,
      });
    } catch (err) {
      logger.warn('failed to parse row %s: %s', row.id, err);
    }
  }
  return out;
}

function pickVendorSessionId(session: AgentSessionV2): string | null {
  const ps = session.providerSession;
  if (!ps) return null;
  // Take the first defined value. Each adapter stores at most one resume id
  // under a vendor-specific key (claudeSessionId, threadId, etc.).
  for (const value of Object.values(ps)) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function deriveStatus(
  session: WebSession
): 'active' | 'disconnected' | 'archived' {
  if (archivedIds.has(session.id)) return 'archived';
  const live = session.agentSessionV2.live.status;
  if (live === 'disconnected') return 'disconnected';
  return 'active';
}

function toEpochMs(value: string | number | Date | undefined): number {
  if (value === undefined) return Date.now();
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
