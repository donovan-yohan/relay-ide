import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initAnalytics, closeAnalytics, getDbPath, recordSessionEvent, flushEventBuffer, recordRateLimitSnapshot, upsertSessionRollup, getSessionRollup, computeEngagementMetrics, runRetentionCleanup, recoverOrphanedSessions } from '../server/analytics.js';
import type { SessionEvent } from '../server/types.js';

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
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  assert.ok(tables.some(t => t.name === 'session_events'), 'session_events table should exist');
  db.close();
});

test('initAnalytics creates session_rollups table', () => {
  initAnalytics(tmpDir);
  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  assert.ok(tables.some(t => t.name === 'session_rollups'), 'session_rollups table should exist');
  db.close();
});

test('initAnalytics creates rate_limit_snapshots table', () => {
  initAnalytics(tmpDir);
  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  assert.ok(tables.some(t => t.name === 'rate_limit_snapshots'), 'rate_limit_snapshots table should exist');
  db.close();
});

test('initAnalytics creates schema_version table at version 2', () => {
  initAnalytics(tmpDir);
  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  assert.ok(tables.some(t => t.name === 'schema_version'), 'schema_version table should exist');
  const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
  assert.equal(version.version, 2);
  db.close();
});

test('recordSessionEvent buffers and flushes to DB', () => {
  initAnalytics(tmpDir);

  recordSessionEvent({
    session_id: 'sess-1',
    repo_path: '/repo',
    event_type: 'session_start',
    timestamp: '2026-04-01T10:00:00.000Z',
  });

  // Before flush: DB has 0 session events
  const db1 = new Database(getDbPath(tmpDir), { readonly: true });
  const before = db1.prepare('SELECT COUNT(*) as count FROM session_events').get() as { count: number };
  assert.equal(before.count, 0);
  db1.close();

  flushEventBuffer();

  // After flush: DB has 1 session event
  const db2 = new Database(getDbPath(tmpDir), { readonly: true });
  const after = db2.prepare('SELECT COUNT(*) as count FROM session_events').get() as { count: number };
  assert.equal(after.count, 1);
  const row = db2.prepare('SELECT * FROM session_events').get() as Record<string, unknown>;
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
  const row = db.prepare('SELECT * FROM session_events').get() as Record<string, unknown>;
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
  const count = db.prepare('SELECT COUNT(*) as count FROM session_events').get() as { count: number };
  assert.equal(count.count, 5);
  db.close();
});

test('flushEventBuffer with sessionId only flushes that session', () => {
  initAnalytics(tmpDir);

  recordSessionEvent({ session_id: 'sess-A', event_type: 'tool_use', timestamp: new Date().toISOString() });
  recordSessionEvent({ session_id: 'sess-B', event_type: 'tool_use', timestamp: new Date().toISOString() });
  recordSessionEvent({ session_id: 'sess-A', event_type: 'agent_stop', timestamp: new Date().toISOString() });

  flushEventBuffer('sess-A');

  // sess-A events flushed, sess-B still in buffer
  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const rows = db.prepare('SELECT session_id FROM session_events ORDER BY id').all() as { session_id: string }[];
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.session_id === 'sess-A'));
  db.close();

  // Flush remaining
  flushEventBuffer();
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
  const row = db.prepare('SELECT * FROM rate_limit_snapshots').get() as Record<string, unknown>;
  assert.equal(row.five_hour_percent, 62);
  assert.equal(row.seven_day_percent, 91);
  db.close();
});

// ── Session Rollup Tests ──

test('upsertSessionRollup creates initial rollup', () => {
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
  assert.equal(rollup!.recovered, false);
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

test('upsertSessionRollup stores recovered flag', () => {
  initAnalytics(tmpDir);

  upsertSessionRollup({
    sessionId: 'sess-1',
    repoPath: '/repo',
    repoName: 'repo',
    agentType: 'claude',
    startedAt: '2026-04-01T10:00:00.000Z',
    recovered: true,
  });

  const rollup = getSessionRollup('sess-1');
  assert.equal(rollup!.recovered, true);
});

test('getSessionRollup returns null for unknown session', () => {
  initAnalytics(tmpDir);
  assert.equal(getSessionRollup('nonexistent'), null);
});

// ── Engagement Metric Tests ──

test('computeEngagementMetrics calculates human response latency', () => {
  initAnalytics(tmpDir);

  const events = [
    { session_id: 'sess-1', event_type: 'session_start', timestamp: '2026-04-01T10:00:00.000Z' },
    { session_id: 'sess-1', event_type: 'user_prompt', timestamp: '2026-04-01T10:00:05.000Z' },
    { session_id: 'sess-1', event_type: 'agent_stop', timestamp: '2026-04-01T10:01:00.000Z' },
    { session_id: 'sess-1', event_type: 'notification', timestamp: '2026-04-01T10:01:00.500Z' },
    { session_id: 'sess-1', event_type: 'user_prompt', timestamp: '2026-04-01T10:01:32.500Z' },
  ];
  for (const e of events) recordSessionEvent(e);
  flushEventBuffer();

  const metrics = computeEngagementMetrics('sess-1');
  assert.ok(metrics);
  assert.equal(metrics!.humanResponseLatencyAvgMs, 32000);
  assert.equal(metrics!.humanResponseLatencyP50Ms, 32000);
});

test('computeEngagementMetrics counts rate limit encounters', () => {
  initAnalytics(tmpDir);

  const events = [
    { session_id: 'sess-2', event_type: 'session_start', timestamp: '2026-04-01T10:00:00.000Z' },
    { session_id: 'sess-2', event_type: 'stop_failure', event_data: { error: 'rate_limit' }, timestamp: '2026-04-01T10:05:00.000Z' },
    { session_id: 'sess-2', event_type: 'stop_failure', event_data: { error: 'rate_limit' }, timestamp: '2026-04-01T10:10:00.000Z' },
    { session_id: 'sess-2', event_type: 'stop_failure', event_data: { error: 'other' }, timestamp: '2026-04-01T10:15:00.000Z' },
  ];
  for (const e of events) recordSessionEvent(e);
  flushEventBuffer();

  const metrics = computeEngagementMetrics('sess-2');
  assert.equal(metrics!.rateLimitEncounters, 2);
});

test('computeEngagementMetrics aggregates tool use counts', () => {
  initAnalytics(tmpDir);

  const events = [
    { session_id: 'sess-3', event_type: 'session_start', timestamp: '2026-04-01T10:00:00.000Z' },
    { session_id: 'sess-3', event_type: 'tool_use', event_data: { tool: 'Read' }, timestamp: '2026-04-01T10:00:01.000Z' },
    { session_id: 'sess-3', event_type: 'tool_use', event_data: { tool: 'Read' }, timestamp: '2026-04-01T10:00:02.000Z' },
    { session_id: 'sess-3', event_type: 'tool_use', event_data: { tool: 'Edit' }, timestamp: '2026-04-01T10:00:03.000Z' },
    { session_id: 'sess-3', event_type: 'tool_use', event_data: { tool: 'Bash' }, timestamp: '2026-04-01T10:00:04.000Z' },
  ];
  for (const e of events) recordSessionEvent(e);
  flushEventBuffer();

  const metrics = computeEngagementMetrics('sess-3');
  assert.deepEqual(metrics!.toolUseCounts, { Read: 2, Edit: 1, Bash: 1 });
});

test('computeEngagementMetrics returns null for unknown session', () => {
  initAnalytics(tmpDir);
  assert.equal(computeEngagementMetrics('nonexistent'), null);
});

// ── Retention + Recovery Tests ──

test('runRetentionCleanup deletes old session_events', () => {
  initAnalytics(tmpDir);

  // Insert an event 100 days ago
  const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
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
  const rows = db.prepare('SELECT * FROM session_events').all() as Record<string, unknown>[];
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
  db.prepare("UPDATE session_rollups SET updated_at = ? WHERE session_id = 'orphan-1'").run(oldTime);
  db.close();

  const recovered = recoverOrphanedSessions();
  assert.equal(recovered, 1);

  const rollup = getSessionRollup('orphan-1');
  assert.ok(rollup!.endedAt);
  assert.equal(rollup!.recovered, true);
});

test('recoverOrphanedSessions skips recently updated sessions', () => {
  initAnalytics(tmpDir);

  // Create a rollup that was just updated (not orphaned)
  upsertSessionRollup({
    sessionId: 'active-1',
    repoPath: '/repo',
    repoName: 'repo',
    agentType: 'claude',
    startedAt: new Date().toISOString(),
  });

  const recovered = recoverOrphanedSessions();
  assert.equal(recovered, 0);

  const rollup = getSessionRollup('active-1');
  assert.equal(rollup!.endedAt, null);
  assert.equal(rollup!.recovered, false);
});
