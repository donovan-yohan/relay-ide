import { test, beforeAll, afterAll, expect } from 'vitest';
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

beforeAll(async () => {
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
    windows: [
      { name: 'five_hour', usedPercent: 62, resetsAt: '2026-04-01T14:32:00Z', windowMinutes: 300 },
      { name: 'seven_day', usedPercent: 91, resetsAt: '2026-04-03T00:00:00Z', windowMinutes: 10080 },
    ],
    timestamp: new Date().toISOString(),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/analytics', createSessionAnalyticsRouter());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
  closeAnalytics();
  fs.rmSync(tmpDir, { recursive: true });
});

function url(p: string): string {
  return `http://localhost:${port}/api/analytics${p}`;
}

test('GET /api/analytics/overview returns summary', async () => {
  const res = await fetch(url('/overview'));
  expect(res.status).toBe(200);
  const data = (await res.json()) as Record<string, unknown>;
  expect(typeof data.totalSessions).toBe('number');
  expect(data.totalSessions as number).toBeGreaterThanOrEqual(1);
  expect(typeof data.totalTokensIn).toBe('number');
  expect(data.byRepo).toBeInstanceOf(Array);
});

test('GET /api/analytics/sessions returns paginated list', async () => {
  const res = await fetch(url('/sessions?limit=10'));
  expect(res.status).toBe(200);
  const data = (await res.json()) as Record<string, unknown>;
  expect(data.sessions).toBeInstanceOf(Array);
  expect(typeof data.total).toBe('number');
  expect(typeof data.offset).toBe('number');
  expect(typeof data.limit).toBe('number');
});

test('GET /api/analytics/sessions/:id returns session detail', async () => {
  const res = await fetch(url('/sessions/sess-1'));
  expect(res.status).toBe(200);
  const data = (await res.json()) as Record<string, unknown>;
  expect(data.session).toBeTruthy();
  expect(data.toolBreakdown).toBeTruthy();
  expect(data.events).toBeInstanceOf(Array);
  expect(data.engagementBreakdown).toBeTruthy();
});

test('GET /api/analytics/sessions/:id returns 404 for unknown', async () => {
  const res = await fetch(url('/sessions/nonexistent'));
  expect(res.status).toBe(404);
});

test('GET /api/analytics/trends returns daily data', async () => {
  const res = await fetch(url('/trends?days=7'));
  expect(res.status).toBe(200);
  const data = (await res.json()) as Record<string, unknown>;
  expect(data.days).toBeInstanceOf(Array);
});

test('GET /api/analytics/tools returns tool breakdown', async () => {
  const res = await fetch(url('/tools?days=7'));
  expect(res.status).toBe(200);
  const data = (await res.json()) as {
    tools: Array<{ name: string; totalUses: number; pctOfUses: number }>;
  };
  expect(data.tools).toBeInstanceOf(Array);
  // We seeded 2 tool_use events (Read + Edit)
  expect(data.tools.length).toBeGreaterThanOrEqual(1);
});

test('GET /api/analytics/rate-limits returns snapshots', async () => {
  const res = await fetch(url('/rate-limits?hours=24'));
  expect(res.status).toBe(200);
  const data = (await res.json()) as { snapshots: unknown[] };
  expect(data.snapshots).toBeInstanceOf(Array);
  expect(data.snapshots.length).toBeGreaterThanOrEqual(1);
});
