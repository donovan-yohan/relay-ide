import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCliGatewayEventBus, type CliGatewayMetadataEvent } from '../server/cli-gateway-event-bus.js';
import { createPrOverseerRouter } from '../server/features/pr-overseer-router.js';
import { createPrOverseerStore, type PrOverseerStore } from '../server/pr-overseer.js';
import type { PrObservation } from '../shared/pr-overseer.js';
import type { PrObserver } from '../server/pr-overseer-github.js';

let server: http.Server | undefined;
let baseUrl = '';
let store: PrOverseerStore | undefined;
const tempRoots: string[] = [];

const HEAD = 'a'.repeat(40);

/** Mutable observation the fake observer returns; tests swap it per case. */
let nextObservation: PrObservation = {
  ok: true,
  fetchedAt: '2026-06-15T00:00:00.000Z',
  pr: { number: 1234, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headSha: HEAD },
  checks: { total: 1, passing: 1, failing: 0, pending: 0, failingNames: [] },
  reviews: { decision: 'APPROVED', changesRequestedBy: [], approvedBy: ['r'], unresolvedThreadCount: 0 },
  botComments: { count: 0, sources: [] },
  closingIssueNumbers: [960],
};
const observer: PrObserver = async () => nextObservation;

function createStore(): PrOverseerStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pr-overseer-router-'));
  tempRoots.push(root);
  return createPrOverseerStore({ dbPath: path.join(root, 'pr-overseers.db') });
}

async function mount(): Promise<{ published: CliGatewayMetadataEvent[] }> {
  store = createStore();
  const events = createCliGatewayEventBus();
  const published: CliGatewayMetadataEvent[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createPrOverseerRouter({
      store,
      observer,
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
  id: 'pr-overseer:router-1',
  name: 'pr-960',
  owner: { orchestrator: 'ebi' },
  workContextId: 'wc:960',
  session: { sessionId: 'sess-a' },
  issue: { number: 960 },
  pr: { ownerRepo: 'donovan-yohan/relay-ide', number: 1234 },
  ttlSeconds: 600,
};

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  store?.close();
  store = undefined;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  // reset to a clean ready observation
  nextObservation = {
    ok: true,
    fetchedAt: '2026-06-15T00:00:00.000Z',
    pr: { number: 1234, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headSha: HEAD },
    checks: { total: 1, passing: 1, failing: 0, pending: 0, failingNames: [] },
    reviews: { decision: 'APPROVED', changesRequestedBy: [], approvedBy: ['r'], unresolvedThreadCount: 0 },
    botComments: { count: 0, sources: [] },
    closingIssueNumbers: [960],
  };
});

describe('pr overseer router', () => {
  it('registers, observes via the injected observer, and emits events', async () => {
    const { published } = await mount();
    const reg = await req('POST', '/pr-overseers', registerInput);
    expect(reg.status).toBe(201);
    expect(reg.body.prOverseer.status).toBe('pending');

    const obs = await req('POST', '/pr-overseers/pr-overseer:router-1/observe', { summary: 'green' });
    expect(obs.status).toBe(200);
    expect(obs.body.prOverseer.status).toBe('ready');
    expect(obs.body.prOverseer.handoff.ready).toBe(true);

    const types = published.map((e) => e.type);
    expect(types).toContain('pr-overseer.registered');
    expect(types).toContain('pr-overseer.observed');
    expect(types).toContain('pr-overseer.status-changed'); // pending → ready
    // Events are metadata-only — no PR bodies / transcripts.
    const observed = published.find((e) => e.type === 'pr-overseer.observed');
    expect(observed?.payload).toMatchObject({ status: 'ready', prNumber: 1234, handoffReady: true });
  });

  it('a failing observer (gh down) on first observe still 200s with no evidence + re-observe action', async () => {
    await mount();
    await req('POST', '/pr-overseers', registerInput);
    nextObservation = { ok: false, fetchedAt: '2026-06-15T00:00:00.000Z', unavailableReason: 'gh-missing' };
    const obs = await req('POST', '/pr-overseers/pr-overseer:router-1/observe', {});
    expect(obs.status).toBe(200);
    // No usable evidence yet → still pending, never ready; the failed fetch is
    // flagged and the next action is to re-observe.
    expect(obs.body.prOverseer.status).toBe('pending');
    expect(obs.body.prOverseer.handoff.ready).toBe(false);
    expect(obs.body.prOverseer.lastFetch).toMatchObject({ ok: false, unavailableReason: 'gh-missing' });
    expect(obs.body.prOverseer.requiredNextAction.action).toBe('re-observe');
  });

  it('get with a mismatched currentHeadSha fails the exact-head handoff gate', async () => {
    await mount();
    await req('POST', '/pr-overseers', registerInput);
    await req('POST', '/pr-overseers/pr-overseer:router-1/observe', {});
    const ok = await req('GET', `/pr-overseers/pr-overseer:router-1?currentHeadSha=${HEAD}`);
    expect(ok.body.prOverseer.status).toBe('ready');
    const bad = await req('GET', `/pr-overseers/pr-overseer:router-1?currentHeadSha=${'c'.repeat(40)}`);
    expect(bad.body.prOverseer.status).toBe('blocked');
    expect(bad.body.prOverseer.handoff.ready).toBe(false);
  });

  it('lists and filters by derived status', async () => {
    await mount();
    await req('POST', '/pr-overseers', registerInput);
    await req('POST', '/pr-overseers/pr-overseer:router-1/observe', {});
    const list = await req('GET', '/pr-overseers?status=ready');
    expect(list.body.prOverseers.map((r: any) => r.id)).toEqual(['pr-overseer:router-1']);
    expect((await req('GET', '/pr-overseers?status=blocked')).body.prOverseers).toEqual([]);
  });

  it('retire is idempotent', async () => {
    await mount();
    await req('POST', '/pr-overseers', registerInput);
    const first = await req('POST', '/pr-overseers/pr-overseer:router-1/retire', { reason: 'merged' });
    expect(first.body.prOverseer.status).toBe('retired');
    const second = await req('POST', '/pr-overseers/pr-overseer:router-1/retire', {});
    expect(second.body.prOverseer.version).toBe(first.body.prOverseer.version);
  });

  it('enforces capability gates and 404s for unknown ids', async () => {
    await mount();
    const noCap = await req('POST', '/pr-overseers', registerInput, '');
    expect(noCap.status).toBe(403);
    const missing = await req('GET', '/pr-overseers/nope');
    expect(missing.status).toBe(404);
  });
});
