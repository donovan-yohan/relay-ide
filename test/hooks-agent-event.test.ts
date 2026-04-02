import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import http from 'node:http';
import { createHooksRouter } from '../server/hooks.js';
import { initAnalytics, closeAnalytics } from '../server/analytics.js';
import type { Session } from '../server/types.js';

// ---------------------------------------------------------------------------
// Helpers to build minimal stub sessions
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-001',
    type: 'agent',
    agent: 'claude',
    mode: 'pty',
    repoPath: '/repo/test',
    worktreePath: null,
    cwd: '/repo/test',
    repoName: 'test',
    branchName: 'main',
    displayName: 'Agent 1',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    idle: false,
    customCommand: null,
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
    useTmux: false,
    tmuxSessionName: '',
    onPtyReplacedCallbacks: [],
    restored: false,
    outputParser: { feed: () => undefined, reset: () => undefined } as unknown as Session['outputParser'],
    hookToken: 'valid-token',
    hooksActive: true,
    cleanedUp: false,
    yolo: false,
    claudeArgs: [],
    continuePolicy: 'never',
    scrollback: [],
    pty: {} as Session['pty'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmpDir: string;
let server: http.Server;
let port: number;
let sessions: Map<string, Session>;
let broadcastCalls: Array<{ type: string; data?: Record<string, unknown> }>;
let backendStateCalls: Session[];
let attentionCalls: Array<{ sessionId: string; session: { displayName: string; type: string } }>;

function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-event-test-'));
  initAnalytics(tmpDir);

  sessions = new Map();
  broadcastCalls = [];
  backendStateCalls = [];
  attentionCalls = [];

  const app = express();
  // The hooks router mounts its own JSON middleware internally, but we also need
  // to allow the /api/frameworks route body parsing — not needed here but consistent.
  const hooksRouter = createHooksRouter({
    getSession,
    broadcastEvent: (type, data) => broadcastCalls.push({ type, ...(data !== undefined && { data }) }),
    fireBackendStateIfChanged: (s) => backendStateCalls.push(s),
    notifySessionAttention: (sessionId, session) => attentionCalls.push({ sessionId, session }),
  });

  // Mount at /hooks — same as real server
  app.use('/hooks', hooksRouter);

  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(() => {
  server.close();
  closeAnalytics();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function url(p: string): string {
  return `http://127.0.0.1:${port}/hooks${p}`;
}

function clearTracking(): void {
  broadcastCalls.length = 0;
  backendStateCalls.length = 0;
  attentionCalls.length = 0;
}

// ---------------------------------------------------------------------------
// POST /hooks/agent-event — validation tests
// ---------------------------------------------------------------------------

describe('POST /hooks/agent-event — validation', () => {
  it('returns 400 when sessionId is missing', async () => {
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok', eventType: 'session.started' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error, 'should have error message');
  });

  it('returns 400 when token is missing', async () => {
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-001', eventType: 'session.started' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error);
  });

  it('returns 400 when eventType is missing', async () => {
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-001', token: 'tok' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error);
  });

  it('returns 400 when all three required fields are missing', async () => {
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 when sessionId does not match any session', async () => {
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nonexistent', token: 'tok', eventType: 'session.started' }),
    });
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.ok(body.error);
  });

  it('returns 401 when token does not match session hookToken', async () => {
    sessions.set('sess-001', makeSession({ id: 'sess-001', hookToken: 'correct-token' }));
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-001', token: 'wrong-token', eventType: 'session.started' }),
    });
    assert.equal(res.status, 401);
    const body = await res.json() as { error: string };
    assert.ok(body.error);
    sessions.delete('sess-001');
  });
});

// ---------------------------------------------------------------------------
// POST /hooks/agent-event — successful events
// ---------------------------------------------------------------------------

describe('POST /hooks/agent-event — successful events', () => {
  before(() => {
    sessions.set('sess-002', makeSession({ id: 'sess-002', hookToken: 'valid-token-2' }));
  });

  after(() => {
    sessions.delete('sess-002');
  });

  it('returns 204 for a valid generic event', async () => {
    clearTracking();
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-002', token: 'valid-token-2', eventType: 'some.custom.event' }),
    });
    assert.equal(res.status, 204);
  });

  it('maps session.started to processing state', async () => {
    const session = makeSession({ id: 'sess-003', hookToken: 'tok-003', agentState: 'idle' });
    sessions.set('sess-003', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-003', token: 'tok-003', eventType: 'session.started' }),
    });
    assert.equal(res.status, 204);
    assert.equal(session.agentState, 'processing', 'session.started should transition state to processing');
    assert.ok(backendStateCalls.length > 0, 'fireBackendStateIfChanged should have been called');
    sessions.delete('sess-003');
  });

  it('maps session.idle to idle state', async () => {
    const session = makeSession({ id: 'sess-004', hookToken: 'tok-004', agentState: 'processing' });
    sessions.set('sess-004', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-004', token: 'tok-004', eventType: 'session.idle' }),
    });
    assert.equal(res.status, 204);
    assert.equal(session.agentState, 'idle', 'session.idle should transition state to idle');
    sessions.delete('sess-004');
  });

  it('maps session.ended to idle state', async () => {
    const session = makeSession({ id: 'sess-005', hookToken: 'tok-005', agentState: 'processing' });
    sessions.set('sess-005', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-005', token: 'tok-005', eventType: 'session.ended' }),
    });
    assert.equal(res.status, 204);
    assert.equal(session.agentState, 'idle', 'session.ended should transition state to idle');
    sessions.delete('sess-005');
  });

  it('maps permission.requested to permission-prompt state and notifies attention', async () => {
    const session = makeSession({ id: 'sess-006', hookToken: 'tok-006', agentState: 'processing' });
    sessions.set('sess-006', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-006', token: 'tok-006', eventType: 'permission.requested' }),
    });
    assert.equal(res.status, 204);
    assert.equal(session.agentState, 'permission-prompt', 'permission.requested should transition to permission-prompt');
    assert.ok(attentionCalls.length > 0, 'notifySessionAttention should have been called');
    assert.equal(attentionCalls[0]?.sessionId, 'sess-006');
    sessions.delete('sess-006');
  });

  it('maps tool.started to processing state and sets currentActivity', async () => {
    const session = makeSession({ id: 'sess-007', hookToken: 'tok-007', agentState: 'idle' });
    sessions.set('sess-007', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-007',
        token: 'tok-007',
        eventType: 'tool.started',
        data: { tool: 'Read' },
      }),
    });
    assert.equal(res.status, 204);
    assert.equal(session.agentState, 'processing', 'tool.started should transition to processing');
    assert.ok(session.currentActivity, 'currentActivity should be set');
    assert.equal(session.currentActivity?.tool, 'Read');
    sessions.delete('sess-007');
  });

  it('maps tool.finished by clearing currentActivity', async () => {
    const session = makeSession({
      id: 'sess-008',
      hookToken: 'tok-008',
      agentState: 'processing',
      currentActivity: { tool: 'Edit' },
    });
    sessions.set('sess-008', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-008', token: 'tok-008', eventType: 'tool.finished' }),
    });
    assert.equal(res.status, 204);
    assert.equal(session.currentActivity, undefined, 'tool.finished should clear currentActivity');
    sessions.delete('sess-008');
  });

  it('maps prompt.submitted to processing state', async () => {
    const session = makeSession({ id: 'sess-009', hookToken: 'tok-009', agentState: 'idle' });
    sessions.set('sess-009', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-009', token: 'tok-009', eventType: 'prompt.submitted' }),
    });
    assert.equal(res.status, 204);
    assert.equal(session.agentState, 'processing', 'prompt.submitted should transition to processing');
    sessions.delete('sess-009');
  });

  it('maps state.changed with status=error to error state', async () => {
    const session = makeSession({ id: 'sess-010', hookToken: 'tok-010', agentState: 'processing' });
    sessions.set('sess-010', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-010',
        token: 'tok-010',
        eventType: 'state.changed',
        data: { status: 'error' },
      }),
    });
    assert.equal(res.status, 204);
    assert.equal(session.agentState, 'error', 'state.changed with status=error should set error state');
    sessions.delete('sess-010');
  });

  it('accepts optional timestamp field in body', async () => {
    const session = makeSession({ id: 'sess-011', hookToken: 'tok-011' });
    sessions.set('sess-011', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-011',
        token: 'tok-011',
        eventType: 'session.started',
        timestamp: '2026-04-01T00:00:00.000Z',
      }),
    });
    assert.equal(res.status, 204);
    sessions.delete('sess-011');
  });

  it('does not change state for unrecognized eventType', async () => {
    const session = makeSession({ id: 'sess-012', hookToken: 'tok-012', agentState: 'idle' });
    sessions.set('sess-012', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-012', token: 'tok-012', eventType: 'custom.unknown.event' }),
    });
    assert.equal(res.status, 204);
    assert.equal(session.agentState, 'idle', 'unrecognized eventType should not change state');
    sessions.delete('sess-012');
  });
});
