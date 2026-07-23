import { test, beforeAll, afterEach, afterAll, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

function startServer(cp: string, sessionDeps?: any): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(
      '/workspace-groups',
      createWorkspaceGroupsRouter(cp, noAuth, sessionDeps)
    );
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
  body?: object
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = { method };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${url}`, opts);
  let parsed: any;
  if (res.status !== 204) {
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, body: parsed };
}

async function rawReq(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  rawBody: string
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
  return { status: res.status, body: await res.json() };
}

function fakeSessionDeps() {
  return {
    sessions: {
      create: vi.fn().mockReturnValue({ id: 'sess-1', cwd: tmpDir }),
      list: () => [],
      nextAgentName: () => 'Agent 1',
    },
    gitWatcher: { watchSession: vi.fn() },
    configPath,
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-groups-test-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterAll(async () => {
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
  expect(status).toBe(200);
  expect(body).toEqual([]);
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
  expect(status).toBe(200);
  expect(body.length).toBe(2);
  expect(body[0].id).toBe('id1');
  expect(body[1].id).toBe('id2');
});

test('GET normalizes legacy workspaces without repos', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a'],
    workspaces: [
      { id: 'legacy', name: 'Legacy', order: 0 },
      { id: 'valid', name: 'Valid', repos: ['/a'], order: 1 },
    ],
  });
  await startServer(configPath);
  const { status, body } = await req('GET', '/workspace-groups');
  expect(status).toBe(200);
  expect(body[0]).toMatchObject({ id: 'legacy', repos: [] });
  expect(body[1]).toMatchObject({ id: 'valid', repos: ['/a'] });
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
  expect(status).toBe(201);
  expect(body.id).toBeTypeOf('string');
  expect(body.id.length).toBeGreaterThan(0);
  expect(body.name).toBe('My Workspace');
  expect(body.repos).toEqual(['/a', '/b']);
  expect(body.order).toBe(0);
});

test('POST filters repos against config.repos', async () => {
  writeConfig({ configVersion: 4, repos: ['/a'], workspaces: [] });
  await startServer(configPath);
  const { status, body } = await req('POST', '/workspace-groups', {
    name: 'Filtered',
    repos: ['/a', '/not-in-config'],
  });
  expect(status).toBe(201);
  expect(body.repos).toEqual(['/a']);
});

test('POST rejects empty name', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('POST', '/workspace-groups', { name: '' });
  expect(status).toBe(400);
});

test('POST rejects missing name', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('POST', '/workspace-groups', { repos: [] });
  expect(status).toBe(400);
});

test('POST rejects whitespace-only name', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('POST', '/workspace-groups', { name: '   ' });
  expect(status).toBe(400);
});

test('POST trims name', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status, body } = await req('POST', '/workspace-groups', {
    name: '  Trimmed  ',
  });
  expect(status).toBe(201);
  expect(body.name).toBe('Trimmed');
});

test('POST assigns incrementing order when workspaces already exist', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a'],
    workspaces: [{ id: 'existing', name: 'Existing', repos: [], order: 0 }],
  });
  await startServer(configPath);
  const { status, body } = await req('POST', '/workspace-groups', {
    name: 'New',
    repos: [],
  });
  expect(status).toBe(201);
  expect(body.order).toBe(1);
});

test('POST persists to config file', async () => {
  writeConfig({ configVersion: 4, repos: ['/a'], workspaces: [] });
  await startServer(configPath);
  await req('POST', '/workspace-groups', { name: 'Persistent', repos: ['/a'] });
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(saved.workspaces.length).toBe(1);
  expect(saved.workspaces[0].name).toBe('Persistent');
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
  const { status, body } = await req('PUT', '/workspace-groups/ws-1', {
    name: 'New Name',
  });
  expect(status).toBe(200);
  expect(body.name).toBe('New Name');
  expect(body.id).toBe('ws-1');
});

test('PUT /:id updates workspace repos filtered against config', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a', '/b'],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: ['/a'], order: 0 }],
  });
  await startServer(configPath);
  const { status, body } = await req('PUT', '/workspace-groups/ws-1', {
    repos: ['/b', '/not-here'],
  });
  expect(status).toBe(200);
  expect(body.repos).toEqual(['/b']);
});

test('PUT /:id returns 404 for unknown id', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('PUT', '/workspace-groups/nonexistent', {
    name: 'Test',
  });
  expect(status).toBe(404);
});

test('PUT /:id rejects empty name string', async () => {
  writeConfig({
    configVersion: 4,
    repos: [],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: [], order: 0 }],
  });
  await startServer(configPath);
  const { status } = await req('PUT', '/workspace-groups/ws-1', { name: '' });
  expect(status).toBe(400);
});

test('PUT /:id preserves fields not in the update body', async () => {
  writeConfig({
    configVersion: 4,
    repos: ['/a'],
    workspaces: [
      {
        id: 'ws-1',
        name: 'Ws',
        repos: ['/a'],
        order: 2,
        themeColor: '#ff0000',
      },
    ],
  });
  await startServer(configPath);
  const { status, body } = await req('PUT', '/workspace-groups/ws-1', {
    name: 'Updated',
  });
  expect(status).toBe(200);
  expect(body.themeColor).toBe('#ff0000');
  expect(body.order).toBe(2);
  expect(body.repos).toEqual(['/a']);
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
  expect(status).toBe(204);
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(saved.workspaces.length).toBe(0);
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
  const sorted = [...saved.workspaces].sort(
    (a: any, b: any) => a.order - b.order
  );
  expect(sorted[0].id).toBe('ws-1');
  expect(sorted[0].order).toBe(0);
  expect(sorted[1].id).toBe('ws-3');
  expect(sorted[1].order).toBe(1);
});

test('DELETE /:id returns 404 for unknown id', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('DELETE', '/workspace-groups/nonexistent');
  expect(status).toBe(404);
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
  expect(saved.repos).toEqual(['/a', '/b']);
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
  expect(status).toBe(200);
  expect(body[0].id).toBe('ws-3');
  expect(body[1].id).toBe('ws-1');
  expect(body[2].id).toBe('ws-2');
  expect(body[0].order).toBe(0);
  expect(body[1].order).toBe(1);
  expect(body[2].order).toBe(2);
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
  expect(status).toBe(200);
  expect(body.length).toBe(3);
  expect(body[0].id).toBe('ws-3');
  expect(body[1].id).toBe('ws-1');
  expect(body[2].id).toBe('ws-2');
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
  expect(status).toBe(400);
});

test('PUT /reorder returns 400 when ids is not an array', async () => {
  writeConfig({ configVersion: 4, repos: [], workspaces: [] });
  await startServer(configPath);
  const { status } = await req('PUT', '/workspace-groups/reorder', {
    ids: 'not-an-array',
  });
  expect(status).toBe(400);
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

  expect(ws1.repos).toEqual(['/shared']);
  expect(ws2.repos).toEqual(['/shared']);

  // Verify both stored correctly
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(saved.workspaces.length).toBe(2);
  expect(saved.workspaces.every((w: any) => w.repos.includes('/shared'))).toBe(
    true
  );
});

test('workspace session rejects malformed body and invalid terminal backend', async () => {
  const repoPath = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  writeConfig({
    configVersion: 4,
    repos: [repoPath],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: [repoPath], order: 0 }],
  });
  const sessionDeps = fakeSessionDeps();
  await startServer(configPath, sessionDeps);

  const nullBody = await rawReq('POST', '/workspace-groups/ws-1/session', '[]');
  expect(nullBody.status).toBe(400);
  expect(nullBody.body).toEqual({ error: 'request body must be an object' });

  const invalidBackend = await req('POST', '/workspace-groups/ws-1/session', {
    terminalBackend: 'tmuxx',
  });
  expect(invalidBackend.status).toBe(400);
  expect(invalidBackend.body).toEqual({
    error: 'terminalBackend must be "relay-pty"',
  });
  expect(sessionDeps.sessions.create).not.toHaveBeenCalled();
});

test('workspace session rejects removed terminalBackend', async () => {
  const repoPath = path.join(tmpDir, 'repo-valid');
  fs.mkdirSync(repoPath, { recursive: true });
  writeConfig({
    configVersion: 4,
    repos: [repoPath],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: [repoPath], order: 0 }],
  });
  const sessionDeps = fakeSessionDeps();
  await startServer(configPath, sessionDeps);

  const result = await req('POST', '/workspace-groups/ws-1/session', {
    terminalBackend: 'tmux-compat',
  });
  expect(result.status).toBe(400);
  expect(result.body).toEqual({ error: 'terminalBackend must be "relay-pty"' });
  expect(sessionDeps.sessions.create).not.toHaveBeenCalled();
});

// config.claudeArgs (Claude-only --model/--effort) must not leak into a
// non-claude workspace-group spawn: codex exits code 2 within ~1s otherwise.
test('workspace codex session omits config claudeArgs from spawn args', async () => {
  const repoPath = path.join(tmpDir, 'repo-codex');
  fs.mkdirSync(repoPath, { recursive: true });
  writeConfig({
    configVersion: 4,
    repos: [repoPath],
    claudeArgs: ['--model', 'opus', '--effort', 'high'],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: [repoPath], order: 0 }],
  });
  const sessionDeps = fakeSessionDeps();
  await startServer(configPath, sessionDeps);

  const result = await req('POST', '/workspace-groups/ws-1/session', {
    agent: 'codex',
  });
  expect(result.status).toBe(201);
  expect(sessionDeps.sessions.create).toHaveBeenCalledTimes(1);
  const createParams = sessionDeps.sessions.create.mock.calls[0][0];
  expect(createParams.agent).toBe('codex');
  expect(createParams.args).not.toContain('--model');
  expect(createParams.args).not.toContain('--effort');
  expect(createParams.claudeArgs).not.toContain('--model');
  expect(createParams.claudeArgs).not.toContain('--effort');
});

test('workspace claude session keeps config claudeArgs in spawn args', async () => {
  const repoPath = path.join(tmpDir, 'repo-claude');
  fs.mkdirSync(repoPath, { recursive: true });
  writeConfig({
    configVersion: 4,
    repos: [repoPath],
    claudeArgs: ['--model', 'opus', '--effort', 'high'],
    workspaces: [{ id: 'ws-1', name: 'Ws', repos: [repoPath], order: 0 }],
  });
  const sessionDeps = fakeSessionDeps();
  await startServer(configPath, sessionDeps);

  const result = await req('POST', '/workspace-groups/ws-1/session', {
    agent: 'claude',
  });
  expect(result.status).toBe(201);
  expect(sessionDeps.sessions.create).toHaveBeenCalledTimes(1);
  const createParams = sessionDeps.sessions.create.mock.calls[0][0];
  expect(createParams.agent).toBe('claude');
  expect(createParams.args).toEqual(
    expect.arrayContaining(['--model', 'opus', '--effort', 'high'])
  );
});

// --add-dir is a Claude-only multi-repo flag; it must not leak into a non-claude
// multi-repo workspace-group spawn (#1238, same class as #1237): codex exits
// code 2 within ~1s on the unrecognized flag.
test('workspace codex multi-repo session omits --add-dir from spawn args', async () => {
  const repoA = path.join(tmpDir, 'repo-codex-a');
  const repoB = path.join(tmpDir, 'repo-codex-b');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  writeConfig({
    configVersion: 4,
    repos: [repoA, repoB],
    workspaces: [
      { id: 'ws-1', name: 'Ws', repos: [repoA, repoB], order: 0 },
    ],
  });
  const sessionDeps = fakeSessionDeps();
  await startServer(configPath, sessionDeps);

  const result = await req('POST', '/workspace-groups/ws-1/session', {
    agent: 'codex',
  });
  expect(result.status).toBe(201);
  expect(sessionDeps.sessions.create).toHaveBeenCalledTimes(1);
  const createParams = sessionDeps.sessions.create.mock.calls[0][0];
  expect(createParams.agent).toBe('codex');
  expect(createParams.args).not.toContain('--add-dir');
  expect(createParams.args).not.toContain(repoB);
});

test('workspace claude multi-repo session keeps --add-dir for extra repos', async () => {
  const repoA = path.join(tmpDir, 'repo-claude-a');
  const repoB = path.join(tmpDir, 'repo-claude-b');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  writeConfig({
    configVersion: 4,
    repos: [repoA, repoB],
    workspaces: [
      { id: 'ws-1', name: 'Ws', repos: [repoA, repoB], order: 0 },
    ],
  });
  const sessionDeps = fakeSessionDeps();
  await startServer(configPath, sessionDeps);

  const result = await req('POST', '/workspace-groups/ws-1/session', {
    agent: 'claude',
  });
  expect(result.status).toBe(201);
  expect(sessionDeps.sessions.create).toHaveBeenCalledTimes(1);
  const createParams = sessionDeps.sessions.create.mock.calls[0][0];
  expect(createParams.agent).toBe('claude');
  expect(createParams.args).toEqual(
    expect.arrayContaining(['--add-dir', repoB])
  );
});
