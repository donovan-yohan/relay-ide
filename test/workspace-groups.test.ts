import { test, describe, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import type { Server } from 'node:http';

import { createWorkspaceGroupsRouter } from '../server/workspace-groups.js';

let tmpDir!: string;
let configPath!: string;
let server!: Server;
let baseUrl!: string;

// No-op auth middleware for testing
const noAuth = (_req: any, _res: any, next: any): void => next();

function writeConfig(data: object): void {
  fs.writeFileSync(configPath, JSON.stringify(data), 'utf8');
}

function startServer(cp: string): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/workspace-groups', createWorkspaceGroupsRouter(cp, noAuth));
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}

async function req(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = { method };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${url}`, opts);
  let parsed: any;
  if (res.status !== 204) {
    try { parsed = await res.json(); } catch { parsed = null; }
  }
  return { status: res.status, body: parsed };
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-groups-test-'));
  configPath = path.join(tmpDir, 'config.json');
});

after(async () => {
  await stopServer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await stopServer();
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
});

// ────────────────────────────────────────────────────────────────────────────
// GET /workspace-groups
// ────────────────────────────────────────────────────────────────────────────

test('GET returns empty array when no workspaces', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status, body } = await req('GET', '/workspace-groups');
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test('GET returns workspaces sorted by order', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a', '/b'],
    workspaces: [
      { id: 'id2', name: 'Second', repos: ['/b'], order: 1 },
      { id: 'id1', name: 'First', repos: ['/a'], order: 0 },
    ],
  });
  await startServer(configPath);
  const { status, body } = await req('GET', '/workspace-groups');
  assert.equal(status, 200);
  assert.equal(body.length, 2);
  assert.equal(body[0].id, 'id1');
  assert.equal(body[1].id, 'id2');
});

// ────────────────────────────────────────────────────────────────────────────
// POST /workspace-groups
// ────────────────────────────────────────────────────────────────────────────

test('POST creates a workspace with generated UUID', async () => {
  writeConfig({ configVersion: 4, repos: ['/a', '/b'], workspaces: [] });
  await startServer(configPath);
  const { status, body } = await req('POST', '/workspace-groups', {
    name: 'My Workspace',
    repos: ['/a', '/b'],
  });
  assert.equal(status, 201);
  assert.ok(typeof body.id === 'string' && body.id.length > 0, 'id should be a non-empty string');
  assert.equal(body.name, 'My Workspace');
  assert.deepEqual(body.repos, ['/a', '/b']);
  assert.equal(body.order, 0);
});

test('POST filters repos against config.repos', async () => {
  writeConfig({ configVersion: 4, repos: ['/a'], workspaces: [] });
  await startServer(configPath);
  const { status, body } = await req('POST', '/workspace-groups', {
    name: 'Filtered',
    repos: ['/a', '/not-in-config'],
  });
  assert.equal(status, 201);
  assert.deepEqual(body.repos, ['/a']);
});

test('POST rejects empty name', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('POST', '/workspace-groups', { name: '' });
  assert.equal(status, 400);
});

test('POST rejects missing name', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('POST', '/workspace-groups', { repos: [] });
  assert.equal(status, 400);
});

test('POST rejects whitespace-only name', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('POST', '/workspace-groups', { name: '   ' });
  assert.equal(status, 400);
});

test('POST trims name', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status, body } = await req('POST', '/workspace-groups', { name: '  Trimmed  ' });
  assert.equal(status, 201);
  assert.equal(body.name, 'Trimmed');
});

test('POST assigns incrementing order when workspaces already exist', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a'],
    workspaces: [{ id: 'existing', name: 'Existing', repos: [], order: 0 }],
  });
  await startServer(configPath);
  const { status, body } = await req('POST', '/workspace-groups', { name: 'New', repos: [] });
  assert.equal(status, 201);
  assert.equal(body.order, 1);
});

test('POST persists to config file', async () => {
  writeConfig({ configVersion: 4, repos: ['/a'], workspaces: [] });
  await startServer(configPath);
  await req('POST', '/workspace-groups', { name: 'Persistent', repos: ['/a'] });
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.workspaces.length, 1);
  assert.equal(saved.workspaces[0].name, 'Persistent');
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /workspace-groups/:id
// ────────────────────────────────────────────────────────────────────────────

test('PUT /:id updates workspace name', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a'],
    workspaces: [{ id: 'ws-1', name: 'Old Name', repos: ['/a'], order: 0 }],
  });
  await startServer(configPath);
  const { status, body } = await req('PUT', '/workspace-groups/ws-1', { name: 'New Name' });
  assert.equal(status, 200);
  assert.equal(body.name, 'New Name');
  assert.equal(body.id, 'ws-1');
});

test('PUT /:id updates workspace repos filtered against config', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a', '/b'],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: ['/a'], order: 0 }],
  });
  await startServer(configPath);
  const { status, body } = await req('PUT', '/workspace-groups/ws-1', { repos: ['/b', '/not-here'] });
  assert.equal(status, 200);
  assert.deepEqual(body.repos, ['/b']);
});

test('PUT /:id returns 404 for unknown id', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('PUT', '/workspace-groups/nonexistent', { name: 'Test' });
  assert.equal(status, 404);
});

test('PUT /:id rejects empty name string', async () => {
  writeConfig({
    configVersion: 4,
    repos: [],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: [], order: 0 }],
  });
  await startServer(configPath);
  const { status } = await req('PUT', '/workspace-groups/ws-1', { name: '' });
  assert.equal(status, 400);
});

test('PUT /:id preserves fields not in the update body', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a'],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: ['/a'], order: 2, themeColor: '#ff0000' }],
  });
  await startServer(configPath);
  const { status, body } = await req('PUT', '/workspace-groups/ws-1', { name: 'Updated' });
  assert.equal(status, 200);
  assert.equal(body.themeColor, '#ff0000');
  assert.equal(body.order, 2);
  assert.deepEqual(body.repos, ['/a']);
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /workspace-groups/:id
// ────────────────────────────────────────────────────────────────────────────

test('DELETE /:id removes workspace and returns 204', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a'],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: ['/a'], order: 0 }],
  });
  await startServer(configPath);
  const { status } = await req('DELETE', '/workspace-groups/ws-1');
  assert.equal(status, 204);
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.workspaces.length, 0);
});

test('DELETE /:id re-normalizes order after deletion', async () => {
  writeConfig({
    configVersion: 4,
    repos: [],
    workspaces: [
      { id: 'ws-1', name: 'First', repos: [], order: 0 },
      { id: 'ws-2', name: 'Second', repos: [], order: 1 },
      { id: 'ws-3', name: 'Third', repos: [], order: 2 },
    ],
  });
  await startServer(configPath);
  await req('DELETE', '/workspace-groups/ws-2');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const sorted = [...saved.workspaces].sort((a: any, b: any) => a.order - b.order);
  assert.equal(sorted[0].id, 'ws-1');
  assert.equal(sorted[0].order, 0);
  assert.equal(sorted[1].id, 'ws-3');
  assert.equal(sorted[1].order, 1);
});

test('DELETE /:id returns 404 for unknown id', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('DELETE', '/workspace-groups/nonexistent');
  assert.equal(status, 404);
});

test('DELETE /:id does not remove repos from config', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a', '/b'],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: ['/a', '/b'], order: 0 }],
  });
  await startServer(configPath);
  await req('DELETE', '/workspace-groups/ws-1');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(saved.repos, ['/a', '/b']);
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /workspace-groups/reorder
// ────────────────────────────────────────────────────────────────────────────

test('PUT /reorder reorders workspaces by ids array', async () => {
  writeConfig({
    configVersion: 4,
    repos: [],
    workspaces: [
      { id: 'ws-1', name: 'First', repos: [], order: 0 },
      { id: 'ws-2', name: 'Second', repos: [], order: 1 },
      { id: 'ws-3', name: 'Third', repos: [], order: 2 },
    ],
  });
  await startServer(configPath);
  const { status, body } = await req('PUT', '/workspace-groups/reorder', {
    ids: ['ws-3', 'ws-1', 'ws-2'],
  });
  assert.equal(status, 200);
  assert.equal(body[0].id, 'ws-3');
  assert.equal(body[1].id, 'ws-1');
  assert.equal(body[2].id, 'ws-2');
  assert.equal(body[0].order, 0);
  assert.equal(body[1].order, 1);
  assert.equal(body[2].order, 2);
});

test('PUT /reorder appends missing workspaces at end', async () => {
  writeConfig({
    configVersion: 4,
    repos: [],
    workspaces: [
      { id: 'ws-1', name: 'First', repos: [], order: 0 },
      { id: 'ws-2', name: 'Second', repos: [], order: 1 },
      { id: 'ws-3', name: 'Third', repos: [], order: 2 },
    ],
  });
  await startServer(configPath);
  // Only specify ws-3 and ws-1; ws-2 is omitted
  const { status, body } = await req('PUT', '/workspace-groups/reorder', {
    ids: ['ws-3', 'ws-1'],
  });
  assert.equal(status, 200);
  assert.equal(body.length, 3);
  assert.equal(body[0].id, 'ws-3');
  assert.equal(body[1].id, 'ws-1');
  assert.equal(body[2].id, 'ws-2');
});

test('PUT /reorder returns 400 for unknown ids', async () => {
  writeConfig({
    configVersion: 4,
    repos: [],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: [], order: 0 }],
  });
  await startServer(configPath);
  const { status } = await req('PUT', '/workspace-groups/reorder', {
    ids: ['ws-1', 'nonexistent'],
  });
  assert.equal(status, 400);
});

test('PUT /reorder returns 400 when ids is not an array', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('PUT', '/workspace-groups/reorder', { ids: 'not-an-array' });
  assert.equal(status, 400);
});

// ────────────────────────────────────────────────────────────────────────────
// many-to-many: same repo in multiple workspaces
// ────────────────────────────────────────────────────────────────────────────

test('same repo can appear in multiple workspaces', async () => {
  writeConfig({ configVersion: 4, repos: ['/shared'], workspaces: [] });
  await startServer(configPath);

  const { body: ws1 } = await req('POST', '/workspace-groups', {
    name: 'Workspace A',
    repos: ['/shared'],
  });
  const { body: ws2 } = await req('POST', '/workspace-groups', {
    name: 'Workspace B',
    repos: ['/shared'],
  });

  assert.deepEqual(ws1.repos, ['/shared']);
  assert.deepEqual(ws2.repos, ['/shared']);

  // Verify both stored correctly
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.workspaces.length, 2);
  assert.ok(saved.workspaces.every((w: any) => w.repos.includes('/shared')));
});
