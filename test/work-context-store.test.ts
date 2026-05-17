import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createWorkContextRouter,
  createWorkContextStore,
  type WorkContextStore,
} from '../server/work-contexts.js';
import type { SessionSummary } from '../server/types.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';
import { DEFAULT_LOCAL_NODE_ID, createGlobalSessionId } from '../shared/identity.js';
import {
  WORK_CONTEXT_SCHEMA_VERSION,
  createWorkContextPrivacyMetadata,
  type WorkContext,
} from '../shared/work-context.js';

const tmpDirs: string[] = [];

function makeStore(): WorkContextStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-work-context-test-'));
  tmpDirs.push(dir);
  return createWorkContextStore(path.join(dir, 'work-contexts.db'));
}

async function startWorkContextApi(
  store: WorkContextStore,
  sessions: SessionSummary[] = [],
  nodes: HubNodeSummary[] = []
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(
    '/work-contexts',
    createWorkContextRouter({
      store,
      getSessions: () => sessions,
      getNodes: () => nodes,
    })
  );

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind tcp');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function jsonRequest(
  baseUrl: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: object
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    ...(body
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return { status: response.status, body: await response.json() };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  const now = '2026-05-17T08:00:00.000Z';
  const id = overrides.id ?? 'sess-local';
  const nodeId = overrides.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  return {
    id,
    type: 'agent',
    agent: 'claude',
    mode: 'pty',
    repoPath: '/repo/relay-ide',
    worktreePath: null,
    cwd: '/repo/relay-ide',
    repoName: 'relay-ide',
    branchName: 'nightly',
    displayName: 'Agent 1',
    createdAt: now,
    lastActivity: now,
    idle: false,
    customCommand: null,
    nodeId,
    globalSessionId: createGlobalSessionId(nodeId, id),
    status: 'running',
    needsBranchRename: false,
    agentState: 'busy',
    ...overrides,
  } as SessionSummary;
}

function node(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: 'node-remote',
    displayName: 'remote mac mini',
    hostname: 'remote-host',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '0.1.0',
    protocolVersion: '1',
    status: 'online',
    connection: { state: 'connected' },
    trust: { state: 'trusted', level: 'full' },
    credentialState: 'active',
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1',
      hubProtocolVersion: 1,
    },
    capabilities: {
      totals: { available: 0, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        tmux: 'available',
        git: 'available',
        browserAutomation: 'unknown',
        clipboardImage: 'unknown',
        ssh: 'unknown',
        tailscale: 'unknown',
      },
      agents: {},
    },
    createdAt: '2026-05-17T07:00:00.000Z',
    pairedAt: '2026-05-17T07:00:00.000Z',
    lastSeenAt: '2026-05-17T08:00:00.000Z',
    credentialId: 'cred-1',
    ...overrides,
  } as HubNodeSummary;
}

function fullContext(overrides: Partial<WorkContext> = {}): WorkContext {
  const now = '2026-05-17T08:00:00.000Z';
  return {
    schemaVersion: WORK_CONTEXT_SCHEMA_VERSION,
    id: 'wc:test',
    title: 'test context',
    createdAt: now,
    updatedAt: now,
    source: 'vitest',
    anchors: {},
    actors: [],
    tasks: [],
    artifacts: [],
    auditRefs: [],
    capabilityGrants: [],
    privacy: createWorkContextPrivacyMetadata({ retention: 'project' }),
    ...overrides,
  };
}

describe('WorkContext store', () => {
  it('exposes create/read/list/update/link/session association through API routes', async () => {
    const store = makeStore();
    const live = session({ id: 'sess-api-live', cwd: '/tmp/free-live', repoPath: undefined });
    const api = await startWorkContextApi(store, [live], [
      node({ nodeId: 'node-offline', status: 'offline', displayName: 'offline node' }),
    ]);
    try {
      const created = await jsonRequest(api.baseUrl, 'POST', '/work-contexts', {
        id: 'wc:api',
        title: 'API work',
      });
      expect(created.status).toBe(201);
      expect(created.body.workContext.id).toBe('wc:api');

      const listed = await jsonRequest(api.baseUrl, 'GET', '/work-contexts');
      expect(listed.body.workContexts.map((context: WorkContext) => context.id)).toContain(
        'wc:api'
      );

      const updated = await jsonRequest(api.baseUrl, 'PATCH', '/work-contexts/wc:api', {
        title: 'Updated API work',
      });
      expect(updated.body.workContext.title).toBe('Updated API work');

      await jsonRequest(api.baseUrl, 'POST', '/work-contexts', {
        id: 'wc:linked',
        title: 'Linked work',
      });
      const linked = await jsonRequest(api.baseUrl, 'POST', '/work-contexts/wc:api/link', {
        targetContextId: 'wc:linked',
        relationship: 'blocks',
      });
      expect(linked.body.workContext.relatedContextRefs).toContain('wc:linked');

      const liveAssociation = await jsonRequest(
        api.baseUrl,
        'POST',
        '/work-contexts/wc:api/sessions',
        { sessionId: live.id }
      );
      expect(liveAssociation.status).toBe(200);

      const offlineAssociation = await jsonRequest(
        api.baseUrl,
        'POST',
        '/work-contexts/wc:linked/sessions',
        {
          sessionId: 'sess-offline-api',
          nodeId: 'node-offline',
          tabKind: 'agent',
          cwd: '/remote/offline',
        }
      );
      expect(offlineAssociation.status).toBe(200);

      const active = await jsonRequest(api.baseUrl, 'GET', '/work-contexts/active');
      expect(active.status).toBe(200);
      expect(active.body.groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'wc:api',
            staleReadModel: false,
            sessions: [expect.objectContaining({ id: live.id, live: true })],
          }),
          expect.objectContaining({
            id: 'wc:linked',
            staleReadModel: true,
            node: expect.objectContaining({ nodeId: 'node-offline', status: 'offline' }),
            sessions: [expect.objectContaining({ id: 'sess-offline-api', live: false })],
          }),
        ])
      );
    } finally {
      await api.close();
      store.close();
    }
  });

  it('persists create/read/list/update/link records using the shared schema', () => {
    const store = makeStore();
    try {
      const created = store.create({ id: 'wc:one', title: 'One' });
      expect(created.schemaVersion).toBe(WORK_CONTEXT_SCHEMA_VERSION);
      expect(created.privacy.rawPayloadStored).toBe(false);
      expect(store.get('wc:one')?.title).toBe('One');

      const updated = store.update('wc:one', {
        tasks: [
          {
            id: 'task:555',
            kind: 'github-issue',
            url: 'https://github.com/donovan-yohan/relay-ide/issues/555',
            title: '#555 WorkContext persistence',
            privacy: createWorkContextPrivacyMetadata({ retention: 'project' }),
          },
        ],
      });
      expect(updated.tasks).toHaveLength(1);

      store.create({ id: 'wc:two', title: 'Two' });
      const linked = store.linkContexts('wc:one', 'wc:two');
      expect(linked.relatedContextRefs).toContain('wc:two');
      expect(new Set(store.list().map((context) => context.id))).toEqual(
        new Set(['wc:one', 'wc:two'])
      );
    } finally {
      store.close();
    }
  });

  it('rejects raw transcripts/log payloads and raw-payload privacy flags', () => {
    const store = makeStore();
    try {
      expect(() =>
        store.create({
          context: fullContext({
            id: 'wc:bad-raw',
            artifacts: [
              {
                id: 'artifact:bad',
                kind: 'transcript-ref',
                summary: 'bad raw transcript',
                ref: 'file://redacted-pointer',
                privacy: createWorkContextPrivacyMetadata({ retention: 'audit' }),
                rawTranscript: 'terminal bytes should not be persisted',
              } as WorkContext['artifacts'][number],
            ],
          }),
        })
      ).toThrow(/invalid_work_context|raw_payload_not_allowed/);
      expect(() =>
        store.create({
          context: fullContext({
            id: 'wc:bad-privacy',
            privacy: {
              ...createWorkContextPrivacyMetadata({ retention: 'project' }),
              rawPayloadStored: true,
            },
          }),
        })
      ).toThrow(/invalid_work_context|raw_payload_storage_not_allowed/);
    } finally {
      store.close();
    }
  });

  it('groups local sessions by WorkContext without requiring repo-only assumptions', () => {
    const store = makeStore();
    try {
      const context = store.create({ id: 'wc:local', title: 'Local work' });
      const local = session();
      store.associateSession(context.id, { session: local });

      const groups = store.listActiveWork({ sessions: [local], nodes: [] });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.context?.id).toBe('wc:local');
      expect(groups[0]?.node.status).toBe('online');
      expect(groups[0]?.sessions[0]).toMatchObject({
        id: local.id,
        nodeId: DEFAULT_LOCAL_NODE_ID,
        repoPath: '/repo/relay-ide',
        live: true,
      });
    } finally {
      store.close();
    }
  });

  it('groups routed node sessions and reports node state from the hub registry read model', () => {
    const store = makeStore();
    try {
      const context = store.create({ id: 'wc:remote', title: 'Remote work' });
      const remote = session({
        id: 'sess-remote',
        nodeId: 'node-remote',
        globalSessionId: createGlobalSessionId('node-remote', 'sess-remote'),
        cwd: '/Users/agent/project',
        repoPath: '/Users/agent/project',
        worktreePath: null,
        displayName: 'Remote Agent',
      });
      store.associateSession(context.id, { session: remote });

      const groups = store.listActiveWork({
        sessions: [remote],
        nodes: [node({ nodeId: 'node-remote', status: 'online' })],
      });
      expect(groups[0]?.node).toMatchObject({
        nodeId: 'node-remote',
        status: 'online',
        displayName: 'remote mac mini',
      });
      expect(groups[0]?.sessions[0]).toMatchObject({
        id: 'sess-remote',
        live: true,
      });
    } finally {
      store.close();
    }
  });

  it('keeps stale/offline node session refs visible when live session aggregation is empty', () => {
    const store = makeStore();
    try {
      const context = store.create({ id: 'wc:offline', title: 'Offline work' });
      store.associateSession(context.id, {
        sessionRef: {
          nodeId: 'node-offline',
          sessionId: 'sess-old',
          globalSessionId: createGlobalSessionId('node-offline', 'sess-old'),
          tabKind: 'agent',
          cwd: '/remote/worktree',
        },
      });

      const groups = store.listActiveWork({
        sessions: [],
        nodes: [
          node({
            nodeId: 'node-offline',
            displayName: 'offline node',
            status: 'offline',
            lastSeenAt: '2026-05-17T07:00:00.000Z',
          }),
        ],
      });
      expect(groups[0]?.node.status).toBe('offline');
      expect(groups[0]?.staleReadModel).toBe(true);
      expect(groups[0]?.sessions[0]).toMatchObject({
        id: 'sess-old',
        live: false,
        cwd: '/remote/worktree',
      });
    } finally {
      store.close();
    }
  });

  it('includes free/non-git sessions in active work associations and unassigned grouping', () => {
    const store = makeStore();
    try {
      const freeSession = session({
        id: 'sess-free',
        type: 'terminal',
        mode: 'pty',
        repoPath: undefined,
        worktreePath: undefined,
        repoName: undefined,
        branchName: undefined,
        cwd: '/tmp/free-shell',
        displayName: 'Free shell',
        agentState: 'idle',
      });
      const context = store.create({ id: 'wc:free', title: 'Free shell context' });
      store.associateSession(context.id, { session: freeSession });

      const [group] = store.listActiveWork({ sessions: [freeSession], nodes: [] });
      expect(group?.context?.id).toBe('wc:free');
      expect(group?.sessions[0]).toMatchObject({
        id: 'sess-free',
        tabKind: 'terminal',
        cwd: '/tmp/free-shell',
        live: true,
      });
      expect(group?.sessions[0]?.repoPath).toBeUndefined();

      const unassigned = session({ id: 'sess-unassigned', cwd: '/tmp/unassigned' });
      const groups = store.listActiveWork({ sessions: [freeSession, unassigned], nodes: [] });
      expect(groups.some((candidate) => candidate.id.startsWith('unassigned:'))).toBe(true);
    } finally {
      store.close();
    }
  });
});
