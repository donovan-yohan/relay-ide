import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SessionEvent, RateLimitSnapshot } from './types.js';

let db: Database.Database | null = null;
let insertStmt: Database.Statement | null = null;

let eventBuffer: SessionEvent[] = [];
let batchTimer: ReturnType<typeof setInterval> | null = null;
const BATCH_INTERVAL_MS = 500;

let insertSessionEventStmt: Database.Statement | null = null;
let insertRateLimitStmt: Database.Statement | null = null;

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

  const hadRow = row !== undefined;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      const ver = migration.version;
      db.transaction(() => {
        db!.exec(migration.sql);
        if (hadRow || currentVersion > 0) {
          db!.prepare('UPDATE schema_version SET version = ?').run(ver);
        } else {
          db!.prepare('INSERT INTO schema_version (version) VALUES (?)').run(ver);
        }
      })();
      currentVersion = ver;
    }
  }

  insertStmt = db.prepare(INSERT_SQL);
}

function ensureSessionStmts(): void {
  if (!db) return;
  if (!insertSessionEventStmt) {
    insertSessionEventStmt = db.prepare(
      'INSERT INTO session_events (session_id, repo_path, event_type, event_data, timestamp) VALUES (?, ?, ?, ?, ?)'
    );
  }
  if (!insertRateLimitStmt) {
    insertRateLimitStmt = db.prepare(
      'INSERT INTO rate_limit_snapshots (five_hour_percent, five_hour_resets_at, seven_day_percent, seven_day_resets_at, timestamp) VALUES (?, ?, ?, ?, ?)'
    );
  }
}

export function recordSessionEvent(event: SessionEvent): void {
  if (!db) return;
  eventBuffer.push(event);
}

export function flushEventBuffer(sessionId?: string): void {
  if (!db || eventBuffer.length === 0) return;
  ensureSessionStmts();
  if (!insertSessionEventStmt) return;

  const toFlush = sessionId
    ? eventBuffer.filter(e => e.session_id === sessionId)
    : [...eventBuffer];

  if (toFlush.length === 0) return;

  const stmt = insertSessionEventStmt;
  const insertMany = db.transaction((events: SessionEvent[]) => {
    for (const e of events) {
      stmt.run(
        e.session_id,
        e.repo_path ?? null,
        e.event_type,
        e.event_data ? JSON.stringify(e.event_data) : null,
        e.timestamp,
      );
    }
  });

  try {
    insertMany(toFlush);
  } catch (err) {
    console.warn('[analytics] Failed to flush event buffer:', err);
  }

  if (sessionId) {
    eventBuffer = eventBuffer.filter(e => e.session_id !== sessionId);
  } else {
    eventBuffer = [];
  }
}

export function recordRateLimitSnapshot(snapshot: RateLimitSnapshot): void {
  if (!db) return;
  ensureSessionStmts();
  if (!insertRateLimitStmt) return;
  try {
    insertRateLimitStmt.run(
      snapshot.fiveHourPercent,
      snapshot.fiveHourResetsAt,
      snapshot.sevenDayPercent,
      snapshot.sevenDayResetsAt,
      snapshot.timestamp,
    );
  } catch (err) {
    console.warn('[analytics] Failed to record rate limit snapshot:', err);
  }
}

export function startEventBatching(): void {
  stopEventBatching();
  batchTimer = setInterval(() => flushEventBuffer(), BATCH_INTERVAL_MS);
}

export function stopEventBatching(): void {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }
  flushEventBuffer(); // flush remaining
}

export function closeAnalytics(): void {
  stopEventBatching();
  if (db) {
    db.close();
    db = null;
    insertStmt = null;
    insertSessionEventStmt = null;
    insertRateLimitStmt = null;
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

export function upsertSessionRollup(data: {
  sessionId: string;
  repoPath?: string;
  repoName?: string;
  agentType?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheRead?: number;
  totalCacheWrite?: number;
  turnCount?: number;
  subagentCount?: number;
  humanResponseLatencyAvgMs?: number;
  humanResponseLatencyP50Ms?: number;
  humanResponseLatencyP95Ms?: number;
  agentIdlePercent?: number;
  rateLimitEncounters?: number;
  toolUseCounts?: Record<string, number>;
  recovered?: boolean;
}): void {
  if (!db) return;

  const existing = db.prepare('SELECT session_id FROM session_rollups WHERE session_id = ?').get(data.sessionId);

  if (!existing) {
    db.prepare(`
      INSERT INTO session_rollups (session_id, repo_path, repo_name, agent_type, model, started_at, ended_at, duration_seconds,
        total_input_tokens, total_output_tokens, total_cache_read, total_cache_write,
        turn_count, subagent_count, human_response_latency_avg_ms, human_response_latency_p50_ms,
        human_response_latency_p95_ms, agent_idle_percent, rate_limit_encounters, tool_use_counts, recovered, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      data.sessionId,
      data.repoPath ?? null,
      data.repoName ?? null,
      data.agentType ?? null,
      data.model ?? null,
      data.startedAt ?? new Date().toISOString(),
      data.endedAt ?? null,
      data.durationSeconds ?? null,
      data.totalInputTokens ?? 0,
      data.totalOutputTokens ?? 0,
      data.totalCacheRead ?? 0,
      data.totalCacheWrite ?? 0,
      data.turnCount ?? 0,
      data.subagentCount ?? 0,
      data.humanResponseLatencyAvgMs ?? null,
      data.humanResponseLatencyP50Ms ?? null,
      data.humanResponseLatencyP95Ms ?? null,
      data.agentIdlePercent ?? null,
      data.rateLimitEncounters ?? 0,
      data.toolUseCounts ? JSON.stringify(data.toolUseCounts) : null,
      data.recovered ? 1 : 0,
    );
  } else {
    const sets: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    const optionalFields: Array<[keyof typeof data, string]> = [
      ['repoPath', 'repo_path'],
      ['repoName', 'repo_name'],
      ['agentType', 'agent_type'],
      ['model', 'model'],
      ['endedAt', 'ended_at'],
      ['durationSeconds', 'duration_seconds'],
      ['totalInputTokens', 'total_input_tokens'],
      ['totalOutputTokens', 'total_output_tokens'],
      ['totalCacheRead', 'total_cache_read'],
      ['totalCacheWrite', 'total_cache_write'],
      ['turnCount', 'turn_count'],
      ['subagentCount', 'subagent_count'],
      ['humanResponseLatencyAvgMs', 'human_response_latency_avg_ms'],
      ['humanResponseLatencyP50Ms', 'human_response_latency_p50_ms'],
      ['humanResponseLatencyP95Ms', 'human_response_latency_p95_ms'],
      ['agentIdlePercent', 'agent_idle_percent'],
      ['rateLimitEncounters', 'rate_limit_encounters'],
    ];

    for (const [key, col] of optionalFields) {
      if (data[key] !== undefined) {
        sets.push(`${col} = ?`);
        values.push(data[key]);
      }
    }

    if (data.recovered !== undefined) {
      sets.push('recovered = ?');
      values.push(data.recovered ? 1 : 0);
    }

    if (data.toolUseCounts !== undefined) {
      sets.push('tool_use_counts = ?');
      values.push(JSON.stringify(data.toolUseCounts));
    }

    values.push(data.sessionId);
    db.prepare(`UPDATE session_rollups SET ${sets.join(', ')} WHERE session_id = ?`).run(...values);
  }
}

export function getSessionRollup(sessionId: string): import('./types.js').SessionRollup | null {
  if (!db) return null;
  const row = db.prepare('SELECT * FROM session_rollups WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id as string,
    repoPath: row.repo_path as string | null,
    repoName: row.repo_name as string | null,
    agentType: row.agent_type as string | null,
    model: row.model as string | null,
    startedAt: row.started_at as string,
    endedAt: row.ended_at as string | null,
    durationSeconds: row.duration_seconds as number | null,
    totalInputTokens: row.total_input_tokens as number,
    totalOutputTokens: row.total_output_tokens as number,
    totalCacheRead: row.total_cache_read as number,
    totalCacheWrite: row.total_cache_write as number,
    turnCount: row.turn_count as number,
    subagentCount: row.subagent_count as number,
    humanResponseLatencyAvgMs: row.human_response_latency_avg_ms as number | null,
    humanResponseLatencyP50Ms: row.human_response_latency_p50_ms as number | null,
    humanResponseLatencyP95Ms: row.human_response_latency_p95_ms as number | null,
    agentIdlePercent: row.agent_idle_percent as number | null,
    rateLimitEncounters: row.rate_limit_encounters as number,
    toolUseCounts: row.tool_use_counts ? JSON.parse(row.tool_use_counts as string) as Record<string, number> : null,
    recovered: (row.recovered as number) === 1,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

export function computeEngagementMetrics(sessionId: string): {
  humanResponseLatencyAvgMs: number | null;
  humanResponseLatencyP50Ms: number | null;
  humanResponseLatencyP95Ms: number | null;
  agentIdlePercent: number | null;
  rateLimitEncounters: number;
  toolUseCounts: Record<string, number>;
} | null {
  if (!db) return null;

  const events = db.prepare(
    'SELECT event_type, event_data, timestamp FROM session_events WHERE session_id = ? ORDER BY timestamp ASC'
  ).all(sessionId) as Array<{ event_type: string; event_data: string | null; timestamp: string }>;

  if (events.length === 0) return null;

  // 1. Human response latency: last notification before each user_prompt
  const latencySamples: number[] = [];
  let lastNotificationTime: number | null = null;
  let inIdlePeriod = false;

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime();
    if (e.event_type === 'agent_stop') {
      inIdlePeriod = true;
      lastNotificationTime = null;
    } else if (e.event_type === 'notification' && inIdlePeriod) {
      lastNotificationTime = ts;
    } else if (e.event_type === 'user_prompt') {
      if (lastNotificationTime !== null) {
        latencySamples.push(ts - lastNotificationTime);
      }
      inIdlePeriod = false;
      lastNotificationTime = null;
    }
  }

  const sortedLatency = [...latencySamples].sort((a, b) => a - b);
  const avgLatency = sortedLatency.length > 0
    ? Math.round(sortedLatency.reduce((a, b) => a + b, 0) / sortedLatency.length)
    : null;

  // 2. Agent idle %
  const firstTs = new Date(events[0]!.timestamp).getTime();
  const lastTs = new Date(events[events.length - 1]!.timestamp).getTime();
  const totalDuration = lastTs - firstTs;

  const stopFailureTimes = events
    .filter(e => e.event_type === 'stop_failure')
    .map(e => ({
      timestamp: new Date(e.timestamp).getTime(),
      isRateLimit: (() => {
        try {
          const data = e.event_data ? JSON.parse(e.event_data) as Record<string, unknown> : {};
          return data.error === 'rate_limit';
        } catch { return false; }
      })(),
    }));

  let waitingForHumanMs = 0;
  let lastActiveStart: number | null = firstTs;

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const ts = new Date(e.timestamp).getTime();

    if (e.event_type === 'agent_stop') {
      lastActiveStart = null;
    } else if (e.event_type === 'user_prompt') {
      if (lastActiveStart === null) {
        let idleStart: number | null = null;
        for (let j = i - 1; j >= 0; j--) {
          if (events[j]!.event_type === 'agent_stop') {
            idleStart = new Date(events[j]!.timestamp).getTime();
            break;
          }
        }
        if (idleStart !== null) {
          const idleMs = ts - idleStart;
          const hasRateLimit = stopFailureTimes.some(sf =>
            sf.isRateLimit && sf.timestamp >= idleStart! && sf.timestamp <= ts
          );
          if (!hasRateLimit) {
            waitingForHumanMs += idleMs;
          }
        }
      }
      lastActiveStart = ts;
    }
  }

  const agentIdlePercent = totalDuration > 0
    ? Math.round((waitingForHumanMs / totalDuration) * 1000) / 10
    : null;

  // 3. Rate limit encounters
  const rateLimitEncounters = stopFailureTimes.filter(sf => sf.isRateLimit).length;

  // 4. Tool use counts
  const toolUseCounts: Record<string, number> = {};
  for (const e of events) {
    if (e.event_type === 'tool_use' && e.event_data) {
      try {
        const data = JSON.parse(e.event_data) as Record<string, unknown>;
        const tool = typeof data.tool === 'string' ? data.tool : 'unknown';
        toolUseCounts[tool] = (toolUseCounts[tool] ?? 0) + 1;
      } catch { /* malformed */ }
    }
  }

  return {
    humanResponseLatencyAvgMs: avgLatency,
    humanResponseLatencyP50Ms: sortedLatency.length > 0 ? percentile(sortedLatency, 50) : null,
    humanResponseLatencyP95Ms: sortedLatency.length > 0 ? percentile(sortedLatency, 95) : null,
    agentIdlePercent,
    rateLimitEncounters,
    toolUseCounts,
  };
}
