// #735 (BE-3): integration coverage for the Bench overlay CRUD routes on
// `createRepoFeatureRouter`. Spins up a real express app + a real (temp-file)
// IaStore and drives the routes over HTTP with `fetch`, mirroring the
// router-level test pattern in `test/changed-files-api.test.ts`.
//
// The bench routes never touch the node registry or repo-inventory feature, so
// those collaborators are minimal stubs here; only `requireAuth` (no-op) and
// the injected `iaStore` matter.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepoFeatureRouter } from '../server/features/repo-router.js';
import { createIaStore, type IaStore } from '../server/ia-store.js';
import { createInstanceId, createProjectId } from '../shared/project.js';
import { createBenchId, parseBenchId } from '../shared/bench.js';

const INSTANCE_ID = createInstanceId(
  createProjectId({ kind: 'node', nodeId: 'macbook' }),
  'macbook'
);
const REPO_INSTANCE_ID = createInstanceId(
  createProjectId({ kind: 'repo', remote: 'github.com/acme/widget' }),
  'local'
);

let tmpDir: string;
let store: IaStore;
let server: Server;
let baseUrl: string;

const noopAuth: express.RequestHandler = (_req, _res, next) => next();

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-bench-routes-'));
  store = createIaStore(path.join(tmpDir, 'ia.db'));

  const app = express();
  app.use(express.json());
  app.use(
    createRepoFeatureRouter({
      // The bench routes don't call these; minimal stubs satisfy the types.
      registry: {
        listNodes: () => [],
        errorBody: (error: unknown) => ({
          error: {
            code: 'INTERNAL' as const,
            message: error instanceof Error ? error.message : 'error',
            retryable: false,
          },
        }),
      } as never,
      repoInventoryFeature: {
        listInventoryReports: () => [],
        aggregateInventoryReports: () => ({
          generatedAt: new Date().toISOString(),
          nodes: [],
          projectGroups: [],
        }),
      } as never,
      requireAuth: noopAuth,
      iaStore: store,
    })
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  server?.close();
  try {
    store.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function post(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/hub/ia/benches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(query = ''): Promise<Response> {
  return fetch(`${baseUrl}/hub/ia/benches${query}`);
}

describe('POST /hub/ia/benches (create)', () => {
  it('creates an arbitrary-cwd bench on a node instance with envOverrides', async () => {
    const res = await post({
      instanceId: INSTANCE_ID,
      cwd: '/srv/scratch/space',
      envOverrides: { NODE_ENV: 'test', PORT: '4100' },
      label: 'Scratch',
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { bench: Record<string, unknown> };
    const bench = json.bench;
    expect(bench['instanceId']).toBe(INSTANCE_ID);
    expect(bench['cwd']).toBe('/srv/scratch/space');
    expect(bench['label']).toBe('Scratch');
    expect(bench['envOverrides']).toEqual({ NODE_ENV: 'test', PORT: '4100' });
    // Minted id round-trips through the shared parser.
    expect(parseBenchId(bench['id'] as string)).toEqual({
      instanceId: INSTANCE_ID,
      cwd: '/srv/scratch/space',
    });
  });

  it('creates a git-worktree-anchored bench overlay (repo instance)', async () => {
    const res = await post({
      instanceId: REPO_INSTANCE_ID,
      cwd: '/repos/widget/.worktrees/feat-x',
      envOverrides: { FEATURE: 'on' },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { bench: Record<string, unknown> };
    expect(json.bench['label']).toBeNull(); // omitted → derived label
    expect(json.bench['envOverrides']).toEqual({ FEATURE: 'on' });
  });

  it('defaults envOverrides to {} when omitted', async () => {
    const res = await post({
      instanceId: INSTANCE_ID,
      cwd: '/srv/no-env',
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { bench: Record<string, unknown> };
    expect(json.bench['envOverrides']).toEqual({});
  });

  it('rejects a malformed instanceId', async () => {
    const res = await post({ instanceId: 'not-an-instance', cwd: '/ok' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { details?: { reasonCode?: string } } };
    expect(json.error.details?.reasonCode).toBe('INVALID_INSTANCE_ID');
  });

  it('rejects a relative cwd', async () => {
    const res = await post({ instanceId: INSTANCE_ID, cwd: 'relative/path' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { details?: { reasonCode?: string } } };
    expect(json.error.details?.reasonCode).toBe('CWD_NOT_ABSOLUTE');
  });

  it('rejects a cwd containing .. traversal', async () => {
    const res = await post({ instanceId: INSTANCE_ID, cwd: '/srv/../etc' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { details?: { reasonCode?: string } } };
    expect(json.error.details?.reasonCode).toBe('CWD_TRAVERSAL');
  });

  it('rejects a cwd containing control characters', async () => {
    const res = await post({ instanceId: INSTANCE_ID, cwd: '/srv/\x01bad' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { details?: { reasonCode?: string } } };
    expect(json.error.details?.reasonCode).toBe('INVALID_CWD');
  });

  it('rejects a missing cwd', async () => {
    const res = await post({ instanceId: INSTANCE_ID });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { details?: { reasonCode?: string } } };
    expect(json.error.details?.reasonCode).toBe('CWD_REQUIRED');
  });

  it('rejects a non-string envOverride value (does not silently strip)', async () => {
    const res = await post({
      instanceId: INSTANCE_ID,
      cwd: '/srv/bad-env',
      envOverrides: { GOOD: 'yes', BAD: 5 },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { details?: { reasonCode?: string } } };
    expect(json.error.details?.reasonCode).toBe('INVALID_ENV_OVERRIDE_VALUE');
  });
});

describe('GET /hub/ia/benches (list + filter)', () => {
  it('lists all overlays and filters by instanceId', async () => {
    const all = await (await get()).json();
    const allBenches = (all as { benches: Array<{ instanceId: string }> }).benches;
    // Persisted by the create block above: 2 on INSTANCE_ID
    // (/srv/scratch/space + /srv/no-env) and 1 on REPO_INSTANCE_ID. Rejected
    // POSTs (bad cwd/env) never persist.
    expect(allBenches.length).toBeGreaterThanOrEqual(3);

    const filtered = await (
      await get(`?instanceId=${encodeURIComponent(REPO_INSTANCE_ID)}`)
    ).json();
    const filteredBenches = (filtered as { benches: Array<{ instanceId: string }> })
      .benches;
    expect(filteredBenches.length).toBe(1);
    expect(filteredBenches[0]!.instanceId).toBe(REPO_INSTANCE_ID);
  });

  it('rejects a malformed instanceId filter', async () => {
    const res = await get('?instanceId=garbage');
    expect(res.status).toBe(400);
  });

  it('returns an empty list (not 404) for an instance with no overlays', async () => {
    const empty = createInstanceId(
      createProjectId({ kind: 'node', nodeId: 'ghost' }),
      'ghost'
    );
    const res = await get(`?instanceId=${encodeURIComponent(empty)}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { benches: unknown[] };
    expect(json.benches).toEqual([]);
  });
});

describe('PUT/PATCH /hub/ia/benches/:id (update)', () => {
  it('round-trips an envOverrides update', async () => {
    const id = createBenchId(INSTANCE_ID, '/srv/update-me');
    await post({ instanceId: INSTANCE_ID, cwd: '/srv/update-me', envOverrides: { A: '1' }, label: 'orig' });

    const res = await fetch(`${baseUrl}/hub/ia/benches/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envOverrides: { A: '2', B: '3' } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bench: Record<string, unknown> };
    expect(json.bench['envOverrides']).toEqual({ A: '2', B: '3' });
    // Omitted label is left unchanged.
    expect(json.bench['label']).toBe('orig');
  });

  it('PATCH clears the label with null and leaves env unchanged', async () => {
    const id = createBenchId(INSTANCE_ID, '/srv/patch-me');
    await post({ instanceId: INSTANCE_ID, cwd: '/srv/patch-me', envOverrides: { K: 'v' }, label: 'set' });

    const res = await fetch(`${baseUrl}/hub/ia/benches/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: null }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bench: Record<string, unknown> };
    expect(json.bench['label']).toBeNull();
    expect(json.bench['envOverrides']).toEqual({ K: 'v' });
  });

  it('404s when updating a non-existent overlay', async () => {
    const id = createBenchId(INSTANCE_ID, '/srv/never-created');
    const res = await fetch(`${baseUrl}/hub/ia/benches/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s on a malformed bench id', async () => {
    const res = await fetch(`${baseUrl}/hub/ia/benches/not-a-bench-id`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /hub/ia/benches/:id', () => {
  it('deletes an overlay then 404s on the second delete', async () => {
    const id = createBenchId(INSTANCE_ID, '/srv/delete-me');
    await post({ instanceId: INSTANCE_ID, cwd: '/srv/delete-me', envOverrides: {} });

    const first = await fetch(`${baseUrl}/hub/ia/benches/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    expect(first.status).toBe(200);
    const json = (await first.json()) as { deleted: boolean; id: string };
    expect(json.deleted).toBe(true);
    expect(json.id).toBe(id);

    const second = await fetch(`${baseUrl}/hub/ia/benches/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    expect(second.status).toBe(404);
  });
});

describe('store-unavailable degradation', () => {
  it('503s when no iaStore is wired', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      createRepoFeatureRouter({
        registry: { listNodes: () => [], errorBody: () => ({ error: { code: 'INTERNAL', message: 'x', retryable: false } }) } as never,
        repoInventoryFeature: {
          listInventoryReports: () => [],
          aggregateInventoryReports: () => ({ generatedAt: '', nodes: [], projectGroups: [] }),
        } as never,
        requireAuth: noopAuth,
        // iaStore intentionally omitted → routes 503.
      })
    );
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = srv.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/hub/ia/benches`);
      expect(res.status).toBe(503);
      const json = (await res.json()) as { error: { details?: { reasonCode?: string } } };
      expect(json.error.details?.reasonCode).toBe('IA_STORE_UNAVAILABLE');
    } finally {
      srv.close();
    }
  });
});
