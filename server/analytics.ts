import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Router } from 'express';
import type { Request, Response } from 'express';

let db: Database.Database | null = null;
let insertStmt: Database.Statement | null = null;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  category    TEXT NOT NULL,  -- 'session', 'ui', 'agent', 'navigation', 'workspace'
  action      TEXT NOT NULL,
  target      TEXT,
  properties  TEXT,
  session_id  TEXT,
  device      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_category_action ON events(category, action);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);
`;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  repo_path TEXT,
  event_type TEXT NOT NULL,
  event_data TEXT,
  timestamp TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sevents_session ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_sevents_type ON session_events(event_type);
CREATE INDEX IF NOT EXISTS idx_sevents_timestamp ON session_events(timestamp);

CREATE TABLE IF NOT EXISTS session_rollups (
  session_id TEXT PRIMARY KEY,
  repo_path TEXT,
  repo_name TEXT,
  agent_type TEXT,
  model TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds INTEGER,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cache_read INTEGER DEFAULT 0,
  total_cache_write INTEGER DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  subagent_count INTEGER DEFAULT 0,
  human_response_latency_avg_ms INTEGER,
  human_response_latency_p50_ms INTEGER,
  human_response_latency_p95_ms INTEGER,
  agent_idle_percent REAL,
  rate_limit_encounters INTEGER DEFAULT 0,
  tool_use_counts TEXT,
  recovered INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rollups_repo ON session_rollups(repo_path);
CREATE INDEX IF NOT EXISTS idx_rollups_started ON session_rollups(started_at);

CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  five_hour_percent REAL,
  five_hour_resets_at TEXT,
  seven_day_percent REAL,
  seven_day_resets_at TEXT,
  timestamp TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ratelimit_ts ON rate_limit_snapshots(timestamp);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
];

const INSERT_SQL = 'INSERT INTO events (category, action, target, properties, session_id, device) VALUES (?, ?, ?, ?, ?, ?)';

export interface AnalyticsEvent {
  category: string;
  action: string;
  target?: string;
  properties?: Record<string, unknown>;
  session_id?: string;
  device?: string;
}

export function initAnalytics(configDir: string): void {
  if (db) {
    db.close();
    db = null;
    insertStmt = null;
  }
  const dbPath = path.join(configDir, 'analytics.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Schema version tracking
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let currentVersion = row?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec(migration.sql);
      currentVersion = migration.version;
    }
  }

  if (row) {
    db.prepare('UPDATE schema_version SET version = ?').run(currentVersion);
  } else {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(currentVersion);
  }

  insertStmt = db.prepare(INSERT_SQL);
}

export function closeAnalytics(): void {
  if (db) {
    db.close();
    db = null;
    insertStmt = null;
  }
}

function runInsert(stmt: Database.Statement, event: AnalyticsEvent): void {
  stmt.run(
    event.category,
    event.action,
    event.target ?? null,
    event.properties ? JSON.stringify(event.properties) : null,
    event.session_id ?? null,
    event.device ?? null,
  );
}

export function trackEvent(event: AnalyticsEvent): void {
  if (!insertStmt) return;
  try {
    runInsert(insertStmt, event);
  } catch {
    // Analytics write failure is non-fatal
  }
}

export function getDbPath(configDir: string): string {
  return path.join(configDir, 'analytics.db');
}

export function getDbSize(configDir: string): number {
  try {
    return fs.statSync(getDbPath(configDir)).size;
  } catch {
    return 0;
  }
}

export function createAnalyticsRouter(configDir: string): Router {
  const router = Router();

  // POST /analytics/events — batch ingest from frontend
  router.post('/events', (req: Request, res: Response) => {
    const { events } = req.body as { events?: AnalyticsEvent[] };
    if (!Array.isArray(events)) {
      res.status(400).json({ error: 'events array required' });
      return;
    }

    if (!db || !insertStmt) {
      res.status(503).json({ error: 'Analytics not initialized' });
      return;
    }

    const stmt = insertStmt;
    const insertMany = db.transaction((evts: AnalyticsEvent[]) => {
      let inserted = 0;
      for (const evt of evts) {
        if (!evt.category || !evt.action) continue;
        runInsert(stmt, evt);
        inserted++;
      }
      return inserted;
    });

    try {
      const inserted = insertMany(events);
      res.json({ ok: true, count: inserted });
    } catch {
      res.status(500).json({ error: 'Failed to write events' });
    }
  });

  // GET /analytics/size — DB file size in bytes
  router.get('/size', (_req: Request, res: Response) => {
    res.json({ bytes: getDbSize(configDir) });
  });

  // DELETE /analytics/events — truncate events table
  router.delete('/events', (_req: Request, res: Response) => {
    if (!db) {
      res.status(503).json({ error: 'Analytics not initialized' });
      return;
    }
    try {
      db.exec('DELETE FROM events');
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to clear analytics' });
    }
  });

  return router;
}
