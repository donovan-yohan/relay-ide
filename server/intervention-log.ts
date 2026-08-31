import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  InterventionKind,
  InterventionRecord,
  InterventionSource,
} from '../shared/control-state.js';
import { createLogger } from './logger.js';

const logger = createLogger('intervention-log');

let db: Database.Database | null = null;
let appendStmt: Database.Statement | null = null;
let listBySessionStmt: Database.Statement | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS interventions (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  tab_id             TEXT NOT NULL,
  node_id            TEXT,
  global_session_id  TEXT,
  occurred_at        TEXT NOT NULL,
  author_json        TEXT NOT NULL,
  source             TEXT NOT NULL,
  kind               TEXT NOT NULL,
  payload_preview    TEXT,
  redaction_json     TEXT NOT NULL,
  mode_before        TEXT NOT NULL,
  mode_after         TEXT,
  acked_by_json      TEXT,
  acked_at           TEXT,
  record_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interventions_session_time
  ON interventions(session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_interventions_node_session_time
  ON interventions(node_id, session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_interventions_unacked_human
  ON interventions(session_id, kind, acked_at);
CREATE INDEX IF NOT EXISTS idx_interventions_global_unacked_human
  ON interventions(global_session_id, kind, acked_at);
`;

const APPEND_SQL = `
INSERT INTO interventions (
  id, session_id, tab_id, node_id, global_session_id, occurred_at,
  author_json, source, kind, payload_preview, redaction_json,
  mode_before, mode_after, acked_by_json, acked_at, record_json
) VALUES (
  @id, @sessionId, @tabId, @nodeId, @globalSessionId, @occurredAt,
  @authorJson, @source, @kind, @payloadPreview, @redactionJson,
  @modeBefore, @modeAfter, @ackedByJson, @ackedAt, @recordJson
)
`;

export function initInterventionLog(configDir: string): void {
  if (db) closeInterventionLog();
  const dbPath = path.join(configDir, 'interventions.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  appendStmt = db.prepare(APPEND_SQL);
  listBySessionStmt = db.prepare(
    `SELECT record_json FROM interventions
     WHERE session_id = @sessionId
       AND (@nodeId IS NULL OR node_id = @nodeId)
     ORDER BY occurred_at DESC, id DESC
     LIMIT @limit`
  );
}

export function closeInterventionLog(): void {
  if (db) db.close();
  db = null;
  appendStmt = null;
  listBySessionStmt = null;
}

function params(record: InterventionRecord): Record<string, unknown> {
  return {
    id: record.id,
    sessionId: record.sessionId,
    tabId: record.tabId,
    nodeId: record.nodeId ?? null,
    globalSessionId: record.globalSessionId ?? null,
    occurredAt: record.timestamp,
    authorJson: JSON.stringify(record.author),
    source: record.source,
    kind: record.kind,
    payloadPreview: record.payloadPreview ?? null,
    redactionJson: JSON.stringify(record.redaction),
    modeBefore: record.modeBefore,
    modeAfter: record.modeAfter ?? null,
    ackedByJson: record.ackedBy ? JSON.stringify(record.ackedBy) : null,
    ackedAt: record.ackedAt ?? null,
    recordJson: JSON.stringify(record),
  };
}

export function appendIntervention(record: InterventionRecord): void {
  if (!appendStmt) return;
  try {
    appendStmt.run(params(record));
  } catch (err) {
    logger.warn('append failed for %s: %s', record.id, err);
  }
}

function parseRecord(value: unknown): InterventionRecord | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as InterventionRecord;
  } catch {
    return null;
  }
}

export function listInterventions(input: {
  sessionId: string;
  nodeId?: string;
  limit?: number;
}): InterventionRecord[] {
  if (!listBySessionStmt) return [];
  const rows = listBySessionStmt.all({
    sessionId: input.sessionId,
    nodeId: input.nodeId ?? null,
    limit: Math.min(Math.max(input.limit ?? 100, 1), 500),
  }) as Array<{ record_json: string }>;
  return rows
    .map((row) => parseRecord(row.record_json))
    .filter((record): record is InterventionRecord => record !== null);
}

export type { InterventionKind, InterventionRecord, InterventionSource };
