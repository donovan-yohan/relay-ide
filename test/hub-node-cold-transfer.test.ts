import * as fs from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeRouter } from '../server/hub-node-router.js';
import { createHubNodeLinkManager } from '../server/hub-node-link.js';
import { createLocalRelayNode } from '../server/local-node.js';
import { setupWebSocket } from '../server/ws.js';
import type { SessionSummary } from '../server/types.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import type { RepoInventoryReport } from '../shared/repo-inventory.js';
import type { RelayNodeEnvelope } from '../shared/relay-node-protocol.js';

function manifest(): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    hostname: 'cold-transfer-node',
    relayVersion: '0.1.0-test',
    generatedAt: '2026-01-02T03:04:05.000Z',
    wsl: { detected: false, version: null, systemd: false },
    serviceManager: {
      kind: 'systemd-user',
      label: 'systemd user',
      supported: true,
      installable: true,
      installHint: 'install',
      uninstallHint: 'uninstall',
      message: 'ok',
      caveats: [],
    },
    capabilities: {
      tmux: { id: 'tmux', label: 'tmux', status: 'available', message: 'ok' },
      git: { id: 'git', label: 'Git', status: 'available', message: 'ok' },
      clipboard: {
        id: 'clipboard',
        label: 'Clipboard',
        status: 'unknown',
        message: 'unknown',
      },
      browserAutomation: {
        id: 'browserAutomation',
        label: 'Browser automation',
        status: 'degraded',
        message: 'missing deps',
      },
      githubCli: {
        id: 'githubCli',
        label: 'GitHub CLI',
        status: 'available',
        message: 'ok',
      },
      tailscale: {
        id: 'tailscale',
        label: 'Tailscale CLI',
        status: 'unavailable',
        message: 'missing',
      },
      ssh: {
        id: 'ssh',
        label: 'SSH client',
        status: 'available',
        message: 'ok',
      },
      agents: {
        claude: {
          id: 'claude',
          label: 'Claude',
          status: 'available',
          message: 'ok',
        },
      },
    },
  };
}

const selectedRemote = {
  name: 'origin',
  url: 'git@github.com:donovan-yohan/relay-ide.git',
  identity: 'github.com/donovan-yohan/relay-ide',
  provider: 'github' as const,
  host: 'github.com',
  path: 'donovan-yohan/relay-ide',
  owner: 'donovan-yohan',
  repoName: 'relay-ide',
};

function repoInventoryReport(
  nodeId: string,
  localPath: string,
  overrides: Partial<RepoInventoryReport['repos'][number]> = {}
): RepoInventoryReport {
  const worktrees = overrides.worktrees ?? [
    {
      worktreeInstanceId: `${nodeId}:${encodeURIComponent(`${localPath}/.worktrees/feature-a`)}`,
      localPath: `${localPath}/.worktrees/feature-a`,
      branchName: 'feature/a',
      dirty: {
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        files: [],
        truncated: false,
      },
      divergence: {
        upstreamRef: 'origin/nightly',
        aheadCount: 0,
        behindCount: 0,
      },
    },
  ];

  return {
    nodeId,
    generatedAt: '2026-01-02T03:04:05.000Z',
    repos: [
      {
        repoInstanceId: `${nodeId}:${encodeURIComponent(localPath)}`,
        nodeId,
        localPath,
        name: 'relay-ide',
        isGitRepo: true,
        defaultBranch: 'nightly',
        currentBranch: 'nightly',
        repoIdentity: 'github.com/donovan-yohan/relay-ide',
        selectedRemote,
        remotes: [selectedRemote],
        repoIdentityWarnings: [],
        dirty: {
          stagedCount: 0,
          unstagedCount: 0,
          untrackedCount: 0,
          conflictedCount: 0,
          files: [],
          truncated: false,
        },
        divergence: {
          upstreamRef: 'origin/nightly',
          aheadCount: 0,
          behindCount: 0,
        },
        worktrees,
        reportedAt: '2026-01-02T03:04:05.000Z',
        ...overrides,
      },
    ],
  };
}

function remoteSession(nodeId: string): SessionSummary {
  return {
    id: 'cold-reopen-session-1',
    type: 'agent',
    agent: 'claude',
    mode: 'pty',
    repoPath: '/srv/relay-ide',
    worktreePath: '/srv/relay-ide/.worktrees/feature-a',
    cwd: '/srv/relay-ide/.worktrees/feature-a',
    repoName: 'relay-ide',
    branchName: 'feature/a',
    displayName: 'Agent 1',
    createdAt: '2026-01-02T03:04:05.000Z',
    lastActivity: '2026-01-02T03:04:05.000Z',
    idle: false,
    customCommand: null,
    nodeId,
    globalSessionId: `${nodeId}:cold-reopen-session-1`,
    repoInstanceId: `${nodeId}:%2Fsrv%2Frelay-ide`,
    worktreeInstanceId: `${nodeId}:%2Fsrv%2Frelay-ide%2F.worktrees%2Ffeature-a`,
    useTmux: true,
    tmuxSessionName: 'relay-ide-cold-reopen-session-1',
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing server address');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

async function nextJson(ws: WebSocket): Promise<RelayNodeEnvelope> {
  return await new Promise<RelayNodeEnvelope>((resolve) => {
    ws.once('message', (data) =>
      resolve(JSON.parse(data.toString()) as RelayNodeEnvelope)
    );
  });
}

describe('hub cold transfer / reopen-on-other-node', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  async function startHub(options?: {
    collectLocalRepoInventory?: () => Promise<RepoInventoryReport>;
  }) {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-hub-cold-transfer-')
    );
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const registry = createHubNodeRegistry({
      storagePath: path.join(tmpDir, 'nodes.json'),
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });
    const nodeLinks = createHubNodeLinkManager();
    const app = express();
    app.use(express.json());
    app.use(
      createHubNodeRouter({
        registry,
        nodeLinks,
        requireAuth: (req, res, next) => {
          if (req.header('x-test-auth') === 'yes') next();
          else res.status(401).json({ error: 'Unauthorized' });
        },
        collectLocalRepoInventory: options?.collectLocalRepoInventory,
      })
    );
    const server = http.createServer(app);
    setupWebSocket(
      server,
      new Set(),
      null,
      undefined,
      true,
      createLocalRelayNode({ nodeId: 'hub-node' }),
      registry,
      nodeLinks
    );
    const port = await listen(server);
    cleanup.push(() => close(server));
    return {
      base: `http://127.0.0.1:${port}`,
      wsBase: `ws://127.0.0.1:${port}`,
    };
  }

  async function pairNode(
    base: string
  ): Promise<{ token: string; nodeId: string }> {
    const pairRes = await fetch(`${base}/hub/pair-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
    });
    expect(pairRes.status).toBe(201);
    const pair = (await pairRes.json()) as { pairToken: string };
    const exchangeRes = await fetch(`${base}/hub/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: pair.pairToken, manifest: manifest() }),
    });
    expect(exchangeRes.status).toBe(201);
    const exchange = (await exchangeRes.json()) as {
      credential: { token: string; nodeId: string };
    };
    return exchange.credential;
  }

  async function heartbeatRepoInventory(
    base: string,
    token: string,
    nodeId: string,
    report: RepoInventoryReport
  ): Promise<void> {
    const res = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        nodeId,
        protocolVersion: '1.0',
        repoInventory: report,
      }),
    });
    expect(res.status).toBe(200);
  }

  it('returns NODE_OFFLINE instead of pretending to migrate when target node has no live link', async () => {
    const { base } = await startHub();
    const { token, nodeId } = await pairNode(base);
    await heartbeatRepoInventory(
      base,
      token,
      nodeId,
      repoInventoryReport(nodeId, '/srv/relay-ide')
    );

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/reopen`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          source: {
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            branchName: 'feature/a',
          },
          type: 'agent',
        }),
      }
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: 'NODE_OFFLINE', retryable: true },
    });
  });

  it('returns a missing-checkout error with clone/worktree guidance when target lacks the repo', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    await heartbeatRepoInventory(
      base,
      token,
      nodeId,
      repoInventoryReport(nodeId, '/srv/other', {
        repoIdentity: 'github.com/example/other',
      })
    );
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/reopen`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          source: {
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            branchName: 'feature/a',
          },
          type: 'agent',
        }),
      }
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        retryable: false,
        details: {
          suggestedAction: 'clone-or-add-worktree',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          targetNodeId: nodeId,
        },
      },
    });
  });

  it('returns a missing-checkout error when the repo exists but requested branch/worktree is absent', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    await heartbeatRepoInventory(
      base,
      token,
      nodeId,
      repoInventoryReport(nodeId, '/srv/relay-ide', {
        worktrees: [],
      })
    );
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/reopen`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          source: {
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            branchName: 'feature/a',
          },
          type: 'agent',
        }),
      }
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        retryable: false,
        details: {
          suggestedAction: 'add-worktree-or-checkout-branch',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          branchName: 'feature/a',
          targetNodeId: nodeId,
        },
      },
    });
  });

  it('surfaces dirty and diverged checkout warnings while still reopening cold', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    await heartbeatRepoInventory(
      base,
      token,
      nodeId,
      repoInventoryReport(nodeId, '/srv/relay-ide', {
        worktrees: [
          {
            worktreeInstanceId: `${nodeId}:${encodeURIComponent('/srv/relay-ide/.worktrees/feature-a')}`,
            localPath: '/srv/relay-ide/.worktrees/feature-a',
            branchName: 'feature/a',
            dirty: {
              stagedCount: 1,
              unstagedCount: 1,
              untrackedCount: 0,
              conflictedCount: 0,
              files: [
                { path: 'server/hub-node-router.ts', status: 'modified' },
              ],
              truncated: false,
            },
            divergence: {
              upstreamRef: 'origin/nightly',
              aheadCount: 2,
              behindCount: 1,
            },
          },
        ],
      })
    );
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/reopen`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          source: {
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            branchName: 'feature/a',
          },
          type: 'agent',
        }),
      }
    );
    const request = await nextJson(nodeWs);
    expect(request.payload).toMatchObject({
      repoPath: '/srv/relay-ide',
      worktreePath: '/srv/relay-ide/.worktrees/feature-a',
      branchName: 'feature/a',
    });
    expect(JSON.stringify(request.payload)).toContain('cold reopen');
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            ...remoteSession(nodeId),
            nodeId: undefined,
            globalSessionId: undefined,
          },
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      transfer: {
        livePtyMigrated: false,
        warnings: [
          { code: 'source-dirty-checkout' },
          { code: 'source-diverged-checkout' },
          { code: 'target-dirty-checkout' },
          { code: 'target-diverged-checkout' },
        ],
      },
    });
  });

  it('surfaces source dirty/diverged warnings when only repoIdentity/branchName is provided', async () => {
    const { base, wsBase } = await startHub();
    const { token: sourceToken, nodeId: sourceNodeId } = await pairNode(base);
    await heartbeatRepoInventory(
      base,
      sourceToken,
      sourceNodeId,
      repoInventoryReport(sourceNodeId, '/srv/relay-ide', {
        worktrees: [
          {
            worktreeInstanceId: `${sourceNodeId}:${encodeURIComponent('/srv/relay-ide/.worktrees/feature-a')}`,
            localPath: '/srv/relay-ide/.worktrees/feature-a',
            branchName: 'feature/a',
            dirty: {
              stagedCount: 1,
              unstagedCount: 1,
              untrackedCount: 0,
              conflictedCount: 0,
              files: [
                { path: 'server/hub-node-router.ts', status: 'modified' },
              ],
              truncated: false,
            },
            divergence: {
              upstreamRef: 'origin/nightly',
              aheadCount: 2,
              behindCount: 1,
            },
          },
        ],
      })
    );

    const { token: targetToken, nodeId: targetNodeId } = await pairNode(base);
    await heartbeatRepoInventory(
      base,
      targetToken,
      targetNodeId,
      repoInventoryReport(targetNodeId, '/srv/relay-ide')
    );
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${targetToken}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(targetNodeId)}/sessions/reopen`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          source: {
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            branchName: 'feature/a',
          },
          type: 'agent',
        }),
      }
    );
    const request = await nextJson(nodeWs);
    expect(request.payload).toMatchObject({
      repoPath: '/srv/relay-ide',
      worktreePath: '/srv/relay-ide/.worktrees/feature-a',
      branchName: 'feature/a',
    });
    expect(JSON.stringify(request.payload)).toContain('cold reopen');
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId: targetNodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            ...remoteSession(targetNodeId),
            nodeId: undefined,
            globalSessionId: undefined,
          },
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      transfer: {
        livePtyMigrated: false,
        warnings: [
          { code: 'source-dirty-checkout' },
          { code: 'source-diverged-checkout' },
        ],
      },
    });
  });

  it('starts a new target-node session from matching repo/worktree state on the success path', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    await heartbeatRepoInventory(
      base,
      token,
      nodeId,
      repoInventoryReport(nodeId, '/srv/relay-ide')
    );
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/reopen`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          source: {
            nodeId: 'local',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            branchName: 'feature/a',
            sessionId: 'source-session-1',
          },
          type: 'agent',
          agent: 'claude',
        }),
      }
    );

    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      nodeId,
      channel: 'rpc',
      type: 'sessions.create',
      payload: {
        type: 'agent',
        agent: 'claude',
        repoPath: '/srv/relay-ide',
        worktreePath: '/srv/relay-ide/.worktrees/feature-a',
        branchName: 'feature/a',
        continue: false,
      },
    });
    expect(JSON.stringify(request.payload)).toContain(
      'not a live tmux/PTY migration'
    );
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            ...remoteSession(nodeId),
            nodeId: undefined,
            globalSessionId: undefined,
          },
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      session: {
        id: 'cold-reopen-session-1',
        nodeId,
        globalSessionId: `${nodeId}:cold-reopen-session-1`,
      },
      transfer: {
        mode: 'cold-reopen',
        livePtyMigrated: false,
        target: {
          repoPath: '/srv/relay-ide',
          worktreePath: '/srv/relay-ide/.worktrees/feature-a',
          branchName: 'feature/a',
        },
        warnings: [],
      },
    });
  });

  it('surfaces source warnings when source checkout is on the hub node via local inventory', async () => {
    const localNodeId = 'local';
    const { base, wsBase } = await startHub({
      collectLocalRepoInventory: async () =>
        repoInventoryReport(localNodeId, '/Users/hub/relay-ide', {
          worktrees: [
            {
              worktreeInstanceId: `${localNodeId}:${encodeURIComponent('/Users/hub/relay-ide/.worktrees/feature-a')}`,
              localPath: '/Users/hub/relay-ide/.worktrees/feature-a',
              branchName: 'feature/a',
              dirty: {
                stagedCount: 1,
                unstagedCount: 1,
                untrackedCount: 0,
                conflictedCount: 0,
                files: [
                  { path: 'server/hub-node-router.ts', status: 'modified' },
                ],
                truncated: false,
              },
              divergence: {
                upstreamRef: 'origin/nightly',
                aheadCount: 2,
                behindCount: 1,
              },
            },
          ],
        }),
    });
    const { token, nodeId: targetNodeId } = await pairNode(base);
    await heartbeatRepoInventory(
      base,
      token,
      targetNodeId,
      repoInventoryReport(targetNodeId, '/srv/relay-ide')
    );
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(targetNodeId)}/sessions/reopen`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          source: {
            nodeId: localNodeId,
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            branchName: 'feature/a',
          },
          type: 'agent',
        }),
      }
    );
    const request = await nextJson(nodeWs);
    expect(request.payload).toMatchObject({
      repoPath: '/srv/relay-ide',
      worktreePath: '/srv/relay-ide/.worktrees/feature-a',
      branchName: 'feature/a',
    });
    expect(JSON.stringify(request.payload)).toContain('cold reopen');
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId: targetNodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            ...remoteSession(targetNodeId),
            nodeId: undefined,
            globalSessionId: undefined,
          },
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      transfer: {
        livePtyMigrated: false,
        warnings: [
          { code: 'source-dirty-checkout' },
          { code: 'source-diverged-checkout' },
        ],
      },
    });
  });

  it('reopens cold when target inventory is only available via local collection', async () => {
    let localReport: RepoInventoryReport | null = null;
    const { base, wsBase } = await startHub({
      collectLocalRepoInventory: async () => {
        if (!localReport) throw new Error('localReport not set');
        return localReport;
      },
    });
    const { token, nodeId: targetNodeId } = await pairNode(base);
    // keep the node online but do not heartbeat repo inventory into the registry
    const heartbeatRes = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ nodeId: targetNodeId, protocolVersion: '1.0' }),
    });
    expect(heartbeatRes.status).toBe(200);
    localReport = repoInventoryReport(targetNodeId, '/srv/relay-ide');

    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(targetNodeId)}/sessions/reopen`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          source: {
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            branchName: 'feature/a',
          },
          type: 'agent',
        }),
      }
    );
    const request = await nextJson(nodeWs);
    expect(request.payload).toMatchObject({
      repoPath: '/srv/relay-ide',
      worktreePath: '/srv/relay-ide/.worktrees/feature-a',
      branchName: 'feature/a',
    });
    expect(JSON.stringify(request.payload)).toContain('cold reopen');
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId: targetNodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            ...remoteSession(targetNodeId),
            nodeId: undefined,
            globalSessionId: undefined,
          },
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      transfer: {
        mode: 'cold-reopen',
        livePtyMigrated: false,
        target: {
          repoPath: '/srv/relay-ide',
          worktreePath: '/srv/relay-ide/.worktrees/feature-a',
          branchName: 'feature/a',
        },
        warnings: [],
      },
    });
  });
});
