import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createWorkContextRouter,
  createWorkContextStore,
  initWorkContextStoreBestEffort,
  type WorkContextStore,
} from '../server/work-contexts.js';
import type { SessionSummary } from '../server/types.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
} from '../shared/identity.js';
import {
  WORK_CONTEXT_SCHEMA_VERSION,
  createWorkContextPrivacyMetadata,
  type WorkContext,
} from '../shared/work-context.js';

const tmpDirs: string[] = [];

function makeStoreHandle(): { store: WorkContextStore; dbPath: string } {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-work-context-test-')
  );
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'work-contexts.db');
  return { store: createWorkContextStore(dbPath), dbPath };
}

function makeStore(): WorkContextStore {
  return makeStoreHandle().store;
}

describe('work-context store boot fallback', () => {
  it('degrades to an unavailable store when sqlite initialization fails', () => {
    const store = initWorkContextStoreBestEffort('/tmp/relay-config', () => {
      throw new Error('Module did not self-register');
    });

    expect(store.list()).toEqual([]);
    expect(store.get('wc:missing')).toBeNull();
    expect(
      store.listActiveWork({ sessions: [], nodes: [] })
    ).toEqual([]);
    expect(() => store.create({ id: 'wc:fallback' })).toThrow(
      'work_context_store_unavailable'
    );
  });
});

function replacePersistedContextJson(
  dbPath: string,
  id: string,
  context: Record<string, unknown>
): void {
  replacePersistedContextJsonRaw(dbPath, id, JSON.stringify(context));
}

function replacePersistedContextJsonRaw(
  dbPath: string,
  id: string,
  contextJson: string
): void {
  const db = new Database(dbPath);
  try {
    db.prepare('UPDATE work_contexts SET context_json = ? WHERE id = ?').run(
      contextJson,
      id
    );
  } finally {
    db.close();
  }
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
  if (!address || typeof address === 'string')
    throw new Error('server did not bind tcp');
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
  it('filters list by workspace before applying limit', () => {
    const { store, dbPath } = makeStoreHandle();
    try {
      store.create({
        context: fullContext({
          id: 'wc:target',
          updatedAt: '2026-05-17T08:00:00.000Z',
          anchors: { project: { workspaceId: 'ws-target' } },
        }),
      });
      store.create({
        context: fullContext({
          id: 'wc:derived-default',
          updatedAt: '2026-05-17T08:01:00.000Z',
          anchors: {},
        }),
      });
      for (let i = 0; i < 5; i += 1) {
        store.create({
          context: fullContext({
            id: `wc:other-${i}`,
            updatedAt: `2026-05-17T08:1${i}:00.000Z`,
            anchors: { project: { workspaceId: 'ws-other' } },
          }),
        });
      }
      store.create({
        context: fullContext({
          id: 'wc:corrupt',
          updatedAt: '2026-05-17T08:20:00.000Z',
          anchors: { project: { workspaceId: 'ws-target' } },
        }),
      });
      replacePersistedContextJsonRaw(dbPath, 'wc:corrupt', '{');

      expect(
        store.list({ workspaceId: 'ws-target', limit: 1 }).map((ctx) => ctx.id)
      ).toEqual(['wc:target']);
      expect(
        store.list({ workspaceId: 'ws:derived', limit: 1 }).map((ctx) => ctx.id)
      ).toEqual(['wc:derived-default']);
    } finally {
      store.close();
    }
  });

  it('exposes create/read/list/update/link/session association through API routes', async () => {
    const store = makeStore();
    const live = session({
      id: 'sess-api-live',
      cwd: '/tmp/free-live',
      repoPath: undefined,
    });
    const api = await startWorkContextApi(
      store,
      [live],
      [
        node({
          nodeId: 'node-offline',
          status: 'offline',
          displayName: 'offline node',
        }),
      ]
    );
    try {
      const created = await jsonRequest(api.baseUrl, 'POST', '/work-contexts', {
        id: 'wc:api',
        title: 'API work',
      });
      expect(created.status).toBe(201);
      expect(created.body.workContext.id).toBe('wc:api');

      const listed = await jsonRequest(api.baseUrl, 'GET', '/work-contexts');
      expect(
        listed.body.workContexts.map((context: WorkContext) => context.id)
      ).toContain('wc:api');

      const updated = await jsonRequest(
        api.baseUrl,
        'PATCH',
        '/work-contexts/wc:api',
        {
          title: 'Updated API work',
        }
      );
      expect(updated.body.workContext.title).toBe('Updated API work');

      await jsonRequest(api.baseUrl, 'POST', '/work-contexts', {
        id: 'wc:linked',
        title: 'Linked work',
      });
      const linked = await jsonRequest(
        api.baseUrl,
        'POST',
        '/work-contexts/wc:api/link',
        {
          targetContextId: 'wc:linked',
          relationship: 'blocks',
        }
      );
      expect(linked.body.workContext.relatedContextRefs).toContain('wc:linked');

      const selfLink = await jsonRequest(
        api.baseUrl,
        'POST',
        '/work-contexts/wc:api/link',
        {
          targetContextId: 'wc:api',
        }
      );
      expect(selfLink.status).toBe(400);
      expect(selfLink.body.error).toBe('work_context_self_link_not_allowed');

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

      const active = await jsonRequest(
        api.baseUrl,
        'GET',
        '/work-contexts/active'
      );
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
            node: expect.objectContaining({
              nodeId: 'node-offline',
              status: 'offline',
            }),
            sessions: [
              expect.objectContaining({ id: 'sess-offline-api', live: false }),
            ],
          }),
        ])
      );
    } finally {
      await api.close();
      store.close();
    }
  });

  it('matches live session associations by nodeId when supplied', async () => {
    const store = makeStore();
    const local = session({
      id: 'shared-session-id',
      nodeId: DEFAULT_LOCAL_NODE_ID,
    });
    const remote = session({
      id: 'shared-session-id',
      nodeId: 'node-remote',
      globalSessionId: createGlobalSessionId(
        'node-remote',
        'shared-session-id'
      ),
      cwd: '/remote/cwd',
      displayName: 'Remote collision session',
    });
    const api = await startWorkContextApi(store, [local, remote]);
    try {
      await jsonRequest(api.baseUrl, 'POST', '/work-contexts', {
        id: 'wc:node-match',
        title: 'Node match',
      });
      const associated = await jsonRequest(
        api.baseUrl,
        'POST',
        '/work-contexts/wc:node-match/sessions',
        { sessionId: 'shared-session-id', nodeId: 'node-remote' }
      );

      expect(associated.status).toBe(200);
      expect(associated.body.workContext.anchors.session).toMatchObject({
        nodeId: 'node-remote',
        cwd: '/remote/cwd',
      });
    } finally {
      await api.close();
      store.close();
    }
  });

  it('creates handoff contexts from task refs and exposes compact resume refs', async () => {
    const store = makeStore();
    const pairSession = session({
      id: 'pair-1',
      nodeId: 'node-remote',
      globalSessionId: createGlobalSessionId('node-remote', 'pair-1'),
      agent: 'codex',
      cwd: '/remote/relay-ide/.worktrees/560-pair-handoff',
      controlMode: 'co-driven',
      displayName: 'Pair session',
    });
    const api = await startWorkContextApi(store, [pairSession], [node({ nodeId: 'node-remote' })]);
    try {
      const created = await jsonRequest(api.baseUrl, 'POST', '/work-contexts/from-task-ref', {
        id: 'wc:handoff',
        title: 'Pair handoff',
        source: 'assistant',
        taskRef: {
          kind: 'github-issue',
          id: '560',
          title: 'assistant-to-pair-session handoff',
          url: 'https://github.com/donovan-yohan/relay-ide/issues/560',
          privacy: createWorkContextPrivacyMetadata({ retention: 'project' }),
        },
        actors: [
          {
            kind: 'agent',
            id: 'assistant:kani',
            displayName: 'Kani backend',
          },
        ],
      });
      expect(created.status).toBe(201);
      expect(created.body.workContext.tasks).toHaveLength(1);
      expect(created.body.workContext.auditRefs).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'handoff.created' })])
      );

      const associated = await jsonRequest(
        api.baseUrl,
        'POST',
        '/work-contexts/wc:handoff/sessions',
        { sessionId: 'pair-1', nodeId: 'node-remote' }
      );
      expect(associated.status).toBe(200);
      expect(associated.body.workContext.anchors.session).toMatchObject({
        nodeId: 'node-remote',
        sessionId: 'pair-1',
        agent: 'codex',
        controlMode: 'co-driven',
        cwd: '/remote/relay-ide/.worktrees/560-pair-handoff',
      });

      const event = await jsonRequest(api.baseUrl, 'POST', '/work-contexts/wc:handoff/events', {
        type: 'summary.recorded',
        actorId: 'assistant:kani',
        summary: 'implementation is ready for pair resume; raw transcript omitted',
        artifacts: [
          {
            id: 'artifact:diff-summary',
            kind: 'report',
            title: 'Diff summary',
            summary: 'server/work-contexts.ts adds compact resume refs',
            privacy: createWorkContextPrivacyMetadata({ retention: 'project' }),
          },
        ],
      });
      expect(event.status).toBe(201);

      const resume = await jsonRequest(api.baseUrl, 'GET', '/work-contexts/wc:handoff/resume');
      expect(resume.status).toBe(200);
      expect(resume.body.resume).toMatchObject({
        workContext: {
          id: 'wc:handoff',
          tasks: [expect.objectContaining({ id: '560', kind: 'github-issue' })],
        },
        node: expect.objectContaining({ nodeId: 'node-remote', status: 'online' }),
        sessions: [
          expect.objectContaining({
            id: 'pair-1',
            nodeId: 'node-remote',
            agent: 'codex',
            controlMode: 'co-driven',
            live: true,
          }),
        ],
        privacy: {
          mode: 'compact-refs',
          rawPayloadAvailable: false,
          transcriptExportAvailable: false,
          rawTranscriptIncluded: false,
        },
      });
      expect(resume.body.resume.artifacts).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'artifact:diff-summary' })])
      );
      expect(resume.body.resume.auditRefs).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'session.associated' })])
      );
      expect(JSON.stringify(resume.body.resume)).not.toContain('terminalTranscript');
      expect(JSON.stringify(resume.body.resume)).not.toContain('providerToken');
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
                privacy: createWorkContextPrivacyMetadata({
                  retention: 'audit',
                }),
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

  it('canonicalizes persisted contexts to the shared WorkContext schema', () => {
    const store = makeStore();
    try {
      const created = store.create({
        context: fullContext({
          id: 'wc:canonical',
          anchors: {
            node: {
              nodeId: 'node-remote',
              kind: 'remote',
              displayName: 'Remote node',
              messages: ['hidden node payload'],
            } as WorkContext['anchors']['node'],
          },
          artifacts: [
            {
              id: 'artifact:summary',
              kind: 'report',
              summary: 'safe summary',
              privacy: createWorkContextPrivacyMetadata({
                retention: 'project',
              }),
              messages: ['raw terminal transcript can hide here'],
            } as WorkContext['artifacts'][number],
          ],
          messages: ['raw terminal transcript can hide here'],
        } as Partial<WorkContext>),
      });

      const reloaded = store.get('wc:canonical') as WorkContext;
      expect(
        (created as WorkContext & { messages?: unknown }).messages
      ).toBeUndefined();
      expect(
        (reloaded as WorkContext & { messages?: unknown }).messages
      ).toBeUndefined();
      expect(
        (
          reloaded.anchors.node as WorkContext['anchors']['node'] & {
            messages?: unknown;
          }
        ).messages
      ).toBeUndefined();
      expect(
        (
          reloaded.artifacts[0] as WorkContext['artifacts'][number] & {
            messages?: unknown;
          }
        ).messages
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('canonicalizes stale context_json rows on read and drops raw payload rows from API responses', async () => {
    const { store, dbPath } = makeStoreHandle();
    const live = session({
      id: 'sess-stale-row',
      nodeId: 'node-remote',
      globalSessionId: createGlobalSessionId('node-remote', 'sess-stale-row'),
      cwd: '/remote/project',
      repoPath: undefined,
      worktreePath: undefined,
      repoName: undefined,
      branchName: undefined,
    });
    const api = await startWorkContextApi(
      store,
      [live],
      [
        node({
          nodeId: 'node-remote',
          status: 'online',
          displayName: 'remote node',
        }),
      ]
    );
    try {
      store.create({ id: 'wc:stale-canonical', title: 'Stale canonical row' });
      store.associateSession('wc:stale-canonical', { session: live });
      replacePersistedContextJson(dbPath, 'wc:stale-canonical', {
        ...fullContext({
          id: 'wc:stale-canonical',
          title: 'Stale canonical row',
          anchors: {
            node: {
              nodeId: 'node-remote',
              kind: 'remote',
              displayName: 'remote node',
              debugPayload: 'hidden node payload must not leave the read path',
            } as WorkContext['anchors']['node'],
            session: {
              nodeId: 'node-remote',
              sessionId: live.id,
              globalSessionId: live.globalSessionId,
              tabKind: 'agent',
              cwd: live.cwd,
              debugPayload:
                'hidden session payload must not leave the read path',
            } as WorkContext['anchors']['session'],
          },
          artifacts: [
            {
              id: 'artifact:stale-summary',
              kind: 'report',
              summary: 'safe stale summary',
              privacy: createWorkContextPrivacyMetadata({
                retention: 'project',
              }),
              debugPayload:
                'hidden artifact payload must not leave the read path',
            } as WorkContext['artifacts'][number],
          ],
        }),
        debugPayload: 'hidden top-level payload must not leave the read path',
      } as unknown as Record<string, unknown>);

      store.create({ id: 'wc:raw-stale', title: 'Raw stale row' });
      replacePersistedContextJson(dbPath, 'wc:raw-stale', {
        ...fullContext({
          id: 'wc:raw-stale',
          title: 'Raw stale row',
          artifacts: [
            {
              id: 'artifact:raw-transcript',
              kind: 'transcript-ref',
              summary: 'unsafe raw transcript row',
              privacy: createWorkContextPrivacyMetadata({ retention: 'audit' }),
              rawTranscript: 'raw transcript secret must not leak',
            } as WorkContext['artifacts'][number],
          ],
        }),
        hermesProfileState: { token: 'profile payload secret must not leak' },
      } as unknown as Record<string, unknown>);

      store.create({ id: 'wc:raw-flag-stale', title: 'Raw flag stale row' });
      replacePersistedContextJson(dbPath, 'wc:raw-flag-stale', {
        ...fullContext({
          id: 'wc:raw-flag-stale',
          title: 'Raw flag stale row',
          privacy: {
            ...createWorkContextPrivacyMetadata({ retention: 'project' }),
            rawPayloadStored: true,
          },
        }),
      } as unknown as Record<string, unknown>);

      const canonicalGet = await jsonRequest(
        api.baseUrl,
        'GET',
        '/work-contexts/wc:stale-canonical'
      );
      expect(canonicalGet.status).toBe(200);
      expect(canonicalGet.body.workContext.id).toBe('wc:stale-canonical');
      expect(JSON.stringify(canonicalGet.body)).not.toContain('hidden');

      const rawGet = await jsonRequest(
        api.baseUrl,
        'GET',
        '/work-contexts/wc:raw-stale'
      );
      expect(rawGet.status).toBe(404);
      const rawFlagGet = await jsonRequest(
        api.baseUrl,
        'GET',
        '/work-contexts/wc:raw-flag-stale'
      );
      expect(rawFlagGet.status).toBe(404);

      const listed = await jsonRequest(api.baseUrl, 'GET', '/work-contexts');
      const listedIds = listed.body.workContexts.map(
        (context: WorkContext) => context.id
      );
      const listJson = JSON.stringify(listed.body);
      expect(listedIds).toContain('wc:stale-canonical');
      expect(listedIds).not.toContain('wc:raw-stale');
      expect(listedIds).not.toContain('wc:raw-flag-stale');
      expect(listJson).not.toContain('hidden');
      expect(listJson).not.toContain('raw transcript secret');
      expect(listJson).not.toContain('profile payload secret');

      const active = await jsonRequest(
        api.baseUrl,
        'GET',
        '/work-contexts/active'
      );
      const activeIds = active.body.groups.map(
        (group: { id: string }) => group.id
      );
      const activeJson = JSON.stringify(active.body);
      expect(active.status).toBe(200);
      expect(activeIds).toContain('wc:stale-canonical');
      expect(activeIds).not.toContain('wc:raw-stale');
      expect(activeIds).not.toContain('wc:raw-flag-stale');
      expect(activeJson).not.toContain('hidden');
      expect(activeJson).not.toContain('raw transcript secret');
      expect(activeJson).not.toContain('profile payload secret');
    } finally {
      await api.close();
      store.close();
    }
  });

  it('filters PATCH payloads before persistence', async () => {
    const store = makeStore();
    const api = await startWorkContextApi(store);
    try {
      await jsonRequest(api.baseUrl, 'POST', '/work-contexts', {
        id: 'wc:patch-filter',
        title: 'Patch filter',
      });
      const patched = await jsonRequest(
        api.baseUrl,
        'PATCH',
        '/work-contexts/wc:patch-filter',
        {
          title: 'Patched',
          messages: ['top-level raw transcript'],
          artifacts: [
            {
              id: 'artifact:patch',
              kind: 'report',
              summary: 'safe patch summary',
              privacy: createWorkContextPrivacyMetadata({
                retention: 'project',
              }),
              messages: ['nested raw transcript'],
            },
          ],
        }
      );

      expect(patched.status).toBe(200);
      const context = patched.body.workContext as WorkContext & {
        messages?: unknown;
      };
      expect(context.title).toBe('Patched');
      expect(context.messages).toBeUndefined();
      expect(
        (
          context.artifacts[0] as WorkContext['artifacts'][number] & {
            messages?: unknown;
          }
        ).messages
      ).toBeUndefined();
    } finally {
      await api.close();
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
        currentActivity: { tool: 'npm run build', detail: 'vite compiling' },
        controlMode: 'co-driven',
        activeActors: [
          { kind: 'agent', id: 'ika', displayName: 'ika-frontend' },
        ],
        controlFreshness: 'fresh',
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
        currentActivity: { tool: 'npm run build', detail: 'vite compiling' },
        controlMode: 'co-driven',
        activeActors: [
          { kind: 'agent', id: 'ika', displayName: 'ika-frontend' },
        ],
        controlFreshness: 'fresh',
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
      const context = store.create({
        id: 'wc:free',
        title: 'Free shell context',
      });
      store.associateSession(context.id, { session: freeSession });

      const [group] = store.listActiveWork({
        sessions: [freeSession],
        nodes: [],
      });
      expect(group?.context?.id).toBe('wc:free');
      expect(group?.sessions[0]).toMatchObject({
        id: 'sess-free',
        tabKind: 'terminal',
        cwd: '/tmp/free-shell',
        live: true,
      });
      expect(group?.sessions[0]?.repoPath).toBeUndefined();

      const unassigned = session({
        id: 'sess-unassigned',
        cwd: '/tmp/unassigned',
      });
      const groups = store.listActiveWork({
        sessions: [freeSession, unassigned],
        nodes: [],
      });
      expect(
        groups.some((candidate) => candidate.id.startsWith('unassigned:'))
      ).toBe(true);
    } finally {
      store.close();
    }
  });
});
