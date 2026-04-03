import { test, before, after } from 'node:test';
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

  // Seed test data
  upsertSessionRollup({
    sessionId: 'sess-1',
    repoPath: '/repo/a',
    repoName: 'repo-a',
    agentType: 'claude',
    model: 'opus-4',
    startedAt: new Date().toISOString(),
    totalInputTokens: 5000,
    totalOutputTokens: 1200,
    durationSeconds: 600,
    rateLimitEncounters: 1,
    toolUseCounts: { Read: 10, Edit: 3 },
  });

  recordSessionEvent({
    session_id: 'sess-1',
    repo_path: '/repo/a',
    event_type: 'session_start',
    timestamp: new Date().toISOString(),
  });
  recordSessionEvent({
    session_id: 'sess-1',
    repo_path: '/repo/a',
    event_type: 'tool_use',
    event_data: { tool: 'Read' },
    timestamp: new Date().toISOString(),
  });
  recordSessionEvent({
    session_id: 'sess-1',
    repo_path: '/repo/a',
    event_type: 'tool_use',
    event_data: { tool: 'Edit' },
    timestamp: new Date().toISOString(),
  });
  flushEventBuffer();

  recordRateLimitSnapshot({
    fiveHourPercent: 62,
    fiveHourResetsAt: '2026-04-01T14:32:00Z',
    sevenDayPercent: 91,
    sevenDayResetsAt: '2026-04-03T00:00:00Z',
    timestamp: new Date().toISOString(),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/analytics', createSessionAnalyticsRouter());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
});

after(() => {
  server.close();
  closeAnalytics();
  fs.rmSync(tmpDir, { recursive: true });
});

function url(p: string): string {
  return `http://localhost:${port}/api/analytics${p}`;
}

test('GET /api/analytics/overview returns summary', async () => {
  const res = await fetch(url('/overview'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.equal(typeof data.totalSessions, 'number');
  assert.ok((data.totalSessions as number) >= 1);
  assert.equal(typeof data.totalTokensIn, 'number');
  assert.ok(Array.isArray(data.byRepo));
});

test('GET /api/analytics/sessions returns paginated list', async () => {
  const res = await fetch(url('/sessions?limit=10'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.ok(Array.isArray(data.sessions));
  assert.equal(typeof data.total, 'number');
  assert.equal(typeof data.offset, 'number');
  assert.equal(typeof data.limit, 'number');
});

test('GET /api/analytics/sessions/:id returns session detail', async () => {
  const res = await fetch(url('/sessions/sess-1'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;
  assert.ok(data.session);
  assert.ok(data.toolBreakdown);
  assert.ok(Array.isArray(data.events));
  assert.ok(data.engagementBreakdown);
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
  const res = await fetch(url('/tools?days=7'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    tools: Array<{ name: string; totalUses: number; pctOfUses: number }>;
  };
  assert.ok(Array.isArray(data.tools));
  // We seeded 2 tool_use events (Read + Edit)
  assert.ok(data.tools.length >= 1);
});

test('GET /api/analytics/rate-limits returns snapshots', async () => {
  const res = await fetch(url('/rate-limits?hours=24'));
  assert.equal(res.status, 200);
  const data = (await res.json()) as { snapshots: unknown[] };
  assert.ok(Array.isArray(data.snapshots));
  assert.ok(data.snapshots.length >= 1);
});
