import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCliGatewayEventBus,
  type CliGatewayMetadataEvent,
} from '../server/cli-gateway-event-bus.js';
import { createWorkflowRunRouter } from '../server/features/workflow-run-router.js';
import {
  createWorkflowRunStore,
  type WorkflowRunStore,
} from '../server/workflow-runs.js';

let server: http.Server | undefined;
let baseUrl = '';
let store: WorkflowRunStore | undefined;
const tempRoots: string[] = [];

function createStore(): WorkflowRunStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workflow-runs-'));
  tempRoots.push(root);
  return createWorkflowRunStore({
    dbPath: path.join(root, 'workflow-runs.db'),
  });
}

async function mount(events = createCliGatewayEventBus()): Promise<{
  events: ReturnType<typeof createCliGatewayEventBus>;
  published: CliGatewayMetadataEvent[];
}> {
  store = createStore();
  const published: CliGatewayMetadataEvent[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createWorkflowRunRouter({
      store,
      events: {
        publish(input) {
          const event = events.publish(input);
          published.push(event);
          return event;
        },
      },
      requireAuth: (_req, _res, next) => next(),
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
  return { events, published };
}

async function req(
  method: string,
  route: string,
  input?: unknown,
  caps = method === 'GET' ? 'context:read' : 'context:write'
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'x-relay-capabilities': caps };
  if (input !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const publishInput = {
  id: 'workflow-run:test-1',
  runId: 'dynamic-workflow-run-1',
  providerRuntime: 'hermes-dynamic-workflows',
  workContextId: 'wc:test',
  definition: { hash: 'sha256:abc123', templateId: 'relay/github-exact-head' },
  state: 'running',
  progress: { total: 2, completed: 1 },
  links: {
    sessionIds: ['session:test'],
    taskRefs: [{ kind: 'github-issue', id: '944' }],
  },
};

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  store?.close();
  store = undefined;
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('workflow run projection router', () => {
  it('publishes, lists, updates, and gets redacted WorkContext-scoped workflow runs', async () => {
    const { published } = await mount();

    const created = await req('POST', '/workflow-runs', publishInput);
    expect(created.status).toBe(201);
    expect(created.body.workflowRun).toMatchObject({
      id: 'workflow-run:test-1',
      runId: 'dynamic-workflow-run-1',
      workContextId: 'wc:test',
      state: 'running',
      version: 1,
      redaction: {
        rawPayloadStored: false,
        rawTranscriptStored: false,
        providerPrivateStateStored: false,
      },
    });

    const listed = await req('GET', '/workflow-runs?workContextId=wc:test');
    expect(listed.status).toBe(200);
    expect(listed.body.workflowRuns).toHaveLength(1);

    const updated = await req('PATCH', '/workflow-runs/workflow-run%3Atest-1', {
      expectedVersion: 1,
      state: 'succeeded',
      resultSummary: 'release gate passed at exact head',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.workflowRun).toMatchObject({
      id: 'workflow-run:test-1',
      state: 'succeeded',
      version: 2,
      resultSummary: 'release gate passed at exact head',
    });

    const got = await req('GET', '/workflow-runs/workflow-run%3Atest-1');
    expect(got.status).toBe(200);
    expect(got.body.workflowRun.state).toBe('succeeded');

    expect(published.map((event) => event.type)).toEqual([
      'workflow-run.published',
      'workflow-run.updated',
      'workflow-run.state-changed',
    ]);
    expect(published[0]).toMatchObject({
      topic: 'workflow-runs',
      workContextId: 'wc:test',
      sessionId: 'session:test',
      payload: {
        workflowRunId: 'workflow-run:test-1',
        runId: 'dynamic-workflow-run-1',
        state: 'running',
      },
      redaction: {
        rawPayloadIncluded: false,
        rawTranscriptIncluded: false,
        artifactBodyIncluded: false,
      },
    });
  });

  it('rejects raw/private workflow state instead of storing transcripts', async () => {
    await mount();

    const rejected = await req('POST', '/workflow-runs', {
      ...publishInput,
      id: 'workflow-run:raw-private',
      rawTranscript: 'do not store this',
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reasonCode: 'WORKFLOW_RUN_VALIDATION_FAILED' },
    });
  });

  it('publishes and updates Relay orchestration topology for visible planner and worker sessions', async () => {
    const { published } = await mount();

    const created = await req('POST', '/workflow-runs', {
      ...publishInput,
      id: 'workflow-run:orchestration-1',
      runId: 'relay-orchestration-1',
      providerRuntime: 'relay-orchestration',
      runKind: 'relay-orchestration',
      orchestration: {
        planner: {
          role: 'planner',
          sessionId: 'planner:test',
          globalSessionId: 'local:planner:test',
          provider: 'hermes',
          nodeId: 'local',
          cwd: '/repo/relay-ide',
          repoPath: '/repo/relay-ide',
          state: 'running',
          attention: { needsAttention: false, pendingInboxCount: 0 },
        },
        children: [
          {
            role: 'implementer',
            sessionId: 'worker:claude',
            globalSessionId: 'local:worker:claude',
            provider: 'claude',
            state: 'running',
          },
          {
            role: 'reviewer',
            sessionId: 'worker:codex',
            provider: 'codex',
            state: 'waiting',
            attention: {
              needsAttention: true,
              reasons: ['pending-inbox'],
              pendingInboxCount: 1,
            },
          },
        ],
      },
    });

    expect(created.status).toBe(201);
    expect(created.body.workflowRun).toMatchObject({
      id: 'workflow-run:orchestration-1',
      runKind: 'relay-orchestration',
      orchestration: {
        planner: {
          role: 'planner',
          sessionId: 'planner:test',
          globalSessionId: 'local:planner:test',
          provider: 'hermes',
        },
        children: [
          {
            role: 'implementer',
            sessionId: 'worker:claude',
            provider: 'claude',
          },
          {
            role: 'reviewer',
            sessionId: 'worker:codex',
            provider: 'codex',
            attention: { needsAttention: true, pendingInboxCount: 1 },
          },
        ],
      },
    });

    const updated = await req(
      'PATCH',
      '/workflow-runs/workflow-run%3Aorchestration-1',
      {
        expectedVersion: 1,
        orchestration: {
          planner: {
            role: 'planner',
            sessionId: 'planner:test',
            globalSessionId: 'local:planner:test',
          },
          children: [
            {
              role: 'implementer',
              sessionId: 'worker:claude',
              provider: 'claude',
              state: 'succeeded',
            },
          ],
        },
      }
    );

    expect(updated.status).toBe(200);
    expect(updated.body.workflowRun).toMatchObject({
      version: 2,
      orchestration: {
        children: [
          {
            role: 'implementer',
            sessionId: 'worker:claude',
            state: 'succeeded',
          },
        ],
      },
    });
    expect(published[0]).toMatchObject({
      topic: 'workflow-runs',
      sessionId: 'planner:test',
      globalSessionId: 'local:planner:test',
      payload: {
        runKind: 'relay-orchestration',
        plannerSessionId: 'planner:test',
        participantSessionIds: [
          'planner:test',
          'worker:claude',
          'worker:codex',
        ],
        childSessionIds: ['worker:claude', 'worker:codex'],
        childCount: 2,
      },
    });
  });

  it('rejects raw/private fields inside Relay orchestration topology', async () => {
    await mount();

    const rejected = await req('POST', '/workflow-runs', {
      ...publishInput,
      id: 'workflow-run:orchestration-private',
      runKind: 'relay-orchestration',
      orchestration: {
        planner: {
          role: 'planner',
          sessionId: 'planner:test',
          prompt: 'do not persist private planner prompts',
        },
      },
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: {
        reasonCode: 'WORKFLOW_RUN_VALIDATION_FAILED',
        omittedKeys: ['$.orchestration.planner.prompt'],
      },
    });
  });

  it('rejects publish requests missing workContextId with a typed error', async () => {
    await mount();

    const rejected = await req('POST', '/workflow-runs', {
      ...publishInput,
      id: 'workflow-run:missing-context',
      workContextId: undefined,
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { field: 'workContextId' },
    });
  });

  it('supports cursor replay on the metadata event bus without replaying raw payloads', async () => {
    const events = createCliGatewayEventBus();
    const first = events.publish({
      topic: 'workflow-runs',
      type: 'workflow-run.published',
      workContextId: 'wc:test',
      payload: { workflowRunId: 'workflow-run:old', state: 'running' },
    });
    const second = events.publish({
      topic: 'workflow-runs',
      type: 'workflow-run.state-changed',
      workContextId: 'wc:test',
      payload: JSON.parse(
        '{"workflowRunId":"workflow-run:new","state":"succeeded","rawTranscript":"SECRET","__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}'
      ) as Record<string, unknown>,
    });

    const replay = events.replay('workflow-runs', first.cursor);
    expect(replay).toMatchObject({ replayDropped: false });
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({
      cursor: second.cursor,
      payload: { workflowRunId: 'workflow-run:new', state: 'succeeded' },
      redaction: {
        rawPayloadIncluded: false,
        rawTranscriptIncluded: false,
        artifactBodyIncluded: false,
      },
    });
    const payload = replay.events[0]?.payload ?? {};
    expect(payload['rawTranscript']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(payload, '__proto__')).toBe(
      false
    );
    expect(Object.prototype.hasOwnProperty.call(payload, 'constructor')).toBe(
      false
    );
    expect(Object.prototype.hasOwnProperty.call(payload, 'prototype')).toBe(
      false
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
