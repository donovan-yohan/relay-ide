import express from 'express';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorkContextArtifactRouter } from '../server/features/work-context-artifact-router.js';
import {
  attachAuthenticatedCliGatewayActorCredential,
  bearerActorToken,
  cliGatewayActorFailure,
  issueCliGatewayActorCredential,
  validateCliGatewayActorCredential,
} from '../server/cli-gateway-actor-auth.js';
import { ScopedActorCredentialRegistry } from '../shared/scoped-actor-credentials.js';
import {
  createWorkContextArtifactStore,
  WorkContextArtifactStoreError,
  type WorkContextArtifactStore,
} from '../server/work-context-artifacts.js';
import type {
  WorkContextStore,
  WorkContextLifecycleEventInput,
  WorkContextPatchInput,
} from '../server/work-contexts.js';
import {
  PIPELINE_HANDOFF_ARTIFACT_SCHEMA_VERSION,
  isPipelineHandoffArtifactStale,
  validatePublicPipelineHandoffArtifact,
  type PipelineHandoffArtifact,
  type PipelineHandoffQaStage,
} from '../shared/pipeline-handoff-artifact.js';
import {
  AGENT_VIEW_MANIFEST_KIND,
  AGENT_VIEW_SCHEMA_VERSION,
  type ViewArtifactPackage,
} from '../shared/agent-view-artifact.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';
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

interface LiveWorkerPatternFixture {
  workContextId: string;
  currentHeadSha: string;
  qaArtifactId: string;
  qaUpdatedAt: string;
  implementationArtifact: PipelineHandoffArtifact;
  qaStage: PipelineHandoffQaStage;
}

type ArtifactReadCommand =
  | 'work-context-artifacts.list'
  | 'work-context-artifacts.show'
  | 'work-context-artifacts.export'
  | 'work-context-artifacts.doctor'
  | 'handoff-artifacts.list'
  | 'handoff-artifacts.show'
  | 'handoff-artifacts.copy';

function loadLiveWorkerPatternFixture(): LiveWorkerPatternFixture {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        process.cwd(),
        'test',
        'fixtures',
        'pipeline-handoff',
        'live-worker-pattern.json'
      ),
      'utf8'
    )
  ) as LiveWorkerPatternFixture;
}

function appendQaArtifact(
  fixture: LiveWorkerPatternFixture
): PipelineHandoffArtifact {
  return {
    ...fixture.implementationArtifact,
    id: fixture.qaArtifactId,
    updatedAt: fixture.qaUpdatedAt,
    stages: [...fixture.implementationArtifact.stages, fixture.qaStage],
  };
}

function artifact(
  input: Partial<PipelineHandoffArtifact> = {}
): PipelineHandoffArtifact {
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
      pr: {
        number: 890,
        url: 'https://github.com/example-org/example-project/pull/890',
      },
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
          {
            label: 'router',
            disposition: 'provided',
            summary: 'express routes exercised',
          },
        ],
        commands: [
          {
            label: 'test',
            command: 'vitest',
            status: 'passed',
            summary: 'router test',
            exitCode: 0,
          },
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

function viewArtifact(
  input: Partial<ViewArtifactPackage> = {}
): ViewArtifactPackage {
  const manifest = {
    kind: AGENT_VIEW_MANIFEST_KIND,
    schemaVersion: AGENT_VIEW_SCHEMA_VERSION,
    title: 'Router static view',
    description: 'Router view artifact fixture',
    entry: 'index.html',
    authoring: { actorId: 'agent:kani-backend', harness: 'router-test' },
    createdAt: now,
    updatedAt: now,
    scope: {
      repo: 'example-org/example-project',
      taskRefs: [
        {
          kind: 'github-issue',
          id: '830',
          url: 'https://github.com/example-org/example-project/issues/830',
        },
      ],
    },
    sources: [
      {
        label: 'Issue 830',
        url: 'https://github.com/example-org/example-project/issues/830',
        kind: 'github-issue',
      },
    ],
    capabilities: [],
    export: { policy: 'private' },
    revision: { id: 'agent-view:router:aaaaaaaa' },
  } satisfies ViewArtifactPackage['manifest'];
  return {
    manifest,
    files: {
      'index.html': '<main><h1>Router static view</h1></main>',
      'style.css': 'main { color: #123; }',
    },
    ...input,
  };
}

function reorderJsonObjectKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item) => reorderJsonObjectKeys(item));
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
  const byId = new Map<WorkContextId, WorkContext>(
    contexts.map((ctx) => [ctx.id, ctx])
  );
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
    recordLifecycleEvent(
      id: WorkContextId,
      event: WorkContextLifecycleEventInput
    ): WorkContext {
      const existing = byId.get(id);
      if (!existing) throw new Error(`missing WorkContext ${id}`);
      const updated: WorkContext = {
        ...existing,
        artifacts: event.artifacts
          ? [...existing.artifacts, ...event.artifacts]
          : existing.artifacts,
        updatedAt: now,
      };
      byId.set(id, updated);
      return updated;
    },
  };
  return store as unknown as WorkContextStore;
}

function tmpStore(): { root: string; store: WorkContextArtifactStore } {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'work-context-artifact-router-')
  );
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
  requireReadAuth?: Parameters<
    typeof createWorkContextArtifactRouter
  >[0]['requireReadAuth'];
  requireWriteAuth?: express.RequestHandler;
  requireWriteActorAuth?: Parameters<
    typeof createWorkContextArtifactRouter
  >[0]['requireWriteActorAuth'];
}): Promise<{ baseUrl: string; server: http.Server }> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(
    createWorkContextArtifactRouter({
      store: input.store,
      workContextStore: input.workContextStore,
      ...(input.requireReadAuth
        ? { requireReadAuth: input.requireReadAuth }
        : {}),
      ...(input.requireWriteAuth
        ? { requireWriteAuth: input.requireWriteAuth }
        : {}),
      ...(input.requireWriteActorAuth
        ? { requireWriteActorAuth: input.requireWriteActorAuth }
        : {}),
      diagnostics: {
        dbPath: path.join(input.root, 'work-context-artifacts.db'),
        payloadRoot: path.join(input.root, 'payloads'),
        ...(input.maxPublishBytes !== undefined
          ? { maxPublishBytes: input.maxPublishBytes }
          : {}),
        ...(input.maxExportBytes !== undefined
          ? { maxExportBytes: input.maxExportBytes }
          : {}),
      },
    })
  );
  const server = app.listen(0);
  cleanup.push(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address)
    throw new Error('server did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function actorHeaders(
  command: string,
  capabilities = 'context:read'
): Record<string, string> {
  return {
    authorization: 'Bearer relay-sac-v1.test-credential.[REDACTED]',
    'x-relay-cli-gateway': 'v1',
    'x-relay-cli-actor-token': 'v1',
    'x-relay-cli-command': command,
    'x-relay-capabilities': capabilities,
  };
}

function actorReadAuth(
  expectedCommand: ArtifactReadCommand
): express.RequestHandler {
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

function actorHeadersWithToken(
  command: string,
  token: string
): Record<string, string> {
  return { ...actorHeaders(command), authorization: `Bearer ${token}` };
}

function scopedActorReadAuth(
  registry: ScopedActorCredentialRegistry,
  expectedCommand: string,
  options: {
    scopeForRequest?: (
      req: express.Request
    ) => { workContextIds?: string[] } | undefined;
    deferWorkContextScope?: boolean;
    capabilities?: readonly RelayCapabilityBit[];
  } = {}
): express.RequestHandler {
  return (req, res, next) => {
    if (req.header('x-relay-cli-actor-token') !== 'v1') {
      next();
      return;
    }
    if (req.header('x-relay-cli-command') !== expectedCommand) {
      res
        .status(401)
        .json({ error: { code: 'UNAUTHORIZED', expectedCommand } });
      return;
    }
    const requestScope = options.scopeForRequest?.(req);
    const validation = validateCliGatewayActorCredential(registry, {
      token: bearerActorToken(req),
      capabilities: options.capabilities ?? ['session:read'],
      ...(requestScope !== undefined ? { scope: requestScope } : {}),
      ...(options.deferWorkContextScope ? { deferWorkContextScope: true } : {}),
    });
    if ('reason' in validation) {
      res
        .status(
          validation.reason === 'missing_scope' ||
            validation.reason.startsWith('wrong_')
            ? 403
            : 401
        )
        .json({
          error: cliGatewayActorFailure({
            reason: validation.reason,
            ...(validation.credentialId !== undefined
              ? { credentialId: validation.credentialId }
              : {}),
          }),
        });
      return;
    }
    attachAuthenticatedCliGatewayActorCredential(req, validation.credential);
    next();
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
    const workContextStore = fakeWorkContextStore(
      createWorkContext(workContextId)
    );
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
    expect(await json(show)).toMatchObject({
      artifact: { metadata: { id: stored.metadata.id } },
    });

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
        ...actorHeaders(
          'work-context-artifacts.publish',
          'artifact:write,context:read'
        ),
      },
      body: JSON.stringify({
        workContextId,
        artifact: artifact({ id: 'pipeline-handoff:router:denied' }),
      }),
    });
    expect(publish.status).toBe(403);
    expect(await json(publish)).toMatchObject({
      code: 'CLI_GATEWAY_ACTOR_WRITE_UNSUPPORTED',
    });

    const pin = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}/pin`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...actorHeaders(
            'work-context-artifacts.pin',
            'artifact:write,context:read'
          ),
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
          ...actorHeaders(
            'work-context-artifacts.unpin',
            'artifact:write,context:read'
          ),
        },
        body: JSON.stringify({ workContextId }),
      }
    );
    expect(unpin.status).toBe(403);
  });

  it('honors actor credential workContextIds for list and deferred show reads', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-scoped-allowed';
    const wrongWorkContextId = 'wc:router-scoped-denied';
    const workContextStore = fakeWorkContextStore(
      createWorkContext(workContextId),
      createWorkContext(wrongWorkContextId)
    );
    const stored = store.storePipelineHandoffArtifact({
      workContextId,
      visibility: 'public',
      artifact: artifact({ id: 'pipeline-handoff:router:scoped-allowed' }),
    });
    const registry = new ScopedActorCredentialRegistry({
      secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
    });
    const allowed = issueCliGatewayActorCredential(registry, {
      scope: { workContextIds: [workContextId] },
    });
    const denied = issueCliGatewayActorCredential(registry, {
      scope: { workContextIds: [wrongWorkContextId] },
    });
    const scopeForRequest = (
      req: express.Request
    ): { workContextIds?: string[] } | undefined => {
      const raw = req.query['workContextId'];
      return typeof raw === 'string' && raw
        ? { workContextIds: [raw] }
        : undefined;
    };
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore,
      requireReadAuth: {
        list: scopedActorReadAuth(registry, 'work-context-artifacts.list', {
          scopeForRequest,
        }),
        show: scopedActorReadAuth(registry, 'work-context-artifacts.show', {
          deferWorkContextScope: true,
        }),
      },
    });

    const list = await fetch(
      `${baseUrl}/work-context-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      {
        headers: actorHeadersWithToken(
          'work-context-artifacts.list',
          allowed.token
        ),
      }
    );
    expect(list.status).toBe(200);
    expect((await json(list)).artifacts).toHaveLength(1);

    const wrongList = await fetch(
      `${baseUrl}/work-context-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      {
        headers: actorHeadersWithToken(
          'work-context-artifacts.list',
          denied.token
        ),
      }
    );
    expect(wrongList.status).toBe(403);
    expect(await json(wrongList)).toMatchObject({
      error: { reasonCode: 'CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE' },
    });

    const show = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}`,
      {
        headers: actorHeadersWithToken(
          'work-context-artifacts.show',
          allowed.token
        ),
      }
    );
    expect(show.status).toBe(200);
    expect(await json(show)).toMatchObject({
      artifact: { metadata: { workContextId } },
    });

    const wrongShow = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}`,
      {
        headers: actorHeadersWithToken(
          'work-context-artifacts.show',
          denied.token
        ),
      }
    );
    expect(wrongShow.status).toBe(403);
    expect(await json(wrongShow)).toMatchObject({
      error: { details: { reasonCode: 'CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE' } },
    });
  });

  it('denies scoped actor pin and unpin writes outside the credential WorkContext scope', async () => {
    const { root, store } = tmpStore();
    const allowedWorkContextId = 'wc:router-scoped-write-allowed';
    const deniedWorkContextId = 'wc:router-scoped-write-denied';
    const workContextStore = fakeWorkContextStore(
      createWorkContext(allowedWorkContextId),
      createWorkContext(deniedWorkContextId)
    );
    const stored = store.storePipelineHandoffArtifact({
      workContextId: allowedWorkContextId,
      visibility: 'public',
      artifact: artifact({ id: 'pipeline-handoff:router:scoped-write' }),
    });
    const registry = new ScopedActorCredentialRegistry({
      secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
    });
    const allowed = issueCliGatewayActorCredential(registry, {
      capabilities: ['artifact:write'],
      scope: { workContextIds: [allowedWorkContextId] },
    });
    const requireWriteActorAuth: Parameters<
      typeof createWorkContextArtifactRouter
    >[0]['requireWriteActorAuth'] = (command, options) =>
      scopedActorReadAuth(registry, command, {
        capabilities: ['artifact:write'],
        ...(options?.scopeForRequest
          ? { scopeForRequest: options.scopeForRequest }
          : {}),
        ...(options?.deferWorkContextScope
          ? { deferWorkContextScope: true }
          : {}),
      });
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore,
      requireWriteActorAuth,
    });

    const pin = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}/pin`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...actorHeadersWithToken('work-context-artifacts.pin', allowed.token),
        },
        body: JSON.stringify({ workContextId: deniedWorkContextId }),
      }
    );
    expect(pin.status).toBe(403);
    expect(await json(pin)).toMatchObject({
      error: { details: { reasonCode: 'CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE' } },
    });
    expect(workContextStore.get(deniedWorkContextId)?.artifacts).toHaveLength(
      0
    );

    const unpin = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}/unpin`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...actorHeadersWithToken(
            'work-context-artifacts.unpin',
            allowed.token
          ),
        },
        body: JSON.stringify({ workContextId: deniedWorkContextId }),
      }
    );
    expect(unpin.status).toBe(403);
    expect(await json(unpin)).toMatchObject({
      error: { details: { reasonCode: 'CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE' } },
    });
    expect(workContextStore.get(deniedWorkContextId)?.artifacts).toHaveLength(
      0
    );
  });

  it('denies scoped actor pin and unpin writes when stored artifact metadata is outside the credential WorkContext scope', async () => {
    const { root, store } = tmpStore();
    const allowedWorkContextId = 'wc:router-stored-scope-allowed';
    const deniedWorkContextId = 'wc:router-stored-scope-denied';
    const workContextStore = fakeWorkContextStore(
      createWorkContext(allowedWorkContextId),
      createWorkContext(deniedWorkContextId)
    );
    const stored = store.storePipelineHandoffArtifact({
      workContextId: deniedWorkContextId,
      visibility: 'public',
      artifact: artifact({ id: 'pipeline-handoff:router:stored-scope-denied' }),
    });
    const registry = new ScopedActorCredentialRegistry({
      secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
    });
    const allowedWrite = issueCliGatewayActorCredential(registry, {
      capabilities: ['artifact:write'],
      scope: { workContextIds: [allowedWorkContextId] },
    });
    const allowedRead = issueCliGatewayActorCredential(registry, {
      scope: { workContextIds: [allowedWorkContextId] },
    });
    const requireWriteActorAuth: Parameters<
      typeof createWorkContextArtifactRouter
    >[0]['requireWriteActorAuth'] = (command, options) =>
      scopedActorReadAuth(registry, command, {
        capabilities: ['artifact:write'],
        ...(options?.scopeForRequest
          ? { scopeForRequest: options.scopeForRequest }
          : {}),
        ...(options?.deferWorkContextScope
          ? { deferWorkContextScope: true }
          : {}),
      });
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore,
      requireReadAuth: {
        show: scopedActorReadAuth(registry, 'work-context-artifacts.show', {
          capabilities: ['session:read'],
          deferWorkContextScope: true,
        }),
      },
      requireWriteActorAuth,
    });

    const crossContextPin = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}/pin`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...actorHeadersWithToken(
            'work-context-artifacts.pin',
            allowedWrite.token
          ),
        },
        body: JSON.stringify({ workContextId: allowedWorkContextId }),
      }
    );
    expect(crossContextPin.status).toBe(403);
    const crossContextPinBody = await json(crossContextPin);
    expect(crossContextPinBody).toMatchObject({
      error: { details: { reasonCode: 'CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE' } },
    });
    expect(
      (crossContextPinBody.error as { details: Record<string, unknown> })
        .details.workContextId
    ).toBeUndefined();
    expect(crossContextPinBody.artifact).toBeUndefined();
    expect(workContextStore.get(allowedWorkContextId)?.artifacts).toHaveLength(
      0
    );

    const crossContextShow = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}`,
      {
        headers: actorHeadersWithToken(
          'work-context-artifacts.show',
          allowedRead.token
        ),
      }
    );
    expect(crossContextShow.status).toBe(403);
    const crossContextShowBody = await json(crossContextShow);
    expect(crossContextShowBody).toMatchObject({
      error: { details: { reasonCode: 'CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE' } },
    });
    expect(
      (crossContextShowBody.error as { details: Record<string, unknown> })
        .details.workContextId
    ).toBeUndefined();
    expect(crossContextShowBody.artifact).toBeUndefined();

    const operatorPin = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}/pin`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'artifact:write',
        },
        body: JSON.stringify({ workContextId: allowedWorkContextId }),
      }
    );
    expect(operatorPin.status).toBe(201);
    expect(workContextStore.get(allowedWorkContextId)?.artifacts).toHaveLength(
      1
    );

    const crossContextUnpin = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(stored.metadata.id)}/unpin`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...actorHeadersWithToken(
            'work-context-artifacts.unpin',
            allowedWrite.token
          ),
        },
        body: JSON.stringify({ workContextId: allowedWorkContextId }),
      }
    );
    expect(crossContextUnpin.status).toBe(403);
    const crossContextUnpinBody = await json(crossContextUnpin);
    expect(crossContextUnpinBody).toMatchObject({
      error: { details: { reasonCode: 'CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE' } },
    });
    expect(
      (crossContextUnpinBody.error as { details: Record<string, unknown> })
        .details.workContextId
    ).toBeUndefined();
    expect(workContextStore.get(allowedWorkContextId)?.artifacts).toHaveLength(
      1
    );
  });

  it('attaches, lists, shows, and copies handoff artifacts on dedicated route/auth names', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-handoff';
    const workContextStore = fakeWorkContextStore(
      createWorkContext(workContextId)
    );
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
    const attachedArtifact = artifact({
      id: 'pipeline-handoff:router:handoff-attach',
    });
    const attach = await fetch(`${baseUrl}/pipeline-handoff-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'artifact:write,context:read',
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
      artifact: {
        metadata: {
          id: attachedArtifact.id,
          workContextId,
          stage: 'implementation',
        },
      },
    });

    const wrongLane = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      { headers: actorHeaders('work-context-artifacts.list') }
    );
    expect(wrongLane.status).toBe(401);
    expect(await json(wrongLane)).toMatchObject({
      error: { expectedCommand: 'handoff-artifacts.list' },
    });

    const list = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      { headers: actorHeaders('handoff-artifacts.list') }
    );
    expect(list.status).toBe(200);
    expect((await json(list)).artifacts).toHaveLength(1);

    const show = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts/${encodeURIComponent(attachedArtifact.id)}`,
      {
        headers: actorHeaders('handoff-artifacts.show'),
      }
    );
    expect(show.status).toBe(200);
    expect(await json(show)).toMatchObject({
      artifact: { payload: { id: attachedArtifact.id } },
    });

    const copied = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts/${encodeURIComponent(attachedArtifact.id)}/copy`,
      { headers: actorHeaders('handoff-artifacts.copy') }
    );
    expect(copied.status).toBe(200);
    expect(await json(copied)).toMatchObject({
      artifact: { metadata: { id: attachedArtifact.id } },
      copy: { mode: 'public-summary', rawPayloadAvailable: false },
    });

    const copiedWithSlash = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts/${encodeURIComponent(attachedArtifact.id)}/copy/`,
      { headers: actorHeaders('handoff-artifacts.copy') }
    );
    expect(copiedWithSlash.status).toBe(200);
    expect(await json(copiedWithSlash)).toMatchObject({
      artifact: { metadata: { id: attachedArtifact.id } },
      copy: { mode: 'public-summary', rawPayloadAvailable: false },
    });

    const qaStage: PipelineHandoffArtifact['stages'][number] = {
      stage: 'qa',
      addedAt: now,
      actorId: 'agent:kame-qa',
      summary: 'added qa layer',
      acceptanceEvidence: [
        {
          label: 'router',
          disposition: 'provided',
          summary: 'append-only route exercised',
        },
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
      supersedesArtifactId: attachedArtifact.id,
      stages: [
        reorderJsonObjectKeys(
          attachedArtifact.stages[0]
        ) as PipelineHandoffArtifact['stages'][number],
        qaStage,
      ],
    });
    const appendEquivalent = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'artifact:write,context:read',
        },
        body: JSON.stringify({
          workContextId,
          artifact: appendEquivalentArtifact,
        }),
      }
    );
    expect(appendEquivalent.status).toBe(201);
    expect(await json(appendEquivalent)).toMatchObject({
      artifact: {
        metadata: { supersedesArtifactId: attachedArtifact.id },
      },
    });

    const mismatchedPredecessor = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'artifact:write,context:read',
        },
        body: JSON.stringify({
          workContextId,
          artifact: {
            ...appendEquivalentArtifact,
            id: 'pipeline-handoff:router:handoff-mismatch',
          },
          supersedesArtifactId: 'pipeline-handoff:router:other',
        }),
      }
    );
    expect(mismatchedPredecessor.status).toBe(400);
    expect(await json(mismatchedPredecessor)).toMatchObject({
      error: {
        details: {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_VALIDATION_FAILED',
          operation: 'attach',
        },
      },
    });

    const appendViolationArtifact = artifact({
      id: 'pipeline-handoff:router:handoff-append-violation',
      stages: [
        {
          ...attachedArtifact.stages[0]!,
          summary: 'mutated original implementation layer',
        },
        qaStage,
      ],
    });
    const appendViolation = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'artifact:write,context:read',
        },
        body: JSON.stringify({
          workContextId,
          artifact: appendViolationArtifact,
          supersedesArtifactId: attachedArtifact.id,
        }),
      }
    );
    expect(appendViolation.status).toBe(400);
    expect(await json(appendViolation)).toMatchObject({
      error: {
        details: {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_APPEND_ONLY_VIOLATION',
          operation: 'attach',
        },
      },
    });
  });

  it('live-worker-pattern attaches implementation and appends QA through handoff-artifacts surface', async () => {
    const fixture = loadLiveWorkerPatternFixture();
    const qaArtifact = appendQaArtifact(fixture);
    const { root, store } = tmpStore();
    const workContextStore = fakeWorkContextStore(
      createWorkContext(fixture.workContextId)
    );
    const { baseUrl } = await serve({ root, store, workContextStore });
    const headers = {
      'Content-Type': 'application/json',
      'x-relay-capabilities': 'artifact:write,context:read',
    };

    for (const artifactLayer of [fixture.implementationArtifact, qaArtifact]) {
      const publicValidation =
        validatePublicPipelineHandoffArtifact(artifactLayer);
      expect(publicValidation.errors).toEqual([]);
      expect(publicValidation.valid).toBe(true);
      expect(artifactLayer.head.pr).toEqual(
        fixture.implementationArtifact.head.pr
      );
      expect(artifactLayer.head.headSha).toBe(fixture.currentHeadSha);
      expect(artifactLayer.head.staleIf).toEqual({ headShaChanges: true });
      expect(
        isPipelineHandoffArtifactStale(artifactLayer, fixture.currentHeadSha)
      ).toBe(false);
      expect(JSON.stringify(artifactLayer)).not.toMatch(
        /\/home\/|\/Users\/|t_[0-9a-f]{8}|OPENAI_API_KEY|rawTranscript|dispatcher/i
      );
    }

    const implementationAttach = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workContextId: fixture.workContextId,
          artifact: fixture.implementationArtifact,
          stage: 'implementation',
          visibility: 'public',
          currentHeadSha: fixture.currentHeadSha,
        }),
      }
    );
    expect(implementationAttach.status).toBe(201);
    expect(await json(implementationAttach)).toMatchObject({
      artifact: {
        metadata: {
          id: fixture.implementationArtifact.id,
          workContextId: fixture.workContextId,
          stage: 'implementation',
          headSha: fixture.currentHeadSha,
        },
        staleness: { stale: false, currentHeadSha: fixture.currentHeadSha },
      },
    });

    const qaAppend = await fetch(`${baseUrl}/pipeline-handoff-artifacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workContextId: fixture.workContextId,
        artifact: qaArtifact,
        stage: 'qa',
        visibility: 'public',
        currentHeadSha: fixture.currentHeadSha,
        supersedesArtifactId: fixture.implementationArtifact.id,
      }),
    });
    expect(qaAppend.status).toBe(201);
    expect(await json(qaAppend)).toMatchObject({
      artifact: {
        metadata: {
          id: qaArtifact.id,
          workContextId: fixture.workContextId,
          stage: 'qa',
          supersedesArtifactId: fixture.implementationArtifact.id,
          headSha: fixture.currentHeadSha,
        },
        staleness: { stale: false, currentHeadSha: fixture.currentHeadSha },
      },
    });

    const showQa = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts/${encodeURIComponent(qaArtifact.id)}?currentHeadSha=${fixture.currentHeadSha}`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(showQa.status).toBe(200);
    expect(await json(showQa)).toMatchObject({
      artifact: {
        payload: { stages: [{ stage: 'implementation' }, { stage: 'qa' }] },
        staleness: { stale: false, currentHeadSha: fixture.currentHeadSha },
      },
    });
  });

  it('publishes, lists, shows, pins, unpins, exports, and doctors artifacts', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router';
    const workContextStore = fakeWorkContextStore(
      createWorkContext(workContextId)
    );
    const { baseUrl } = await serve({ root, store, workContextStore });
    const headers = {
      'Content-Type': 'application/json',
      'x-relay-capabilities': 'artifact:write,context:read',
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

    const list = await fetch(
      `${baseUrl}/work-context-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      {
        headers: { 'x-relay-capabilities': 'context:read' },
      }
    );
    expect(list.status).toBe(200);
    const listBody = await json(list);
    expect(listBody.artifacts as unknown[]).toHaveLength(1);

    const show = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent('pipeline-handoff:router:aaaaaaaa')}?currentHeadSha=${nextHeadSha}`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(show.status).toBe(200);
    const showBody = await json(show);
    expect(showBody.artifact).toMatchObject({
      metadata: { id: 'pipeline-handoff:router:aaaaaaaa', workContextId },
      staleness: {
        stale: true,
        artifactHeadSha: headSha,
        currentHeadSha: nextHeadSha,
      },
    });

    const exported = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent('pipeline-handoff:router:aaaaaaaa')}/export`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(exported.status).toBe(200);
    const exportBody = await json(exported);
    expect(exportBody.export).toMatchObject({
      mode: 'public-summary',
      rawPayloadAvailable: false,
    });

    const doctor = await fetch(`${baseUrl}/work-context-artifacts/doctor`, {
      headers: { 'x-relay-capabilities': 'context:read' },
    });
    expect(doctor.status).toBe(200);
    expect(await json(doctor)).toMatchObject({
      diagnostics: {
        storage: { artifactCount: 1, integrity: 'read-index-ok' },
      },
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
    expect(await json(unpin)).toMatchObject({
      removed: true,
      lifecycle: { artifactDeleted: false },
    });
  });

  it('maps agent view store contention to a retryable 503 envelope', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-view-busy';
    const busyStore: WorkContextArtifactStore = {
      ...store,
      storeAgentViewArtifact() {
        throw new WorkContextArtifactStoreError(503, 'artifact_store_busy');
      },
    };
    const { baseUrl } = await serve({
      root,
      store: busyStore,
      workContextStore: fakeWorkContextStore(createWorkContext(workContextId)),
    });

    const response = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'artifact:write,context:read',
      },
      body: JSON.stringify({ workContextId, viewArtifact: viewArtifact() }),
    });

    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({
      error: {
        code: 'SERVER_UNAVAILABLE',
        retryable: true,
        details: {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_STORE_BUSY',
          storeCode: 'artifact_store_busy',
        },
      },
    });
  });

  it('publishes agent view artifacts and exposes an authenticated package route', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-view';
    const workContextStore = fakeWorkContextStore(
      createWorkContext(workContextId)
    );
    const { baseUrl } = await serve({ root, store, workContextStore });
    const pkg = viewArtifact();

    const publish = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'artifact:write,context:read',
      },
      body: JSON.stringify({
        workContextId,
        viewArtifact: pkg,
        pin: true,
        actorId: 'agent:kani-backend',
      }),
    });
    expect(publish.status).toBe(201);
    const publishBody = await json(publish);
    expect(publishBody).toMatchObject({
      artifact: {
        metadata: {
          id: pkg.manifest.revision.id,
          payloadKind: 'agent-view-artifact',
          workContextId,
        },
      },
      pin: { alreadyPinned: false },
    });
    const payloadJson = JSON.stringify(pkg, null, 2);
    expect(
      (publishBody.artifact as { metadata: Record<string, unknown> }).metadata
        .payloadSha256
    ).toBe(createHash('sha256').update(payloadJson).digest('hex'));

    const packageRead = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(pkg.manifest.revision.id)}/view-package`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(packageRead.status).toBe(200);
    expect(await json(packageRead)).toMatchObject({
      artifact: {
        metadata: {
          id: pkg.manifest.revision.id,
          payloadKind: 'agent-view-artifact',
        },
        viewArtifact: {
          manifest: { revision: { id: pkg.manifest.revision.id } },
          files: pkg.files,
        },
      },
    });
  });

  it('rejects ambiguous publish payloads and keeps handoff routes handoff-only', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-view-xor';
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore: fakeWorkContextStore(createWorkContext(workContextId)),
    });
    const headers = {
      'Content-Type': 'application/json',
      'x-relay-capabilities': 'artifact:write,context:read',
    };

    const conflict = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workContextId,
        artifact: artifact(),
        viewArtifact: viewArtifact(),
      }),
    });
    expect(conflict.status).toBe(400);
    expect(await json(conflict)).toMatchObject({
      error: {
        details: { reasonCode: 'WORK_CONTEXT_ARTIFACT_PAYLOAD_CONFLICT' },
      },
    });

    const wrongSurface = await fetch(`${baseUrl}/pipeline-handoff-artifacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workContextId, viewArtifact: viewArtifact() }),
    });
    expect(wrongSurface.status).toBe(400);
    expect(await json(wrongSurface)).toMatchObject({
      error: {
        details: {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_KIND_MISMATCH',
          operation: 'attach',
        },
      },
    });
  });

  it('rejects cross-kind view supersession without hiding the handoff route', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-cross-kind';
    const handoff = store.storePipelineHandoffArtifact({
      workContextId,
      artifact: artifact({ id: 'pipeline-handoff:router:cross-kind' }),
    });
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore: fakeWorkContextStore(createWorkContext(workContextId)),
    });
    const pkg = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        revision: {
          id: 'agent-view:router:cross-kind',
          supersedes: handoff.metadata.id,
        },
      },
    });

    const publish = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'artifact:write,context:read',
      },
      body: JSON.stringify({ workContextId, viewArtifact: pkg }),
    });
    expect(publish.status).toBe(404);
    expect(await json(publish)).toMatchObject({
      error: {
        details: {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_SUPERSEDES_NOT_FOUND',
          storeCode: 'superseded_artifact_payload_kind_mismatch',
        },
      },
    });

    const list = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(list.status).toBe(200);
    expect(await json(list)).toMatchObject({
      artifacts: [{ metadata: { id: handoff.metadata.id } }],
    });
  });

  it('keeps agent view artifacts out of pipeline handoff list/show surfaces', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-handoff-filter';
    const handoff = store.storePipelineHandoffArtifact({
      workContextId,
      artifact: artifact(),
    });
    const view = store.storeAgentViewArtifact({
      workContextId,
      viewArtifact: viewArtifact(),
    });
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore: fakeWorkContextStore(createWorkContext(workContextId)),
    });
    const readHeaders = { 'x-relay-capabilities': 'context:read' };

    const handoffList = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      {
        headers: readHeaders,
      }
    );
    expect(handoffList.status).toBe(200);
    const handoffListBody = await json(handoffList);
    expect(
      (handoffListBody.artifacts as Array<{ metadata: { id: string } }>).map(
        (entry) => entry.metadata.id
      )
    ).toEqual([handoff.metadata.id]);

    const allList = await fetch(
      `${baseUrl}/work-context-artifacts?workContextId=${encodeURIComponent(workContextId)}`,
      {
        headers: readHeaders,
      }
    );
    expect(allList.status).toBe(200);
    expect((await json(allList)).artifacts as unknown[]).toHaveLength(2);

    const viewViaHandoffRoute = await fetch(
      `${baseUrl}/pipeline-handoff-artifacts/${encodeURIComponent(view.metadata.id)}`,
      {
        headers: readHeaders,
      }
    );
    expect(viewViaHandoffRoute.status).toBe(404);
  });

  it('rejects unsafe or oversized agent view artifact publishes', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-view-guardrails';
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore: fakeWorkContextStore(createWorkContext(workContextId)),
    });
    const headers = {
      'Content-Type': 'application/json',
      'x-relay-capabilities': 'artifact:write,context:read',
    };

    const withCapabilities = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        revision: { id: 'agent-view:router:capabilities' },
        capabilities: ['network'],
      },
    });
    const denied = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workContextId, viewArtifact: withCapabilities }),
    });
    expect(denied.status).toBe(400);
    expect(await json(denied)).toMatchObject({
      error: {
        details: {
          field: 'viewArtifact',
          reasonCode: 'WORK_CONTEXT_ARTIFACT_VALIDATION_FAILED',
        },
      },
    });

    const oversizedFiles = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [
        `chunk-${index}.css`,
        'x'.repeat(40 * 1024),
      ])
    );
    const oversized = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        revision: { id: 'agent-view:router:oversized' },
      },
      files: { 'index.html': '<main>oversized</main>', ...oversizedFiles },
    });
    const oversizedPublish = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workContextId, viewArtifact: oversized }),
    });
    expect(oversizedPublish.status).toBe(400);
    expect(await json(oversizedPublish)).toMatchObject({
      error: {
        details: { reasonCode: 'WORK_CONTEXT_ARTIFACT_VIEW_OVERSIZE_PAYLOAD' },
      },
    });
  });

  it('exports agent view artifacts as sanitized manifest-only public copies', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-view-export';
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore: fakeWorkContextStore(createWorkContext(workContextId)),
    });
    const privateStored = store.storeAgentViewArtifact({
      workContextId,
      viewArtifact: viewArtifact({
        manifest: {
          ...viewArtifact().manifest,
          revision: { id: 'agent-view:router:private-export' },
        },
      }),
    });
    const privateExport = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(privateStored.metadata.id)}/export`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(privateExport.status).toBe(403);

    const publicPkg = viewArtifact({
      manifest: {
        ...viewArtifact().manifest,
        description:
          'Public route from /home/operator/relay with t_12345678 scratch id',
        export: { policy: 'public' },
        revision: { id: 'agent-view:router:public-export' },
      },
      files: {
        'index.html':
          '<main>private raw html /home/operator/relay t_12345678</main>',
      },
    });
    const publicStored = store.storeAgentViewArtifact({
      workContextId,
      viewArtifact: publicPkg,
    });
    const publicExport = await fetch(
      `${baseUrl}/work-context-artifacts/${encodeURIComponent(publicStored.metadata.id)}/export`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(publicExport.status).toBe(200);
    const publicBody = await json(publicExport);
    expect(publicBody).toMatchObject({
      artifact: {
        metadata: {
          id: publicStored.metadata.id,
          payloadKind: 'agent-view-artifact',
        },
        payload: {
          manifest: { revision: { id: 'agent-view:router:public-export' } },
        },
      },
      export: { mode: 'public-summary', rawPayloadAvailable: false },
    });
    expect(JSON.stringify(publicBody)).toContain('[redacted-local-path]');
    expect(JSON.stringify(publicBody)).toContain('[redacted-kanban-task]');
    expect(JSON.stringify(publicBody)).not.toContain('private raw html');
    expect(JSON.stringify(publicBody)).not.toContain('files');
  });

  it('size-checks the canonical payload after request-only predecessor normalization', async () => {
    const fixture = loadLiveWorkerPatternFixture();
    const successor = appendQaArtifact(fixture);
    const { root, store } = tmpStore();
    store.storePipelineHandoffArtifact({
      workContextId: fixture.workContextId,
      artifact: fixture.implementationArtifact,
    });
    const unnormalizedBytes = Buffer.byteLength(
      JSON.stringify(successor, null, 2),
      'utf8'
    );
    const canonicalBytes = Buffer.byteLength(
      JSON.stringify(
        {
          ...successor,
          supersedesArtifactId: fixture.implementationArtifact.id,
        },
        null,
        2
      ),
      'utf8'
    );
    expect(canonicalBytes).toBeGreaterThan(unnormalizedBytes);
    const { baseUrl } = await serve({
      root,
      store,
      workContextStore: fakeWorkContextStore(
        createWorkContext(fixture.workContextId)
      ),
      maxPublishBytes: unnormalizedBytes,
    });

    const response = await fetch(`${baseUrl}/pipeline-handoff-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'artifact:write,context:read',
      },
      body: JSON.stringify({
        workContextId: fixture.workContextId,
        artifact: successor,
        supersedesArtifactId: fixture.implementationArtifact.id,
      }),
    });

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      error: {
        details: {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_OVERSIZE_PAYLOAD',
          payloadBytes: canonicalBytes,
          maxBytes: unnormalizedBytes,
        },
      },
    });
  });

  it('enforces publish and export guardrails with persisted public bytes', async () => {
    const { root, store } = tmpStore();
    const workContextId = 'wc:router-guardrails';
    const workContextStore = fakeWorkContextStore(
      createWorkContext(workContextId)
    );
    const publishArtifact = artifact({
      id: 'pipeline-handoff:router:guardrails',
    });
    const minifiedBytes = Buffer.byteLength(
      JSON.stringify(publishArtifact),
      'utf8'
    );
    const persistedBytes = Buffer.byteLength(
      JSON.stringify(publishArtifact, null, 2),
      'utf8'
    );
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
      'x-relay-capabilities': 'artifact:write,context:read',
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
        details: {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_OVERSIZE_EXPORT',
          maxBytes: 16,
        },
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

    const missing = await fetch(
      `${baseUrl}/work-context-artifacts/missing/export`,
      {
        headers: { 'x-relay-capabilities': 'context:read' },
      }
    );
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        details: {
          reasonCode: 'WORK_CONTEXT_ARTIFACT_NOT_FOUND',
          operation: 'export',
        },
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

    const forbidden = await fetch(
      `${baseUrl}/work-context-artifacts?workContextId=${encodeURIComponent(workContextId)}`
    );
    expect(forbidden.status).toBe(403);
    expect(await json(forbidden)).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });

    const stale = await fetch(`${baseUrl}/work-context-artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'artifact:write',
      },
      body: JSON.stringify({
        workContextId,
        artifact: artifact(),
        currentHeadSha: nextHeadSha,
      }),
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({
      error: {
        code: 'SESSION_CONFLICT',
        details: { reasonCode: 'WORK_CONTEXT_ARTIFACT_STALE_HEAD' },
      },
    });
  });

  describe('hub-wide `q` search lane (#1065)', () => {
    it('rejects unauthorized (missing capability) search calls the same as list', async () => {
      const { root, store } = tmpStore();
      const workContextId = 'wc:router-search-auth';
      const { baseUrl } = await serve({
        root,
        store,
        workContextStore: fakeWorkContextStore(
          createWorkContext(workContextId)
        ),
      });

      const noCapability = await fetch(
        `${baseUrl}/work-context-artifacts?q=widget`
      );
      expect(noCapability.status).toBe(403);
      expect(await json(noCapability)).toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
    });

    it('matches title/kind/taskRef/workContextId but never body/summary content', async () => {
      const { root, store } = tmpStore();
      const workContextId = 'wc:router-search-match';
      store.storePipelineHandoffArtifact({
        workContextId,
        artifact: artifact({
          id: 'pipeline-handoff:router-search:aaaaaaaa',
          title: 'Widget rollout handoff',
        }),
      });
      const { baseUrl } = await serve({
        root,
        store,
        workContextStore: fakeWorkContextStore(
          createWorkContext(workContextId)
        ),
      });

      const byTitle = await fetch(
        `${baseUrl}/work-context-artifacts?q=widget`,
        {
          headers: { 'x-relay-capabilities': 'context:read' },
        }
      );
      expect(byTitle.status).toBe(200);
      const byTitleBody = (await json(byTitle)) as {
        artifacts: Array<{ metadata: { id: string } }>;
      };
      expect(byTitleBody.artifacts.map((a) => a.metadata.id)).toEqual([
        'pipeline-handoff:router-search:aaaaaaaa',
      ]);

      const byBodyContent = await fetch(
        `${baseUrl}/work-context-artifacts?q=${encodeURIComponent('router and CLI/API support for WorkContext artifacts')}`,
        { headers: { 'x-relay-capabilities': 'context:read' } }
      );
      expect(byBodyContent.status).toBe(200);
      expect((await json(byBodyContent)).artifacts).toEqual([]);

      const noQueryNoFilter = await fetch(`${baseUrl}/work-context-artifacts`, {
        headers: { 'x-relay-capabilities': 'context:read' },
      });
      expect(noQueryNoFilter.status).toBe(400);
      expect(await json(noQueryNoFilter)).toMatchObject({
        error: {
          details: { reasonCode: 'WORK_CONTEXT_ARTIFACT_FILTER_REQUIRED' },
        },
      });
    });

    it('enforces a hard <=20 result limit regardless of the requested limit', async () => {
      const { root, store } = tmpStore();
      const workContextId = 'wc:router-search-limit';
      for (let i = 0; i < 25; i += 1) {
        store.storePipelineHandoffArtifact({
          workContextId,
          artifact: artifact({
            id: `pipeline-handoff:router-search-limit:${i.toString().padStart(8, '0')}`,
            title: `Search limit fixture #${i}`,
          }),
        });
      }
      const { baseUrl } = await serve({
        root,
        store,
        workContextStore: fakeWorkContextStore(
          createWorkContext(workContextId)
        ),
      });

      const res = await fetch(
        `${baseUrl}/work-context-artifacts?q=${encodeURIComponent('search limit fixture')}&limit=200`,
        { headers: { 'x-relay-capabilities': 'context:read' } }
      );
      expect(res.status).toBe(200);
      expect((await json(res)).artifacts).toHaveLength(20);
    });

    it('rejects hub-wide search for actor credentials scoped to specific WorkContexts', async () => {
      const { root, store } = tmpStore();
      const workContextId = 'wc:router-search-scoped';
      store.storePipelineHandoffArtifact({
        workContextId,
        artifact: artifact({
          id: 'pipeline-handoff:router-search-scoped:aaaaaaaa',
        }),
      });
      const registry = new ScopedActorCredentialRegistry({
        secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
      });
      const scoped = issueCliGatewayActorCredential(registry, {
        scope: { workContextIds: [workContextId] },
      });
      const scopeForRequest = (
        req: express.Request
      ): { workContextIds?: string[] } | undefined => {
        const raw = req.query['workContextId'];
        return typeof raw === 'string' && raw
          ? { workContextIds: [raw] }
          : undefined;
      };
      const { baseUrl } = await serve({
        root,
        store,
        workContextStore: fakeWorkContextStore(
          createWorkContext(workContextId)
        ),
        requireReadAuth: {
          list: scopedActorReadAuth(registry, 'work-context-artifacts.list', {
            scopeForRequest,
          }),
        },
      });

      const res = await fetch(`${baseUrl}/work-context-artifacts?q=widget`, {
        headers: actorHeadersWithToken(
          'work-context-artifacts.list',
          scoped.token
        ),
      });
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({
        error: { reasonCode: 'CLI_ACTOR_MISSING_SCOPE' },
      });
    });

    it('rejects hub-wide search in-handler even when the auth middleware defers WorkContext scope validation', async () => {
      // Defense-in-depth (#1065 review): this test does NOT pass a
      // `scopeForRequest` to `scopedActorReadAuth` for the `list` command, and
      // sets `deferWorkContextScope: true` instead — simulating a future/
      // misconfigured wiring where the production `scopeForRequest` middleware
      // no longer catches a hub-wide `q` search for a scoped actor. The
      // handler's own `denyScopedActorHubWideSearch` check must still reject
      // it independently.
      const { root, store } = tmpStore();
      const workContextId = 'wc:router-search-defer-scoped';
      store.storePipelineHandoffArtifact({
        workContextId,
        artifact: artifact({
          id: 'pipeline-handoff:router-search-defer-scoped:aaaaaaaa',
        }),
      });
      const registry = new ScopedActorCredentialRegistry({
        secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
      });
      const scoped = issueCliGatewayActorCredential(registry, {
        scope: { workContextIds: [workContextId] },
      });
      const { baseUrl } = await serve({
        root,
        store,
        workContextStore: fakeWorkContextStore(
          createWorkContext(workContextId)
        ),
        requireReadAuth: {
          list: scopedActorReadAuth(registry, 'work-context-artifacts.list', {
            deferWorkContextScope: true,
          }),
        },
      });

      const res = await fetch(`${baseUrl}/work-context-artifacts?q=widget`, {
        headers: actorHeadersWithToken(
          'work-context-artifacts.list',
          scoped.token
        ),
      });
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({
        error: { details: { reasonCode: 'CLI_ACTOR_MISSING_SCOPE' } },
      });
    });
  });
});
