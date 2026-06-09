import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorkContextArtifactRouter } from '../server/features/work-context-artifact-router.js';
import {
  createWorkContextArtifactStore,
  type WorkContextArtifactStore,
} from '../server/work-context-artifacts.js';
import type {
  WorkContextStore,
  WorkContextLifecycleEventInput,
  WorkContextPatchInput,
} from '../server/work-contexts.js';
import {
  PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION,
  type PipelineHandoffArtifact,
} from '../shared/pipeline-handoff-artifact.js';
import {
  WORK_CONTEXT_SCHEMA_VERSION,
  createWorkContextPrivacyMetadata,
  type WorkContext,
  type WorkContextId,
} from '../shared/work-context.js';

const now = '2026-06-08T12:00:00.000Z';
const headSha = 'a'.repeat(40);
const nextHeadSha = 'b'.repeat(40);
const cleanup: Array<() => void> = [];
type ArtifactReadCommand =
  | 'work-context-artifacts.list'
  | 'work-context-artifacts.show'
  | 'work-context-artifacts.export'
  | 'work-context-artifacts.doctor'
  | 'handoff-artifacts.list'
  | 'handoff-artifacts.show'
  | 'handoff-artifacts.copy';

function artifact(input: Partial<PipelineHandoffArtifact> = {}): PipelineHandoffArtifact {
  return {
    schemaVersion: PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION,
    id: 'pipeline-handoff:router:aaaaaaaa',
    title: 'Router Project implementation handoff',
    createdAt: now,
    updatedAt: now,
    scope: {
      summary: 'router and CLI/API support for WorkContext artifacts',
      risk: 'medium',
      taskRefs: [{ kind: 'github-issue', id: '890' }],
      acceptance: ['publish/list/show/pin/unpin/export are exposed'],
      nonGoals: ['no raw transcript export'],
    },
    head: {
      repo: { ownerRepo: 'example-org/example-project' },
      base: { name: 'nightly' },
      branch: { name: 'issue-890-workcontext-artifact-cli-api' },
      pr: { number: 890, url: 'https://github.com/example-org/example-project/pull/890' },
      headSha,
      staleIf: { headShaChanges: true },
      capturedAt: now,
    },
    stages: [
      {
        stage: 'implementation',
        addedAt: now,
        actorId: 'agent:kani-backend',
        summary: 'added API router coverage for WorkContext artifacts',
        acceptanceEvidence: [
          { label: 'router', disposition: 'provided', summary: 'express routes exercised' },
        ],
        commands: [
          { label: 'test', command: 'vitest', status: 'passed', summary: 'router test', exitCode: 0 },
        ],
        downstreamFocus: ['verify CLI gateway contract shape'],
        nonGoals: ['UI support'],
        decision: 'implemented',
        changedFiles: ['server/features/work-context-artifact-router.ts'],
        migrationOrStateRisk: 'isolated WorkContext artifact store only',
      },
    ],
    ...input,
  };
}

function reorderJsonObjectKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => reorderJsonObjectKeys(item));
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .reverse()
      .map((key) => [key, reorderJsonObjectKeys(record[key])])
  );
}

function createWorkContext(id: WorkContextId): WorkContext {
  return {
    schemaVersion: WORK_CONTEXT_SCHEMA_VERSION,
    id,
    title: 'Artifact router WorkContext',
    createdAt: now,
    updatedAt: now,
    source: 'test',
    anchors: {},
    actors: [],
    tasks: [],
    artifacts: [],
    auditRefs: [],
    capabilityGrants: [],
    privacy: createWorkContextPrivacyMetadata(),
  };
}

function fakeWorkContextStore(...contexts: WorkContext[]): WorkContextStore {
  const byId = new Map<WorkContextId, WorkContext>(contexts.map((ctx) => [ctx.id, ctx]));
  const store = {
    close: () => undefined,
    create: () => {
      throw new Error('not implemented');
    },
    get: (id: WorkContextId) => byId.get(id) ?? null,
    list: () => [...byId.values()],
    update(id: WorkContextId, patch: WorkContextPatchInput): WorkContext {
      const existing = byId.get(id);
      if (!existing) throw new Error(`missing WorkContext ${id}`);
      const updated: WorkContext = { ...existing, ...patch, updatedAt: now };
      byId.set(id, updated);
      return updated;
    },
    recordLifecycleEvent(id: WorkContextId, event: WorkContextLifecycleEventInput): WorkContext {
      const existing = byId.get(id);
      if (!existing) throw new Error(`missing WorkContext ${id}`);
      const updated: WorkContext = {
        ...existing,
        artifacts: event.artifacts ? [...existing.artifacts, ...event.artifacts] : existing.artifacts,
        updatedAt: now,
      };
      byId.set(id, updated);
      return updated;
    },
  };
  return store as unknown as WorkContextStore;
}

function tmpStore(): { root: string; store: WorkContextArtifactStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-context-artifact-router-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createWorkContextArtifactStore({
    dbPath: path.join(root, 'work-context-artifacts.db'),
    payloadRoot: path.join(root, 'payloads'),
  });
  cleanup.push(() => store.close());
  return { root, store };
}

async function serve(input: {
  store: WorkContextArtifactStore | null;
  workContextStore: WorkContextStore;
  root: string;
  maxPublishBytes?: number;
  maxExportBytes?: number;
  requireReadAuth?: Parameters<typeof createWorkContextArtifactRouter>[0]['requireReadAuth'];
  requireWriteAuth?: express.RequestHandler;
}): Promise<{ baseUrl: string; server: http.Server }> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(
    createWorkContextArtifactRouter({
      store: input.store,
      workContextStore: input.workContextStore,
      ...(input.requireReadAuth ? { requireReadAuth: input.requireReadAuth } : {}),
      ...(input.requireWriteAuth ? { requireWriteAuth: input.requireWriteAuth } : {}),
      diagnostics: {
        dbPath: path.join(input.root, 'work-context-artifacts.db'),
        payloadRoot: path.join(input.root, 'payloads'),
        ...(input.maxPublishBytes !== undefined ? { maxPublishBytes: input.maxPublishBytes } : {}),
        ...(input.maxExportBytes !== undefined ? { maxExportBytes: input.maxExportBytes } : {}),
      },
    })
  );
  const server = app.listen(0);
  cleanup.push(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('server did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function actorHeaders(command: string, capabilities = 'context:read'): Record<string, string> {
  return {
    authorization: 'Bearer relay-sac-v1.test-credential.[REDACTED]',
    'x-relay-cli-gateway': 'v1',
    'x-relay-cli-actor-token': 'v1',
    'x-relay-cli-command': command,
    'x-relay-capabilities': capabilities,
  };
}

function actorReadAuth(expectedCommand: ArtifactReadCommand): express.RequestHandler {
  return (req, res, next) => {
    if (req.header('x-relay-cli-actor-token') !== 'v1') {
      next();
      return;
    }
    if (
      req.header('x-relay-cli-gateway') === 'v1' &&
      req.header('x-relay-cli-command') === expectedCommand &&
      (req.header('authorization') ?? '').startsWith('Bearer relay-sac-v1.')
    ) {
      next();
      return;
    }
    res.status(401).json({ error: { code: 'UNAUTHORIZED', expectedCommand } });
  };
}

const actorWriteAuth: express.RequestHandler = (req, res, next) => {
  if (req.header('x-relay-cli-actor-token') === 'v1') {
    res.status(403).json({
      error: 'Forbidden',
      code: 'CLI_GATEWAY_ACTOR_WRITE_UNSUPPORTED',
    });
    return;
  }
  next();
};

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

describe('WorkContext artifact router', () => {
  it('accepts actor-token reads and rejects actor-token writes through route-specific auth', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-actor-token';
    const workContextStore = fakeWorkContextStore(createWorkContext(workContextId));
    const stored = store.storePipelineHandoffArtifact({
      workContextId,
      visibility: 'public',
      artifact: artifact({ id: 'pipeline-handoff:router:actor-token' }),
    });
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore,
      requireReadAuth: {
        list: actorReadAuth('work-context-artifacts.list'),
        show: actorReadAuth('work-context-artifacts.show'),
        export: actorReadAuth('work-context-artifacts.export'),
        doctor: actorReadAuth('work-context-artifacts.doctor'),
      },
      requireWriteAuth: actorWriteAuth,
    });

    const list = await fetch(
      `${baseUrl}/work-context-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      { headers: actorHeaders('work-context-artifacts.list') }
    );
    expect(list.status).toBe(200);
    expect((await json(list)).artifacts).toHaveLength(1);

    const show = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}`,
      { headers: actorHeaders('work-context-artifacts.show') }
    );
    expect(show.status).toBe(200);
    expect(await json(show)).toMatchObject({ artifact: { metadata: { id: stored.metadata.id } } });

    const exported = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}/export`,
      { headers: actorHeaders('work-context-artifacts.export') }
    );
    expect(exported.status).toBe(200);
    expect(await json(exported)).toMatchObject({
      export: { mode: 'public-summary', rawPayloadAvailable: false },
    });

    const doctor = await fetch(`${baseUrl}/work-context-artifacts/doctor`, {
      headers: actorHeaders('work-context-artifacts.doctor'),
    });
    expect(doctor.status).toBe(200);

    const publish = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...actorHeaders('work-context-artifacts.publish', 'context:write,context:read'),
      },
      body: JSON.stringify({ workContextId, artifact: artifact({ id: 'pipeline-handoff:router:denied' }) }),
    });
    expect(publish.status).toBe(403);
    expect(await json(publish)).toMatchObject({ code: 'CLI_GATEWAY_ACTOR_WRITE_UNSUPPORTED' });

    const pin = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}/pin`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...actorHeaders('work-context-artifacts.pin', 'context:write,context:read'),
        },
        body: JSON.stringify({ workContextId }),
      }
    );
    expect(pin.status).toBe(403);

    const unpin = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}/unpin`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...actorHeaders('work-context-artifacts.unpin', 'context:write,context:read'),
        },
        body: JSON.stringify({ workContextId }),
      }
    );
    expect(unpin.status).toBe(403);
  });

  it('attaches, lists, shows, and copies handoff artifacts on dedicated route/auth names', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-handoff';
    const workContextStore = fakeWorkContextStore(createWorkContext(workContextId));
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore,
      requireReadAuth: {
        handoffList: actorReadAuth('handoff-artifacts.list'),
        handoffShow: actorReadAuth('handoff-artifacts.show'),
        handoffCopy: actorReadAuth('handoff-artifacts.copy'),
      },
      requireWriteAuth: actorWriteAuth,
    });
    const attachedArtifact = artifact({ id: 'pipeline-handoff:router:handoff-attach' });
    const attach = await fetch(`${baseUrl}/pipeline-handoff-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write,context:read',
      },
      body: JSON.stringify({
        workContextId,
        artifact: attachedArtifact,
        stage: 'implementation',
        visibility: 'public',
        actorId: 'agent:kani-backend',
      }),
    });
    expect(attach.status).toBe(201);
    expect(await json(attach)).toMatchObject({
      artifact: { metadata: { id: attachedArtifact.id, workContextId, stage: 'implementation' } },
    });

    const wrongLane = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      { headers: actorHeaders('work-context-artifacts.list') }
    );
    expect(wrongLane.status).toBe(401);
    expect(await json(wrongLane)).toMatchObject({ error: { expectedCommand: 'handoff-artifacts.list' } });

    const list = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      { headers: actorHeaders('handoff-artifacts.list') }
    );
    expect(list.status).toBe(200);
    expect((await json(list)).artifacts).toHaveLength(1);

    const show = await fetch(`${baseUrl}/pipeline-handoff-artifacts/${encodeURIComponent(attachedArtifact.id)}`, {
      headers: actorHeaders('handoff-artifacts.show'),
    });
    expect(show.status).toBe(200);
    expect(await json(show)).toMatchObject({ artifact: { payload: { id: attachedArtifact.id } } });

    const copied = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts/${encodeURIComponent(attachedArtifact.id)}/copy`,
      { headers: actorHeaders('handoff-artifacts.copy') }
    );
    expect(copied.status).toBe(200);
    expect(await json(copied)).toMatchObject({
      artifact: { metadata: { id: attachedArtifact.id } },
      copy: { mode: 'public-summary', rawPayloadAvailable: false },
    });

    const qaStage: PipelineHandoffArtifact['stages'][number] = {
      stage: 'qa',
      addedAt: now,
      actorId: 'agent:kame-qa',
      summary: 'added qa layer',
      acceptanceEvidence: [
        { label: 'router', disposition: 'provided', summary: 'append-only route exercised' },
      ],
      commands: [],
      downstreamFocus: ['review handoff artifact lane'],
      nonGoals: [],
      verdict: 'passed',
      testedHeadSha: headSha,
      findings: [],
    };

    const appendEquivalentArtifact = artifact({
      id: 'pipeline-handoff:router:handoff-append-reordered',
      stages: [
        reorderJsonObjectKeys(attachedArtifact.stages[0]) as PipelineHandoffArtifact['stages'][number],
        qaStage,
      ],
    });
    const appendEquivalent = await fetch(`${baseUrl}/pipeline-handoff-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write,context:read',
      },
      body: JSON.stringify({
        workContextId,
        artifact: appendEquivalentArtifact,
        supersedesArtifactId: attachedArtifact.id,
      }),
    });
    expect(appendEquivalent.status).toBe(201);

    const appendViolationArtifact = artifact({
      id: 'pipeline-handoff:router:handoff-append-violation',
      stages: [
        { ...attachedArtifact.stages[0]!, summary: 'mutated original implementation layer' },
        qaStage,
      ],
    });
    const appendViolation = await fetch(`${baseUrl}/pipeline-handoff-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write,context:read',
      },
      body: JSON.stringify({
        workContextId,
        artifact: appendViolationArtifact,
        supersedesArtifactId: attachedArtifact.id,
      }),
    });
    expect(appendViolation.status).toBe(400);
    expect(await json(appendViolation)).toMatchObject({
      error: { details: { reasonCode: 'WORK_CONTEXT_ARTIFACT_APPEND_ONLY_VIOLATION', operation: 'attach' } },
    });
  });

  it('publishes, lists, shows, pins, unpins, exports, and doctors artifacts', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router';
    const workContextStore = fakeWorkContextStore(createWorkContext(workContextId));
    const { baseUrl } = await serve({ root, store, workContextStore });
    const headers = {
      'Content-Type': 'application/json',
      'x-relay-capabilities': 'context:write,context:read',
    };

    const publish = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workContextId,
        artifact: artifact(),
        taskRef: { kind: 'github-issue', id: '890' },
        stage: 'implementation',
        visibility: 'public',
        pin: true,
        actorId: 'agent:kani-backend',
      }),
    });
    expect(publish.status).toBe(201);
    const publishBody = await json(publish);
    expect(publishBody.pin).toMatchObject({ alreadyPinned: false });

    const list = await fetch(`${baseUrl}/work-context-artifacts?workContextId=${encodeURIComponent(workContextId)}`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    });
    expect(list.status).toBe(200);
    const listBody = await json(list);
    expect((listBody.artifacts as unknown[])).toHaveLength(1);

    const show = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent('pipeline-handoff:router:aaaaaaaa')}?currentHeadSha=${nextHeadSha}`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(show.status).toBe(200);
    const showBody = await json(show);
    expect(showBody.artifact).toMatchObject({
      metadata: { id: 'pipeline-handoff:router:aaaaaaaa', workContextId },
      staleness: { stale: true, artifactHeadSha: headSha, currentHeadSha: nextHeadSha },
    });

    const exported = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent('pipeline-handoff:router:aaaaaaaa')}/export`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(exported.status).toBe(200);
    const exportBody = await json(exported);
    expect(exportBody.export).toMatchObject({ mode: 'public-summary', rawPayloadAvailable: false });

    const doctor = await fetch(`${baseUrl}/work-context-artifacts/doctor`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    });
    expect(doctor.status).toBe(200);
    expect(await json(doctor)).toMatchObject({
      diagnostics: { storage: { artifactCount: 1, integrity: 'read-index-ok' } },
    });

    const unpin = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent('pipeline-handoff:router:aaaaaaaa')}/unpin`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ workContextId, actorId: 'agent:kani-backend' }),
      }
    );
    expect(unpin.status).toBe(200);
    expect(await json(unpin)).toMatchObject({ removed: true, lifecycle: { artifactDeleted: false } });
  });

  it('enforces publish and export guardrails with persisted public bytes', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-guardrails';
    const workContextStore = fakeWorkContextStore(createWorkContext(workContextId));
    const publishArtifact = artifact({
      id: 'pipeline-handoff:router:guardrails',
    });
    const minifiedBytes = Buffer.byteLength(JSON.stringify(publishArtifact), 'utf8');
    const persistedBytes = Buffer.byteLength(JSON.stringify(publishArtifact, null, 2), 'utf8');
    expect(persistedBytes).toBeGreaterThan(minifiedBytes);
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore,
      maxPublishBytes: minifiedBytes,
      maxExportBytes: 16,
    });
    const headers = {
      'Content-Type': 'application/json',
      'x-relay-capabilities': 'context:write,context:read',
    };

    const oversizedPublish = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workContextId, artifact: publishArtifact }),
    });
    expect(oversizedPublish.status).toBe(400);
    expect(await json(oversizedPublish)).toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
        details: {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_OVERSIZE_PAYLOAD',
          payloadBytes: persistedBytes,
          maxBytes: minifiedBytes,
        },
      },
    });

    const publicStored = store.storePipelineHandoffArtifact({
      workContextId,
      visibility: 'public',
      artifact: artifact({ id: 'pipeline-handoff:router:public-export' }),
    });
    const oversizedExport = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(publicStored.metadata.id)}/export`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(oversizedExport.status).toBe(400);
    expect(await json(oversizedExport)).toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
        details: { reasonCode: 'WORK_CONTEXT_ARTIFACT_OVERSIZE_EXPORT', maxBytes: 16 },
      },
    });
  });

  it('distinguishes missing and unsafe public artifact exports', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-export-errors';
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore: fakeWorkContextStore(createWorkContext(workContextId)),
    });

    const missing = await fetch(`${baseUrl}/work-context-artifacts/missing/export`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        details: { reasonCode: 'WORK_CONTEXT_ARTIFACT_NOT_FOUND', operation: 'export' },
      },
    });

    const privateStored = store.storePipelineHandoffArtifact({
      workContextId,
      visibility: 'private',
      artifact: artifact({ id: 'pipeline-handoff:router:private-export' }),
    });
    const forbidden = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(privateStored.metadata.id)}/export`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(forbidden.status).toBe(403);
    expect(await json(forbidden)).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        details: { reasonCode: 'WORK_CONTEXT_ARTIFACT_UNSAFE_PUBLIC_COPY' },
      },
    });
  });

  it('returns stable typed errors for missing capability and stale publish heads', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-errors';
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore: fakeWorkContextStore(createWorkContext(workContextId)),
    });

    const forbidden = await fetch(`${baseUrl}/work-context-artifacts?workContextId=${encodeURIComponent(workContextId)}`);
    expect(forbidden.status).toBe(403);
    expect(await json(forbidden)).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const stale = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write',
      },
      body: JSON.stringify({ workContextId, artifact: artifact(), currentHeadSha: nextHeadSha }),
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({
      error: {
        code: 'SESSION_CONFLICT',
        details: { reasonCode: 'WORK_CONTEXT_ARTIFACT_STALE_HEAD' },
      },
    });
  });
});
