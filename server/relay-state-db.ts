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

const logger = createLogger('relay-state-db');

let db: Database.Database | null = null;
let upsertWebStmt: Database.Statement | null = null;
let deleteWebStmt: Database.Statement | null = null;
let markStatusStmt: Database.Statement | null = null;
let loadAllWebStmt: Database.Statement | null = null;
let reapDisconnectedStmt: Database.Statement | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;

// ── Storage-hygiene tunables (#1243) ──────────────────────────────────────
/**
 * Cap the WAL high-water mark. A single multi-MB blob transaction otherwise
 * pins the WAL to its size until a full checkpoint runs; journal_size_limit
 * makes SQLite truncate the WAL back to this bound after each checkpoint.
 */
const JOURNAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;
/** Restore at most the most-recent K non-archived rows on boot. */
const MAX_RESTORE_SESSIONS = 50;
/** Disconnected rows older than this are reaped (boot + interval). */
const DISCONNECTED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
  // Restore only the most-recent K rows (belt-and-suspenders bound on boot rss
  // even if the reaper has not yet caught a backlog), returned oldest-first so
  // display-name counter sync and ordering match the historical behaviour.
  loadAllWebStmt = db.prepare(
    `SELECT id, vendor, vendor_session_id, cwd, repo_path, worktree_path,
            branch_name, display_name, workspace_id, agent_session_v2_json,
            meta_json, created_at, last_activity, status
     FROM (
       SELECT id, vendor, vendor_session_id, cwd, repo_path, worktree_path,
              branch_name, display_name, workspace_id, agent_session_v2_json,
              meta_json, created_at, last_activity, status
       FROM web_sessions
       WHERE status != 'archived'
       ORDER BY last_activity DESC
       LIMIT @limit
     )
     ORDER BY last_activity ASC`
  );
  reapDisconnectedStmt = db.prepare(
    `DELETE FROM web_sessions
      WHERE status = 'disconnected' AND last_activity < @cutoff`
  );

  // Boot-time reclaim + reap, then a periodic pass so a long-lived hub keeps
  // the WAL checkpointed, the freelist returned, and stale rows evicted.
  reapStaleWebSessions();
  runRelayStateDbMaintenance();
  maintenanceTimer = setInterval(() => {
    reapStaleWebSessions();
    runRelayStateDbMaintenance();
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();
}

/**
 * Delete `disconnected` rows whose last activity predates the TTL. Never
 * touches `active` (live/connected) or `archived` rows. Returns the count
 * removed (0 when the store is closed or nothing was stale).
 */
export function reapStaleWebSessions(): number {
  if (!db || !reapDisconnectedStmt) return 0;
  try {
    const result = reapDisconnectedStmt.run({
      cutoff: Date.now() - DISCONNECTED_TTL_MS,
    });
    if (result.changes > 0) {
      logger.info(
        'reaped %d stale disconnected web session(s)',
        result.changes
      );
    }
    return result.changes;
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
    reapDisconnectedStmt = null;
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

  const rows = loadAllWebStmt.all({ limit: MAX_RESTORE_SESSIONS }) as Array<{
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
