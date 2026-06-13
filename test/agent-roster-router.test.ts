import express from 'express';
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentRosterRouter } from '../server/features/agent-roster-router.js';
import type { RosterSessionInput } from '../shared/agent-roster.js';

let server: http.Server | undefined;
let baseUrl = '';

const SESSIONS: RosterSessionInput[] = [
  {
    id: 'sess-claude',
    globalSessionId: 'node-a:sess-claude',
    nodeId: 'node-a',
    agent: 'claude',
    type: 'agent',
    displayName: 'Claude impl',
    repoPath: '/home/u/relay-ide',
    repoName: 'relay-ide',
    branchName: 'feat/x',
    cwd: '/home/u/relay-ide',
    workContextId: 'wc:1',
    controlMode: 'agent-driven',
    status: 'active',
    agentState: 'permission-prompt',
    lastActivity: '2026-06-13T03:00:00.000Z',
  },
  {
    id: 'sess-codex',
    globalSessionId: 'node-a:sess-codex',
    nodeId: 'node-a',
    agent: 'codex',
    type: 'agent',
    displayName: 'Codex review',
    repoPath: '/home/u/relay-ide',
    repoName: 'relay-ide',
    workContextId: 'wc:2',
    controlMode: 'agent-driven',
    status: 'active',
    agentState: 'idle',
    lastActivity: '2026-06-13T02:00:00.000Z',
  },
  {
    id: 'sess-shell',
    globalSessionId: 'node-a:sess-shell',
    nodeId: 'node-a',
    agent: 'terminal',
    type: 'terminal',
    displayName: 'a shell',
    repoPath: '/home/u/other-repo',
    repoName: 'other-repo',
    status: 'active',
    agentState: 'idle',
    lastActivity: '2026-06-13T01:00:00.000Z',
  },
];

// One open inbox message targets the codex session → pending-inbox attention.
const PENDING: Record<string, number> = { 'node-a:sess-codex': 2 };

async function mount(
  overrides: Partial<Parameters<typeof createAgentRosterRouter>[0]> = {}
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    createAgentRosterRouter({
      requireAuth: (_req, _res, next) => next(),
      listSessions: () => SESSIONS,
      resolveCapabilities: (agent) =>
        agent === 'claude' ? ['hooks', 'continue'] : [],
      pendingInboxCount: (session) =>
        PENDING[session.globalSessionId ?? ''] ?? 0,
      nodeId: 'node-a',
      now: () => new Date('2026-06-13T04:00:00.000Z'),
      ...overrides,
    })
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      if (!addr || typeof addr === 'string')
        throw new Error('missing server address');
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

async function get(
  route: string,
  caps = 'session:read'
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (caps) headers['x-relay-capabilities'] = caps;
  const res = await fetch(`${baseUrl}${route}`, { method: 'GET', headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

beforeEach(async () => {
  await mount();
});

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve()
  );
  server = undefined;
});

describe('agent roster router', () => {
  it('returns a derived, role-mapped roster for active agents (terminals excluded by default)', async () => {
    const { status, body } = await get('/roster');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      count: 2,
      nodeId: 'node-a',
      generatedAt: '2026-06-13T04:00:00.000Z',
    });
    const byId = Object.fromEntries(
      body.roster.map((e: any) => [e.sessionId, e])
    );
    expect(byId['sess-claude']).toMatchObject({
      provider: 'claude',
      role: 'implementer',
      capabilities: ['hooks', 'continue'],
      controlMode: 'agent-driven',
    });
    expect(byId['sess-codex']).toMatchObject({
      provider: 'codex',
      role: 'reviewer',
    });
    expect(byId['sess-shell']).toBeUndefined();
  });

  it('includes terminals when asked', async () => {
    const { body } = await get('/roster?includeTerminals=true');
    expect(body.count).toBe(3);
    expect(body.roster.map((e: any) => e.sessionId)).toContain('sess-shell');
  });

  it('derives attention from agentState and pending inbox backlog', async () => {
    const { body } = await get('/roster');
    const byId = Object.fromEntries(
      body.roster.map((e: any) => [e.sessionId, e])
    );
    expect(byId['sess-claude'].attention).toMatchObject({
      needsAttention: true,
      reasons: ['permission-prompt'],
    });
    expect(byId['sess-codex'].attention).toMatchObject({
      needsAttention: true,
      pendingInboxCount: 2,
      reasons: ['pending-inbox'],
    });
  });

  it('sorts attention-needing entries first', async () => {
    const { body } = await get('/roster?includeTerminals=true');
    const byId = body.roster.map((entry: any) => entry.sessionId);
    expect(byId.indexOf('sess-claude')).toBeLessThan(
      byId.indexOf('sess-shell')
    );
    expect(byId.indexOf('sess-codex')).toBeLessThan(byId.indexOf('sess-shell'));
    expect(body.roster.at(-1).attention.needsAttention).toBe(false);
  });

  it('scopes by workContextId, repo, provider, role, and needsAttention', async () => {
    expect(
      (await get('/roster?workContextId=wc:1')).body.roster.map(
        (e: any) => e.sessionId
      )
    ).toEqual(['sess-claude']);
    expect((await get('/roster?repo=relay-ide')).body.count).toBe(2);
    expect(
      (
        await get('/roster?repo=other-repo&includeTerminals=true')
      ).body.roster.map((e: any) => e.sessionId)
    ).toEqual(['sess-shell']);
    expect(
      (await get('/roster?provider=codex')).body.roster.map(
        (e: any) => e.sessionId
      )
    ).toEqual(['sess-codex']);
    expect(
      (await get('/roster?role=Reviewer')).body.roster.map(
        (e: any) => e.sessionId
      )
    ).toEqual(['sess-codex']);
    expect((await get('/roster?needsAttention=false')).body.count).toBe(0);
  });

  it('matches Windows-style repo path suffixes', async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve()
    );
    await mount({
      listSessions: () => [
        {
          id: 'sess-windows',
          globalSessionId: 'node-a:sess-windows',
          nodeId: 'node-a',
          agent: 'codex',
          type: 'agent',
          displayName: 'Windows Codex review',
          repoPath: 'C:\\Users\\u\\windows-repo',
          repoName: 'windows-repo',
          status: 'active',
          agentState: 'idle',
          lastActivity: '2026-06-13T00:30:00.000Z',
        },
      ],
    });
    expect(
      (await get('/roster?repo=windows-repo')).body.roster.map(
        (e: any) => e.sessionId
      )
    ).toEqual(['sess-windows']);
  });

  it('fails closed when the session:read capability header is missing', async () => {
    const { status, body } = await get('/roster', 'context:read');
    expect(status).toBe(403);
    expect(body.error).toMatchObject({
      code: 'FORBIDDEN',
      details: { capability: 'session:read' },
    });
  });

  it('never serializes transcript/prompt/env/token material', async () => {
    const { body } = await get('/roster?includeTerminals=true');
    const serialized = JSON.stringify(body);
    // Quoted-key form avoids false positives on values like "permission-prompt".
    for (const forbidden of [
      '"transcript"',
      '"prompt"',
      '"apiKey"',
      '"env"',
      '"token"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('returns 503 fail-closed when the session read model throws', async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve()
    );
    await mount({
      listSessions: () => {
        throw new Error('registry down');
      },
    });
    const { status, body } = await get('/roster');
    expect(status).toBe(503);
    expect(body.error).toMatchObject({ code: 'SERVER_UNAVAILABLE' });
  });
});
