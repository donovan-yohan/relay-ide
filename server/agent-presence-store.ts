// Explicit active-agent presence store (#964, child of #953).
//
// Persists SELF-DECLARED presence records behind the hub gateway, reusing the
// self-contained store pattern of `server/context-packets.ts` /
// `server/work-contexts.ts`: a per-store SQLite file, a `schema_version` table
// with a version-gated migration run inside a transaction, an
// `init*(configDir)` / `create*(dbPath)` factory split, a blob `presence_json`
// column plus denormalized columns for scope queries, and prepared statements.
//
// STRICTLY NON-DESTRUCTIVE: owns its own DB file (`agent-presence.db`) and
// creates only the new `agent_presence` table. It never reads or mutates
// `config.json` or any existing store/table.
//
// Heartbeat semantics: every register/update-self stamps `expiresAt = now +
// ttl`. Reads filter expired rows (lazy expiry) and every write sweeps expired
// rows, so stale explicit presence never lives forever. The store is the
// security boundary: it sanitizes/redacts every field via
// `sanitizePresenceInput` and never persists secrets/tokens/transcripts/raw
// payloads (#964 acceptance: unsafe field rejection/redaction).

import * as crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  PRESENCE_DEFAULT_TTL_SECONDS,
  PresenceValidationError,
  sanitizePresenceInput,
  type AgentPresence,
  type SanitizedPresenceFields,
} from '../shared/agent-presence.js';
import { createLogger } from './logger.js';

const logger = createLogger('agent-presence');

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS agent_presence (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT,
  global_session_id  TEXT,
  work_context_id    TEXT,
  repo_path          TEXT,
  node_id            TEXT,
  presence_json      TEXT NOT NULL,
  registered_by      TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_presence_expires
  ON agent_presence(expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_presence_session
  ON agent_presence(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_presence_global_session
  ON agent_presence(global_session_id);
CREATE INDEX IF NOT EXISTS idx_agent_presence_work_context
  ON agent_presence(work_context_id);
CREATE INDEX IF NOT EXISTS idx_agent_presence_repo
  ON agent_presence(repo_path);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
];

interface AgentPresenceRow {
  id: string;
  session_id: string | null;
  global_session_id: string | null;
  work_context_id: string | null;
  repo_path: string | null;
  node_id: string | null;
  presence_json: string;
  registered_by: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/**
 * Write input for register/update-self. Soft fields are sanitized inside the
 * store; `registeredBy` is required (every record is attributable); `id` lets a
 * caller target a specific record (otherwise it is stably derived from
 * `registeredBy` + scope so an agent has one presence per session/scope).
 */
export interface PresenceWriteInput extends Record<string, unknown> {
  registeredBy?: string;
  id?: string;
}

/** Filter for `list`. All clauses are ANDed; expired rows are dropped unless `includeExpired`. */
export interface PresenceListFilter {
  sessionId?: string;
  globalSessionId?: string;
  workContextId?: string;
  repoPath?: string;
  nodeId?: string;
  includeExpired?: boolean;
}

export interface AgentPresenceStore {
  close(): void;
  /** Create-or-replace a presence record (full self-declaration + heartbeat). */
  register(input: PresenceWriteInput): AgentPresence;
  /** Patch an existing presence record + refresh its heartbeat. 404 if none lives. */
  updateSelf(input: PresenceWriteInput): AgentPresence;
  get(id: string): AgentPresence | null;
  list(filter?: PresenceListFilter): AgentPresence[];
  delete(id: string): boolean;
  /** Remove all expired rows; returns the number swept. */
  sweepExpired(): number;
}

export class AgentPresenceStoreError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.name = 'AgentPresenceStoreError';
    this.status = status;
    this.code = code;
  }
}

/** Boot entry point: opens (and migrates) the store DB under `configDir`. */
export function initAgentPresenceStore(
  configDir: string,
  options: { now?: () => Date } = {}
): AgentPresenceStore {
  return createAgentPresenceStore(
    path.join(configDir, 'agent-presence.db'),
    options
  );
}

/** Factory taking an explicit DB path. Used directly by unit tests. */
export function createAgentPresenceStore(
  dbPath: string,
  options: { now?: () => Date } = {}
): AgentPresenceStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);

  const now = options.now ?? (() => new Date());

  const selectById = db.prepare(
    `SELECT id, session_id, global_session_id, work_context_id, repo_path,
            node_id, presence_json, registered_by, created_at, updated_at, expires_at
     FROM agent_presence WHERE id = ?`
  );
  const upsert = db.prepare(
    `INSERT INTO agent_presence (
       id, session_id, global_session_id, work_context_id, repo_path, node_id,
       presence_json, registered_by, created_at, updated_at, expires_at
     ) VALUES (
       @id, @sessionId, @globalSessionId, @workContextId, @repoPath, @nodeId,
       @presenceJson, @registeredBy, @createdAt, @updatedAt, @expiresAt
     )
     ON CONFLICT(id) DO UPDATE SET
       session_id        = excluded.session_id,
       global_session_id = excluded.global_session_id,
       work_context_id   = excluded.work_context_id,
       repo_path         = excluded.repo_path,
       node_id           = excluded.node_id,
       presence_json     = excluded.presence_json,
       registered_by     = excluded.registered_by,
       updated_at        = excluded.updated_at,
       expires_at        = excluded.expires_at`
  );
  const deleteById = db.prepare('DELETE FROM agent_presence WHERE id = ?');
  const deleteExpired = db.prepare(
    'DELETE FROM agent_presence WHERE expires_at <= ?'
  );

  function getLive(id: string, includeExpired: boolean): AgentPresence | null {
    const row = selectById.get(id) as AgentPresenceRow | undefined;
    if (!row) return null;
    const presence = rowToPresenceSafe(row);
    if (!presence) return null;
    const expires = Date.parse(presence.expiresAt);
    if (!includeExpired && (!Number.isFinite(expires) || expires <= now().getTime())) {
      return null;
    }
    return presence;
  }

  function sweep(nowIso: string): number {
    return deleteExpired.run(nowIso).changes;
  }

  function persist(record: AgentPresence): AgentPresence {
    upsert.run({
      id: record.id,
      sessionId: record.sessionId ?? null,
      globalSessionId: record.globalSessionId ?? null,
      workContextId: record.workContextId ?? null,
      repoPath: record.repoPath ?? null,
      nodeId: record.nodeId ?? null,
      presenceJson: JSON.stringify(record),
      registeredBy: record.registeredBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
    });
    const written = getLive(record.id, true);
    if (!written) {
      throw new AgentPresenceStoreError(500, 'agent_presence_write_failed');
    }
    return written;
  }

  return {
    close() {
      db.close();
    },

    register(input: PresenceWriteInput): AgentPresence {
      const { fields, registeredBy } = parseWriteInput(input);
      const nowDate = now();
      const nowIso = nowDate.toISOString();
      const id = readId(input) ?? stablePresenceId(registeredBy, fields);
      const existing = getLive(id, true);
      const ttlSeconds = fields.ttlSeconds ?? PRESENCE_DEFAULT_TTL_SECONDS;
      const record: AgentPresence = {
        ...presenceFieldsToRecord(fields),
        id,
        registeredBy,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
        expiresAt: new Date(nowDate.getTime() + ttlSeconds * 1000).toISOString(),
      };
      const written = persist(record);
      sweep(nowIso);
      return written;
    },

    updateSelf(input: PresenceWriteInput): AgentPresence {
      const { fields, registeredBy } = parseWriteInput(input);
      const nowDate = now();
      const nowIso = nowDate.toISOString();
      const id = readId(input) ?? stablePresenceId(registeredBy, fields);
      const existing = getLive(id, false);
      if (!existing) {
        throw new AgentPresenceStoreError(404, 'agent_presence_not_found');
      }
      if (existing.registeredBy !== registeredBy) {
        // An agent may only update its own presence (audit attribution match).
        throw new AgentPresenceStoreError(403, 'agent_presence_not_owner');
      }
      const patch = presenceFieldsToRecord(fields);
      const ttlSeconds = fields.ttlSeconds ?? PRESENCE_DEFAULT_TTL_SECONDS;
      const record: AgentPresence = {
        ...existing,
        ...patch,
        id,
        registeredBy,
        createdAt: existing.createdAt,
        updatedAt: nowIso,
        expiresAt: new Date(nowDate.getTime() + ttlSeconds * 1000).toISOString(),
      };
      const written = persist(record);
      sweep(nowIso);
      return written;
    },

    get(id: string): AgentPresence | null {
      return getLive(id, false);
    },

    list(filter: PresenceListFilter = {}): AgentPresence[] {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (!filter.includeExpired) {
        clauses.push('expires_at > ?');
        params.push(now().toISOString());
      }
      const eq = (col: string, val: string | undefined) => {
        if (val !== undefined) {
          clauses.push(`${col} = ?`);
          params.push(val);
        }
      };
      eq('session_id', filter.sessionId);
      eq('global_session_id', filter.globalSessionId);
      eq('work_context_id', filter.workContextId);
      eq('repo_path', filter.repoPath);
      eq('node_id', filter.nodeId);
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const stmt = db.prepare(
        `SELECT id, session_id, global_session_id, work_context_id, repo_path,
                node_id, presence_json, registered_by, created_at, updated_at, expires_at
         FROM agent_presence${where}
         ORDER BY updated_at DESC, id ASC`
      );
      return (stmt.all(...params) as AgentPresenceRow[])
        .map(rowToPresenceSafe)
        .filter((p): p is AgentPresence => p !== null);
    },

    delete(id: string): boolean {
      return deleteById.run(id).changes > 0;
    },

    sweepExpired(): number {
      return sweep(now().toISOString());
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readId(input: PresenceWriteInput): string | undefined {
  return typeof input.id === 'string' && input.id.trim()
    ? input.id.trim()
    : undefined;
}

function parseWriteInput(input: PresenceWriteInput): {
  fields: SanitizedPresenceFields;
  registeredBy: string;
} {
  const registeredBy =
    typeof input.registeredBy === 'string' ? input.registeredBy.trim() : '';
  if (!registeredBy) {
    throw new AgentPresenceStoreError(
      400,
      'agent_presence_registered_by_required'
    );
  }
  try {
    const { fields } = sanitizePresenceInput(input);
    return { fields, registeredBy };
  } catch (err) {
    if (err instanceof PresenceValidationError) {
      throw new AgentPresenceStoreError(400, err.code, err.message);
    }
    throw err;
  }
}

/** Project sanitized fields into the persisted record subset (drops ttlSeconds). */
function presenceFieldsToRecord(
  fields: SanitizedPresenceFields
): Partial<AgentPresence> {
  const out: Partial<AgentPresence> = {};
  if (fields.sessionId) out.sessionId = fields.sessionId;
  if (fields.globalSessionId) out.globalSessionId = fields.globalSessionId;
  if (fields.workContextId) out.workContextId = fields.workContextId;
  if (fields.repoPath) out.repoPath = fields.repoPath;
  if (fields.nodeId) out.nodeId = fields.nodeId;
  if (fields.provider) out.provider = fields.provider;
  if (fields.role) out.role = fields.role;
  if (fields.displayName) out.displayName = fields.displayName;
  if (fields.useCase) out.useCase = fields.useCase;
  if (fields.statusText) out.statusText = fields.statusText;
  if (fields.needsAttention !== undefined) {
    out.needsAttention = fields.needsAttention;
  }
  if (fields.capabilityHints) out.capabilityHints = fields.capabilityHints;
  return out;
}

/**
 * Stable presence id from the actor + its scope, so register/update-self hit
 * the same row (one presence per agent per session/scope). Falls back to the
 * actor alone when no scope is given.
 */
function stablePresenceId(
  registeredBy: string,
  fields: SanitizedPresenceFields
): string {
  const scope =
    fields.globalSessionId ??
    fields.sessionId ??
    fields.workContextId ??
    fields.repoPath ??
    '';
  const digest = crypto
    .createHash('sha1')
    .update(`${registeredBy}\u0000${scope}`)
    .digest('hex')
    .slice(0, 16);
  return `pres:${digest}`;
}

function rowToPresenceSafe(row: AgentPresenceRow): AgentPresence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.presence_json) as unknown;
  } catch {
    logger.warn('dropped agent presence %s: corrupt presence_json', row.id);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn('dropped agent presence %s: not an object', row.id);
    return null;
  }
  const record = parsed as Partial<AgentPresence>;
  if (
    typeof record.id !== 'string' ||
    typeof record.registeredBy !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    typeof record.expiresAt !== 'string'
  ) {
    logger.warn('dropped agent presence %s: failed validation', row.id);
    return null;
  }
  // The denormalized columns are the query source of truth; reconcile the blob's
  // expiry to the column so an externally-tampered blob can't outlive its row.
  return { ...(record as AgentPresence), expiresAt: row.expires_at };
}

// ── Migration runner (mirrors context-packets.ts / ia-store.ts) ───────────────
function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined;
  const hadRow = row !== undefined;
  let currentVersion = row?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      const ver = migration.version;
      db.transaction(() => {
        db.exec(migration.sql);
        if (hadRow || currentVersion > 0) {
          db.prepare('UPDATE schema_version SET version = ?').run(ver);
        } else {
          db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(ver);
        }
      })();
      currentVersion = ver;
    }
  }
}
