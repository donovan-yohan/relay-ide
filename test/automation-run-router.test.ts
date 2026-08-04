import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCliGatewayEventBus, type CliGatewayMetadataEvent } from '../server/cli-gateway-event-bus.js';
import { createAutomationRunRouter } from '../server/features/automation-run-router.js';
import { createAutomationRunStore, type AutomationRunStore } from '../server/automation-runs.js';
import type { AutomationRunLivenessResolver } from '../shared/automation-run.js';

let server: http.Server | undefined;
let baseUrl = '';
let store: AutomationRunStore | undefined;
const tempRoots: string[] = [];

/** Sessions considered alive by the injected liveness resolver. Mutable per test. */
const aliveSessions = new Set<string>();
const resolveLiveness: AutomationRunLivenessResolver = (target) => {
  if (target.sessionId && aliveSessions.has(target.sessionId)) return 'alive';
  if (target.globalSessionId && aliveSessions.has(target.globalSessionId)) return 'alive';
  return 'gone';
};

function createStore(): AutomationRunStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-automation-run-router-'));
  tempRoots.push(root);
  return createAutomationRunStore({ dbPath: path.join(root, 'automation-runs.db') });
}

async function mount(): Promise<{ published: CliGatewayMetadataEvent[] }> {
  store = createStore();
  const events = createCliGatewayEventBus();
  const published: CliGatewayMetadataEvent[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createAutomationRunRouter({
      store,
      resolveLiveness,
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
      if (!addr || typeof addr === 'string') throw new Error('missing server address');
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
  return { published };
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

const registerInput = {
  id: 'automation-run:router-1',
  name: 'pr-959-watchdog',
  kind: 'watchdog',
  runId: 'e059bf471bd0',
  owner: { orchestrator: 'hermes' },
  repoPath: '/repo/relay-ide',
  workContextId: 'wc:959',
  targets: [{ sessionId: 'sess-a' }],
  ttlSeconds: 300,
};

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  store?.close();
  store = undefined;
  aliveSessions.clear();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('automation run router', () => {
  it('registers, lists, gets, observes, and retires a watchdog run', async () => {
    aliveSessions.add('sess-a');
    const { published } = await mount();

    const created = await req('POST', '/automation-runs', registerInput);
    expect(created.status).toBe(201);
    expect(created.body.automationRun).toMatchObject({
      id: 'automation-run:router-1',
      status: 'active',
      version: 1,
      cleanup: { state: 'none' },
    });
    expect(created.body.automationRun.targets[0].lastKnownState).toBe('alive');

    const listed = await req('GET', '/automation-runs?workContextId=wc:959');
    expect(listed.status).toBe(200);
    expect(listed.body.automationRuns).toHaveLength(1);

    const observed = await req('POST', '/automation-runs/automation-run%3Arouter-1/observe', {
      summary: 'still green',
    });
    expect(observed.status).toBe(200);
    expect(observed.body.automationRun).toMatchObject({ status: 'active', version: 2 });

    const retired = await req('POST', '/automation-runs/automation-run%3Arouter-1/retire', {
      reason: 'pr merged',
    });
    expect(retired.status).toBe(200);
    expect(retired.body.automationRun.status).toBe('retired');

    expect(published.map((event) => event.type)).toEqual([
      'automation-run.registered',
      'automation-run.observed',
      'automation-run.retired',
    ]);
    expect(published[0]).toMatchObject({
      topic: 'automation-runs',
      workContextId: 'wc:959',
      sessionId: 'sess-a',
      payload: { automationRunId: 'automation-run:router-1', status: 'active' },
      redaction: { rawPayloadIncluded: false, rawTranscriptIncluded: false },
    });
  });

  it('surfaces a stale target session as cleanup-needed on read', async () => {
    aliveSessions.add('sess-a');
    await mount();
    await req('POST', '/automation-runs', registerInput);

    // The watched session is killed; the registry should detect the dead target.
    aliveSessions.delete('sess-a');

    const got = await req('GET', '/automation-runs/automation-run%3Arouter-1');
    expect(got.status).toBe(200);
    expect(got.body.automationRun.status).toBe('cleanup-needed');
    expect(got.body.automationRun.staleReasons).toContain('target-session-gone');

    const stale = await req('GET', '/automation-runs?status=cleanup-needed');
    expect(stale.body.automationRuns.map((r: { id: string }) => r.id)).toEqual([
      'automation-run:router-1',
    ]);
  });

  it('retire is idempotent over HTTP', async () => {
    aliveSessions.add('sess-a');
    await mount();
    await req('POST', '/automation-runs', registerInput);

    const first = await req('POST', '/automation-runs/automation-run%3Arouter-1/retire', {
      reason: 'done',
    });
    expect(first.status).toBe(200);
    const firstVersion = first.body.automationRun.version;

    const second = await req('POST', '/automation-runs/automation-run%3Arouter-1/retire', {
      reason: 'done again',
    });
    expect(second.status).toBe(200);
    expect(second.body.automationRun.status).toBe('retired');
    expect(second.body.automationRun.version).toBe(firstVersion);
    expect(second.body.automationRun.cleanup.reason).toBe('done');
  });

  it('rejects secret-shaped register fields with a typed validation error', async () => {
    await mount();
    const rejected = await req('POST', '/automation-runs', {
      ...registerInput,
      id: 'automation-run:secret',
      token: 'relay-sac-v1.secret',
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reasonCode: 'AUTOMATION_RUN_VALIDATION_FAILED' },
    });
  });

  it('denies writes lacking the context:write capability', async () => {
    await mount();
    const denied = await req('POST', '/automation-runs', registerInput, 'context:read');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns NOT_FOUND for an unknown run', async () => {
    await mount();
    const missing = await req('GET', '/automation-runs/automation-run%3Anope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects re-registering a run under a different workContextId', async () => {
    aliveSessions.add('sess-a');
    await mount();
    await req('POST', '/automation-runs', registerInput);
    const conflict = await req('POST', '/automation-runs', {
      ...registerInput,
      workContextId: 'wc:other',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: 'SESSION_CONFLICT',
      details: { reasonCode: 'AUTOMATION_RUN_WORK_CONTEXT_IMMUTABLE' },
    });
  });
});
