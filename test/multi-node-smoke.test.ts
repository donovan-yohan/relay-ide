import * as fs from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubNodeLinkManager } from '../server/hub-node-link.js';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeRouter } from '../server/hub-node-router.js';
import { createLocalRelayNode } from '../server/local-node.js';
import { setupWebSocket } from '../server/ws.js';
import type { SessionSummary } from '../server/types.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type HubNodeSummary,
  type RelayNodeEnvelope,
} from '../shared/relay-node-protocol.js';
import { buildManifestWithAgents } from './helpers/manifest-fixtures.js';
import { mintPairTokenWithOperatorGrantForTest } from './helpers/operator-pairing.js';
import {
  testBrowserAuthTokens,
  testBrowserWsHeaders,
} from './helpers/ws-auth.js';

const LOCAL_SESSION_ID = 'duplicate-local-session';

// Test-local agent list. Specific ids are an INPUT to the fixture so
// the smoke harness doesn't carry a hardcoded global assumption about
// which frameworks the platform ships.
const SMOKE_AGENTS = [
  { id: 'claude', label: 'Claude', status: 'available' as const },
  {
    id: 'codex',
    label: 'Codex',
    status: 'degraded' as const,
    message: 'test double',
  },
];

function manifest(
  name: string,
  overrides: Partial<NodeManifest> = {}
): NodeManifest {
  const base = buildManifestWithAgents({
    agents: SMOKE_AGENTS,
    overrides: {
      platform: 'linux',
      arch: 'x64',
      hostname: name,
      relayVersion: '0.1.0-smoke',
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
    },
  });
  // The smoke harness needs a couple capability-status tweaks relative
  // to the helper's defaults (clipboard available, browserAutomation
  // degraded, tailscale unavailable, githubCli available). Apply them
  // here so the harness intent stays self-contained.
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      clipboard: {
        id: 'clipboard',
        label: 'Clipboard',
        status: 'available',
        message: 'ok',
      },
      browserAutomation: {
        id: 'browserAutomation',
        label: 'Browser automation',
        status: 'degraded',
        message: 'browser deps are optional in smoke',
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
    },
    ...overrides,
  };
}

function remoteSession(nodeId: string, hostname: string): SessionSummary {
  const repoPath = `/nodes/${hostname}/relay-ide`;
  return {
    id: LOCAL_SESSION_ID,
    type: 'terminal',
    agent: 'claude',
    mode: 'pty',
    repoPath,
    worktreePath: null,
    cwd: repoPath,
    repoName: 'relay-ide',
    branchName: 'nightly',
    displayName: `${hostname} terminal`,
    createdAt: '2026-01-02T03:04:05.000Z',
    lastActivity: '2026-01-02T03:04:05.000Z',
    idle: false,
    customCommand: null,
    nodeId,
    globalSessionId: `${nodeId}:${LOCAL_SESSION_ID}`,
    repoInstanceId: `${encodeURIComponent(nodeId)}:${encodeURIComponent(repoPath)}`,
    useTmux: true,
    tmuxSessionName: `relay-ide-${LOCAL_SESSION_ID}`,
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('smoke hub did not bind a TCP port');
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
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

async function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => ws.once('close', () => resolve()));
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

class SimulatedRelayNode {
  readonly messages: RelayNodeEnvelope[] = [];
  private cursor = 0;
  private readonly waiters: Array<(message: RelayNodeEnvelope) => void> = [];

  constructor(
    readonly nodeId: string,
    readonly token: string,
    readonly hostname: string,
    readonly ws: WebSocket
  ) {
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as RelayNodeEnvelope;
      this.messages.push(message);
      const waiter = this.waiters.shift();
      if (waiter) {
        this.cursor = this.messages.length;
        waiter(message);
      }
    });
  }

  async nextEnvelope(): Promise<RelayNodeEnvelope> {
    if (this.cursor < this.messages.length)
      return this.messages[this.cursor++]!;
    return await new Promise<RelayNodeEnvelope>((resolve) =>
      this.waiters.push(resolve)
    );
  }

  send(
    type: string,
    channel: RelayNodeEnvelope['channel'],
    extras: Partial<RelayNodeEnvelope> = {}
  ): void {
    this.ws.send(
      JSON.stringify({
        protocol: RELAY_NODE_LINK_PROTOCOL,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        nodeId: this.nodeId,
        channel,
        type,
        timestamp: new Date().toISOString(),
        ...extras,
      })
    );
  }

  async hello(): Promise<RelayNodeEnvelope> {
    this.send('control.hello', 'control', {
      payload: { manifest: manifest(this.hostname) },
    });
    return await this.nextEnvelope();
  }

  answerCreate(request: RelayNodeEnvelope): void {
    this.send('sessions.create.result', 'rpc', {
      requestId: request.requestId,
      payload: {
        session: {
          ...remoteSession(this.nodeId, this.hostname),
          nodeId: 'spoofed-node-from-simulated-process',
          globalSessionId: 'spoofed-global-session',
        },
      },
    });
  }

  publishSessionState(state: string): void {
    this.send('events.publish', 'events', {
      payload: {
        type: 'session-backend-state-changed',
        sessionId: LOCAL_SESSION_ID,
        state,
        timestamp: '2026-01-02T03:04:05.000Z',
      },
    });
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function expectRelayError(
  response: Response,
  status: number,
  code: string
): Promise<void> {
  expect(response.status, `expected relay error HTTP ${status}`).toBe(status);
  await expect(
    readJson(response),
    `expected typed relay diagnostic ${code}`
  ).resolves.toMatchObject({
    error: { code, retryable: expect.any(Boolean) },
  });
}

async function startSmokeHub(now: () => Date) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-multi-node-smoke-')
  );
  const registry = createHubNodeRegistry({
    storagePath: path.join(tmpDir, 'hub', 'nodes.json'),
    now,
    staleMs: 45_000,
    offlineMs: 90_000,
    heartbeatPersistDebounceMs: 1,
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
    })
  );
  const server = http.createServer(app);
  setupWebSocket(
    server,
    testBrowserAuthTokens(),
    null,
    undefined,
    true,
    createLocalRelayNode({ nodeId: 'local' }),
    registry,
    nodeLinks
  );
  const port = await listen(server);
  return {
    tmpDir,
    server,
    registry,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
  };
}

async function pairAndConnectNode(
  base: string,
  wsBase: string,
  hostname: string
): Promise<SimulatedRelayNode> {
  const pair = await mintPairTokenWithOperatorGrantForTest(base, {
    displayName: hostname,
  });

  const exchangeRes = await fetch(`${base}/hub/pairing/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairToken: pair.pairToken,
      manifest: manifest(hostname),
    }),
  });
  expect(exchangeRes.status, `pair-token exchange failed for ${hostname}`).toBe(
    201
  );
  const exchange = (await exchangeRes.json()) as {
    credential: { token: string; nodeId: string };
  };

  const ws = new WebSocket(`${wsBase}/hub/node-link`, {
    headers: { authorization: `Bearer ${exchange.credential.token}` },
  });
  await waitForOpen(ws);
  return new SimulatedRelayNode(
    exchange.credential.nodeId,
    exchange.credential.token,
    hostname,
    ws
  );
}

describe('multi-node smoke harness', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  it('pairs two simulated nodes, routes duplicate local session ids, and survives disconnect/reconnect', async () => {
    let currentTime = new Date('2026-01-02T03:04:05.000Z');
    const hub = await startSmokeHub(() => currentTime);
    cleanup.push(() => fs.rmSync(hub.tmpDir, { recursive: true, force: true }));
    cleanup.push(() => closeServer(hub.server));

    const nodeA = await pairAndConnectNode(
      hub.base,
      hub.wsBase,
      'smoke-node-a'
    );
    const nodeB = await pairAndConnectNode(
      hub.base,
      hub.wsBase,
      'smoke-node-b'
    );
    cleanup.push(() => nodeA.ws.close());
    cleanup.push(() => nodeB.ws.close());

    await expect(
      nodeA.hello(),
      'node A hello should produce a typed control ack'
    ).resolves.toMatchObject({
      type: 'control.hello.result',
      payload: { node: { hostname: 'smoke-node-a', status: 'online' } },
    });
    await expect(
      nodeB.hello(),
      'node B hello should produce a typed control ack'
    ).resolves.toMatchObject({
      type: 'control.hello.result',
      payload: { node: { hostname: 'smoke-node-b', status: 'online' } },
    });

    const nodesRes = await fetch(`${hub.base}/nodes`, {
      headers: { 'x-test-auth': 'yes' },
    });
    expect(
      nodesRes.status,
      'hub /nodes should be reachable with user auth'
    ).toBe(200);
    const nodesBody = (await nodesRes.json()) as { nodes: HubNodeSummary[] };
    expect(nodesBody.nodes.map((node) => node.nodeId).sort()).toEqual(
      [nodeA.nodeId, nodeB.nodeId].sort()
    );
    expect(nodesBody.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: nodeA.nodeId,
          status: 'online',
          capabilities: expect.objectContaining({
            core: expect.objectContaining({
              tmux: 'available',
              git: 'available',
            }),
            agents: expect.objectContaining({
              claude: 'available',
              codex: 'degraded',
            }),
          }),
        }),
        expect.objectContaining({ nodeId: nodeB.nodeId, status: 'online' }),
      ])
    );

    const createA = fetch(
      `${hub.base}/hub/nodes/${encodeURIComponent(nodeA.nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          repoPath: '/nodes/smoke-node-a/relay-ide',
          type: 'terminal',
        }),
      }
    );
    const createARequest = await nodeA.nextEnvelope();
    expect(createARequest).toMatchObject({
      nodeId: nodeA.nodeId,
      type: 'sessions.create',
    });
    nodeA.answerCreate(createARequest);
    const sessionA = (await (await createA).json()) as SessionSummary;

    const createB = fetch(
      `${hub.base}/hub/nodes/${encodeURIComponent(nodeB.nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          repoPath: '/nodes/smoke-node-b/relay-ide',
          type: 'terminal',
        }),
      }
    );
    const createBRequest = await nodeB.nextEnvelope();
    expect(createBRequest).toMatchObject({
      nodeId: nodeB.nodeId,
      type: 'sessions.create',
    });
    nodeB.answerCreate(createBRequest);
    const sessionB = (await (await createB).json()) as SessionSummary;

    expect(sessionA.id).toBe(LOCAL_SESSION_ID);
    expect(sessionB.id).toBe(LOCAL_SESSION_ID);
    expect(sessionA.globalSessionId).toBe(
      `${nodeA.nodeId}:${LOCAL_SESSION_ID}`
    );
    expect(sessionB.globalSessionId).toBe(
      `${nodeB.nodeId}:${LOCAL_SESSION_ID}`
    );
    expect(sessionA.globalSessionId).not.toBe(sessionB.globalSessionId);
    expect(sessionA.nodeId).toBe(nodeA.nodeId);
    expect(sessionB.nodeId).toBe(nodeB.nodeId);

    const eventWs = new WebSocket(`${hub.wsBase}/ws/events`, {
      headers: testBrowserWsHeaders(),
    });
    cleanup.push(() => eventWs.close());
    await waitForOpen(eventWs);
    const events: Array<Record<string, unknown>> = [];
    eventWs.on('message', (data) =>
      events.push(JSON.parse(data.toString()) as Record<string, unknown>)
    );

    nodeA.publishSessionState('running');
    nodeB.publishSessionState('idle');
    await expect
      .poll(() => events.length, {
        message: 'expected two node-scoped events from duplicate local ids',
      })
      .toBe(2);
    expect(events).toEqual([
      expect.objectContaining({
        nodeId: nodeA.nodeId,
        localSessionId: LOCAL_SESSION_ID,
        sessionId: LOCAL_SESSION_ID,
        globalSessionId: `${nodeA.nodeId}:${LOCAL_SESSION_ID}`,
        state: 'running',
      }),
      expect.objectContaining({
        nodeId: nodeB.nodeId,
        localSessionId: LOCAL_SESSION_ID,
        sessionId: LOCAL_SESSION_ID,
        globalSessionId: `${nodeB.nodeId}:${LOCAL_SESSION_ID}`,
        state: 'idle',
      }),
    ]);

    const nodeBMessageCount = nodeB.messages.length;
    const browserWs = new WebSocket(
      `${hub.wsBase}/nodes/${encodeURIComponent(nodeA.nodeId)}/ws/sessions/${LOCAL_SESSION_ID}`,
      { headers: testBrowserWsHeaders() }
    );
    cleanup.push(() => browserWs.close());
    await waitForOpen(browserWs);
    const attachA = await nodeA.nextEnvelope();
    expect(attachA).toMatchObject({
      nodeId: nodeA.nodeId,
      channel: 'pty',
      type: 'pty.attach',
      payload: { sessionId: LOCAL_SESSION_ID },
    });
    await delay(25);
    expect(
      nodeB.messages
        .slice(nodeBMessageCount)
        .filter((message) => message.type === 'pty.attach'),
      'routed attach for node A must not leak to node B with the same local session id'
    ).toHaveLength(0);

    const browserMessage = new Promise<string>((resolve) =>
      browserWs.once('message', (data) => resolve(data.toString()))
    );
    nodeA.send('pty.data', 'pty', {
      streamId: attachA.streamId,
      payload: { data: 'hello from smoke-node-a' },
    });
    await expect(browserMessage).resolves.toBe('hello from smoke-node-a');

    currentTime = new Date('2026-01-02T03:05:36.000Z');
    nodeA.ws.close();
    await waitForClose(nodeA.ws);
    const offlineNodesRes = await fetch(`${hub.base}/nodes`, {
      headers: { 'x-test-auth': 'yes' },
    });
    const offlineNodes = (await offlineNodesRes.json()) as {
      nodes: HubNodeSummary[];
    };
    expect(
      offlineNodes.nodes.find((node) => node.nodeId === nodeA.nodeId)?.status
    ).toBe('offline');

    const offlineCreate = await fetch(
      `${hub.base}/hub/nodes/${encodeURIComponent(nodeA.nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          repoPath: '/nodes/smoke-node-a/relay-ide',
          type: 'terminal',
        }),
      }
    );
    await expectRelayError(offlineCreate, 404, 'NODE_OFFLINE');

    const reconnectedWs = new WebSocket(`${hub.wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${nodeA.token}` },
    });
    await waitForOpen(reconnectedWs);
    const reconnectedNodeA = new SimulatedRelayNode(
      nodeA.nodeId,
      nodeA.token,
      nodeA.hostname,
      reconnectedWs
    );
    cleanup.push(() => reconnectedNodeA.ws.close());
    await expect(reconnectedNodeA.hello()).resolves.toMatchObject({
      type: 'control.hello.result',
      payload: { node: { nodeId: nodeA.nodeId, status: 'online' } },
    });

    const reconnectCreate = fetch(
      `${hub.base}/hub/nodes/${encodeURIComponent(nodeA.nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          repoPath: '/nodes/smoke-node-a/relay-ide',
          type: 'terminal',
        }),
      }
    );
    const reconnectRequest = await reconnectedNodeA.nextEnvelope();
    expect(reconnectRequest).toMatchObject({
      nodeId: nodeA.nodeId,
      type: 'sessions.create',
    });
    reconnectedNodeA.answerCreate(reconnectRequest);
    expect((await reconnectCreate).status).toBe(201);
  });

  it('keeps the local single-node boundary fast and deterministic', () => {
    const local = createLocalRelayNode();

    expect(local.authority()).toEqual({
      nodeId: 'local',
      environmentId: 'local',
      authority: 'local-node',
    });
    expect(local.sessionEventScope('terminal-1')).toMatchObject({
      nodeId: 'local',
      environmentId: 'local',
      sessionId: 'terminal-1',
      localSessionId: 'terminal-1',
      globalSessionId: 'local:terminal-1',
    });
    expect(
      local.fileEventScope({ workspacePath: '/src/relay-ide' })
    ).toMatchObject({
      nodeId: 'local',
      repoInstanceId: `local:${encodeURIComponent('/src/relay-ide')}`,
    });
  });
});
