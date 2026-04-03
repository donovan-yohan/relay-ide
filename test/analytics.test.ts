import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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

before(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'claude-remote-cli-analytics-test-')
  );
});

afterEach(() => {
  closeAnalytics();
  // Clean up DB files between tests
  for (const entry of fs.readdirSync(tmpDir)) {
    fs.unlinkSync(path.join(tmpDir, entry));
  }
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

test('initAnalytics creates database and schema', () => {
  initAnalytics(tmpDir);
  const dbPath = getDbPath(tmpDir);
  assert.ok(fs.existsSync(dbPath), 'DB file should exist');

  const db = new Database(dbPath, { readonly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  assert.ok(
    tables.some((t) => t.name === 'events'),
    'events table should exist'
  );
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
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.category, 'session');
  assert.equal(rows[0]!.action, 'created');
  assert.equal(rows[0]!.target, 'session-123');
  assert.equal(rows[0]!.device, 'desktop');

  const props = JSON.parse(rows[0]!.properties as string) as Record<
    string,
    unknown
  >;
  assert.equal(props.workspace, '/proj');
  assert.equal(props.agent, 'claude');
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
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.target, null);
  assert.equal(rows[0]!.properties, null);
  assert.equal(rows[0]!.session_id, null);
  assert.equal(rows[0]!.device, null);
  db.close();
});

test('trackEvent is no-op before initAnalytics', () => {
  // Should not throw
  trackEvent({ category: 'test', action: 'noop' });
});

test('getDbSize returns file size after writes', () => {
  initAnalytics(tmpDir);
  const sizeBefore = getDbSize(tmpDir);
  assert.ok(sizeBefore > 0, 'DB file should have non-zero size after init');

  for (let i = 0; i < 10; i++) {
    trackEvent({ category: 'bulk', action: 'test', properties: { i } });
  }

  const sizeAfter = getDbSize(tmpDir);
  assert.ok(sizeAfter >= sizeBefore, 'Size should grow after writes');
});

test('getDbSize returns 0 for non-existent path', () => {
  assert.equal(getDbSize('/nonexistent/path'), 0);
});

test('initAnalytics is idempotent (schema already exists)', () => {
  initAnalytics(tmpDir);
  trackEvent({ category: 'test', action: 'first' });
  closeAnalytics();

  // Re-init should not throw or lose data
  initAnalytics(tmpDir);
  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const rows = db.prepare('SELECT * FROM events').all();
  assert.equal(rows.length, 1);
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
  assert.equal(data.ok, true);
  assert.equal(data.count, 2);

  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const rows = db.prepare('SELECT * FROM events').all();
  assert.equal(rows.length, 2);
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
  assert.ok(data.bytes > 0);

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
  assert.equal(data.ok, true);

  const db = new Database(getDbPath(tmpDir), { readonly: true });
  const rows = db.prepare('SELECT * FROM events').all();
  assert.equal(rows.length, 0);
  db.close();

  server.close();
});
