# Session Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite-backed session analytics with hook event collection, engagement metric computation, REST API, and a TUI-aesthetic dashboard showing historical session data, tool breakdown, and "DORA for agents" metrics.

**Architecture:** Extend the existing `server/analytics.ts` module (currently a generic event logger) into a session analytics engine. New tables (`session_events`, `session_rollups`, `rate_limit_snapshots`) alongside the existing `events` table. Hook event collector subscribes to existing hook callbacks in `hooks.ts`. Engagement metrics computed lazily at session end via PTY `onExit` callback. 6 REST API endpoints under `/api/analytics/`. Two new Svelte 5 frontend pages: `AnalyticsDashboard.svelte` and `SessionDetail.svelte`.

**Tech Stack:** TypeScript + ESM, better-sqlite3 (already installed), Express REST API, Svelte 5 (runes), node:test for testing.

**Design spec:** `~/.gstack/projects/donovan-yohan-claude-remote-cli/donovanyohan-nightly-design-20260401-000549.md`

---

## File Structure

### Server (new/modified)

- **Modify:** `server/analytics.ts` — extend with new schema tables, session event recording, rollup upsert, engagement metric computation, retention cleanup, write batching
- **Modify:** `server/hooks.ts` — emit events to analytics collector on each hook callback
- **Modify:** `server/sessions.ts` — register analytics session-end callback for engagement metric finalization
- **Modify:** `server/index.ts` — wire up analytics session-end callback, pass configDir
- **Modify:** `server/types.ts` — add analytics-related type exports

### Frontend (new/modified)

- **Create:** `frontend/src/components/AnalyticsDashboard.svelte` — main analytics page
- **Create:** `frontend/src/components/SessionDetail.svelte` — session drill-down
- **Modify:** `frontend/src/lib/api.ts` — add analytics API fetch functions
- **Modify:** `frontend/src/lib/types.ts` — add analytics response types
- **Modify:** `frontend/src/App.svelte` — add `analytics` view mode, wire navigation
- **Modify:** `frontend/src/components/Sidebar.svelte` — add analytics nav button

### Tests (new)

- **Create:** `test/session-analytics.test.ts` — schema, event recording, rollups, engagement metrics, retention
- **Create:** `test/session-analytics-api.test.ts` — REST API endpoint tests

---

## Task 1: Extend Analytics Schema

**Files:**

- Modify: `server/analytics.ts`
- Modify: `server/types.ts`
- Test: `test/session-analytics.test.ts`

- [ ] **Step 1: Add analytics types to `server/types.ts`**

Append these types at the end of the file:

```typescript
// ── Session Analytics ──

export interface SessionEvent {
  session_id: string;
  repo_path?: string;
  event_type: string;
  event_data?: Record<string, unknown>;
  timestamp: string;
}

export interface SessionRollup {
  sessionId: string;
  repoPath: string | null;
  repoName: string | null;
  agentType: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  turnCount: number;
  subagentCount: number;
  humanResponseLatencyAvgMs: number | null;
  humanResponseLatencyP50Ms: number | null;
  humanResponseLatencyP95Ms: number | null;
  agentIdlePercent: number | null;
  rateLimitEncounters: number;
  toolUseCounts: Record<string, number> | null;
  recovered: boolean;
}

export interface RateLimitSnapshot {
  fiveHourPercent: number;
  fiveHourResetsAt: string;
  sevenDayPercent: number;
  sevenDayResetsAt: string;
  timestamp: string;
}
```

- [ ] **Step 2: Write the failing test for new schema tables**

Create `test/session-analytics.test.ts`:

```typescript
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  initAnalytics,
  closeAnalytics,
  getDbPath,
} from '../server/analytics.js';

let tmpDir!: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-analytics-test-'));
});

afterEach(() => {
  closeAnalytics();
  for (const entry of fs.readdirSync(tmpDir)) {
    fs.unlinkSync(path.join(tmpDir, entry));
  }
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

test('initAnalytics creates session_events table', () => {
  initAnalytics(tmpDir);
  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  assert.ok(
    tables.some((t) => t.name === 'session_events'),
    'session_events table should exist'
  );
  db.close();
});

test('initAnalytics creates session_rollups table', () => {
  initAnalytics(tmpDir);
  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  assert.ok(
    tables.some((t) => t.name === 'session_rollups'),
    'session_rollups table should exist'
  );
  db.close();
});

test('initAnalytics creates rate_limit_snapshots table', () => {
  initAnalytics(tmpDir);
  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  assert.ok(
    tables.some((t) => t.name === 'rate_limit_snapshots'),
    'rate_limit_snapshots table should exist'
  );
  db.close();
});

test('initAnalytics creates schema_version table', () => {
  initAnalytics(tmpDir);
  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  assert.ok(
    tables.some((t) => t.name === 'schema_version'),
    'schema_version table should exist'
  );
  const version = db.prepare('SELECT version FROM schema_version').get() as {
    version: number;
  };
  assert.equal(version.version, 2);
  db.close();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run build && node --test dist/test/session-analytics.test.js`
Expected: FAIL — `session_events`, `session_rollups`, `rate_limit_snapshots`, `schema_version` tables don't exist.

- [ ] **Step 4: Add new schema tables to `server/analytics.ts`**

In `server/analytics.ts`, add a migration-based schema system. Replace the current `SCHEMA` constant and `initAnalytics` function body. Keep all existing functions (`trackEvent`, `closeAnalytics`, `createAnalyticsRouter`, etc.) unchanged.

Add above the existing `SCHEMA` constant:

```typescript
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  category    TEXT NOT NULL,
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
```

Replace the `initAnalytics` function body to use migrations:

```typescript
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
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`
  );
  const row = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined;
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
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
      currentVersion
    );
  }

  insertStmt = db.prepare(INSERT_SQL);
}
```

Remove the old `SCHEMA` constant (its contents are now in `SCHEMA_V1`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && node --test dist/test/session-analytics.test.js`
Expected: All 4 tests PASS.

- [ ] **Step 6: Verify existing analytics tests still pass**

Run: `npm run build && node --test dist/test/analytics.test.js`
Expected: All existing tests PASS (migration is backwards-compatible).

- [ ] **Step 7: Commit**

```bash
git add server/analytics.ts server/types.ts test/session-analytics.test.ts
git commit -m "feat(analytics): add session_events, session_rollups, rate_limit_snapshots schema with migration system"
```

---

## Task 2: Session Event Recording + Write Batching

**Files:**

- Modify: `server/analytics.ts`
- Test: `test/session-analytics.test.ts`

- [ ] **Step 1: Write failing tests for event recording and batching**

Append to `test/session-analytics.test.ts`:

```typescript
import {
  recordSessionEvent,
  flushEventBuffer,
  recordRateLimitSnapshot,
} from '../server/analytics.js';
import type { SessionEvent } from '../server/types.js';

test('recordSessionEvent buffers and flushes events', () => {
  initAnalytics(tmpDir);

  recordSessionEvent({
    session_id: 'sess-1',
    repo_path: '/repo',
    event_type: 'session_start',
    timestamp: '2026-04-01T10:00:00.000Z',
  });

  // Before flush, DB should have 0 session events
  const db1 = new Database(getDbPath(tmpDir), { readonly: true });
  const before = db1
    .prepare('SELECT COUNT(*) as count FROM session_events')
    .get() as { count: number };
  assert.equal(before.count, 0);
  db1.close();

  flushEventBuffer();

  // After flush, DB should have 1 session event
  const db2 = new Database(getDbPath(tmpDir), { readonly: true });
  const after = db2
    .prepare('SELECT COUNT(*) as count FROM session_events')
    .get() as { count: number };
  assert.equal(after.count, 1);
  const row = db2.prepare('SELECT * FROM session_events').get() as Record<
    string,
    unknown
  >;
  assert.equal(row.session_id, 'sess-1');
  assert.equal(row.event_type, 'session_start');
  db2.close();
});

test('recordSessionEvent stores event_data as JSON', () => {
  initAnalytics(tmpDir);

  recordSessionEvent({
    session_id: 'sess-1',
    event_type: 'tool_use',
    event_data: { tool: 'Read', target: 'server/index.ts' },
    timestamp: '2026-04-01T10:00:05.000Z',
  });
  flushEventBuffer();

  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const row = db.prepare('SELECT * FROM session_events').get() as Record<
    string,
    unknown
  >;
  const data = JSON.parse(row.event_data as string) as Record<string, unknown>;
  assert.equal(data.tool, 'Read');
  assert.equal(data.target, 'server/index.ts');
  db.close();
});

test('flushEventBuffer batch-inserts multiple events', () => {
  initAnalytics(tmpDir);

  for (let i = 0; i < 5; i++) {
    recordSessionEvent({
      session_id: 'sess-1',
      event_type: 'tool_use',
      event_data: { tool: 'Read', i },
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
  flushEventBuffer();

  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const count = db
    .prepare('SELECT COUNT(*) as count FROM session_events')
    .get() as { count: number };
  assert.equal(count.count, 5);
  db.close();
});

test('recordSessionEvent is no-op before initAnalytics', () => {
  // Should not throw
  recordSessionEvent({
    session_id: 'sess-1',
    event_type: 'session_start',
    timestamp: new Date().toISOString(),
  });
  flushEventBuffer();
});

test('recordRateLimitSnapshot inserts a snapshot row', () => {
  initAnalytics(tmpDir);

  recordRateLimitSnapshot({
    fiveHourPercent: 62,
    fiveHourResetsAt: '2026-04-01T14:32:00Z',
    sevenDayPercent: 91,
    sevenDayResetsAt: '2026-04-03T00:00:00Z',
    timestamp: '2026-04-01T10:00:00.000Z',
  });

  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const row = db.prepare('SELECT * FROM rate_limit_snapshots').get() as Record<
    string,
    unknown
  >;
  assert.equal(row.five_hour_percent, 62);
  assert.equal(row.seven_day_percent, 91);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test dist/test/session-analytics.test.js`
Expected: FAIL — `recordSessionEvent`, `flushEventBuffer`, `recordRateLimitSnapshot` not exported.

- [ ] **Step 3: Implement event recording and write batching in `server/analytics.ts`**

Add these at the top of the file (after imports):

```typescript
import type { SessionEvent, RateLimitSnapshot } from './types.js';
```

Add the event buffer and recording functions after the existing `trackEvent` function:

```typescript
// ── Session Event Recording (write-batched) ──

let eventBuffer: SessionEvent[] = [];
let batchTimer: ReturnType<typeof setInterval> | null = null;
const BATCH_INTERVAL_MS = 500;

let insertSessionEventStmt: Database.Statement | null = null;
let insertRateLimitStmt: Database.Statement | null = null;

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
    ? eventBuffer.filter((e) => e.session_id === sessionId)
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
        e.timestamp
      );
    }
  });

  try {
    insertMany(toFlush);
  } catch (err) {
    console.warn('[analytics] Failed to flush event buffer:', err);
  }

  if (sessionId) {
    eventBuffer = eventBuffer.filter((e) => e.session_id !== sessionId);
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
      snapshot.timestamp
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
```

Update `closeAnalytics` to clean up session stmts:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test dist/test/session-analytics.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/analytics.ts test/session-analytics.test.ts
git commit -m "feat(analytics): add session event recording with write batching and rate limit snapshots"
```

---

## Task 3: Session Rollup Upsert + Engagement Metric Computation

**Files:**

- Modify: `server/analytics.ts`
- Test: `test/session-analytics.test.ts`

- [ ] **Step 1: Write failing tests for rollup creation and upsert**

Append to `test/session-analytics.test.ts`:

```typescript
import { upsertSessionRollup, getSessionRollup } from '../server/analytics.js';

test('upsertSessionRollup creates initial rollup on session start', () => {
  initAnalytics(tmpDir);

  upsertSessionRollup({
    sessionId: 'sess-1',
    repoPath: '/repo/path',
    repoName: 'my-repo',
    agentType: 'claude',
    startedAt: '2026-04-01T10:00:00.000Z',
  });

  const rollup = getSessionRollup('sess-1');
  assert.ok(rollup, 'rollup should exist');
  assert.equal(rollup!.sessionId, 'sess-1');
  assert.equal(rollup!.repoName, 'my-repo');
  assert.equal(rollup!.agentType, 'claude');
  assert.equal(rollup!.endedAt, null);
  assert.equal(rollup!.totalInputTokens, 0);
});

test('upsertSessionRollup updates token counts', () => {
  initAnalytics(tmpDir);

  upsertSessionRollup({
    sessionId: 'sess-1',
    repoPath: '/repo',
    repoName: 'my-repo',
    agentType: 'claude',
    startedAt: '2026-04-01T10:00:00.000Z',
  });

  upsertSessionRollup({
    sessionId: 'sess-1',
    totalInputTokens: 5000,
    totalOutputTokens: 1200,
    totalCacheRead: 3000,
    totalCacheWrite: 800,
    model: 'opus-4',
    turnCount: 3,
  });

  const rollup = getSessionRollup('sess-1');
  assert.equal(rollup!.totalInputTokens, 5000);
  assert.equal(rollup!.totalOutputTokens, 1200);
  assert.equal(rollup!.model, 'opus-4');
  assert.equal(rollup!.turnCount, 3);
});

test('upsertSessionRollup sets endedAt and duration', () => {
  initAnalytics(tmpDir);

  upsertSessionRollup({
    sessionId: 'sess-1',
    repoPath: '/repo',
    repoName: 'my-repo',
    agentType: 'claude',
    startedAt: '2026-04-01T10:00:00.000Z',
  });

  upsertSessionRollup({
    sessionId: 'sess-1',
    endedAt: '2026-04-01T10:30:00.000Z',
    durationSeconds: 1800,
  });

  const rollup = getSessionRollup('sess-1');
  assert.equal(rollup!.endedAt, '2026-04-01T10:30:00.000Z');
  assert.equal(rollup!.durationSeconds, 1800);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test dist/test/session-analytics.test.js`
Expected: FAIL — `upsertSessionRollup`, `getSessionRollup` not exported.

- [ ] **Step 3: Implement rollup upsert and getter in `server/analytics.ts`**

Add these functions:

```typescript
// ── Session Rollup Management ──

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

  const existing = db
    .prepare('SELECT session_id FROM session_rollups WHERE session_id = ?')
    .get(data.sessionId);

  if (!existing) {
    db.prepare(
      `
      INSERT INTO session_rollups (session_id, repo_path, repo_name, agent_type, model, started_at, ended_at, duration_seconds,
        total_input_tokens, total_output_tokens, total_cache_read, total_cache_write,
        turn_count, subagent_count, human_response_latency_avg_ms, human_response_latency_p50_ms,
        human_response_latency_p95_ms, agent_idle_percent, rate_limit_encounters, tool_use_counts, recovered, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `
    ).run(
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
      data.recovered ? 1 : 0
    );
  } else {
    // Build dynamic UPDATE — only set fields that are provided
    const sets: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    const fields: Array<[string, unknown, string]> = [
      ['repo_path', data.repoPath, 'repo_path = ?'],
      ['repo_name', data.repoName, 'repo_name = ?'],
      ['agent_type', data.agentType, 'agent_type = ?'],
      ['model', data.model, 'model = ?'],
      ['ended_at', data.endedAt, 'ended_at = ?'],
      ['duration_seconds', data.durationSeconds, 'duration_seconds = ?'],
      ['total_input_tokens', data.totalInputTokens, 'total_input_tokens = ?'],
      [
        'total_output_tokens',
        data.totalOutputTokens,
        'total_output_tokens = ?',
      ],
      ['total_cache_read', data.totalCacheRead, 'total_cache_read = ?'],
      ['total_cache_write', data.totalCacheWrite, 'total_cache_write = ?'],
      ['turn_count', data.turnCount, 'turn_count = ?'],
      ['subagent_count', data.subagentCount, 'subagent_count = ?'],
      [
        'human_response_latency_avg_ms',
        data.humanResponseLatencyAvgMs,
        'human_response_latency_avg_ms = ?',
      ],
      [
        'human_response_latency_p50_ms',
        data.humanResponseLatencyP50Ms,
        'human_response_latency_p50_ms = ?',
      ],
      [
        'human_response_latency_p95_ms',
        data.humanResponseLatencyP95Ms,
        'human_response_latency_p95_ms = ?',
      ],
      ['agent_idle_percent', data.agentIdlePercent, 'agent_idle_percent = ?'],
      [
        'rate_limit_encounters',
        data.rateLimitEncounters,
        'rate_limit_encounters = ?',
      ],
      ['recovered', data.recovered, 'recovered = ?'],
    ];

    for (const [_, value, clause] of fields) {
      if (value !== undefined) {
        sets.push(clause);
        values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
      }
    }

    if (data.toolUseCounts !== undefined) {
      sets.push('tool_use_counts = ?');
      values.push(JSON.stringify(data.toolUseCounts));
    }

    values.push(data.sessionId);
    db.prepare(
      `UPDATE session_rollups SET ${sets.join(', ')} WHERE session_id = ?`
    ).run(...values);
  }
}

export function getSessionRollup(
  sessionId: string
): import('./types.js').SessionRollup | null {
  if (!db) return null;
  const row = db
    .prepare('SELECT * FROM session_rollups WHERE session_id = ?')
    .get(sessionId) as Record<string, unknown> | undefined;
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
    humanResponseLatencyAvgMs: row.human_response_latency_avg_ms as
      | number
      | null,
    humanResponseLatencyP50Ms: row.human_response_latency_p50_ms as
      | number
      | null,
    humanResponseLatencyP95Ms: row.human_response_latency_p95_ms as
      | number
      | null,
    agentIdlePercent: row.agent_idle_percent as number | null,
    rateLimitEncounters: row.rate_limit_encounters as number,
    toolUseCounts: row.tool_use_counts
      ? (JSON.parse(row.tool_use_counts as string) as Record<string, number>)
      : null,
    recovered: (row.recovered as number) === 1,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test dist/test/session-analytics.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Write failing tests for engagement metric computation**

Append to `test/session-analytics.test.ts`:

```typescript
import { computeEngagementMetrics } from '../server/analytics.js';

test('computeEngagementMetrics calculates human response latency', () => {
  initAnalytics(tmpDir);

  // Simulate: session start -> agent stop -> notification -> user prompt (32s later)
  const events: SessionEvent[] = [
    {
      session_id: 'sess-1',
      event_type: 'session_start',
      timestamp: '2026-04-01T10:00:00.000Z',
    },
    {
      session_id: 'sess-1',
      event_type: 'user_prompt',
      timestamp: '2026-04-01T10:00:05.000Z',
    },
    {
      session_id: 'sess-1',
      event_type: 'agent_stop',
      timestamp: '2026-04-01T10:01:00.000Z',
    },
    {
      session_id: 'sess-1',
      event_type: 'notification',
      timestamp: '2026-04-01T10:01:00.500Z',
    },
    {
      session_id: 'sess-1',
      event_type: 'user_prompt',
      timestamp: '2026-04-01T10:01:32.500Z',
    },
  ];

  for (const e of events) {
    recordSessionEvent(e);
  }
  flushEventBuffer();

  upsertSessionRollup({
    sessionId: 'sess-1',
    repoPath: '/repo',
    repoName: 'my-repo',
    agentType: 'claude',
    startedAt: '2026-04-01T10:00:00.000Z',
  });

  const metrics = computeEngagementMetrics('sess-1');
  assert.ok(metrics, 'metrics should be computed');
  // One latency sample: notification at 10:01:00.500 -> user_prompt at 10:01:32.500 = 32000ms
  assert.equal(metrics!.humanResponseLatencyAvgMs, 32000);
  assert.equal(metrics!.humanResponseLatencyP50Ms, 32000);
});

test('computeEngagementMetrics counts rate limit encounters', () => {
  initAnalytics(tmpDir);

  const events: SessionEvent[] = [
    {
      session_id: 'sess-2',
      event_type: 'session_start',
      timestamp: '2026-04-01T10:00:00.000Z',
    },
    {
      session_id: 'sess-2',
      event_type: 'stop_failure',
      event_data: { error: 'rate_limit' },
      timestamp: '2026-04-01T10:05:00.000Z',
    },
    {
      session_id: 'sess-2',
      event_type: 'stop_failure',
      event_data: { error: 'rate_limit' },
      timestamp: '2026-04-01T10:10:00.000Z',
    },
    {
      session_id: 'sess-2',
      event_type: 'stop_failure',
      event_data: { error: 'other' },
      timestamp: '2026-04-01T10:15:00.000Z',
    },
  ];

  for (const e of events) recordSessionEvent(e);
  flushEventBuffer();

  upsertSessionRollup({
    sessionId: 'sess-2',
    repoPath: '/repo',
    repoName: 'my-repo',
    agentType: 'claude',
    startedAt: '2026-04-01T10:00:00.000Z',
  });

  const metrics = computeEngagementMetrics('sess-2');
  assert.equal(metrics!.rateLimitEncounters, 2);
});

test('computeEngagementMetrics aggregates tool use counts', () => {
  initAnalytics(tmpDir);

  const events: SessionEvent[] = [
    {
      session_id: 'sess-3',
      event_type: 'session_start',
      timestamp: '2026-04-01T10:00:00.000Z',
    },
    {
      session_id: 'sess-3',
      event_type: 'tool_use',
      event_data: { tool: 'Read' },
      timestamp: '2026-04-01T10:00:01.000Z',
    },
    {
      session_id: 'sess-3',
      event_type: 'tool_use',
      event_data: { tool: 'Read' },
      timestamp: '2026-04-01T10:00:02.000Z',
    },
    {
      session_id: 'sess-3',
      event_type: 'tool_use',
      event_data: { tool: 'Edit' },
      timestamp: '2026-04-01T10:00:03.000Z',
    },
    {
      session_id: 'sess-3',
      event_type: 'tool_use',
      event_data: { tool: 'Bash' },
      timestamp: '2026-04-01T10:00:04.000Z',
    },
  ];

  for (const e of events) recordSessionEvent(e);
  flushEventBuffer();

  upsertSessionRollup({
    sessionId: 'sess-3',
    repoPath: '/repo',
    repoName: 'my-repo',
    agentType: 'claude',
    startedAt: '2026-04-01T10:00:00.000Z',
  });

  const metrics = computeEngagementMetrics('sess-3');
  assert.deepEqual(metrics!.toolUseCounts, { Read: 2, Edit: 1, Bash: 1 });
});

test('computeEngagementMetrics returns null for unknown session', () => {
  initAnalytics(tmpDir);
  const metrics = computeEngagementMetrics('nonexistent');
  assert.equal(metrics, null);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npm run build && node --test dist/test/session-analytics.test.js`
Expected: FAIL — `computeEngagementMetrics` not exported.

- [ ] **Step 7: Implement `computeEngagementMetrics` in `server/analytics.ts`**

```typescript
// ── Engagement Metric Computation ──

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

  const events = db
    .prepare(
      'SELECT event_type, event_data, timestamp FROM session_events WHERE session_id = ? ORDER BY timestamp ASC'
    )
    .all(sessionId) as Array<{
    event_type: string;
    event_data: string | null;
    timestamp: string;
  }>;

  if (events.length === 0) return null;

  // 1. Human response latency: notification -> next user_prompt
  const latencySamples: number[] = [];
  let lastNotificationTime: number | null = null;
  let inIdlePeriod = false;

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime();
    if (e.event_type === 'agent_stop') {
      inIdlePeriod = true;
      lastNotificationTime = null; // reset — wait for notification
    } else if (e.event_type === 'notification' && inIdlePeriod) {
      lastNotificationTime = ts; // overwrite — use last notification before prompt
    } else if (e.event_type === 'user_prompt') {
      if (lastNotificationTime !== null) {
        latencySamples.push(ts - lastNotificationTime);
      }
      inIdlePeriod = false;
      lastNotificationTime = null;
    }
  }

  const sortedLatency = [...latencySamples].sort((a, b) => a - b);
  const avgLatency =
    sortedLatency.length > 0
      ? Math.round(
          sortedLatency.reduce((a, b) => a + b, 0) / sortedLatency.length
        )
      : null;

  // 2. Agent idle % — time breakdown
  let agentActiveMs = 0;
  let waitingForHumanMs = 0;
  let rateLimitMs = 0;
  let lastActiveStart: number | null = null;

  const firstTs = new Date(events[0]!.timestamp).getTime();
  const lastTs = new Date(events[events.length - 1]!.timestamp).getTime();
  const totalDuration = lastTs - firstTs;

  // Build stop_failure lookup for rate limit detection in idle intervals
  const stopFailures = events
    .filter((e) => e.event_type === 'stop_failure')
    .map((e) => ({
      timestamp: new Date(e.timestamp).getTime(),
      isRateLimit: (() => {
        try {
          const data = e.event_data
            ? (JSON.parse(e.event_data) as Record<string, unknown>)
            : {};
          return data.error === 'rate_limit';
        } catch {
          return false;
        }
      })(),
    }));

  lastActiveStart = firstTs; // session_start begins an active period

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime();

    if (e.event_type === 'agent_stop') {
      if (lastActiveStart !== null) {
        agentActiveMs += ts - lastActiveStart;
        lastActiveStart = null;
      }
    } else if (e.event_type === 'user_prompt') {
      if (lastActiveStart === null) {
        // We were in an idle period — classify it
        // Find the preceding agent_stop
        const idleStart = (() => {
          for (let i = events.indexOf(e) - 1; i >= 0; i--) {
            if (events[i]!.event_type === 'agent_stop')
              return new Date(events[i]!.timestamp).getTime();
          }
          return null;
        })();

        if (idleStart !== null) {
          const idleMs = ts - idleStart;
          // Check if any rate_limit stop_failure occurred in this interval
          const hasRateLimit = stopFailures.some(
            (sf) =>
              sf.isRateLimit && sf.timestamp >= idleStart && sf.timestamp <= ts
          );
          if (hasRateLimit) {
            rateLimitMs += idleMs;
          } else {
            waitingForHumanMs += idleMs;
          }
        }
      }
      lastActiveStart = ts; // user prompt starts a new active period
    }
  }

  // If session ended while agent was active, count remaining time
  if (lastActiveStart !== null) {
    agentActiveMs += lastTs - lastActiveStart;
  }

  const agentIdlePercent =
    totalDuration > 0
      ? Math.round((waitingForHumanMs / totalDuration) * 1000) / 10
      : null;

  // 3. Rate limit encounters
  const rateLimitEncounters = stopFailures.filter(
    (sf) => sf.isRateLimit
  ).length;

  // 4. Tool use counts
  const toolUseCounts: Record<string, number> = {};
  for (const e of events) {
    if (e.event_type === 'tool_use' && e.event_data) {
      try {
        const data = JSON.parse(e.event_data) as Record<string, unknown>;
        const tool = typeof data.tool === 'string' ? data.tool : 'unknown';
        toolUseCounts[tool] = (toolUseCounts[tool] ?? 0) + 1;
      } catch {
        /* malformed event_data */
      }
    }
  }

  return {
    humanResponseLatencyAvgMs: avgLatency,
    humanResponseLatencyP50Ms:
      sortedLatency.length > 0 ? percentile(sortedLatency, 50) : null,
    humanResponseLatencyP95Ms:
      sortedLatency.length > 0 ? percentile(sortedLatency, 95) : null,
    agentIdlePercent,
    rateLimitEncounters,
    toolUseCounts,
  };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm run build && node --test dist/test/session-analytics.test.js`
Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
git add server/analytics.ts test/session-analytics.test.ts
git commit -m "feat(analytics): add session rollup upsert and engagement metric computation"
```

---

## Task 4: Hook Event Collector Integration

**Files:**

- Modify: `server/hooks.ts`
- Modify: `server/sessions.ts`
- Modify: `server/index.ts`

This task wires the analytics module to the existing hook handlers so every hook callback records a session event, and session end triggers engagement metric finalization.

- [ ] **Step 1: Add analytics event recording to each hook handler in `server/hooks.ts`**

Import at the top of `server/hooks.ts`:

```typescript
import { recordSessionEvent, upsertSessionRollup } from './analytics.js';
```

In each route handler, after the existing logic and before `res.json({ ok: true })`, add the corresponding `recordSessionEvent` call.

**POST /stop** — after `setAgentState(session, 'idle', deps)`:

```typescript
recordSessionEvent({
  session_id: session.id,
  repo_path: session.repoPath,
  event_type: 'agent_stop',
  timestamp: new Date().toISOString(),
});
```

**POST /notification** — after the `if/else if` block (before `res.json`):

```typescript
recordSessionEvent({
  session_id: session.id,
  repo_path: session.repoPath,
  event_type: 'notification',
  event_data: { notificationType: type as string },
  timestamp: new Date().toISOString(),
});
```

**POST /prompt-submit** — after `setAgentState(session, 'processing', deps)`:

```typescript
recordSessionEvent({
  session_id: session.id,
  repo_path: session.repoPath,
  event_type: 'user_prompt',
  timestamp: new Date().toISOString(),
});
```

**POST /session-end** — before `res.json`:

```typescript
const session = (req as unknown as Record<string, unknown>)
  ._hookSession as Session;
recordSessionEvent({
  session_id: session.id,
  repo_path: session.repoPath,
  event_type: 'session_end',
  timestamp: new Date().toISOString(),
});
```

**POST /tool-use** — after setting `session.currentActivity`:

```typescript
recordSessionEvent({
  session_id: session.id,
  repo_path: session.repoPath,
  event_type: 'tool_use',
  event_data: { tool: toolName, target: detail },
  timestamp: new Date().toISOString(),
});
```

**POST /tool-result** — after clearing `session.currentActivity`:

```typescript
recordSessionEvent({
  session_id: session.id,
  repo_path: session.repoPath,
  event_type: 'tool_complete',
  timestamp: new Date().toISOString(),
});
```

- [ ] **Step 2: Add session-start event recording in `server/sessions.ts`**

In `sessions.ts`, the `create` function handles new session creation. Import and call analytics on create.

Add import at top of `server/sessions.ts`:

```typescript
import { recordSessionEvent, upsertSessionRollup } from './analytics.js';
```

In the `create` function, after the session is added to the map and the session-create callbacks are fired, add:

```typescript
// Record session start for analytics
recordSessionEvent({
  session_id: newSession.id,
  repo_path: newSession.repoPath,
  event_type: 'session_start',
  timestamp: new Date().toISOString(),
});
upsertSessionRollup({
  sessionId: newSession.id,
  repoPath: newSession.repoPath,
  repoName: newSession.repoName,
  agentType: newSession.agent,
  startedAt: new Date().toISOString(),
});
```

- [ ] **Step 3: Add session-end engagement metric finalization in `server/index.ts`**

In `server/index.ts`, after the session-end callbacks are registered (around line 366 where `sessions.onSessionEnd` is called), add an analytics finalization callback:

```typescript
import {
  flushEventBuffer,
  computeEngagementMetrics,
  upsertSessionRollup,
  startEventBatching,
  stopEventBatching,
} from './analytics.js';
```

Register the session-end callback (add near the other `sessions.onSessionEnd` calls):

```typescript
sessions.onSessionEnd((sessionId) => {
  // 1-second grace period for in-flight hooks
  setTimeout(() => {
    flushEventBuffer(sessionId);
    const metrics = computeEngagementMetrics(sessionId);
    if (metrics) {
      upsertSessionRollup({
        sessionId,
        endedAt: new Date().toISOString(),
        durationSeconds: undefined, // will be computed from events
        ...metrics,
      });
    } else {
      upsertSessionRollup({
        sessionId,
        endedAt: new Date().toISOString(),
      });
    }
  }, 1000);
});
```

Also start event batching at startup (near where `startTelemetry` is called):

```typescript
startEventBatching();
```

And stop it at shutdown (near `stopTelemetry`):

```typescript
stopEventBatching();
```

- [ ] **Step 4: Wire telemetry ticks to rollup upserts in `server/index.ts`**

The telemetry module broadcasts `session-telemetry` events. Subscribe to update rollups with token data. In the WebSocket event handler section of `index.ts`, where events are broadcast, add a listener for telemetry updates that upserts rollups.

Find the `broadcastEvent` function usage and add after `startTelemetry(...)`:

```typescript
// Subscribe to telemetry broadcasts to update analytics rollups
const originalBroadcast = broadcastEvent;
// We can't easily intercept broadcastEvent, so instead we'll hook into the telemetry module
// by checking in the periodic batch flush. A simpler approach: hook into the telemetry
// collection by adding a session-telemetry handler.
```

Actually, a cleaner approach: in `server/index.ts`, the telemetry data is already broadcasted via WebSocket. We can tap into the telemetry polling by using `getTelemetryForSession` in the session-end callback. Add to the session-end callback before metrics computation:

```typescript
import { getTelemetryForSession } from './telemetry.js';
```

In the session-end setTimeout handler, before computing metrics:

```typescript
const telemetry = getTelemetryForSession(sessionId);
if (telemetry) {
  upsertSessionRollup({
    sessionId,
    model: telemetry.model,
    totalInputTokens: telemetry.totalInputTokens,
    totalOutputTokens: telemetry.totalOutputTokens,
    totalCacheRead: telemetry.totalCacheRead,
    totalCacheWrite: telemetry.totalCacheWrite,
  });
}
```

- [ ] **Step 5: Build and verify no type errors**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 6: Run all existing tests to verify no regressions**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/hooks.ts server/sessions.ts server/index.ts
git commit -m "feat(analytics): wire hook events and telemetry to session analytics collector"
```

---

## Task 5: Retention Policy + Orphaned Session Recovery

**Files:**

- Modify: `server/analytics.ts`
- Test: `test/session-analytics.test.ts`

- [ ] **Step 1: Write failing tests for retention cleanup**

Append to `test/session-analytics.test.ts`:

```typescript
import {
  runRetentionCleanup,
  recoverOrphanedSessions,
} from '../server/analytics.js';

test('runRetentionCleanup deletes old session_events', () => {
  initAnalytics(tmpDir);

  // Insert an event 100 days ago
  const oldDate = new Date(
    Date.now() - 100 * 24 * 60 * 60 * 1000
  ).toISOString();
  recordSessionEvent({
    session_id: 'old-sess',
    event_type: 'session_start',
    timestamp: oldDate,
  });
  // Insert a recent event
  recordSessionEvent({
    session_id: 'new-sess',
    event_type: 'session_start',
    timestamp: new Date().toISOString(),
  });
  flushEventBuffer();

  runRetentionCleanup(90);

  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const rows = db.prepare('SELECT * FROM session_events').all() as Record<
    string,
    unknown
  >[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.session_id, 'new-sess');
  db.close();
});

test('recoverOrphanedSessions marks stale sessions as recovered', () => {
  initAnalytics(tmpDir);

  // Create a rollup that appears orphaned (no ended_at, old updated_at)
  upsertSessionRollup({
    sessionId: 'orphan-1',
    repoPath: '/repo',
    repoName: 'repo',
    agentType: 'claude',
    startedAt: '2026-03-01T10:00:00.000Z',
  });

  // Manually set updated_at to 20 minutes ago
  const db = new Database(getDbPath(tmpDir));
  const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE session_rollups SET updated_at = ? WHERE session_id = 'orphan-1'"
  ).run(oldTime);
  db.close();

  const recovered = recoverOrphanedSessions();
  assert.equal(recovered, 1);

  const rollup = getSessionRollup('orphan-1');
  assert.ok(rollup!.endedAt);
  assert.ok(rollup!.recovered);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test dist/test/session-analytics.test.js`
Expected: FAIL — `runRetentionCleanup`, `recoverOrphanedSessions` not exported.

- [ ] **Step 3: Implement retention cleanup and orphan recovery in `server/analytics.ts`**

```typescript
// ── Retention Policy ──

export function runRetentionCleanup(retentionDays = 90): void {
  if (!db) return;

  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000
  ).toISOString();

  // Delete old session events
  db.prepare('DELETE FROM session_events WHERE timestamp < ?').run(cutoff);

  // Downsample rate_limit_snapshots: after 7 days keep hourly, after 30 days keep daily
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  // Keep first snapshot per hour for entries older than 7 days but newer than 30 days
  db.prepare(
    `
    DELETE FROM rate_limit_snapshots
    WHERE timestamp < ? AND timestamp >= ?
    AND id NOT IN (
      SELECT MIN(id) FROM rate_limit_snapshots
      WHERE timestamp < ? AND timestamp >= ?
      GROUP BY strftime('%Y-%m-%d %H', timestamp)
    )
  `
  ).run(sevenDaysAgo, thirtyDaysAgo, sevenDaysAgo, thirtyDaysAgo);

  // Keep first snapshot per day for entries older than 30 days
  db.prepare(
    `
    DELETE FROM rate_limit_snapshots
    WHERE timestamp < ?
    AND id NOT IN (
      SELECT MIN(id) FROM rate_limit_snapshots
      WHERE timestamp < ?
      GROUP BY strftime('%Y-%m-%d', timestamp)
    )
  `
  ).run(thirtyDaysAgo, thirtyDaysAgo);
}

// ── Orphaned Session Recovery ──

export function recoverOrphanedSessions(): number {
  if (!db) return 0;

  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const orphans = db
    .prepare(
      `
    SELECT session_id FROM session_rollups
    WHERE ended_at IS NULL AND updated_at < ?
  `
    )
    .all(staleThreshold) as Array<{ session_id: string }>;

  for (const { session_id } of orphans) {
    // Find the last event timestamp for this session
    const lastEvent = db
      .prepare(
        'SELECT timestamp FROM session_events WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1'
      )
      .get(session_id) as { timestamp: string } | undefined;

    const endedAt = lastEvent?.timestamp ?? new Date().toISOString();
    const metrics = computeEngagementMetrics(session_id);

    upsertSessionRollup({
      sessionId: session_id,
      endedAt,
      recovered: true,
      ...(metrics ?? {}),
    });
  }

  return orphans.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test dist/test/session-analytics.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Wire retention and recovery to server startup in `server/index.ts`**

Near the `startTelemetry()` call, add:

```typescript
import { runRetentionCleanup, recoverOrphanedSessions } from './analytics.js';

// Run retention cleanup and orphan recovery at startup
try {
  const recovered = recoverOrphanedSessions();
  if (recovered > 0)
    console.log(`[analytics] Recovered ${recovered} orphaned session(s).`);
  runRetentionCleanup();
} catch (err) {
  console.warn('[analytics] Retention/recovery error:', err);
}

// Schedule daily retention cleanup
setInterval(
  () => {
    try {
      runRetentionCleanup();
    } catch {
      /* non-fatal */
    }
  },
  24 * 60 * 60 * 1000
);
```

- [ ] **Step 6: Build and test**

Run: `npm run build && npm test`
Expected: All tests PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/analytics.ts server/index.ts test/session-analytics.test.ts
git commit -m "feat(analytics): add retention policy, rate limit downsampling, and orphaned session recovery"
```

---

## Task 6: REST API Endpoints

**Files:**

- Modify: `server/analytics.ts`
- Modify: `server/index.ts`
- Test: `test/session-analytics-api.test.ts`

- [ ] **Step 1: Write failing tests for the analytics API endpoints**

Create `test/session-analytics-api.test.ts`:

```typescript
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import http from 'node:http';
import {
  initAnalytics,
  closeAnalytics,
  createSessionAnalyticsRouter,
  recordSessionEvent,
  flushEventBuffer,
  upsertSessionRollup,
  recordRateLimitSnapshot,
} from '../server/analytics.js';

let tmpDir!: string;
let server: http.Server;
let port: number;

before(async () => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-analytics-api-test-')
  );
  initAnalytics(tmpDir);

  const app = express();
  app.use(express.json());
  app.use('/api/analytics', createSessionAnalyticsRouter());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(() => {
  // Don't close analytics between tests — just clean data
});

after(() => {
  server.close();
  closeAnalytics();
  fs.rmSync(tmpDir, { recursive: true });
});

function url(path: string): string {
  return `http://localhost:${port}/api/analytics${path}`;
}

test('GET /api/analytics/overview returns summary', async () => {
  upsertSessionRollup({
    sessionId: 'sess-1',
    repoPath: '/repo/a',
    repoName: 'repo-a',
    agentType: 'claude',
    startedAt: new Date().toISOString(),
    totalInputTokens: 5000,
    totalOutputTokens: 1200,
    durationSeconds: 600,
  });

  const res = await fetch(url('/overview'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.ok(typeof data.totalSessions === 'number');
  assert.ok(typeof data.totalTokensIn === 'number');
  assert.ok(Array.isArray(data.byRepo));
});

test('GET /api/analytics/sessions returns paginated list', async () => {
  const res = await fetch(url('/sessions?limit=10'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.ok(Array.isArray(data.sessions));
  assert.ok(typeof data.total === 'number');
});

test('GET /api/analytics/sessions/:id returns session detail', async () => {
  const res = await fetch(url('/sessions/sess-1'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.ok(data.session);
});

test('GET /api/analytics/sessions/:id returns 404 for unknown', async () => {
  const res = await fetch(url('/sessions/nonexistent'));
  assert.equal(res.status, 404);
});

test('GET /api/analytics/trends returns daily data', async () => {
  const res = await fetch(url('/trends?days=7'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.ok(Array.isArray(data.days));
});

test('GET /api/analytics/tools returns tool breakdown', async () => {
  // Insert some tool use events
  recordSessionEvent({
    session_id: 'sess-1',
    event_type: 'tool_use',
    event_data: { tool: 'Read' },
    timestamp: new Date().toISOString(),
  });
  recordSessionEvent({
    session_id: 'sess-1',
    event_type: 'tool_use',
    event_data: { tool: 'Read' },
    timestamp: new Date().toISOString(),
  });
  recordSessionEvent({
    session_id: 'sess-1',
    event_type: 'tool_use',
    event_data: { tool: 'Edit' },
    timestamp: new Date().toISOString(),
  });
  flushEventBuffer();

  const res = await fetch(url('/tools?days=7'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.ok(Array.isArray(data.tools));
});

test('GET /api/analytics/rate-limits returns snapshots', async () => {
  recordRateLimitSnapshot({
    fiveHourPercent: 62,
    fiveHourResetsAt: '2026-04-01T14:32:00Z',
    sevenDayPercent: 91,
    sevenDayResetsAt: '2026-04-03T00:00:00Z',
    timestamp: new Date().toISOString(),
  });

  const res = await fetch(url('/rate-limits?hours=24'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.ok(Array.isArray(data.snapshots));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test dist/test/session-analytics-api.test.js`
Expected: FAIL — `createSessionAnalyticsRouter` not exported.

- [ ] **Step 3: Implement `createSessionAnalyticsRouter` in `server/analytics.ts`**

```typescript
// ── Session Analytics REST API ──

export function createSessionAnalyticsRouter(): Router {
  const router = Router();

  // GET /overview
  router.get('/overview', (_req: Request, res: Response) => {
    if (!db) {
      res.status(503).json({ error: 'Analytics not initialized' });
      return;
    }

    const days = parseInt(_req.query.days as string) || 7;
    const repoFilter = _req.query.repo as string | undefined;
    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    ).toISOString();

    let query = `SELECT * FROM session_rollups WHERE started_at >= ?`;
    const params: unknown[] = [since];
    if (repoFilter) {
      query += ' AND repo_path = ?';
      params.push(repoFilter);
    }

    const rollups = db.prepare(query).all(...params) as Array<
      Record<string, unknown>
    >;

    let totalTokensIn = 0,
      totalTokensOut = 0,
      totalCacheRead = 0;
    let totalDuration = 0,
      durationCount = 0;
    let totalLatency = 0,
      latencyCount = 0;
    let totalIdle = 0,
      idleCount = 0;
    let totalRateLimits = 0;
    const byRepo = new Map<
      string,
      {
        repoName: string;
        sessions: number;
        tokensIn: number;
        tokensOut: number;
      }
    >();

    for (const r of rollups) {
      totalTokensIn += r.total_input_tokens as number;
      totalTokensOut += r.total_output_tokens as number;
      totalCacheRead += r.total_cache_read as number;
      if (r.duration_seconds) {
        totalDuration += r.duration_seconds as number;
        durationCount++;
      }
      if (r.human_response_latency_avg_ms) {
        totalLatency += r.human_response_latency_avg_ms as number;
        latencyCount++;
      }
      if (r.agent_idle_percent !== null) {
        totalIdle += r.agent_idle_percent as number;
        idleCount++;
      }
      totalRateLimits += r.rate_limit_encounters as number;

      const rp = (r.repo_path as string) ?? 'unknown';
      const existing = byRepo.get(rp);
      if (existing) {
        existing.sessions++;
        existing.tokensIn += r.total_input_tokens as number;
        existing.tokensOut += r.total_output_tokens as number;
      } else {
        byRepo.set(rp, {
          repoName: (r.repo_name as string) ?? rp.split('/').pop() ?? rp,
          sessions: 1,
          tokensIn: r.total_input_tokens as number,
          tokensOut: r.total_output_tokens as number,
        });
      }
    }

    const totalTokens = totalTokensIn + totalTokensOut;
    const byRepoArr = [...byRepo.entries()]
      .map(([_, v]) => ({
        ...v,
        pctOfTotal:
          totalTokens > 0
            ? Math.round(((v.tokensIn + v.tokensOut) / totalTokens) * 1000) / 10
            : 0,
      }))
      .sort((a, b) => b.tokensIn - a.tokensIn);

    res.json({
      timeWindow: { start: since, end: new Date().toISOString() },
      totalSessions: rollups.length,
      totalTokensIn,
      totalTokensOut,
      totalCacheRead,
      avgSessionDuration:
        durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
      avgHumanResponseLatency:
        latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
      avgAgentIdlePercent:
        idleCount > 0 ? Math.round((totalIdle / idleCount) * 10) / 10 : 0,
      totalRateLimitEncounters: totalRateLimits,
      byRepo: byRepoArr,
    });
  });

  // GET /sessions
  router.get('/sessions', (_req: Request, res: Response) => {
    if (!db) {
      res.status(503).json({ error: 'Analytics not initialized' });
      return;
    }

    const offset = parseInt(_req.query.offset as string) || 0;
    const limit = Math.min(parseInt(_req.query.limit as string) || 20, 100);
    const repoFilter = _req.query.repo as string | undefined;
    const agentFilter = _req.query.agent as string | undefined;
    const sort = (_req.query.sort as string) || 'started_at';

    const validSorts: Record<string, string> = {
      started_at: 'started_at DESC',
      tokens: 'total_input_tokens DESC',
      duration: 'duration_seconds DESC',
    };
    const orderBy = validSorts[sort] ?? 'started_at DESC';

    let where = 'WHERE 1=1';
    const params: unknown[] = [];
    if (repoFilter) {
      where += ' AND repo_path = ?';
      params.push(repoFilter);
    }
    if (agentFilter) {
      where += ' AND agent_type = ?';
      params.push(agentFilter);
    }

    const total = (
      db
        .prepare(`SELECT COUNT(*) as count FROM session_rollups ${where}`)
        .get(...params) as { count: number }
    ).count;

    const rows = db
      .prepare(
        `SELECT * FROM session_rollups ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    const sessions = rows.map((r) => ({
      sessionId: r.session_id,
      repoName: r.repo_name,
      repoPath: r.repo_path,
      agentType: r.agent_type,
      model: r.model,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationSeconds: r.duration_seconds,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      turnCount: r.turn_count,
      humanResponseLatencyAvg: r.human_response_latency_avg_ms,
      agentIdlePercent: r.agent_idle_percent,
      rateLimitEncounters: r.rate_limit_encounters,
      topTools: (() => {
        try {
          const counts = r.tool_use_counts
            ? (JSON.parse(r.tool_use_counts as string) as Record<
                string,
                number
              >)
            : {};
          return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([name]) => name);
        } catch {
          return [];
        }
      })(),
      recovered: (r.recovered as number) === 1,
    }));

    res.json({ sessions, total, offset, limit });
  });

  // GET /sessions/:id
  router.get('/sessions/:id', (req: Request, res: Response) => {
    if (!db) {
      res.status(503).json({ error: 'Analytics not initialized' });
      return;
    }

    const rollup = getSessionRollup(req.params.id);
    if (!rollup) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const events = db
      .prepare(
        'SELECT event_type, event_data, timestamp FROM session_events WHERE session_id = ? ORDER BY timestamp ASC'
      )
      .all(req.params.id) as Array<{
      event_type: string;
      event_data: string | null;
      timestamp: string;
    }>;

    const toolBreakdown: Record<string, { count: number }> = {};
    for (const e of events) {
      if (e.event_type === 'tool_use' && e.event_data) {
        try {
          const data = JSON.parse(e.event_data) as Record<string, unknown>;
          const tool = (data.tool as string) ?? 'unknown';
          toolBreakdown[tool] = {
            count: (toolBreakdown[tool]?.count ?? 0) + 1,
          };
        } catch {
          /* ignore */
        }
      }
    }

    // Compute time breakdown
    let agentActiveTime = 0,
      waitingForHumanTime = 0,
      rateLimitTime = 0;
    if (events.length > 0) {
      const firstTs = new Date(events[0]!.timestamp).getTime();
      const lastTs = new Date(events[events.length - 1]!.timestamp).getTime();
      const totalMs = lastTs - firstTs;
      if (rollup.agentIdlePercent !== null && totalMs > 0) {
        waitingForHumanTime = Math.round(
          (totalMs * (rollup.agentIdlePercent / 100)) / 1000
        );
        agentActiveTime = Math.round(
          (totalMs - waitingForHumanTime * 1000) / 1000
        );
      }
    }

    res.json({
      session: rollup,
      toolBreakdown,
      events: events.map((e) => ({
        type: e.event_type,
        timestamp: e.timestamp,
        data: e.event_data ? JSON.parse(e.event_data) : {},
      })),
      engagementBreakdown: {
        agentActiveTime,
        waitingForHumanTime,
        rateLimitTime,
        otherTime:
          (rollup.durationSeconds ?? 0) -
          agentActiveTime -
          waitingForHumanTime -
          rateLimitTime,
      },
    });
  });

  // GET /trends
  router.get('/trends', (_req: Request, res: Response) => {
    if (!db) {
      res.status(503).json({ error: 'Analytics not initialized' });
      return;
    }

    const days = parseInt(_req.query.days as string) || 30;
    const repoFilter = _req.query.repo as string | undefined;
    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    ).toISOString();

    let query = `
      SELECT
        date(started_at) as date,
        COUNT(*) as sessions,
        SUM(total_input_tokens) as tokens_in,
        SUM(total_output_tokens) as tokens_out,
        AVG(human_response_latency_avg_ms) as avg_human_latency,
        AVG(agent_idle_percent) as avg_agent_idle,
        SUM(rate_limit_encounters) as rate_limit_encounters
      FROM session_rollups
      WHERE started_at >= ?
    `;
    const params: unknown[] = [since];
    if (repoFilter) {
      query += ' AND repo_path = ?';
      params.push(repoFilter);
    }
    query += ' GROUP BY date(started_at) ORDER BY date ASC';

    const rows = db.prepare(query).all(...params) as Array<
      Record<string, unknown>
    >;

    res.json({
      days: rows.map((r) => ({
        date: r.date,
        sessions: r.sessions,
        tokensIn: r.tokens_in ?? 0,
        tokensOut: r.tokens_out ?? 0,
        avgHumanLatency: r.avg_human_latency
          ? Math.round(r.avg_human_latency as number)
          : 0,
        avgAgentIdle: r.avg_agent_idle
          ? Math.round((r.avg_agent_idle as number) * 10) / 10
          : 0,
        rateLimitEncounters: r.rate_limit_encounters ?? 0,
      })),
    });
  });

  // GET /tools
  router.get('/tools', (_req: Request, res: Response) => {
    if (!db) {
      res.status(503).json({ error: 'Analytics not initialized' });
      return;
    }

    const days = parseInt(_req.query.days as string) || 7;
    const repoFilter = _req.query.repo as string | undefined;
    const sessionFilter = _req.query.session as string | undefined;
    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    ).toISOString();

    let query = `SELECT event_data FROM session_events WHERE event_type = 'tool_use' AND timestamp >= ?`;
    const params: unknown[] = [since];
    if (repoFilter) {
      query += ' AND repo_path = ?';
      params.push(repoFilter);
    }
    if (sessionFilter) {
      query += ' AND session_id = ?';
      params.push(sessionFilter);
    }

    const rows = db.prepare(query).all(...params) as Array<{
      event_data: string | null;
    }>;

    const counts = new Map<string, number>();
    let totalUses = 0;
    for (const r of rows) {
      if (!r.event_data) continue;
      try {
        const data = JSON.parse(r.event_data) as Record<string, unknown>;
        const tool = (data.tool as string) ?? 'unknown';
        counts.set(tool, (counts.get(tool) ?? 0) + 1);
        totalUses++;
      } catch {
        /* ignore */
      }
    }

    const tools = [...counts.entries()]
      .map(([name, count]) => ({
        name,
        totalUses: count,
        pctOfUses:
          totalUses > 0 ? Math.round((count / totalUses) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.totalUses - a.totalUses);

    res.json({ tools });
  });

  // GET /rate-limits
  router.get('/rate-limits', (_req: Request, res: Response) => {
    if (!db) {
      res.status(503).json({ error: 'Analytics not initialized' });
      return;
    }

    const hours = parseInt(_req.query.hours as string) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const rows = db
      .prepare(
        'SELECT * FROM rate_limit_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC'
      )
      .all(since) as Array<Record<string, unknown>>;

    res.json({
      snapshots: rows.map((r) => ({
        timestamp: r.timestamp,
        fiveHourPercent: r.five_hour_percent,
        sevenDayPercent: r.seven_day_percent,
      })),
    });
  });

  return router;
}
```

- [ ] **Step 4: Mount the session analytics router in `server/index.ts`**

Find the line where the existing analytics router is mounted:

```typescript
app.use('/analytics', requireAuth, createAnalyticsRouter(configDir));
```

Add after it:

```typescript
import { createSessionAnalyticsRouter } from './analytics.js';

app.use('/api/analytics', requireAuth, createSessionAnalyticsRouter());
```

Note: the existing `/analytics` route stays for the generic event tracking. The new `/api/analytics` route serves session analytics.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && node --test dist/test/session-analytics-api.test.js`
Expected: All tests PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/analytics.ts server/index.ts test/session-analytics-api.test.ts
git commit -m "feat(analytics): add 6 REST API endpoints for session analytics"
```

---

## Task 7: Rate Limit Snapshot Recording from Telemetry

**Files:**

- Modify: `server/index.ts`

The telemetry module already broadcasts `account-telemetry` events with rate limit data. We need to record snapshots periodically.

- [ ] **Step 1: Add rate limit snapshot recording to the telemetry subscription in `server/index.ts`**

After `startTelemetry(...)`, add a periodic rate limit snapshot recorder. Since telemetry polls every 2 seconds but we don't need that granularity for snapshots, record every 5 minutes:

```typescript
import { recordRateLimitSnapshot } from './analytics.js';
import { getAccountTelemetry } from './telemetry.js';

let lastRateLimitSnapshot = 0;
const RATE_LIMIT_SNAPSHOT_INTERVAL = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  const now = Date.now();
  if (now - lastRateLimitSnapshot < RATE_LIMIT_SNAPSHOT_INTERVAL) return;
  const account = getAccountTelemetry();
  if (!account || account.fiveHourUsedPercent < 0) return;
  lastRateLimitSnapshot = now;
  recordRateLimitSnapshot({
    fiveHourPercent: account.fiveHourUsedPercent,
    fiveHourResetsAt: account.fiveHourResetsAt,
    sevenDayPercent: account.sevenDayUsedPercent,
    sevenDayResetsAt: account.sevenDayResetsAt,
    timestamp: new Date().toISOString(),
  });
}, 60_000); // Check every minute, record at most every 5 min
```

- [ ] **Step 2: Build and test**

Run: `npm run build && npm test`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat(analytics): record rate limit snapshots every 5 minutes from telemetry"
```

---

## Task 8: Frontend Types + API Client

**Files:**

- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Add analytics response types to `frontend/src/lib/types.ts`**

Append:

```typescript
// ── Session Analytics ──

export interface AnalyticsOverview {
  timeWindow: { start: string; end: string };
  totalSessions: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheRead: number;
  avgSessionDuration: number;
  avgHumanResponseLatency: number;
  avgAgentIdlePercent: number;
  totalRateLimitEncounters: number;
  byRepo: Array<{
    repoName: string;
    sessions: number;
    tokensIn: number;
    tokensOut: number;
    pctOfTotal: number;
  }>;
}

export interface AnalyticsSessionSummary {
  sessionId: string;
  repoName: string | null;
  repoPath: string | null;
  agentType: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  humanResponseLatencyAvg: number | null;
  agentIdlePercent: number | null;
  rateLimitEncounters: number;
  topTools: string[];
  recovered: boolean;
}

export interface AnalyticsSessionsResponse {
  sessions: AnalyticsSessionSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface AnalyticsSessionDetail {
  session: {
    sessionId: string;
    repoPath: string | null;
    repoName: string | null;
    agentType: string | null;
    model: string | null;
    startedAt: string;
    endedAt: string | null;
    durationSeconds: number | null;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheRead: number;
    totalCacheWrite: number;
    turnCount: number;
    subagentCount: number;
    humanResponseLatencyAvgMs: number | null;
    humanResponseLatencyP50Ms: number | null;
    humanResponseLatencyP95Ms: number | null;
    agentIdlePercent: number | null;
    rateLimitEncounters: number;
    toolUseCounts: Record<string, number> | null;
    recovered: boolean;
  };
  toolBreakdown: Record<string, { count: number }>;
  events: Array<{
    type: string;
    timestamp: string;
    data: Record<string, unknown>;
  }>;
  engagementBreakdown: {
    agentActiveTime: number;
    waitingForHumanTime: number;
    rateLimitTime: number;
    otherTime: number;
  };
}

export interface AnalyticsTrend {
  date: string;
  sessions: number;
  tokensIn: number;
  tokensOut: number;
  avgHumanLatency: number;
  avgAgentIdle: number;
  rateLimitEncounters: number;
}

export interface AnalyticsToolBreakdown {
  tools: Array<{
    name: string;
    totalUses: number;
    pctOfUses: number;
  }>;
}

export interface AnalyticsRateLimitHistory {
  snapshots: Array<{
    timestamp: string;
    fiveHourPercent: number;
    sevenDayPercent: number;
  }>;
}
```

- [ ] **Step 2: Add API fetch functions to `frontend/src/lib/api.ts`**

Append:

```typescript
// ── Session Analytics API ──

export async function fetchAnalyticsOverview(
  days = 7,
  repo?: string
): Promise<AnalyticsOverview> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  return json<AnalyticsOverview>(
    await fetch(`/api/analytics/overview?${params}`)
  );
}

export async function fetchAnalyticsSessions(opts?: {
  offset?: number;
  limit?: number;
  repo?: string;
  agent?: string;
  sort?: string;
}): Promise<AnalyticsSessionsResponse> {
  const params = new URLSearchParams();
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.repo) params.set('repo', opts.repo);
  if (opts?.agent) params.set('agent', opts.agent);
  if (opts?.sort) params.set('sort', opts.sort);
  return json<AnalyticsSessionsResponse>(
    await fetch(`/api/analytics/sessions?${params}`)
  );
}

export async function fetchAnalyticsSessionDetail(
  id: string
): Promise<AnalyticsSessionDetail> {
  return json<AnalyticsSessionDetail>(
    await fetch(`/api/analytics/sessions/${encodeURIComponent(id)}`)
  );
}

export async function fetchAnalyticsTrends(
  days = 30,
  repo?: string
): Promise<{ days: AnalyticsTrend[] }> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  return json<{ days: AnalyticsTrend[] }>(
    await fetch(`/api/analytics/trends?${params}`)
  );
}

export async function fetchAnalyticsTools(
  days = 7,
  repo?: string,
  session?: string
): Promise<AnalyticsToolBreakdown> {
  const params = new URLSearchParams({ days: String(days) });
  if (repo) params.set('repo', repo);
  if (session) params.set('session', session);
  return json<AnalyticsToolBreakdown>(
    await fetch(`/api/analytics/tools?${params}`)
  );
}

export async function fetchAnalyticsRateLimits(
  hours = 24
): Promise<AnalyticsRateLimitHistory> {
  return json<AnalyticsRateLimitHistory>(
    await fetch(`/api/analytics/rate-limits?hours=${hours}`)
  );
}
```

Add the missing type imports at the top of `api.ts`:

```typescript
import type {
  AnalyticsOverview,
  AnalyticsSessionsResponse,
  AnalyticsSessionDetail,
  AnalyticsTrend,
  AnalyticsToolBreakdown,
  AnalyticsRateLimitHistory,
} from './types.js';
```

- [ ] **Step 3: Build to verify types**

Run: `npm run build`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/lib/api.ts
git commit -m "feat(analytics): add frontend types and API client for session analytics"
```

---

## Task 9: AnalyticsDashboard.svelte

**Files:**

- Create: `frontend/src/components/AnalyticsDashboard.svelte`
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/components/Sidebar.svelte`

This is the main analytics page. TUI aesthetic: monospace, `--bg` black, `--border` structural borders, 0px border-radius, terracotta accent, all lowercase headers. Read `DESIGN.md` before implementing to verify compliance.

**Important references:**

- `DESIGN.md` — TUI aesthetic, colors, typography, button styles
- `frontend/src/components/SessionStatusBar.svelte` — reference for TUI data display patterns
- `frontend/src/components/RepoDashboard.svelte` — reference for dashboard layout patterns
- `frontend/src/components/DataTable.svelte` — reuse for session list table

- [ ] **Step 1: Create `frontend/src/components/AnalyticsDashboard.svelte`**

Create the component with: overview stats, rate limit bars, engagement metrics, tool usage breakdown, daily trend visualization (ASCII bar chart), and a session list using DataTable. The component should:

- Fetch data using `fetchAnalyticsOverview`, `fetchAnalyticsTrends`, `fetchAnalyticsTools`, `fetchAnalyticsSessions`
- Allow clicking a session row to navigate to session detail (emit `onSelectSession` event)
- Use `$state` and `$effect` for data fetching (Svelte 5 runes)
- All section headers lowercase
- Use ASCII bar characters for rate limit and tool breakdown bars (e.g. `'█'.repeat(filled) + '░'.repeat(empty)`)
- Use `--accent` (terracotta) for primary bars, `--text-muted` for secondary
- Format tokens as `↓12.4k ↑3.2k` pattern (consistent with SessionStatusBar)
- Format durations as `30m 42s` or `1h 12m`
- Responsive: stack vertically below 768px, hide tool breakdown and trends below 480px

The mock in the design spec (lines 426-463 of the spec file) shows the target layout:

```
analytics
────────────────────────────────────────────────────────────

overview (last 7 days)                         rate limits
─────────────────────────                      ──────────────
sessions:     47                               5-hour:  ████████████░░░░░░░░ 62%
tokens:       ↓284.2k ↑71.8k                          resets 14:32
...
```

Create the full component following this layout. It should be approximately 300-400 lines.

Props:

```typescript
interface Props {
  onSelectSession: (sessionId: string) => void;
}
```

- [ ] **Step 2: Create `frontend/src/components/SessionDetail.svelte`**

Create the session detail drill-down component. Shows full event timeline, metrics, tool breakdown, and time breakdown visualization.

Props:

```typescript
interface Props {
  sessionId: string;
  onBack: () => void;
}
```

Fetches data using `fetchAnalyticsSessionDetail`. Layout follows the mock in the spec (lines 472-511):

```
session abc-123 — claude-remote-cli — opus-4
────────────────────────────────────────────────────────────

metrics
──────────────
duration:     46m 12s
...

event timeline
──────────────
14:22:00  ● session start
14:22:05  ◆ user prompt
...
```

Event timeline uses Unicode symbols per event type:

- `●` session start/end
- `◆` user prompt
- `▸` tool use (show tool name + target)
- `■` agent stop
- `⚡` notification
- Idle periods shown as `─── human idle: 33s ───` between agent_stop and user_prompt

- [ ] **Step 3: Add `analytics` view mode to `App.svelte`**

Modify `App.svelte`:

1. Add imports:

```typescript
import AnalyticsDashboard from './components/AnalyticsDashboard.svelte';
import SessionDetail from './components/SessionDetail.svelte';
```

2. Add analytics state:

```typescript
let analyticsView = $state<'dashboard' | { sessionId: string } | null>(null);
```

3. Modify the `viewMode` derived to add analytics:

```typescript
let viewMode = $derived<
  'empty' | 'org' | 'dashboard' | 'session' | 'analytics'
>(
  analyticsView !== null
    ? 'analytics'
    : !sessionState.repos.length
      ? 'empty'
      : !ui.activeRepoPath
        ? 'org'
        : !hasActiveSession
          ? 'dashboard'
          : 'session'
);
```

4. Add analytics rendering in the template, in the `{#if viewMode === ...}` chain:

```svelte
{:else if viewMode === 'analytics'}
  {#if typeof analyticsView === 'object' && analyticsView !== null && 'sessionId' in analyticsView}
    <SessionDetail
      sessionId={analyticsView.sessionId}
      onBack={() => { analyticsView = 'dashboard'; }}
    />
  {:else}
    <AnalyticsDashboard
      onSelectSession={(id) => { analyticsView = { sessionId: id }; }}
    />
  {/if}
```

5. Add a function to navigate to analytics:

```typescript
function openAnalytics() {
  analyticsView = 'dashboard';
}

function closeAnalytics() {
  analyticsView = null;
}
```

When `analyticsView` is set back to `null`, the normal view mode logic takes over.

- [ ] **Step 4: Add analytics button to Sidebar**

In `frontend/src/components/Sidebar.svelte`, add an `onOpenAnalytics` prop and an analytics button in the sidebar footer, next to the settings button:

Add prop:

```typescript
onOpenAnalytics: () => void;
```

In the `sidebar-footer-row` div, add before the settings button:

```svelte
<button class="settings-icon-btn" data-track="sidebar.analytics" onclick={() => onOpenAnalytics()} aria-label="Analytics">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" width="14" height="14">
    <rect x="3" y="12" width="4" height="9"/>
    <rect x="10" y="7" width="4" height="14"/>
    <rect x="17" y="3" width="4" height="18"/>
  </svg>
</button>
```

Pass `onOpenAnalytics` from `App.svelte` when rendering `<Sidebar>`:

```svelte
<Sidebar ... onOpenAnalytics={openAnalytics} />
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: No type errors, no svelte-check errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/AnalyticsDashboard.svelte frontend/src/components/SessionDetail.svelte frontend/src/App.svelte frontend/src/components/Sidebar.svelte
git commit -m "feat(analytics): add AnalyticsDashboard and SessionDetail frontend pages with sidebar navigation"
```

---

## Task 10: Polish + Integration Test

**Files:**

- All modified files

- [ ] **Step 1: Run the full build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Manually verify the analytics API works end-to-end**

Start the server locally and verify:

1. `curl http://localhost:<port>/api/analytics/overview` returns valid JSON
2. `curl http://localhost:<port>/api/analytics/sessions` returns empty session list
3. `curl http://localhost:<port>/api/analytics/trends` returns empty days array
4. `curl http://localhost:<port>/api/analytics/tools` returns empty tools array
5. `curl http://localhost:<port>/api/analytics/rate-limits` returns empty snapshots array

- [ ] **Step 4: Final commit if any polish needed**

```bash
git add -A
git commit -m "chore(analytics): polish and integration verification"
```

---

## Summary

| Task | Description                                        | Test File                            |
| ---- | -------------------------------------------------- | ------------------------------------ |
| 1    | Schema extension (3 new tables + migration system) | `test/session-analytics.test.ts`     |
| 2    | Event recording + write batching                   | `test/session-analytics.test.ts`     |
| 3    | Session rollup upsert + engagement metrics         | `test/session-analytics.test.ts`     |
| 4    | Hook event collector integration                   | (build + existing tests)             |
| 5    | Retention policy + orphan recovery                 | `test/session-analytics.test.ts`     |
| 6    | REST API endpoints (6 GET routes)                  | `test/session-analytics-api.test.ts` |
| 7    | Rate limit snapshot recording                      | (build + existing tests)             |
| 8    | Frontend types + API client                        | (build verification)                 |
| 9    | AnalyticsDashboard + SessionDetail + navigation    | (build + svelte-check)               |
| 10   | Polish + integration verification                  | (full test suite)                    |
