import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import http from 'node:http';
import { createHooksRouter } from '../server/hooks.js';
import { initAnalytics, closeAnalytics } from '../server/analytics.js';
import type { Session } from '../server/types.js';

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
      onData: () => null,
      reset: () => undefined,
    },
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-router-test-'));
  initAnalytics(tmpDir);

  sessions = new Map();
  broadcastCalls = [];
  backendStateCalls = [];
  attentionCalls = [];

  const app = express();
  const hooksRouter = createHooksRouter({
    getSession,
    broadcastEvent: (type, data) =>
      broadcastCalls.push({ type, ...(data !== undefined && { data }) }),
    fireBackendStateIfChanged: (s) => backendStateCalls.push(s),
    notifySessionAttention: (sessionId, session) =>
      attentionCalls.push({ sessionId, session }),
  });

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

beforeEach(() => {
  broadcastCalls.length = 0;
  backendStateCalls.length = 0;
  attentionCalls.length = 0;
});

function url(p: string, sessionId = 'sess-001', token = 'valid-token'): string {
  const qs = new URLSearchParams({ sessionId, token });
  return `http://127.0.0.1:${port}/hooks${p}?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// Token middleware
// ---------------------------------------------------------------------------

describe('hooks router — token middleware', () => {
  it('returns 400 when sessionId is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/stop?token=x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/sessionId/i);
  });

  it('returns 400 when token is missing', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/hooks/stop?sessionId=sess-001`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/token/i);
  });

  it('returns 404 when session does not exist', async () => {
    const res = await fetch(url('/stop', 'nonexistent', 'x'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('returns 403 when token does not match', async () => {
    sessions.set(
      'token-mismatch',
      makeSession({ id: 'token-mismatch', hookToken: 'correct' })
    );
    const res = await fetch(url('/stop', 'token-mismatch', 'wrong'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    sessions.delete('token-mismatch');
  });

  it('allows web sessions to receive hooks', async () => {
    sessions.set(
      'web-session',
      makeSession({
        id: 'web-session',
        mode: 'web',
        hookToken: 'tok',
      })
    );
    const res = await fetch(url('/stop', 'web-session', 'tok'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    sessions.delete('web-session');
  });

  it('uses constant-time token comparison (rejects equal-length mismatches)', async () => {
    sessions.set(
      'prefix-test',
      makeSession({ id: 'prefix-test', hookToken: 'longtoken' })
    );
    const res = await fetch(url('/stop', 'prefix-test', 'longtokeX'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    sessions.delete('prefix-test');
  });
});

// ---------------------------------------------------------------------------
// POST /stop
// ---------------------------------------------------------------------------

describe('POST /hooks/stop', () => {
  it('transitions session to idle state', async () => {
    const session = makeSession({
      id: 'stop-001',
      hookToken: 'tok',
      agentState: 'processing',
    });
    sessions.set('stop-001', session);

    const res = await fetch(url('/stop', 'stop-001', 'tok'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(session.agentState).toBe('idle');
    sessions.delete('stop-001');
  });

  it('fires backend state change', async () => {
    const session = makeSession({
      id: 'stop-002',
      hookToken: 'tok',
      agentState: 'processing',
    });
    sessions.set('stop-002', session);

    await fetch(url('/stop', 'stop-002', 'tok'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(backendStateCalls.length).toBeGreaterThan(0);
    expect(backendStateCalls.some((s) => s.id === 'stop-002')).toBe(true);
    sessions.delete('stop-002');
  });
});

// ---------------------------------------------------------------------------
// POST /notification
// ---------------------------------------------------------------------------

describe('POST /hooks/notification', () => {
  it('maps type=permission_prompt → permission-prompt state and notifies attention', async () => {
    const session = makeSession({
      id: 'notif-001',
      hookToken: 'tok',
      agentState: 'processing',
    });
    sessions.set('notif-001', session);

    const qs = new URLSearchParams({
      sessionId: 'notif-001',
      token: 'tok',
      type: 'permission_prompt',
    });
    const res = await fetch(
      `http://127.0.0.1:${port}/hooks/notification?${qs.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    );

    expect(res.status).toBe(200);
    expect(session.agentState).toBe('permission-prompt');
    expect(attentionCalls.some((c) => c.sessionId === 'notif-001')).toBe(true);
    expect(session.lastAttentionNotifiedAt).toBeGreaterThan(0);
    sessions.delete('notif-001');
  });

  it('maps type=idle_prompt → waiting-for-input state and notifies attention', async () => {
    const session = makeSession({
      id: 'notif-002',
      hookToken: 'tok',
      agentState: 'processing',
    });
    sessions.set('notif-002', session);

    const qs = new URLSearchParams({
      sessionId: 'notif-002',
      token: 'tok',
      type: 'idle_prompt',
    });
    const res = await fetch(
      `http://127.0.0.1:${port}/hooks/notification?${qs.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    );

    expect(res.status).toBe(200);
    expect(session.agentState).toBe('waiting-for-input');
    expect(attentionCalls.some((c) => c.sessionId === 'notif-002')).toBe(true);
    sessions.delete('notif-002');
  });

  it('ignores unknown notification type (no state change)', async () => {
    const session = makeSession({
      id: 'notif-003',
      hookToken: 'tok',
      agentState: 'processing',
    });
    sessions.set('notif-003', session);

    const qs = new URLSearchParams({
      sessionId: 'notif-003',
      token: 'tok',
      type: 'unknown-type',
    });
    const res = await fetch(
      `http://127.0.0.1:${port}/hooks/notification?${qs.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    );

    expect(res.status).toBe(200);
    expect(session.agentState).toBe('processing');
    expect(attentionCalls.some((c) => c.sessionId === 'notif-003')).toBe(false);
    sessions.delete('notif-003');
  });
});

// ---------------------------------------------------------------------------
// POST /prompt-submit (branch-rename trigger lives here)
// ---------------------------------------------------------------------------

describe('POST /hooks/prompt-submit', () => {
  it('transitions to processing state', async () => {
    const session = makeSession({
      id: 'prompt-001',
      hookToken: 'tok',
      agentState: 'idle',
    });
    sessions.set('prompt-001', session);

    const res = await fetch(url('/prompt-submit', 'prompt-001', 'tok'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    expect(res.status).toBe(200);
    expect(session.agentState).toBe('processing');
    sessions.delete('prompt-001');
  });

  it('clears needsBranchRename flag when set (branch rename is triggered)', async () => {
    const session = makeSession({
      id: 'prompt-002',
      hookToken: 'tok',
      needsBranchRename: true,
    });
    sessions.set('prompt-002', session);

    const res = await fetch(url('/prompt-submit', 'prompt-002', 'tok'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'add a feature' }),
    });

    expect(res.status).toBe(200);
    expect(session.needsBranchRename).toBe(false);
    sessions.delete('prompt-002');
  });

  it('leaves needsBranchRename=false untouched when already false', async () => {
    const session = makeSession({
      id: 'prompt-003',
      hookToken: 'tok',
      needsBranchRename: false,
    });
    sessions.set('prompt-003', session);

    await fetch(url('/prompt-submit', 'prompt-003', 'tok'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'no rename' }),
    });

    expect(session.needsBranchRename).toBe(false);
    sessions.delete('prompt-003');
  });
});

// ---------------------------------------------------------------------------
// POST /tool-result — permission-prompt → processing transition
// ---------------------------------------------------------------------------

describe('POST /hooks/tool-result', () => {
  it('clears currentActivity and broadcasts', async () => {
    const session = makeSession({
      id: 'tr-001',
      hookToken: 'tok',
      currentActivity: { tool: 'Edit' },
    });
    sessions.set('tr-001', session);

    const res = await fetch(url('/tool-result', 'tr-001', 'tok'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(session.currentActivity).toBe(undefined);
    expect(
      broadcastCalls.some(
        (c) =>
          c.type === 'session-activity-changed' &&
          (c.data as { sessionId: string } | undefined)?.sessionId === 'tr-001'
      )
    ).toBe(true);
    sessions.delete('tr-001');
  });

  it('transitions permission-prompt → processing on tool completion', async () => {
    const session = makeSession({
      id: 'tr-002',
      hookToken: 'tok',
      agentState: 'permission-prompt',
    });
    sessions.set('tr-002', session);

    await fetch(url('/tool-result', 'tr-002', 'tok'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(session.agentState).toBe('processing');
    sessions.delete('tr-002');
  });
});
