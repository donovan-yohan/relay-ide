import express from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIaWorkspaceRouter } from '../server/features/ia-workspace-router.js';
import { createIaStore, type IaStore } from '../server/ia-store.js';
import { parseWorkspaceId, type Workspace } from '../shared/workspace.js';

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

let tmpDir: string;
let store: IaStore | null;
let server: Server;
let baseUrl: string;

// Pass-through auth so the suite exercises the route logic, not auth itself.
// A separate test below proves the router actually applies the injected
// `requireAuth` middleware.
const passThroughAuth: express.RequestHandler = (_req, _res, next) => next();

function mount(opts: {
  iaStore: IaStore | null;
  requireAuth?: express.RequestHandler;
}): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    createIaWorkspaceRouter({
      requireAuth: opts.requireAuth ?? passThroughAuth,
      iaStore: opts.iaStore,
    })
  );
  return new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-workspace-router-'));
  store = createIaStore(path.join(tmpDir, 'ia.db'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try {
    store?.close();
  } catch {
    /* already closed */
  }
  store = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const WS = '/hub/ia/workspaces';

describe('IA Workspace CRUD router', () => {
  it('round-trips create → list → patch (rename/reorder/membership) → delete', async () => {
    await mount({ iaStore: store });

    // empty list to start
    const empty = await fetch(`${baseUrl}${WS}`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ workspaces: [] });

    // create A (no order → appends at 0)
    const createA = await fetch(`${baseUrl}${WS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha' }),
    });
    expect(createA.status).toBe(201);
    const { workspace: a } = (await createA.json()) as { workspace: Workspace };
    expect(parseWorkspaceId(a.id)).not.toBeNull();
    expect(a).toMatchObject({ name: 'Alpha', order: 0, projectIds: [] });
    expect(typeof a.createdAt).toBe('string');
    expect(typeof a.updatedAt).toBe('string');

    // create B with explicit projectIds (no order → appends after A)
    const createB = await fetch(`${baseUrl}${WS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Beta', projectIds: ['p1', 'p2'] }),
    });
    expect(createB.status).toBe(201);
    const { workspace: b } = (await createB.json()) as { workspace: Workspace };
    expect(b).toMatchObject({ name: 'Beta', order: 1, projectIds: ['p1', 'p2'] });

    // list returns both, ordered by order asc
    const listed = (await (await fetch(`${baseUrl}${WS}`)).json()) as {
      workspaces: Workspace[];
    };
    expect(listed.workspaces.map((w) => w.name)).toEqual(['Alpha', 'Beta']);

    // PATCH A: rename + reorder past B + set membership (move projects)
    const patchA = await fetch(`${baseUrl}${WS}/${encodeURIComponent(a.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha-2', order: 5, projectIds: ['p2'] }),
    });
    expect(patchA.status).toBe(200);
    const { workspace: a2 } = (await patchA.json()) as { workspace: Workspace };
    expect(a2).toMatchObject({
      id: a.id,
      name: 'Alpha-2',
      order: 5,
      projectIds: ['p2'],
      createdAt: a.createdAt, // preserved across update
    });

    // reorder reflected in list: Beta(1) now before Alpha-2(5)
    const reordered = (await (await fetch(`${baseUrl}${WS}`)).json()) as {
      workspaces: Workspace[];
    };
    expect(reordered.workspaces.map((w) => w.name)).toEqual(['Beta', 'Alpha-2']);

    // DELETE B
    const del = await fetch(`${baseUrl}${WS}/${encodeURIComponent(b.id)}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);

    const after = (await (await fetch(`${baseUrl}${WS}`)).json()) as {
      workspaces: Workspace[];
    };
    expect(after.workspaces.map((w) => w.name)).toEqual(['Alpha-2']);
  });

  it('PATCH preserves unspecified fields (partial update)', async () => {
    await mount({ iaStore: store });
    const created = (await (
      await fetch(`${baseUrl}${WS}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Gamma', projectIds: ['p1'], order: 3 }),
      })
    ).json()) as { workspace: Workspace };

    // rename only — order + projectIds must survive
    const patched = (await (
      await fetch(`${baseUrl}${WS}/${encodeURIComponent(created.workspace.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Gamma-renamed' }),
      })
    ).json()) as { workspace: Workspace };
    expect(patched.workspace).toMatchObject({
      name: 'Gamma-renamed',
      order: 3,
      projectIds: ['p1'],
    });
  });

  it('rejects blank name on create (400)', async () => {
    await mount({ iaStore: store });
    const res = await fetch(`${baseUrl}${WS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.details?.field).toBe('name');
  });

  it('rejects bad projectIds and bad order on create (400)', async () => {
    await mount({ iaStore: store });
    const badProjects = await fetch(`${baseUrl}${WS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', projectIds: ['ok', ''] }),
    });
    expect(badProjects.status).toBe(400);
    expect((await badProjects.json()).error.details.field).toBe('projectIds');

    const badOrder = await fetch(`${baseUrl}${WS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', order: 'first' }),
    });
    expect(badOrder.status).toBe(400);
    expect((await badOrder.json()).error.details.field).toBe('order');
  });

  it('PATCH/DELETE on unknown id → 404; bad id → 400', async () => {
    await mount({ iaStore: store });

    const patchMissing = await fetch(`${baseUrl}${WS}/ws%3Anope`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(patchMissing.status).toBe(404);
    expect((await patchMissing.json()).error.code).toBe('NOT_FOUND');

    const delMissing = await fetch(`${baseUrl}${WS}/ws%3Anope`, {
      method: 'DELETE',
    });
    expect(delMissing.status).toBe(404);

    const badId = await fetch(`${baseUrl}${WS}/not-a-ws-id`, {
      method: 'DELETE',
    });
    expect(badId.status).toBe(400);
    expect((await badId.json()).error.details.field).toBe('id');
  });

  it('degrades to 503 when the IA store is unavailable', async () => {
    await mount({ iaStore: null });
    const res = await fetch(`${baseUrl}${WS}`);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('NODE_BUSY');
  });

  it('applies the injected requireAuth middleware', async () => {
    const denyAuth: express.RequestHandler = (_req, res) => {
      res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    };
    await mount({ iaStore: store, requireAuth: denyAuth });
    const res = await fetch(`${baseUrl}${WS}`);
    expect(res.status).toBe(401);
  });
});
