import { describe, it, beforeAll, afterAll, expect } from 'vitest';
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
    outputParser: {
      feed: () => undefined,
      reset: () => undefined,
    } as unknown as Session['outputParser'],
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
let attentionCalls: Array<{
  sessionId: string;
  session: { displayName: string; type: string };
}>;

function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

beforeAll(async () => {
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
    broadcastEvent: (type, data) =>
      broadcastCalls.push({ type, ...(data !== undefined && { data }) }),
    fireBackendStateIfChanged: (s) => backendStateCalls.push(s),
    notifySessionAttention: (sessionId, session) =>
      attentionCalls.push({ sessionId, session }),
  });

  // Mount at /hooks — same as real server
  app.use('/hooks', hooksRouter);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
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
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('returns 400 when token is missing', async () => {
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-001',
        eventType: 'session.started',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('returns 400 when eventType is missing', async () => {
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-001', token: 'tok' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('returns 400 when all three required fields are missing', async () => {
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when sessionId does not match any session', async () => {
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'nonexistent',
        token: 'tok',
        eventType: 'session.started',
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('returns 401 when token does not match session hookToken', async () => {
    sessions.set(
      'sess-001',
      makeSession({ id: 'sess-001', hookToken: 'correct-token' })
    );
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-001',
        token: 'wrong-token',
        eventType: 'session.started',
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
    sessions.delete('sess-001');
  });
});

// ---------------------------------------------------------------------------
// POST /hooks/agent-event — successful events
// ---------------------------------------------------------------------------

describe('POST /hooks/agent-event — successful events', () => {
  beforeAll(() => {
    sessions.set(
      'sess-002',
      makeSession({ id: 'sess-002', hookToken: 'valid-token-2' })
    );
  });

  afterAll(() => {
    sessions.delete('sess-002');
  });

  it('returns 204 for a valid generic event', async () => {
    clearTracking();
    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-002',
        token: 'valid-token-2',
        eventType: 'some.custom.event',
      }),
    });
    expect(res.status).toBe(204);
  });

  it('maps session.started to processing state', async () => {
    const session = makeSession({
      id: 'sess-003',
      hookToken: 'tok-003',
      agentState: 'idle',
    });
    sessions.set('sess-003', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-003',
        token: 'tok-003',
        eventType: 'session.started',
      }),
    });
    expect(res.status).toBe(204);
    expect(session.agentState).toBe('processing');
    expect(backendStateCalls.length > 0).toBeTruthy();
    sessions.delete('sess-003');
  });

  it('maps session.idle to idle state', async () => {
    const session = makeSession({
      id: 'sess-004',
      hookToken: 'tok-004',
      agentState: 'processing',
    });
    sessions.set('sess-004', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-004',
        token: 'tok-004',
        eventType: 'session.idle',
      }),
    });
    expect(res.status).toBe(204);
    expect(session.agentState).toBe('idle');
    sessions.delete('sess-004');
  });

  it('maps session.ended to idle state', async () => {
    const session = makeSession({
      id: 'sess-005',
      hookToken: 'tok-005',
      agentState: 'processing',
    });
    sessions.set('sess-005', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-005',
        token: 'tok-005',
        eventType: 'session.ended',
      }),
    });
    expect(res.status).toBe(204);
    expect(session.agentState).toBe('idle');
    sessions.delete('sess-005');
  });

  it('maps permission.requested to permission-prompt state and notifies attention', async () => {
    const session = makeSession({
      id: 'sess-006',
      hookToken: 'tok-006',
      agentState: 'processing',
    });
    sessions.set('sess-006', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-006',
        token: 'tok-006',
        eventType: 'permission.requested',
      }),
    });
    expect(res.status).toBe(204);
    expect(session.agentState).toBe('permission-prompt');
    expect(attentionCalls.length > 0).toBeTruthy();
    expect(attentionCalls[0]?.sessionId).toBe('sess-006');
    sessions.delete('sess-006');
  });

  it('maps tool.started to processing state and sets currentActivity', async () => {
    const session = makeSession({
      id: 'sess-007',
      hookToken: 'tok-007',
      agentState: 'idle',
    });
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
    expect(res.status).toBe(204);
    expect(session.agentState).toBe('processing');
    expect(session.currentActivity).toBeTruthy();
    expect(session.currentActivity?.tool).toBe('Read');
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
      body: JSON.stringify({
        sessionId: 'sess-008',
        token: 'tok-008',
        eventType: 'tool.finished',
      }),
    });
    expect(res.status).toBe(204);
    expect(session.currentActivity).toBe(undefined);
    sessions.delete('sess-008');
  });

  it('maps prompt.submitted to processing state', async () => {
    const session = makeSession({
      id: 'sess-009',
      hookToken: 'tok-009',
      agentState: 'idle',
    });
    sessions.set('sess-009', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-009',
        token: 'tok-009',
        eventType: 'prompt.submitted',
      }),
    });
    expect(res.status).toBe(204);
    expect(session.agentState).toBe('processing');
    sessions.delete('sess-009');
  });

  it('maps state.changed with status=error to error state', async () => {
    const session = makeSession({
      id: 'sess-010',
      hookToken: 'tok-010',
      agentState: 'processing',
    });
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
    expect(res.status).toBe(204);
    expect(session.agentState).toBe('error');
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
    expect(res.status).toBe(204);
    sessions.delete('sess-011');
  });

  it('does not change state for unrecognized eventType', async () => {
    const session = makeSession({
      id: 'sess-012',
      hookToken: 'tok-012',
      agentState: 'idle',
    });
    sessions.set('sess-012', session);
    clearTracking();

    const res = await fetch(url('/agent-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-012',
        token: 'tok-012',
        eventType: 'custom.unknown.event',
      }),
    });
    expect(res.status).toBe(204);
    expect(session.agentState).toBe('idle');
    sessions.delete('sess-012');
  });
});
