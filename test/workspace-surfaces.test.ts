import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkspaceSurfaceStore,
  createWorkspaceSurfacesRouter,
  type WorkspaceSurfaceStore,
} from '../server/workspace-surfaces.js';
import type { Config } from '../server/types.js';
import type {
  WorkspaceSurface,
  WorkspaceSurfaceListResponse,
} from '../shared/workspace-surfaces.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function tmpRoot(name = 'relay-workspace-surfaces-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function asConfig(
  repos: string[],
  workspaceSurfaces: Config['workspaceSurfaces'] = []
): Config {
  return { repos, workspaces: [], workspaceSurfaces } as unknown as Config;
}

async function listen(input: {
  store?: WorkspaceSurfaceStore | null;
  getConfig?: () => Config;
}): Promise<{ port: number }> {
  const app = express();
  app.use(express.json());
  app.use(
    createWorkspaceSurfacesRouter({
      store: input.store ?? null,
      getConfig: input.getConfig,
    })
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
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

async function postJson<T>(
  port: number,
  url: string,
  body: unknown,
  capabilities = 'context:write'
): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-relay-capabilities': capabilities,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function surfaceStore(): WorkspaceSurfaceStore {
  const dir = tmpRoot('relay-workspace-surfaces-db-');
  const store = createWorkspaceSurfaceStore({
    dbPath: path.join(dir, 'surfaces.db'),
    now: () => '2026-06-21T00:00:00.000Z',
  });
  cleanup.push(() => store.close());
  return store;
}

describe('workspace surfaces router', () => {
  it('discovers package scripts and compose ports using static metadata only', async () => {
    const repo = tmpRoot();
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({
        scripts: {
          dev: 'vite --host 127.0.0.1 --port 5173',
          test: 'vitest run',
        },
      })
    );
    fs.writeFileSync(
      path.join(repo, 'docker-compose.yml'),
      ['services:', '  web:', '    ports:', '      - "3000:8080"'].join('\n')
    );
    const { port } = await listen({
      getConfig: () =>
        asConfig([repo], [
          {
            kind: 'dashboard',
            label: 'configured ops dashboard',
            url: 'https://ops.example.test/relay',
            repoPath: repo,
            provenanceDetail: 'config.json workspaceSurfaces',
          },
        ]),
    });

    const res = await getJson<WorkspaceSurfaceListResponse>(
      port,
      '/workspace-surfaces'
    );

    expect(res.status).toBe(200);
    expect(res.body.surfaces.map((surface) => surface.label).sort()).toEqual([
      'compose :3000',
      'configured ops dashboard',
      'npm run dev',
    ]);
    expect(
      res.body.surfaces.find((surface) => surface.label === 'configured ops dashboard')
    ).toMatchObject({
      provenance: { source: 'configured', detail: 'config.json workspaceSurfaces' },
      openMode: 'direct',
    });
    expect(res.body.surfaces.every((surface) => surface.openMode === 'direct')).toBe(
      true
    );
  });

  it('publishes bounded agent surfaces and rejects unsafe urls', async () => {
    const store = surfaceStore();
    const { port } = await listen({ store });

    const bad = await postJson(port, '/workspace-surfaces', {
      kind: 'web',
      label: 'bad js',
      url: 'javascript:alert(1)',
    });
    expect(bad.status).toBe(400);

    const good = await postJson<{ surface: WorkspaceSurface }>(
      port,
      '/workspace-surfaces',
      {
        kind: 'preview',
        label: 'agent preview',
        url: 'http://localhost:4173',
        nodeId: 'node_remote',
        rootId: 'root-a',
        repoPath: '/repo',
        actor: 'agent:kani',
        health: 'reachable',
      }
    );
    expect(good.status).toBe(201);
    expect(good.body.surface).toMatchObject({
      label: 'agent preview',
      status: 'published',
      openMode: 'node-scoped',
      provenance: { source: 'agent-published', actor: 'agent:kani' },
    });

    const list = await getJson<WorkspaceSurfaceListResponse>(
      port,
      '/workspace-surfaces?repoPath=%2Frepo'
    );
    expect(list.body.surfaces).toHaveLength(1);
    expect(list.body.surfaces[0]?.label).toBe('agent preview');
  });

  it('enforces capability headers for list and publish', async () => {
    const store = surfaceStore();
    const { port } = await listen({ store });

    const listDenied = await getJson(port, '/workspace-surfaces', 'context:write');
    expect(listDenied.status).toBe(403);

    const publishDenied = await postJson(
      port,
      '/workspace-surfaces',
      { kind: 'web', label: 'dev', url: 'https://example.com' },
      'context:read'
    );
    expect(publishDenied.status).toBe(403);
  });
});
