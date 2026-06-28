import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  bearerActorToken,
  createCliGatewayActorRegistry,
  issueCliGatewayActorCredential,
  validateCliGatewayActorCredential,
} from '../server/cli-gateway-actor-auth.js';
import type { Config } from '../server/types.js';
import {
  createWorkspaceSurfaceStore,
  type WorkspaceSurfaceStore,
} from '../server/workspace-surfaces.js';
import {
  WORKSPACE_TOPICS_MAX_STORED_ENTRIES,
  createWorkspaceTopicStore,
  createWorkspaceTopicsRouter,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import type {
  WorkContextListOptions,
  WorkContextStore,
} from '../server/work-contexts.js';
import type { WorkContext } from '../shared/work-context.js';
import {
  WORKSPACE_TOPICS_MAX_LIST_ENTRIES,
  buildWorkspaceTopicLaunchPreview,
  buildWorkspaceTopicSessionCreateBody,
  buildWorkspaceTopicRecord,
  parseWorkspaceTopicCreateInput,
  resolveWorkspaceTopicRoutingDefaults,
  workspaceTopicSessionLinkPatch,
  type WorkspaceTopic,
  type WorkspaceTopicListResponse,
  type WorkspaceTopicSearchResponse,
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
  requireReadActorAuth?: (
    expectedCommand:
      | 'workspace-topics.list'
      | 'workspace-topics.search'
      | 'workspace-topics.get',
    options?: {
      scopeForRequest?: (
        req: express.Request
      ) => { workContextIds?: string[] } | undefined;
    }
  ) => RequestHandler;
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
      requireReadActorAuth: input.requireReadActorAuth,
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
  headers?: Record<string, string>;
}): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${input.port}${input.url}`, {
    method: input.method,
    headers: {
      'Content-Type': 'application/json',
      'x-relay-capabilities': input.capabilities ?? 'context:write',
      ...(input.headers ?? {}),
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

  it('projects topic defaults into session create bodies and link patches', () => {
    const topic = buildWorkspaceTopicRecord({
      create: {
        workspaceId: 'ws-launch',
        title: 'Hermes topic launch',
        promptDefaults: {
          starterPrompt: 'resume this topic',
          instructions: 'keep the workspace context attached',
        },
        routingDefaults: {
          providerId: 'hermes',
          repoPath: '/repo',
          cwd: '/repo/.worktrees/topic',
        },
        linkedRefs: { workContextIds: ['wc-topic'] },
      },
      now: '2026-06-26T00:00:00.000Z',
    });

    expect(
      buildWorkspaceTopicSessionCreateBody({
        topic,
        overrides: { initialPrompt: 'explicit prompt', yolo: true },
      })
    ).toMatchObject({
      workspaceTopicId: topic.id,
      repoPath: '/repo',
      worktreePath: '/repo/.worktrees/topic',
      agent: 'hermes',
      workContextId: 'wc-topic',
      initialPrompt: 'explicit prompt',
      yolo: true,
    });

    expect(
      buildWorkspaceTopicSessionCreateBody({
        topic,
        overrides: { initialPrompt: '', workContextId: '' },
      })
    ).toMatchObject({
      workContextId: 'wc-topic',
      initialPrompt: 'resume this topic\n\nkeep the workspace context attached',
    });

    expect(
      buildWorkspaceTopicSessionCreateBody({
        topic,
        overrides: { worktreePath: null },
      })
    ).toMatchObject({
      repoPath: '/repo',
      worktreePath: null,
      agent: 'hermes',
    });

    expect(
      workspaceTopicSessionLinkPatch({
        topic,
        sessionId: 'session-topic',
        workContextId: 'wc-topic',
      })
    ).toEqual({
      linkedRefs: {
        workContextIds: ['wc-topic'],
        sessionIds: ['session-topic'],
      },
    });
  });

  it('previews create-only and create+launch side effects from topic defaults', () => {
    const create = {
      workspaceId: 'ws-launch',
      title: 'Issue 1045 task room',
      promptDefaults: {
        starterPrompt: 'start on #1045',
        contextPacketIds: ['ctx:one', 'ctx:two'],
      },
      routingDefaults: {
        providerId: 'hermes',
        nodeId: 'devbox',
        repoPath: '/repo/relay',
        worktreePath: '/repo/relay/.worktrees/1045',
      },
      linkedRefs: {
        taskRefs: [
          { kind: 'github-issue' as const, id: '1045', title: 'Launch flow' },
        ],
      },
    };

    expect(
      buildWorkspaceTopicLaunchPreview({
        create,
        intent: 'create-only',
        templateKind: 'agent-task',
      })
    ).toMatchObject({
      intent: 'create-only',
      providerLabel: 'hermes (mode explicit)',
      modeLabel: 'pty',
      nodeLabel: 'devbox',
      cwdLabel: '/repo/relay/.worktrees/1045',
      taskRefs: ['github-issue:1045 · Launch flow'],
      sideEffects: [
        'create WorkspaceTopic room',
        'create WorkContext link for this room',
      ],
    });

    expect(
      buildWorkspaceTopicLaunchPreview({
        create,
        intent: 'create-and-launch',
        launchOverrides: { agent: 'claude', mode: 'web', cwd: '/repo/relay' },
      })
    ).toMatchObject({
      intent: 'create-and-launch',
      providerLabel: 'claude',
      modeLabel: 'web',
      cwdLabel: '/repo/relay/.worktrees/1045',
      sideEffects: [
        'create WorkspaceTopic room',
        'create WorkContext link for this room',
        'launch provider-neutral session through sessions.create',
        'link created session back to WorkspaceTopic/WorkContext',
      ],
    });
  });

  it('namespaces generated topic ids by workspace', () => {
    const now = '2026-06-26T00:00:00.000Z';
    const first = buildWorkspaceTopicRecord({
      create: { workspaceId: 'ws-alpha', title: 'Same lane' },
      now,
    });
    const second = buildWorkspaceTopicRecord({
      create: { workspaceId: 'ws-beta', title: 'Same lane' },
      now,
    });

    expect(first.id).toBe('topic:ws-alpha-same-lane');
    expect(second.id).toBe('topic:ws-beta-same-lane');
    expect(first.id).not.toBe(second.id);
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
    let requestedReadCommand: string | undefined;
    let requestedScope: { workContextIds?: string[] } | undefined;
    const { port } = await listen({
      store,
      surfaceStore: surfaces,
      getConfig: () => asConfig(['/repo']),
      requireReadActorAuth: (expectedCommand) => {
        return ((_req, _res, next) => {
          requestedReadCommand = expectedCommand;
          next();
        }) as RequestHandler;
      },
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
        privacy: {
          classification: 'sensitive',
          retention: 'audit',
          redaction: 'hash',
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
      privacy: {
        classification: 'sensitive',
        retention: 'audit',
        redaction: 'hash',
        rawDefaultsStored: false,
      },
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
    expect(requestedReadCommand).toBe('workspace-topics.list');
    expect(list.body).toMatchObject({ derived: false, truncated: false });
    expect(list.body.topics.map((topic) => topic.id)).toEqual([
      'topic:build-lane',
    ]);

    const get = await getJson<{ topic: WorkspaceTopic }>(
      port,
      '/workspace-topics/topic%3Abuild-lane'
    );
    expect(get.status).toBe(200);
    expect(requestedReadCommand).toBe('workspace-topics.get');
    expect(get.body.topic.id).toBe('topic:build-lane');

    const update = await writeJson<{
      topic: WorkspaceTopic;
      mutationPolicy: unknown;
    }>({
      port,
      method: 'PATCH',
      url: '/workspace-topics/topic%3Abuild-lane',
      body: {
        title: 'Build lane renamed',
        pinned: true,
        privacy: { retention: 'session' },
      },
    });
    expect(update.status).toBe(200);
    expect(update.body.topic.display.title).toBe('Build lane renamed');
    expect(update.body.topic.state.pinned).toBe(true);
    expect(update.body.topic.privacy).toMatchObject({
      classification: 'sensitive',
      retention: 'session',
      redaction: 'hash',
      rawDefaultsStored: false,
    });
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

  it('authorizes update and archive against persisted topic workContext refs', async () => {
    const store = topicStore();
    store.create({
      id: 'topic:allowed',
      workspaceId: 'ws-1',
      title: 'Allowed topic',
      linkedRefs: { workContextIds: ['wc-allowed'] },
    });
    store.create({
      id: 'topic:denied',
      workspaceId: 'ws-1',
      title: 'Denied topic',
      linkedRefs: { workContextIds: ['wc-denied'] },
    });
    const requested: Array<{
      command: string;
      scope?: { workContextIds?: string[] };
    }> = [];
    const { port } = await listen({
      store,
      requireWriteActorAuth: (expectedCommand, options) => {
        return ((req, res, next) => {
          const scope = options?.scopeForRequest?.(req);
          requested.push({ command: expectedCommand, scope });
          if (
            scope?.workContextIds?.includes('wc-allowed') &&
            !scope.workContextIds.includes('wc-denied')
          ) {
            next();
            return;
          }
          res.status(403).json({ error: { code: 'FORBIDDEN' } });
        }) as RequestHandler;
      },
    });

    const forgedUpdate = await writeJson({
      port,
      method: 'PATCH',
      url: '/workspace-topics/topic%3Adenied',
      body: {
        title: 'Forged update',
        linkedRefs: { workContextIds: ['wc-allowed'] },
      },
    });
    expect(forgedUpdate.status).toBe(403);
    expect(store.get('topic:denied')?.display.title).toBe('Denied topic');

    const scopedArchive = await writeJson<{ topic: WorkspaceTopic }>({
      port,
      method: 'POST',
      url: '/workspace-topics/topic%3Aallowed/archive',
      body: {},
    });
    expect(scopedArchive.status).toBe(200);
    expect(scopedArchive.body.topic.status).toBe('archived');
    expect(requested).toEqual([
      {
        command: 'workspace-topics.update',
        scope: { workContextIds: ['wc-denied', 'wc-allowed'] },
      },
      {
        command: 'workspace-topics.archive',
        scope: { workContextIds: ['wc-allowed'] },
      },
    ]);
  });

  it('rejects scoped actor topic updates that add unauthorized WorkContext refs', async () => {
    const store = topicStore();
    const registry = createCliGatewayActorRegistry();
    store.create({
      id: 'topic:auth-hole',
      workspaceId: 'ws-1',
      title: 'Scoped topic',
      linkedRefs: { workContextIds: ['wc:allowed'] },
    });
    const issued = issueCliGatewayActorCredential(registry, {
      capabilities: ['context:write'],
      scope: { workContextIds: ['wc:allowed'] },
    });
    const actorHeaders = {
      authorization: 'Bearer ' + issued.token,
      'x-relay-cli-actor-token': 'v1',
      'x-relay-cli-command': 'workspace-topics.update',
    };
    const { port } = await listen({
      store,
      requireWriteActorAuth: (expectedCommand, options) => {
        return ((req, res, next) => {
          if (req.header('x-relay-cli-command') !== expectedCommand) {
            res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
            return;
          }
          const validation = validateCliGatewayActorCredential(registry, {
            token: bearerActorToken(req),
            capabilities: ['context:write'],
            ...(options?.scopeForRequest
              ? { scope: options.scopeForRequest(req) }
              : {}),
          });
          if ('reason' in validation) {
            res.status(403).json({ error: { reason: validation.reason } });
            return;
          }
          next();
        }) as RequestHandler;
      },
    });

    const allowedUpdate = await writeJson<{ topic: WorkspaceTopic }>({
      port,
      method: 'PATCH',
      url: '/workspace-topics/topic%3Aauth-hole',
      headers: actorHeaders,
      body: { title: 'Allowed rename' },
    });
    expect(allowedUpdate.status).toBe(200);
    expect(allowedUpdate.body.topic.display.title).toBe('Allowed rename');

    const forgedUpdate = await writeJson<{
      error: { reason?: string };
    }>({
      port,
      method: 'PATCH',
      url: '/workspace-topics/topic%3Aauth-hole',
      headers: actorHeaders,
      body: {
        linkedRefs: { workContextIds: ['wc:denied'] },
      },
    });
    expect(forgedUpdate.status).toBe(403);
    expect(forgedUpdate.body.error.reason).toBe('wrong_work_context_scope');
    expect(store.get('topic:auth-hole')?.linkedRefs.workContextIds).toEqual([
      'wc:allowed',
    ]);
  });

  it('derives starter topics from WorkContexts when no persisted topic exists', async () => {
    let requestedLimit: number | undefined;
    let requestedWorkspaceId: string | undefined;
    const workContextStore = {
      list: (options?: WorkContextListOptions) => {
        requestedLimit = options?.limit;
        requestedWorkspaceId = options?.workspaceId;
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
    expect(requestedWorkspaceId).toBe('ws-derived');
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

  it('marks derived topic lists truncated when the sentinel entry exists', async () => {
    let requestedLimit: number | undefined;
    let requestedWorkspaceId: string | undefined;
    const workContextStore = {
      list: (options?: WorkContextListOptions) => {
        requestedLimit = options?.limit;
        requestedWorkspaceId = options?.workspaceId;
        return Array.from(
          { length: WORKSPACE_TOPICS_MAX_LIST_ENTRIES + 1 },
          (_entry, index) => workContext(`wc-topic-${index}`)
        );
      },
    } as unknown as WorkContextStore;
    const { port } = await listen({ store: topicStore(), workContextStore });

    const list = await getJson<WorkspaceTopicListResponse>(
      port,
      '/workspace-topics?workspaceId=ws-derived'
    );

    expect(list.status).toBe(200);
    expect(requestedLimit).toBe(WORKSPACE_TOPICS_MAX_LIST_ENTRIES + 1);
    expect(requestedWorkspaceId).toBe('ws-derived');
    expect(list.body.derived).toBe(true);
    expect(list.body.topics).toHaveLength(WORKSPACE_TOPICS_MAX_LIST_ENTRIES);
    expect(list.body.truncated).toBe(true);
  });

  it('filters derived fallback workspaces before applying the sentinel limit', async () => {
    let requestedLimit: number | undefined;
    let requestedWorkspaceId: string | undefined;
    const otherWorkspaceContexts = Array.from(
      { length: WORKSPACE_TOPICS_MAX_LIST_ENTRIES + 1 },
      (_entry, index) => {
        const context = workContext(`wc-other-${index}`);
        return {
          ...context,
          anchors: {
            ...context.anchors,
            project: { workspaceId: 'ws-other' },
          },
        };
      }
    );
    const target = workContext('wc-target');
    const workContextStore = {
      list: (options?: WorkContextListOptions) => {
        requestedLimit = options?.limit;
        requestedWorkspaceId = options?.workspaceId;
        return [...otherWorkspaceContexts, target]
          .filter(
            (context) =>
              (context.anchors.project?.workspaceId ?? 'ws:derived') ===
              options?.workspaceId
          )
          .slice(0, options?.limit);
      },
    } as unknown as WorkContextStore;
    const { port } = await listen({ store: topicStore(), workContextStore });

    const list = await getJson<WorkspaceTopicListResponse>(
      port,
      '/workspace-topics?workspaceId=ws-derived'
    );

    expect(list.status).toBe(200);
    expect(requestedLimit).toBe(WORKSPACE_TOPICS_MAX_LIST_ENTRIES + 1);
    expect(requestedWorkspaceId).toBe('ws-derived');
    expect(list.body.derived).toBe(true);
    expect(list.body.truncated).toBe(false);
    expect(
      list.body.topics.map((topic) => topic.linkedRefs.workContextIds)
    ).toEqual([['wc-target']]);
  });

  it('searches bounded topic history without indexing raw secret artifacts', async () => {
    const store = topicStore();
    const surfaces = surfaceStore();
    surfaces.upsert({
      id: 'surface:apollo-preview',
      kind: 'preview',
      label: 'Apollo preview',
      workspaceId: 'ws-derived',
      repoPath: '/repo',
      health: 'reachable',
    });
    const context = workContext('wc-search');
    context.title = 'Apollo release lane';
    context.actors = [
      { kind: 'agent', id: 'agent:kani', providerId: 'hermes' },
    ];
    context.tasks = [
      { kind: 'github-issue', id: '1026', title: 'Topic search history' },
    ];
    context.artifacts = [
      {
        id: 'artifact-safe',
        kind: 'file',
        title: 'Apollo handoff note',
        summary: 'bounded topic recall for thin-line navigation',
        uri: 'file:///tmp/apollo.md',
        privacy: {
          classification: 'internal',
          retention: 'project',
          rawPayloadStored: false,
          redaction: { redacted: false, strategy: 'none', classes: [] },
        },
      },
      {
        id: 'artifact-secret',
        kind: 'file',
        title: 'credential dump',
        summary: 'never index this credential phrase',
        privacy: {
          classification: 'secret',
          retention: 'audit',
          rawPayloadStored: true,
          redaction: {
            redacted: true,
            strategy: 'hash',
            classes: ['credential'],
          },
        },
      },
    ];
    const workContextStore = {
      list: (options?: WorkContextListOptions) =>
        [context]
          .filter(
            (entry) =>
              !options?.workspaceId ||
              entry.anchors.project?.workspaceId === options.workspaceId
          )
          .slice(0, options?.limit),
    } as unknown as WorkContextStore;
    const { port } = await listen({
      store,
      surfaceStore: surfaces,
      workContextStore,
    });

    const search = await getJson<WorkspaceTopicSearchResponse>(
      port,
      '/workspace-topics/search?q=apollo&workspaceId=ws-derived&limit=1'
    );

    expect(search.status).toBe(200);
    expect(search.body).toMatchObject({
      query: 'apollo',
      truncated: false,
      derived: true,
    });
    expect(search.body.results).toHaveLength(1);
    expect(search.body.results[0]?.topic.linkedRefs.workContextIds).toEqual([
      'wc-search',
    ]);
    expect(
      search.body.results[0]?.matches.map((match) => match.kind)
    ).toContain('artifact');
    expect(
      search.body.results[0]?.matches.map((match) => match.kind)
    ).toContain('surface');
    expect(search.body.results[0]?.action).toMatchObject({
      kind: 'open-topic',
      primarySessionId: 'session-1',
    });

    const secret = await getJson<WorkspaceTopicSearchResponse>(
      port,
      '/workspace-topics/search?q=credential&workspaceId=ws-derived'
    );
    expect(secret.status).toBe(200);
    expect(secret.body.results).toHaveLength(0);
  });

  it('bounds search results and scopes actor reads by requested WorkContext', async () => {
    const store = topicStore();
    for (let i = 0; i < 3; i += 1) {
      store.create({
        id: `topic:bounded-${i}`,
        workspaceId: 'ws-search',
        title: `Bounded search ${i}`,
        linkedRefs: { workContextIds: [`wc-${i}`] },
      });
    }
    let requestedReadCommand: string | undefined;
    let requestedScope: { workContextIds?: string[] } | undefined;
    const { port } = await listen({
      store,
      requireReadActorAuth: (expectedCommand, options) => (req, _res, next) => {
        requestedReadCommand = expectedCommand;
        requestedScope = options?.scopeForRequest?.(req);
        next();
      },
    });

    const scoped = await getJson<WorkspaceTopicSearchResponse>(
      port,
      '/workspace-topics/search?q=bounded&workContextId=wc-1&limit=1'
    );

    expect(scoped.status).toBe(200);
    expect(requestedReadCommand).toBe('workspace-topics.search');
    expect(requestedScope).toEqual({ workContextIds: ['wc-1'] });
    expect(scoped.body.truncated).toBe(false);
    expect(scoped.body.results.map((result) => result.topic.id)).toEqual([
      'topic:bounded-1',
    ]);

    const mergedScope = await getJson<WorkspaceTopicSearchResponse>(
      port,
      '/workspace-topics/search?q=bounded&workContextId=wc-1&workContextIds=wc-2&limit=3'
    );

    expect(mergedScope.status).toBe(200);
    expect(requestedScope).toEqual({ workContextIds: ['wc-1', 'wc-2'] });
    expect(
      mergedScope.body.results.map((result) => result.topic.id).sort()
    ).toEqual(['topic:bounded-1', 'topic:bounded-2']);

    const bounded = await getJson<WorkspaceTopicSearchResponse>(
      port,
      '/workspace-topics/search?q=bounded&limit=2'
    );
    expect(bounded.status).toBe(200);
    expect(bounded.body.results).toHaveLength(2);
    expect(bounded.body.truncated).toBe(true);

    const hashOnly = await getJson<WorkspaceTopicSearchResponse>(
      port,
      '/workspace-topics/search?q=%23&workspaceId=ws-search'
    );
    expect(hashOnly.status).toBe(200);
    expect(hashOnly.body.unavailableReason).toBe('empty_query');
    expect(hashOnly.body.results).toHaveLength(0);

    const punctuationOnly = await getJson<WorkspaceTopicSearchResponse>(
      port,
      '/workspace-topics/search?q=---&workspaceId=ws-search'
    );
    expect(punctuationOnly.status).toBe(200);
    expect(punctuationOnly.body.unavailableReason).toBe('empty_query');
    expect(punctuationOnly.body.results).toHaveLength(0);
  });

  it('does not leak unrequested scoped contexts or same-repo surfaces through search', async () => {
    const store = topicStore();
    const surfaces = surfaceStore();
    store.create({
      id: 'topic:shared-scope',
      workspaceId: 'ws-search',
      title: 'Shared scope topic',
      routingDefaults: { repoPath: '/repo' },
      linkedRefs: { workContextIds: ['wc-allowed', 'wc-denied'] },
    });
    surfaces.upsert({
      id: 'surface:denied-secret',
      kind: 'dashboard',
      label: 'hidden-denied surface',
      workspaceId: 'ws-search',
      repoPath: '/repo',
      health: 'unreachable',
      workContextId: 'wc-denied',
    });
    const allowedContext = workContext('wc-allowed');
    allowedContext.title = 'allowed recall lane';
    const deniedContext = workContext('wc-denied');
    deniedContext.title = 'hidden-denied context';
    const workContextStore = {
      list: (options?: WorkContextListOptions) =>
        [allowedContext, deniedContext]
          .filter(
            (entry) =>
              !options?.workspaceId ||
              entry.anchors.project?.workspaceId === options.workspaceId
          )
          .slice(0, options?.limit),
    } as unknown as WorkContextStore;
    const { port } = await listen({
      store,
      surfaceStore: surfaces,
      workContextStore,
    });

    const deniedTerm = await getJson<WorkspaceTopicSearchResponse>(
      port,
      '/workspace-topics/search?q=hidden-denied&workContextId=wc-allowed'
    );

    expect(deniedTerm.status).toBe(200);
    expect(deniedTerm.body.results).toHaveLength(0);

    const allowedTerm = await getJson<WorkspaceTopicSearchResponse>(
      port,
      '/workspace-topics/search?q=allowed&workContextId=wc-allowed'
    );
    expect(allowedTerm.status).toBe(200);
    expect(allowedTerm.body.results.length).toBeGreaterThan(0);
    expect(
      allowedTerm.body.results.every((result) => result.freshness !== 'stale')
    ).toBe(true);
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

  it('rejects over-capacity active topic creates instead of evicting active rows', () => {
    const store = topicStore();
    for (let i = 0; i < WORKSPACE_TOPICS_MAX_STORED_ENTRIES; i += 1) {
      store.create({
        id: `topic:active-${i}`,
        workspaceId: 'ws-cap',
        title: `Active ${i}`,
      });
    }

    expect(() =>
      store.create({
        id: 'topic:overflow',
        workspaceId: 'ws-cap',
        title: 'Overflow',
      })
    ).toThrow(/workspace topic store is full/);
    expect(store.get('topic:active-0')).not.toBeNull();
  });

  it('trims only archived rows when creating beyond the stored topic cap', () => {
    const store = topicStore();
    store.create({
      id: 'topic:old-archived',
      workspaceId: 'ws-cap',
      title: 'Old archived',
    });
    store.archive('topic:old-archived');
    for (let i = 0; i < WORKSPACE_TOPICS_MAX_STORED_ENTRIES - 1; i += 1) {
      store.create({
        id: `topic:active-${i}`,
        workspaceId: 'ws-cap',
        title: `Active ${i}`,
      });
    }

    expect(() =>
      store.create({
        id: 'topic:new-active',
        workspaceId: 'ws-cap',
        title: 'New active',
      })
    ).not.toThrow();
    expect(store.get('topic:old-archived')).toBeNull();
    expect(store.get('topic:active-0')).not.toBeNull();
    expect(store.get('topic:new-active')).not.toBeNull();
  });
});
