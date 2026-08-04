import { test, beforeAll, afterAll, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  initAnalytics,
  closeAnalytics,
  trackEvent,
  getDbSize,
  getDbPath,
} from '../server/analytics.js';

let tmpDir!: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-analytics-test-'));
});

afterEach(() => {
  closeAnalytics();
  // Clean up DB files between tests
  for (const entry of fs.readdirSync(tmpDir)) {
    fs.unlinkSync(path.join(tmpDir, entry));
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

test('initAnalytics creates database and schema', () => {
  initAnalytics(tmpDir);
  const dbPath = getDbPath(tmpDir);
  expect(fs.existsSync(dbPath)).toBeTruthy();

  const db = new Database(dbPath, { readonly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  expect(tables.some((t) => t.name === 'events')).toBe(true);
  db.close();
});

test('trackEvent inserts a row', () => {
  initAnalytics(tmpDir);

  trackEvent({
    category: 'session',
    action: 'created',
    target: 'session-123',
    properties: { workspace: '/proj', agent: 'claude' },
    session_id: 'session-123',
    device: 'desktop',
  });

  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const rows = db.prepare('SELECT * FROM events').all() as Record<
    string,
    unknown
  >[];
  expect(rows.length).toBe(1);
  expect(rows[0]!.category).toBe('session');
  expect(rows[0]!.action).toBe('created');
  expect(rows[0]!.target).toBe('session-123');
  expect(rows[0]!.device).toBe('desktop');

  const props = JSON.parse(rows[0]!.properties as string) as Record<
    string,
    unknown
  >;
  expect(props.workspace).toBe('/proj');
  expect(props.agent).toBe('claude');
  db.close();
});

test('trackEvent handles optional fields as null', () => {
  initAnalytics(tmpDir);

  trackEvent({ category: 'ui', action: 'click' });

  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const rows = db.prepare('SELECT * FROM events').all() as Record<
    string,
    unknown
  >[];
  expect(rows.length).toBe(1);
  expect(rows[0]!.target).toBe(null);
  expect(rows[0]!.properties).toBe(null);
  expect(rows[0]!.session_id).toBe(null);
  expect(rows[0]!.device).toBe(null);
  db.close();
});

test('trackEvent is no-op before initAnalytics', () => {
  // Should not throw
  trackEvent({ category: 'test', action: 'noop' });
});

test('getDbSize returns file size after writes', () => {
  initAnalytics(tmpDir);
  const sizeBefore = getDbSize(tmpDir);
  expect(sizeBefore).toBeGreaterThan(0);

  for (let i = 0; i < 10; i++) {
    trackEvent({ category: 'bulk', action: 'test', properties: { i } });
  }

  const sizeAfter = getDbSize(tmpDir);
  expect(sizeAfter).toBeGreaterThanOrEqual(sizeBefore);
});

test('getDbSize returns 0 for non-existent path', () => {
  expect(getDbSize('/nonexistent/path')).toBe(0);
});

test('initAnalytics is idempotent (schema already exists)', () => {
  initAnalytics(tmpDir);
  trackEvent({ category: 'test', action: 'first' });
  closeAnalytics();

  // Re-init should not throw or lose data
  initAnalytics(tmpDir);
  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const rows = db.prepare('SELECT * FROM events').all();
  expect(rows.length).toBe(1);
  db.close();
});

// ── Router endpoint tests ──────────────────────────────────────────────
// These test the Express Router in isolation (same pattern as fs-browse.test.ts)

import express from 'express';
import http from 'node:http';
import { createAnalyticsRouter } from '../server/analytics.js';

test('POST /analytics/events batch inserts events', async () => {
  initAnalytics(tmpDir);
  const app = express();
  app.use(express.json());
  app.use('/analytics', createAnalyticsRouter(tmpDir));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/analytics/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: [
        { category: 'ui', action: 'click', target: 'test-btn' },
        { category: 'session', action: 'created' },
      ],
    }),
  });
  const data = (await res.json()) as { ok: boolean; count: number };
  expect(data.ok).toBe(true);
  expect(data.count).toBe(2);

  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const rows = db.prepare('SELECT * FROM events').all();
  expect(rows.length).toBe(2);
  db.close();

  server.close();
});

test('GET /analytics/size returns bytes', async () => {
  initAnalytics(tmpDir);
  const app = express();
  app.use('/analytics', createAnalyticsRouter(tmpDir));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/analytics/size`);
  const data = (await res.json()) as { bytes: number };
  expect(data.bytes).toBeGreaterThan(0);

  server.close();
});

test('DELETE /analytics/events clears all events', async () => {
  initAnalytics(tmpDir);
  trackEvent({ category: 'test', action: 'to-delete' });

  const app = express();
  app.use(express.json());
  app.use('/analytics', createAnalyticsRouter(tmpDir));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://localhost:${port}/analytics/events`, {
    method: 'DELETE',
  });
  const data = (await res.json()) as { ok: boolean };
  expect(data.ok).toBe(true);

  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const rows = db.prepare('SELECT * FROM events').all();
  expect(rows.length).toBe(0);
  db.close();

  server.close();
});
