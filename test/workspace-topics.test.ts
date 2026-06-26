import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import type { Config } from '../server/types.js';
import {
  createWorkspaceSurfaceStore,
  type WorkspaceSurfaceStore,
} from '../server/workspace-surfaces.js';
import {
  createWorkspaceTopicStore,
  createWorkspaceTopicsRouter,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import type { WorkContextStore } from '../server/work-contexts.js';
import type { WorkContext } from '../shared/work-context.js';
import {
  WORKSPACE_TOPICS_MAX_LIST_ENTRIES,
  parseWorkspaceTopicCreateInput,
  resolveWorkspaceTopicRoutingDefaults,
  type WorkspaceTopic,
  type WorkspaceTopicListResponse,
} from '../shared/workspace-topics.js';

const cleanup: Array<() => void> = [];

function tmpRoot(name = 'relay-workspace-topics-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function asConfig(repos: string[] = []): Config {
  return { repos, workspaces: [] } as unknown as Config;
}

function topicStore(): WorkspaceTopicStore {
  const dir = tmpRoot('relay-workspace-topics-db-');
  const store = createWorkspaceTopicStore({
    dbPath: path.join(dir, 'topics.db'),
    now: () => '2026-06-26T00:00:00.000Z',
  });
  cleanup.push(() => store.close());
  return store;
}

function surfaceStore(): WorkspaceSurfaceStore {
  const dir = tmpRoot('relay-workspace-topic-surfaces-db-');
  const store = createWorkspaceSurfaceStore({
    dbPath: path.join(dir, 'surfaces.db'),
    now: () => '2026-06-26T00:00:00.000Z',
  });
  cleanup.push(() => store.close());
  return store;
}

async function listen(input: {
  store?: WorkspaceTopicStore | null;
  surfaceStore?: WorkspaceSurfaceStore | null;
  workContextStore?: WorkContextStore;
  getConfig?: () => Config;
  requireWriteActorAuth?: (
    expectedCommand:
      | 'workspace-topics.create'
      | 'workspace-topics.update'
      | 'workspace-topics.archive',
    options?: {
      scopeForRequest?: (
        req: express.Request
      ) => { workContextIds?: string[] } | undefined;
    }
  ) => RequestHandler;
}): Promise<{ port: number }> {
  const app = express();
  app.use(express.json());
  app.use(
    createWorkspaceTopicsRouter({
      store: input.store ?? null,
      surfaceStore: input.surfaceStore,
      workContextStore: input.workContextStore,
      getConfig: input.getConfig,
      requireWriteActorAuth: input.requireWriteActorAuth,
    })
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing server address');
  return { port: address.port };
}

async function getJson<T>(
  port: number,
  url: string,
  capabilities = 'context:read'
): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    headers: { 'x-relay-capabilities': capabilities },
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function writeJson<T>(input: {
  port: number;
  method: 'POST' | 'PATCH';
  url: string;
  body: unknown;
  capabilities?: string;
}): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${input.port}${input.url}`, {
    method: input.method,
    headers: {
      'Content-Type': 'application/json',
      'x-relay-capabilities': input.capabilities ?? 'context:write',
    },
    body: JSON.stringify(input.body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function workContext(id = 'wc-topic-1'): WorkContext {
  return {
    schemaVersion: 1,
    id,
    title: 'derived topic',
    createdAt: '2026-06-25T00:00:00.000Z',
    updatedAt: '2026-06-25T01:00:00.000Z',
    source: 'test',
    anchors: {
      project: { workspaceId: 'ws-derived' },
      session: {
        nodeId: 'node-local',
        sessionId: 'session-1',
        tabKind: 'agent',
        cwd: '/repo',
        agent: 'hermes',
      },
      repo: { localPath: '/repo' },
      worktree: { localPath: '/repo/.worktrees/one' },
    },
    actors: [],
    tasks: [{ kind: 'github-issue', id: '1022', title: 'Topic ladder' }],
    artifacts: [
      {
        id: 'artifact-1',
        kind: 'file',
        uri: 'file:///tmp/one.md',
        privacy: {
          classification: 'internal',
          retention: 'project',
          rawPayloadStored: false,
          redaction: { redacted: false, strategy: 'none', classes: [] },
        },
      },
    ],
    auditRefs: [],
    capabilityGrants: [],
    privacy: {
      classification: 'internal',
      retention: 'project',
      rawPayloadStored: false,
      redaction: { redacted: false, strategy: 'none', classes: [] },
    },
  };
}

describe('workspace topics foundation', () => {
  it('validates bounded defaults and keeps precedence explicit', () => {
    expect(() =>
      parseWorkspaceTopicCreateInput({
        workspaceId: 'ws-1',
        title: 'Secrets are not defaults',
        promptDefaults: { apiToken: 'sk-thisshouldnotbestoredanywhere' },
      })
    ).toThrow(/secret/i);

    expect(
      resolveWorkspaceTopicRoutingDefaults({
        providerRuntimeDefaults: { providerId: 'claude', cwd: '/runtime' },
        workspaceDefaults: { providerId: 'hermes', repoPath: '/repo' },
        topicDefaults: { agentId: 'agent:kani' },
        explicitSpawnInput: { cwd: '/repo/task' },
      })
    ).toEqual({
      providerId: 'hermes',
      cwd: '/repo/task',
      repoPath: '/repo',
      agentId: 'agent:kani',
    });
  });

  it('creates, lists, updates, and archives topics with scoped refs and policies', async () => {
    const store = topicStore();
    const surfaces = surfaceStore();
    surfaces.upsert({
      id: 'surface:preview',
      kind: 'preview',
      label: 'preview',
      url: 'https://preview.example.test',
      repoPath: '/repo',
    });
    let requestedCommand: string | undefined;
    let requestedScope: { workContextIds?: string[] } | undefined;
    const { port } = await listen({
      store,
      surfaceStore: surfaces,
      getConfig: () => asConfig(['/repo']),
      requireWriteActorAuth: (expectedCommand, options) => {
        return ((req, _res, next) => {
          requestedCommand = expectedCommand;
          requestedScope = options?.scopeForRequest?.(req);
          next();
        }) as RequestHandler;
      },
    });

    const unknownSurface = await writeJson({
      port,
      method: 'POST',
      url: '/workspace-topics',
      body: {
        workspaceId: 'ws-1',
        title: 'Bad surface',
        linkedRefs: { workspaceSurfaceIds: ['missing-surface'] },
      },
    });
    expect(unknownSurface.status).toBe(400);

    const create = await writeJson<{
      topic: WorkspaceTopic;
      mutationPolicy: unknown;
    }>({
      port,
      method: 'POST',
      url: '/workspace-topics',
      body: {
        id: 'topic:build-lane',
        workspaceId: 'ws-1',
        title: 'Build lane',
        routingDefaults: { providerId: 'hermes', repoPath: '/repo' },
        linkedRefs: {
          workContextIds: ['wc-1'],
          workspaceSurfaceIds: ['surface:preview'],
        },
      },
    });
    expect(create.status).toBe(201);
    expect(requestedCommand).toBe('workspace-topics.create');
    expect(requestedScope).toEqual({ workContextIds: ['wc-1'] });
    expect(create.body.topic).toMatchObject({
      id: 'topic:build-lane',
      workspaceId: 'ws-1',
      source: 'persisted',
      linkedRefs: { workspaceSurfaceIds: ['surface:preview'] },
      privacy: { rawDefaultsStored: false },
    });
    expect(create.body.mutationPolicy).toMatchObject({
      kind: 'create',
      sideEffectClass: 'write',
      requiresConfirmation: false,
    });

    const duplicate = await writeJson<{
      error: { code: string; details?: Record<string, unknown> };
    }>({
      port,
      method: 'POST',
      url: '/workspace-topics',
      body: {
        id: 'topic:build-lane',
        workspaceId: 'ws-1',
        title: 'Build lane',
      },
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.code).toBe('SESSION_CONFLICT');
    expect(duplicate.body.error.details).toMatchObject({
      reasonCode: 'WORKSPACE_TOPIC_ALREADY_EXISTS',
      id: 'topic:build-lane',
    });

    const list = await getJson<WorkspaceTopicListResponse>(
      port,
      '/workspace-topics?workspaceId=ws-1'
    );
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ derived: false, truncated: false });
    expect(list.body.topics.map((topic) => topic.id)).toEqual([
      'topic:build-lane',
    ]);

    const update = await writeJson<{
      topic: WorkspaceTopic;
      mutationPolicy: unknown;
    }>({
      port,
      method: 'PATCH',
      url: '/workspace-topics/topic%3Abuild-lane',
      body: { title: 'Build lane renamed', pinned: true },
    });
    expect(update.status).toBe(200);
    expect(update.body.topic.display.title).toBe('Build lane renamed');
    expect(update.body.topic.state.pinned).toBe(true);
    expect(update.body.mutationPolicy).toMatchObject({
      kind: 'update',
      sideEffectClass: 'write',
      requiresConfirmation: false,
    });

    const archive = await writeJson<{
      topic: WorkspaceTopic;
      mutationPolicy: unknown;
    }>({
      port,
      method: 'POST',
      url: '/workspace-topics/topic%3Abuild-lane/archive',
      body: {},
    });
    expect(archive.status).toBe(200);
    expect(archive.body.topic.status).toBe('archived');
    expect(archive.body.mutationPolicy).toMatchObject({
      kind: 'archive',
      sideEffectClass: 'destructive',
      requiresConfirmation: true,
    });

    const activeOnly = await getJson<WorkspaceTopicListResponse>(
      port,
      '/workspace-topics?workspaceId=ws-1'
    );
    expect(activeOnly.body.topics).toHaveLength(0);
    const includeArchived = await getJson<WorkspaceTopicListResponse>(
      port,
      '/workspace-topics?workspaceId=ws-1&includeArchived=true'
    );
    expect(includeArchived.body.topics.map((topic) => topic.status)).toEqual([
      'archived',
    ]);
  });

  it('derives starter topics from WorkContexts when no persisted topic exists', async () => {
    let requestedLimit: number | undefined;
    const workContextStore = {
      list: (options?: { limit?: number }) => {
        requestedLimit = options?.limit;
        return [workContext()];
      },
    } as unknown as WorkContextStore;
    const { port } = await listen({ store: topicStore(), workContextStore });

    const list = await getJson<WorkspaceTopicListResponse>(
      port,
      '/workspace-topics?workspaceId=ws-derived'
    );

    expect(list.status).toBe(200);
    expect(requestedLimit).toBe(WORKSPACE_TOPICS_MAX_LIST_ENTRIES + 1);
    expect(list.body.derived).toBe(true);
    expect(list.body.topics).toHaveLength(1);
    expect(list.body.topics[0]).toMatchObject({
      source: 'derived',
      workspaceId: 'ws-derived',
      linkedRefs: {
        workContextIds: ['wc-topic-1'],
        sessionIds: ['session-1'],
        artifactIds: ['artifact-1'],
      },
      routingDefaults: {
        providerId: 'hermes',
        nodeId: 'node-local',
        repoPath: '/repo',
        worktreePath: '/repo/.worktrees/one',
        cwd: '/repo',
      },
    });
  });

  it('enforces capability headers and list caps', async () => {
    const store = topicStore();
    for (let i = 0; i < WORKSPACE_TOPICS_MAX_LIST_ENTRIES + 1; i += 1) {
      store.create({ workspaceId: 'ws-cap', title: `Topic ${i}` });
    }
    const { port } = await listen({ store });

    const listDenied = await getJson(
      port,
      '/workspace-topics',
      'context:write'
    );
    expect(listDenied.status).toBe(403);
    const createDenied = await writeJson({
      port,
      method: 'POST',
      url: '/workspace-topics',
      capabilities: 'context:read',
      body: { workspaceId: 'ws-cap', title: 'Denied' },
    });
    expect(createDenied.status).toBe(403);

    const list = await getJson<WorkspaceTopicListResponse>(
      port,
      '/workspace-topics?workspaceId=ws-cap'
    );
    expect(list.status).toBe(200);
    expect(list.body.topics).toHaveLength(WORKSPACE_TOPICS_MAX_LIST_ENTRIES);
    expect(list.body.truncated).toBe(true);
  });
});
