import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initAnalytics, closeAnalytics, getDbPath } from '../server/analytics.js';

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
