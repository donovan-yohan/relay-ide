import express from 'express';
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAgentRosterRouter,
  type RosterPresencePort,
} from '../server/features/agent-roster-router.js';
import type { RosterSessionInput } from '../shared/agent-roster.js';
import type { AgentPresence } from '../shared/agent-presence.js';

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

async function post(
  route: string,
  body: unknown,
  caps = 'context:write'
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (caps) headers['x-relay-capabilities'] = caps;
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** In-memory presence port: exercises the router's body→port + error mapping. */
function fakePresencePort(seed: AgentPresence[] = []): RosterPresencePort & {
  records: AgentPresence[];
} {
  const records = [...seed];
  return {
    records,
    register(input) {
      const record: AgentPresence = {
        id: 'pres:test',
        registeredBy: String(input['registeredBy'] ?? ''),
        createdAt: '2026-06-13T03:59:00.000Z',
        updatedAt: '2026-06-13T03:59:30.000Z',
        expiresAt: '2026-06-13T05:00:00.000Z',
        ...(typeof input['role'] === 'string'
          ? { role: input['role'] as AgentPresence['role'] }
          : {}),
        ...(typeof input['useCase'] === 'string'
          ? { useCase: input['useCase'] as string }
          : {}),
      };
      records.push(record);
      return record;
    },
    updateSelf(input) {
      const found = records.find((r) => r.id === input['id']);
      if (!found) {
        const err = Object.assign(new Error('not found'), {
          status: 404,
          code: 'agent_presence_not_found',
        });
        throw err;
      }
      return found;
    },
    list() {
      return records;
    },
  };
}

async function remount(
  overrides: Partial<Parameters<typeof createAgentRosterRouter>[0]>
): Promise<void> {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve()
  );
  await mount(overrides);
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

describe('agent roster presence overlay (#964)', () => {
  it('registers self-declared presence under context:write', async () => {
    const port = fakePresencePort();
    await remount({ presence: port });
    const { status, body } = await post('/roster/register', {
      createdBy: 'actor:claude-1',
      globalSessionId: 'node-a:sess-claude',
      role: 'reviewer',
      useCase: 'reviewing #964',
    });
    expect(status).toBe(200);
    expect(body.presence).toMatchObject({
      id: 'pres:test',
      registeredBy: 'actor:claude-1',
      role: 'reviewer',
    });
    expect(port.records).toHaveLength(1);
  });

  it('rejects presence writes without the context:write capability', async () => {
    await remount({ presence: fakePresencePort() });
    const { status, body } = await post(
      '/roster/register',
      { createdBy: 'a' },
      'session:read'
    );
    expect(status).toBe(403);
    expect(body.error).toMatchObject({
      code: 'FORBIDDEN',
      details: { capability: 'context:write' },
    });
  });

  it('fails closed (503) when no presence store is wired', async () => {
    await remount({});
    const { status, body } = await post('/roster/register', { createdBy: 'a' });
    expect(status).toBe(503);
    expect(body.error).toMatchObject({ code: 'SERVER_UNAVAILABLE' });
  });

  it('maps a store NOT_FOUND into a gateway NOT_FOUND on update-self', async () => {
    await remount({ presence: fakePresencePort() });
    const { status, body } = await post('/roster/update-self', {
      createdBy: 'actor:claude-1',
      id: 'pres:missing',
    });
    expect(status).toBe(404);
    expect(body.error).toMatchObject({
      code: 'NOT_FOUND',
      details: { reasonCode: 'agent_presence_not_found' },
    });
  });

  it('merges self-declared presence into the derived roster', async () => {
    const port = fakePresencePort([
      // overlay onto the live claude session
      {
        id: 'pres:claude',
        registeredBy: 'actor:claude-1',
        globalSessionId: 'node-a:sess-claude',
        role: 'orchestrator',
        useCase: 'driving the lane',
        capabilityHints: ['web-sessions'],
        createdAt: '2026-06-13T03:00:00.000Z',
        updatedAt: '2026-06-13T03:30:00.000Z',
        expiresAt: '2026-06-13T05:00:00.000Z',
      },
      // self-declared-only external agent (no live session)
      {
        id: 'pres:ext',
        registeredBy: 'actor:ext-1',
        sessionId: 'external-hermes',
        provider: 'hermes',
        displayName: 'Hermes orchestrator',
        repoPath: '/home/u/relay-ide',
        workContextId: 'wc:1',
        createdAt: '2026-06-13T03:00:00.000Z',
        updatedAt: '2026-06-13T03:45:00.000Z',
        expiresAt: '2026-06-13T05:00:00.000Z',
      },
    ]);
    await remount({ presence: port });
    const { body } = await get('/roster');
    const byId = Object.fromEntries(
      body.roster.map((e: any) => [e.sessionId, e])
    );
    // merged entry: derived identity kept, soft overlay applied
    expect(byId['sess-claude']).toMatchObject({
      origin: 'merged',
      provider: 'claude',
      role: 'orchestrator',
      controlMode: 'agent-driven',
    });
    expect(byId['sess-claude'].capabilities).toContain('web-sessions');
    expect(byId['sess-claude'].selfDeclared).toMatchObject({
      presenceId: 'pres:claude',
      useCase: 'driving the lane',
    });
    // synthesized self-declared external agent surfaces in the roster
    expect(byId['external-hermes']).toMatchObject({
      origin: 'self-declared',
      provider: 'hermes',
      role: 'orchestrator',
      displayName: 'Hermes orchestrator',
    });
  });

  it('drops expired presence from the merged roster', async () => {
    const port = fakePresencePort([
      {
        id: 'pres:stale',
        registeredBy: 'actor:ext-1',
        sessionId: 'ghost-agent',
        provider: 'codex',
        createdAt: '2026-06-13T01:00:00.000Z',
        updatedAt: '2026-06-13T01:30:00.000Z',
        expiresAt: '2026-06-13T02:00:00.000Z', // before the router's frozen now
      },
    ]);
    await remount({ presence: port });
    const { body } = await get('/roster');
    expect(
      body.roster.map((e: any) => e.sessionId)
    ).not.toContain('ghost-agent');
  });
});
