import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkspaceEvidenceRouter,
  type WorkspaceEvidenceNodeLinks,
  type WorkspaceEvidenceNodeRegistry,
} from '../server/workspace-evidence.js';
import type { Config } from '../server/types.js';
import {
  createWorkspaceEvidenceRootId,
  WORKSPACE_EVIDENCE_LIST_HASH_TOTAL_BYTE_LIMIT,
  type WorkspaceEvidenceRoot,
  type WorkspaceEvidenceRootRef,
} from '../shared/workspace-evidence.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createRepoInstanceId,
} from '../shared/identity.js';
import {
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type HubNodeSummary,
} from '../shared/relay-node-protocol.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function tmpRoot(name = 'relay-workspace-evidence-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function asConfig(repos: string[], workspaces: Array<{ id: string; name: string; repos: string[] }> = []): Config {
  return { repos, workspaces } as unknown as Config;
}

async function listen(router: express.Router): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function getJson<T>(port: number, url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function postJson<T>(port: number, url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function remoteRoot(nodeId = 'node_remote', remotePath = '/srv/project'): WorkspaceEvidenceRoot {
  const ref: WorkspaceEvidenceRootRef = {
    id: createWorkspaceEvidenceRootId(nodeId, remotePath),
    nodeId,
    kind: 'repo',
    repoInstanceId: createRepoInstanceId(nodeId, remotePath),
  };
  return {
    ref,
    name: 'project',
    path: remotePath,
    nodeId,
    kind: 'repo',
    backing: 'repo',
    status: 'available',
    capabilities: { list: true, stat: true, read: true, preview: true, write: false },
    repo: { repoPath: remotePath, repoInstanceId: ref.repoInstanceId, isGitRepo: true },
  };
}

function onlineNode(nodeId = 'node_remote'): HubNodeSummary {
  return {
    nodeId,
    identity: { nodeId, publicKeyFingerprint: 'fingerprint' },
    displayName: 'Remote Node',
    hostname: 'remote-host',
    platform: 'linux',
    arch: 'x64',
    relayVersion: 'test',
    protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    status: 'online',
    connection: { state: 'connected', transport: 'websocket' },
    trust: { state: 'trusted', level: 'trusted' },
    credentialState: 'active',
    credential: { credentialId: 'cred', nodeId, publicKeyFingerprint: 'fingerprint', createdAt: '2026-01-01T00:00:00.000Z' },
    version: {
      state: 'compatible',
      nodeProtocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
      hubProtocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    },
    capabilities: { terminalBackends: [], protocolFeatures: [] },
    fileRpcAvailable: true,
    degradedReasons: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    pairedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    credentialId: 'cred',
  } as unknown as HubNodeSummary;
}

describe('workspace evidence router', () => {
  it('lists local directory, repo, and worktree roots as read-only evidence scopes', async () => {
    const plain = tmpRoot();
    fs.writeFileSync(path.join(plain, 'notes.txt'), 'plain workspace\n');
    const repo = tmpRoot();
    fs.mkdirSync(path.join(repo, '.git'));
    const worktree = tmpRoot();
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'sample')}\n`);

    const { port } = await listen(
      createWorkspaceEvidenceRouter({
        getConfig: () => asConfig([plain, repo], [{ id: 'ws_a', name: 'Workspace A', repos: [worktree] }]),
      })
    );

    const res = await getJson<{ roots: WorkspaceEvidenceRoot[] }>(port, '/workspace-evidence/roots');
    expect(res.status).toBe(200);
    expect(res.body.roots.map((root) => root.kind).sort()).toEqual(['directory', 'repo', 'worktree']);
    expect(res.body.roots.every((root) => root.capabilities.write === false)).toBe(true);
    expect(res.body.roots.find((root) => root.path === worktree)?.ref.workspaceId).toBe('ws_a');
    expect(res.body.roots.find((root) => root.path === plain)?.nodeId).toBe(DEFAULT_LOCAL_NODE_ID);
  });

  it('populates repo.currentBranch for an available git-backed root (#897 BUG 4)', async () => {
    const repo = tmpRoot();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-b', 'evidence-branch');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
    git('add', '.');
    git('commit', '-m', 'init');

    const { port } = await listen(
      createWorkspaceEvidenceRouter({ getConfig: () => asConfig([repo]) })
    );

    const res = await getJson<{ roots: WorkspaceEvidenceRoot[] }>(port, '/workspace-evidence/roots');
    expect(res.status).toBe(200);
    const root = res.body.roots.find((r) => r.path === repo);
    expect(root?.kind).toBe('repo');
    expect(root?.status).toBe('available');
    expect(root?.repo?.currentBranch).toBe('evidence-branch');
  });

  it('exposes production remote node home roots with offline/online route state', async () => {
    const node = { ...onlineNode('node_prod'), homeDir: '/home/relay' };
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const registry: WorkspaceEvidenceNodeRegistry = { listNodes: () => [node] };
    const nodeLinks: WorkspaceEvidenceNodeLinks = {
      hasActiveNode: () => true,
      request: async (_nodeId, type, payload) => {
        calls.push({ type, payload: payload as Record<string, unknown> });
        return {
          operation: 'list',
          root: '/home/relay',
          cwd: '/home/relay',
          path: '/home/relay/project',
          entries: [],
          truncated: false,
          maxEntries: 100,
        };
      },
    };

    const { port } = await listen(createWorkspaceEvidenceRouter({ registry, nodeLinks }));
    const roots = await getJson<{ roots: WorkspaceEvidenceRoot[] }>(port, '/workspace-evidence/roots');
    const remote = roots.body.roots.find((root) => root.nodeId === 'node_prod');
    expect(remote).toMatchObject({ status: 'available', path: '/home/relay', capabilities: { list: true, write: false } });

    const list = await postJson<{ state: string }>(port, '/workspace-evidence/list', {
      rootRef: remote?.ref,
      path: 'project',
    });
    expect(list.status).toBe(200);
    expect(calls[0].payload).toMatchObject({ root: '/home/relay', cwd: '/home/relay', path: '/home/relay/project' });

    const offlinePort = await listen(
      createWorkspaceEvidenceRouter({
        registry,
        nodeLinks: { ...nodeLinks, hasActiveNode: () => false },
      })
    );
    const offlineRoots = await getJson<{ roots: WorkspaceEvidenceRoot[] }>(offlinePort.port, '/workspace-evidence/roots');
    expect(offlineRoots.body.roots.find((root) => root.nodeId === 'node_prod')).toMatchObject({
      status: 'offline',
      unavailableReason: 'WORKSPACE_EVIDENCE_NODE_OFFLINE',
      capabilities: { list: false, reason: 'WORKSPACE_EVIDENCE_NODE_OFFLINE' },
    });
  });

  it('reads and previews local root files without allowing arbitrary path browsing', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'README.md'), '# hello\nworkspace evidence\n');
    fs.writeFileSync(path.join(path.dirname(root), 'secret.txt'), 'nope\n');

    const { port } = await listen(createWorkspaceEvidenceRouter({ getConfig: () => asConfig([root]) }));
    const roots = await getJson<{ roots: WorkspaceEvidenceRoot[] }>(port, '/workspace-evidence/roots');
    const rootRef = roots.body.roots[0].ref;

    const list = await postJson<{ entries: Array<{ path: string; contentHash?: string }> }>(port, '/workspace-evidence/list', {
      rootRef,
      path: '.',
    });
    expect(list.status).toBe(200);
    expect(list.body.entries).toMatchObject([{ path: 'README.md' }]);
    expect(list.body.entries[0].contentHash).toMatch(/^[a-f0-9]{64}$/);

    const read = await postJson<{ operation: string; content: string; truncated: boolean; contentHash: string }>(
      port,
      '/workspace-evidence/read',
      { rootRef, path: 'README.md', maxBytes: 1024 }
    );
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ operation: 'read', content: '# hello\nworkspace evidence\n', truncated: false });
    expect(read.body.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const preview = await postJson<{ preview: { state: string; kind: string; content: string; sandboxRequired?: boolean } }>(
      port,
      '/workspace-evidence/preview',
      { rootRef, path: 'README.md', maxBytes: 1024 }
    );
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ state: 'available', kind: 'markdown', content: '# hello\nworkspace evidence\n' });

    const escape = await postJson<{ error: { reason: string; state: string } }>(port, '/workspace-evidence/preview', {
      rootRef,
      path: '../secret.txt',
    });
    expect(escape.status).toBe(422);
    expect(escape.body.error).toMatchObject({ reason: 'WORKSPACE_EVIDENCE_ROOT_ESCAPE', state: 'unsupported' });
  });

  it('returns explicit preview states for oversized and unsupported files', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'large.txt'), '0123456789');
    fs.writeFileSync(path.join(root, 'archive.bin'), 'abc');

    const { port } = await listen(createWorkspaceEvidenceRouter({ getConfig: () => asConfig([root]) }));
    const roots = await getJson<{ roots: WorkspaceEvidenceRoot[] }>(port, '/workspace-evidence/roots');
    const rootRef = roots.body.roots[0].ref;

    const oversized = await postJson<{ preview: { state: string; unsupportedReason: string } }>(port, '/workspace-evidence/preview', {
      rootRef,
      path: 'large.txt',
      maxBytes: 4,
    });
    expect(oversized.status).toBe(200);
    expect(oversized.body.preview).toMatchObject({ state: 'oversized', unsupportedReason: 'WORKSPACE_EVIDENCE_OVERSIZED' });

    const unsupported = await postJson<{ preview: { state: string; unsupportedReason: string } }>(port, '/workspace-evidence/preview', {
      rootRef,
      path: 'archive.bin',
      maxBytes: 1024,
    });
    expect(unsupported.status).toBe(200);
    expect(unsupported.body.preview).toMatchObject({ state: 'unsupported', unsupportedReason: 'WORKSPACE_EVIDENCE_UNSUPPORTED' });
  });

  it('serves a base64 image preview for raster image files (#897)', async () => {
    const root = tmpRoot();
    // Smallest valid PNG: a 1x1 image. Raw bytes contain NUL, so the utf8
    // decode path would reject it as binary — the image branch must serve it.
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const pngBytes = Buffer.from(pngBase64, 'base64');
    fs.writeFileSync(path.join(root, 'pixel.png'), pngBytes);
    fs.writeFileSync(path.join(root, 'archive.bin'), 'abc');

    const { port } = await listen(createWorkspaceEvidenceRouter({ getConfig: () => asConfig([root]) }));
    const roots = await getJson<{ roots: WorkspaceEvidenceRoot[] }>(port, '/workspace-evidence/roots');
    const rootRef = roots.body.roots[0].ref;

    const image = await postJson<{
      preview: { state: string; kind: string; encoding: string; content: string; contentHash?: string };
    }>(port, '/workspace-evidence/preview', { rootRef, path: 'pixel.png', maxBytes: 1024 });
    expect(image.status).toBe(200);
    expect(image.body.preview).toMatchObject({ state: 'available', kind: 'image', encoding: 'base64' });
    expect(image.body.preview.content.length).toBeGreaterThan(0);
    expect(Buffer.from(image.body.preview.content, 'base64').equals(pngBytes)).toBe(true);
    expect(image.body.preview.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const binary = await postJson<{ preview: { state: string; unsupportedReason: string } }>(
      port,
      '/workspace-evidence/preview',
      { rootRef, path: 'archive.bin', maxBytes: 1024 }
    );
    expect(binary.status).toBe(200);
    expect(binary.body.preview).toMatchObject({ state: 'unsupported', unsupportedReason: 'WORKSPACE_EVIDENCE_UNSUPPORTED' });
  });

  it('reports unavailable local roots instead of pretending missing paths are browsable', async () => {
    const root = path.join(tmpRoot(), 'missing');
    const { port } = await listen(createWorkspaceEvidenceRouter({ getConfig: () => asConfig([root]) }));
    const roots = await getJson<{ roots: WorkspaceEvidenceRoot[] }>(port, '/workspace-evidence/roots');
    expect(roots.status).toBe(200);
    expect(roots.body.roots[0]).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'WORKSPACE_EVIDENCE_ROOT_NOT_FOUND',
      capabilities: { list: false, stat: false, read: false, preview: false, write: false },
    });

    const list = await postJson<{ error: { state: string; reason: string } }>(port, '/workspace-evidence/list', {
      rootRef: roots.body.roots[0].ref,
    });
    expect(list.status).toBe(503);
    expect(list.body.error).toMatchObject({ state: 'unavailable', reason: 'WORKSPACE_EVIDENCE_ROOT_NOT_FOUND' });
  });

  it('bounds local list hashing instead of hashing every listed file concurrently', async () => {
    const root = tmpRoot();
    const fileCount = 8;
    const fileSize = WORKSPACE_EVIDENCE_LIST_HASH_TOTAL_BYTE_LIMIT / 4;
    for (let index = 0; index < fileCount; index += 1) {
      fs.writeFileSync(path.join(root, `file-${index}.txt`), Buffer.alloc(fileSize, String(index)));
    }

    const { port } = await listen(createWorkspaceEvidenceRouter({ getConfig: () => asConfig([root]) }));
    const roots = await getJson<{ roots: WorkspaceEvidenceRoot[] }>(port, '/workspace-evidence/roots');
    const list = await postJson<{ entries: Array<{ path: string; contentHash?: string }> }>(port, '/workspace-evidence/list', {
      rootRef: roots.body.roots[0].ref,
      maxEntries: fileCount,
    });

    expect(list.status).toBe(200);
    expect(list.body.entries.filter((entry) => entry.contentHash).length).toBe(4);
    expect(list.body.entries.filter((entry) => !entry.contentHash).length).toBe(fileCount - 4);
  });

  it('treats invalid UTF-8 text-extension files as binary for preview/read', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'bad.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
    const { port } = await listen(createWorkspaceEvidenceRouter({ getConfig: () => asConfig([root]) }));
    const roots = await getJson<{ roots: WorkspaceEvidenceRoot[] }>(port, '/workspace-evidence/roots');
    const rootRef = roots.body.roots[0].ref;

    const preview = await postJson<{ preview: { state: string; unsupportedReason: string } }>(port, '/workspace-evidence/preview', {
      rootRef,
      path: 'bad.txt',
      maxBytes: 1024,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ state: 'binary', unsupportedReason: 'WORKSPACE_EVIDENCE_BINARY_UNSUPPORTED' });

    const read = await postJson<{ error: { state: string; reason: string } }>(port, '/workspace-evidence/read', {
      rootRef,
      path: 'bad.txt',
      maxBytes: 1024,
    });
    expect(read.status).toBe(422);
    expect(read.body.error).toMatchObject({ state: 'unsupported', reason: 'WORKSPACE_EVIDENCE_BINARY_UNSUPPORTED' });
  });

  it('surfaces remote offline state before routing file RPC', async () => {
    const root = remoteRoot('node_offline');
    let calls = 0;
    const registry: WorkspaceEvidenceNodeRegistry = { listNodes: () => [] };
    const nodeLinks: WorkspaceEvidenceNodeLinks = {
      hasActiveNode: () => {
        calls += 1;
        return false;
      },
      request: async () => {
        calls += 1;
        throw new Error('should not route while offline');
      },
    };

    const { port } = await listen(createWorkspaceEvidenceRouter({ getRoots: () => [root], registry, nodeLinks }));
    const list = await postJson<{ error: { state: string; reason: string } }>(port, '/workspace-evidence/list', {
      rootRef: root.ref,
      path: '.',
    });
    expect(list.status).toBe(503);
    expect(list.body.error).toMatchObject({ state: 'offline', reason: 'WORKSPACE_EVIDENCE_NODE_OFFLINE' });
    expect(calls).toBe(0);
  });

  it('routes remote read/preview through the node file RPC link when online', async () => {
    const root = remoteRoot('node_online');
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const registry: WorkspaceEvidenceNodeRegistry = { listNodes: () => [onlineNode('node_online')] };
    const nodeLinks: WorkspaceEvidenceNodeLinks = {
      hasActiveNode: () => true,
      request: async (_nodeId, type, payload) => {
        calls.push({ type, payload: payload as Record<string, unknown> });
        if (type === 'fs.stat') {
          return {
            operation: 'stat',
            root: '/srv/project',
            cwd: '/srv/project',
            path: '/srv/project/README.md',
            stat: { path: '/srv/project/README.md', name: 'README.md', type: 'file', size: 14, mtimeMs: 1, mode: 0o100644 },
          };
        }
        if (type === 'fs.read') {
          return {
            operation: 'read',
            root: '/srv/project',
            cwd: '/srv/project',
            path: '/srv/project/README.md',
            encoding: 'utf8',
            content: '# remote\nbody\n',
            bytesRead: 14,
            truncatedBytes: false,
            truncatedLines: false,
            maxBytes: 1024,
          };
        }
        throw new Error(`unexpected request ${type}`);
      },
    };

    const { port } = await listen(createWorkspaceEvidenceRouter({ getRoots: () => [root], registry, nodeLinks }));
    const preview = await postJson<{ preview: { state: string; kind: string; content: string } }>(port, '/workspace-evidence/preview', {
      rootRef: root.ref,
      path: 'README.md',
      maxBytes: 1024,
    });

    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ state: 'available', kind: 'markdown', content: '# remote\nbody\n' });
    expect(calls.map((call) => call.type)).toEqual(['fs.stat', 'fs.read']);
    expect(calls[0].payload).toMatchObject({ root: '/srv/project', cwd: '/srv/project', path: '/srv/project/README.md' });
  });

  it('uses remote Windows path semantics when previewing files under dotted directories', async () => {
    const root = remoteRoot('node_windows', 'C:\\srv\\project');
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const registry: WorkspaceEvidenceNodeRegistry = {
      listNodes: () => [{ ...onlineNode('node_windows'), platform: 'win32' }],
    };
    const nodeLinks: WorkspaceEvidenceNodeLinks = {
      hasActiveNode: () => true,
      request: async (_nodeId, type, payload) => {
        calls.push({ type, payload: payload as Record<string, unknown> });
        if (type === 'fs.stat') {
          return {
            operation: 'stat',
            root: 'C:\\srv\\project',
            cwd: 'C:\\srv\\project',
            path: 'C:\\srv\\project\\docs.withdot\\README',
            stat: {
              path: 'C:\\srv\\project\\docs.withdot\\README',
              name: 'README',
              type: 'file',
              size: 10,
              mtimeMs: 1,
              mode: 0o100644,
            },
          };
        }
        if (type === 'fs.read') {
          return {
            operation: 'read',
            root: 'C:\\srv\\project',
            cwd: 'C:\\srv\\project',
            path: 'C:\\srv\\project\\docs.withdot\\README',
            encoding: 'utf8',
            content: 'plain text',
            bytesRead: 10,
            truncatedBytes: false,
            truncatedLines: false,
            maxBytes: 1024,
          };
        }
        throw new Error(`unexpected request ${type}`);
      },
    };

    const { port } = await listen(createWorkspaceEvidenceRouter({ getRoots: () => [root], registry, nodeLinks }));
    const preview = await postJson<{ preview: { state: string; kind: string; content: string } }>(port, '/workspace-evidence/preview', {
      rootRef: root.ref,
      path: 'docs.withdot\\README',
      maxBytes: 1024,
    });

    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ state: 'available', kind: 'text', content: 'plain text' });
    expect(calls.map((call) => call.type)).toEqual(['fs.stat', 'fs.read']);
    expect(calls[0].payload).toMatchObject({ root: 'C:\\srv\\project', cwd: 'C:\\srv\\project', path: 'C:\\srv\\project\\docs.withdot\\README' });
  });
});
