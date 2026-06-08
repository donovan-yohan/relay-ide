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
}): Promise<{ baseUrl: string; server: http.Server }> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(
    createWorkContextArtifactRouter({
      store: input.store,
      workContextStore: input.workContextStore,
      diagnostics: {
        dbPath: path.join(input.root, 'work-context-artifacts.db'),
        payloadRoot: path.join(input.root, 'payloads'),
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

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

describe('WorkContext artifact router', () => {
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
