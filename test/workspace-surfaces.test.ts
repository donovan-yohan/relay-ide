import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { attachAuthenticatedCliGatewayActorCredential } from '../server/cli-gateway-actor-auth.js';
import {
  createWorkspaceSurfaceStore,
  createWorkspaceSurfacesRouter,
  type WorkspaceSurfaceStore,
  type WorkspaceSurfacesRouterOptions,
} from '../server/workspace-surfaces.js';
import type { Config } from '../server/types.js';
import {
  WORKSPACE_SURFACES_MAX_LIST_ENTRIES,
  classifyOpenMode,
  isLoopbackUrl,
  type WorkspaceSurface,
  type WorkspaceSurfaceListResponse,
} from '../shared/workspace-surfaces.js';
import type { ScopedActorCredentialRecord } from '../shared/scoped-actor-credentials.js';

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
  requireWriteActorAuth?: WorkspaceSurfacesRouterOptions['requireWriteActorAuth'];
}): Promise<{ port: number }> {
  const app = express();
  app.use(express.json());
  app.use(
    createWorkspaceSurfacesRouter({
      store: input.store ?? null,
      ...(input.getConfig ? { getConfig: input.getConfig } : {}),
      ...(input.requireWriteActorAuth
        ? { requireWriteActorAuth: input.requireWriteActorAuth }
        : {}),
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

function scopedActorCredential(nodeIds: string[]): ScopedActorCredentialRecord {
  return {
    id: 'credential:workspace-surfaces',
    actor: { type: 'agent', id: 'agent:kani', displayName: 'Kani' },
    issuer: { id: 'operator:test' },
    audience: 'relay:cli-gateway:v1',
    capabilities: ['context:write'],
    scope: { nodeIds },
    issuedAt: '2026-06-21T00:00:00.000Z',
    expiresAt: '2026-06-21T00:05:00.000Z',
    correlationId: 'corr:workspace-surfaces',
  };
}

describe('workspace surfaces router', () => {
  it('treats the full IPv4 loopback range as node-scoped', () => {
    expect(isLoopbackUrl('http://127.0.1.1:3000')).toBe(true);
    expect(
      classifyOpenMode(
        { url: 'http://127.0.1.1:3000', nodeId: 'node_remote' },
        'local'
      )
    ).toBe('node-scoped');
  });

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

    const protocolRelative = await postJson(port, '/workspace-surfaces', {
      kind: 'web',
      label: 'protocol relative',
      url: '//example.com/app',
    });
    expect(protocolRelative.status).toBe(400);

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

  it('prioritizes published and configured surfaces before truncating discoveries', async () => {
    const repo = tmpRoot();
    const scripts: Record<string, string> = {};
    for (let i = 0; i < WORKSPACE_SURFACES_MAX_LIST_ENTRIES + 10; i += 1) {
      scripts[`dev:${i}`] = `vite --host 127.0.0.1 --port ${3000 + i}`;
    }
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts }));
    const store = surfaceStore();
    store.upsert({
      id: 'agent-preview',
      kind: 'preview',
      label: 'agent preview',
      url: 'https://preview.example.test',
      repoPath: repo,
    });
    const { port } = await listen({
      store,
      getConfig: () =>
        asConfig([repo], [
          {
            kind: 'dashboard',
            label: 'configured ops dashboard',
            url: 'https://ops.example.test/relay',
            repoPath: repo,
          },
        ]),
    });

    const res = await getJson<WorkspaceSurfaceListResponse>(
      port,
      `/workspace-surfaces?repoPath=${encodeURIComponent(repo)}`
    );

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.surfaces).toHaveLength(WORKSPACE_SURFACES_MAX_LIST_ENTRIES);
    expect(res.body.surfaces.slice(0, 2).map((surface) => surface.label)).toEqual([
      'agent preview',
      'configured ops dashboard',
    ]);
    expect(res.body.surfaces.map((surface) => surface.label)).toContain(
      'npm run dev:0'
    );
  });

  it('fetches the full response cap of published surfaces and reports sentinel truncation', async () => {
    const store = surfaceStore();
    for (let i = 0; i < WORKSPACE_SURFACES_MAX_LIST_ENTRIES + 1; i += 1) {
      store.upsert({
        id: `agent-preview-${i}`,
        kind: 'preview',
        label: `agent preview ${i}`,
        url: `https://preview-${i}.example.test`,
      });
    }
    const { port } = await listen({ store });

    const res = await getJson<WorkspaceSurfaceListResponse>(
      port,
      '/workspace-surfaces'
    );

    expect(res.status).toBe(200);
    expect(res.body.surfaces).toHaveLength(WORKSPACE_SURFACES_MAX_LIST_ENTRIES);
    expect(res.body.truncated).toBe(true);
  });

  it('binds actor-published node and actor metadata to the authenticated credential', async () => {
    const store = surfaceStore();
    let requestedScope: { nodeIds?: string[]; workContextIds?: string[] } | undefined;
    const { port } = await listen({
      store,
      requireWriteActorAuth: (_expectedCommand, options) => {
        return ((req, _res, next) => {
          requestedScope = options?.scopeForRequest?.(req);
          attachAuthenticatedCliGatewayActorCredential(
            req,
            scopedActorCredential(['node_remote'])
          );
          next();
        }) as RequestHandler;
      },
    });

    const denied = await postJson(port, '/workspace-surfaces', {
      kind: 'preview',
      label: 'spoofed local preview',
      url: 'http://localhost:4173',
      nodeId: 'local',
      actor: 'agent:spoof',
    });
    expect(denied.status).toBe(403);
    expect(requestedScope).toEqual({ nodeIds: ['local'] });

    const allowed = await postJson<{ surface: WorkspaceSurface }>(
      port,
      '/workspace-surfaces',
      {
        kind: 'preview',
        label: 'actor preview',
        url: 'http://localhost:4173',
        actor: 'agent:spoof',
      }
    );

    expect(allowed.status).toBe(201);
    expect(allowed.body.surface).toMatchObject({
      nodeId: 'node_remote',
      openMode: 'node-scoped',
      provenance: { source: 'agent-published', actor: 'agent:kani' },
    });
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
