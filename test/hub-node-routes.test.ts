import * as fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeRouter } from '../server/hub-node-router.js';
import { createRepoFeatureRouter } from '../server/features/repo-router.js';
import { createHubNodeLinkManager, HubNodeLinkError } from '../server/hub-node-link.js';
import { createRepoInventoryFeature } from '../server/features/repo-inventory.js';
import { setupWebSocket } from '../server/ws.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import type { RepoInventoryReport } from '../shared/repo-inventory.js';

function manifest(overrides: Partial<NodeManifest> = {}): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    hostname: 'node-routes-host',
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
      agents: {},
    },
    ...overrides,
  };
}

function nestedMalformedManifest(): unknown {
  const candidate = JSON.parse(JSON.stringify(manifest())) as Record<
    string,
    unknown
  >;
  const serviceManager = candidate['serviceManager'] as Record<string, unknown>;
  serviceManager['kind'] = 'systemd';
  serviceManager['caveats'] = ['ok', { text: 'not a string' }];
  return candidate;
}

function agentArrayManifest(): unknown {
  const candidate = JSON.parse(JSON.stringify(manifest())) as Record<
    string,
    unknown
  >;
  const capabilities = candidate['capabilities'] as Record<string, unknown>;
  capabilities['agents'] = [];
  return candidate;
}

function tmpRegistry(now = () => new Date('2026-01-02T03:04:05.000Z')) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-hub-node-routes-')
  );
  const registry = createHubNodeRegistry({
    storagePath: path.join(tmpDir, 'nodes.json'),
    now,
  });
  return { tmpDir, registry };
}

function mutateStoredNode(
  tmpDir: string,
  nodeId: string,
  mutate: (node: Record<string, unknown>) => void
): void {
  const storagePath = path.join(tmpDir, 'nodes.json');
  const state = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
    nodes: Array<Record<string, unknown>>;
  };
  const node = state.nodes.find((candidate) => candidate['nodeId'] === nodeId);
  if (!node) throw new Error(`missing stored node ${nodeId}`);
  mutate(node);
  fs.writeFileSync(storagePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function repoInventoryReport(
  nodeId: string,
  localPath: string
): RepoInventoryReport {
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
  return {
    nodeId,
    generatedAt: '2026-01-02T03:04:05.000Z',
    repos: [
      {
        repoInstanceId: `${encodeURIComponent(nodeId)}:${encodeURIComponent(localPath)}`,
        nodeId,
        localPath,
        name: 'relay-ide',
        isGitRepo: true,
        defaultBranch: 'nightly',
        currentBranch: 'feature/inventory',
        repoIdentity: 'github.com/donovan-yohan/relay-ide',
        selectedRemote,
        remotes: [selectedRemote],
        repoIdentityWarnings: [],
        dirty: {
          stagedCount: 0,
          unstagedCount: 1,
          untrackedCount: 0,
          conflictedCount: 0,
          files: [{ path: 'server/repo-inventory.ts', status: 'modified' }],
          truncated: false,
        },
        divergence: {
          upstreamRef: 'origin/nightly',
          aheadCount: 2,
          behindCount: 1,
        },
        worktrees: [
          {
            worktreeInstanceId: `${encodeURIComponent(nodeId)}:${encodeURIComponent(`${localPath}/.worktrees/a`)}`,
            localPath: `${localPath}/.worktrees/a`,
            branchName: 'feature/a',
          },
        ],
        reportedAt: '2026-01-02T03:04:05.000Z',
      },
    ],
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

async function rawUpgrade(port: number, pathName: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        `GET ${pathName} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      );
    });
    let response = '';
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error('timed out waiting for raw upgrade response'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString();
      socket.destroy();
      resolve(response);
    });
    socket.on('error', reject);
  });
}

async function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve) => {
    ws.once('message', (data) =>
      resolve(JSON.parse(data.toString()) as Record<string, unknown>)
    );
  });
}

describe('hub node routes and link', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  it('protects user-facing pair/list routes while allowing token exchange and bearer heartbeat', async () => {
    const { tmpDir, registry } = tmpRegistry();
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const app = express();
    app.use(express.json());
    app.use(
      createHubNodeRouter({
        registry,
        requireAuth: (req, res, next) => {
          if (req.header('x-test-auth') === 'yes') next();
          else res.status(401).json({ error: 'Unauthorized' });
        },
      })
    );
    const server = http.createServer(app);
    const port = await listen(server);
    cleanup.push(() => close(server));
    const base = `http://127.0.0.1:${port}`;

    expect(
      (await fetch(`${base}/hub/pair-tokens`, { method: 'POST' })).status
    ).toBe(401);

    const pairRes = await fetch(`${base}/hub/pair-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
      body: JSON.stringify({ displayName: 'Route Node' }),
    });
    expect(pairRes.status).toBe(201);
    const pair = (await pairRes.json()) as {
      pairToken: string;
      expiresAt: string;
      hubUrl: string;
      suggestedCommands: Array<{
        id: string;
        label: string;
        command: string;
        redactedCommand: string;
        caveats: string[];
      }>;
      diagnostics: Array<{ code: string }>;
    };
    expect(pair.pairToken).toMatch(/^pair_/);
    expect(pair.hubUrl).toBe(base);
    expect(pair.suggestedCommands.map((command) => command.id)).toContain(
      'local-manual'
    );
    expect(pair.suggestedCommands[0]!.command).toContain(pair.pairToken);
    expect(pair.suggestedCommands[0]!.redactedCommand).not.toContain(
      pair.pairToken
    );
    const manualCommand = pair.suggestedCommands.find(
      (command) => command.id === 'local-manual'
    );
    expect(manualCommand?.label).toContain('pair-only');
    expect(manualCommand?.command).toContain('node connect');
    expect(manualCommand?.caveats.join(' ')).toContain(
      'sends one heartbeat, then exits'
    );
    const wslManualCommand = pair.suggestedCommands.find(
      (command) => command.id === 'wsl-manual'
    );
    expect(wslManualCommand?.label).toContain('pair-only');
    expect(wslManualCommand?.command).toContain('node connect');
    expect(wslManualCommand?.caveats.join(' ')).not.toMatch(/foreground/i);
    expect(pair.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'NODE_STARTED_NO_HEARTBEAT'
    );
    expect(pair).not.toHaveProperty('bootstrapCommand');

    const defaultedModesRes = await fetch(`${base}/hub/pair-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
      body: JSON.stringify({ serviceModes: ['bogus', 'also-bogus'] }),
    });
    expect(defaultedModesRes.status).toBe(201);
    const defaultedModes = (await defaultedModesRes.json()) as {
      suggestedCommands: Array<{ id: string }>;
    };
    expect(
      defaultedModes.suggestedCommands.map((command) => command.id)
    ).toContain('local-manual');
    expect(
      defaultedModes.suggestedCommands.map((command) => command.id)
    ).toContain('macos-launchd');

    const forwardedHostRes = await fetch(`${base}/hub/pair-tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'relay.example.com',
      },
      body: JSON.stringify({ displayName: 'Proxy Node' }),
    });
    expect(forwardedHostRes.status).toBe(201);
    const forwardedHost = (await forwardedHostRes.json()) as { hubUrl: string };
    expect(forwardedHost.hubUrl).toBe('https://relay.example.com');

    const malformedExchangeRes = await fetch(`${base}/hub/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairToken: pair.pairToken,
        manifest: { schemaVersion: 1, hostname: 'partial' },
      }),
    });
    expect(malformedExchangeRes.status).toBe(400);
    expect(await malformedExchangeRes.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });

    const nestedMalformedExchangeRes = await fetch(
      `${base}/hub/pairing/exchange`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairToken: pair.pairToken,
          manifest: nestedMalformedManifest(),
        }),
      }
    );
    expect(nestedMalformedExchangeRes.status).toBe(400);
    expect(await nestedMalformedExchangeRes.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });

    const agentArrayExchangeRes = await fetch(`${base}/hub/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairToken: pair.pairToken,
        manifest: agentArrayManifest(),
      }),
    });
    expect(agentArrayExchangeRes.status).toBe(400);
    expect(await agentArrayExchangeRes.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });

    const exchangeRes = await fetch(`${base}/hub/pairing/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: pair.pairToken, manifest: manifest() }),
    });
    expect(exchangeRes.status).toBe(201);
    const exchange = (await exchangeRes.json()) as {
      credential: { token: string; nodeId: string };
      node: { nodeId: string };
    };

    const heartbeatRes = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${exchange.credential.token}`,
      },
      body: JSON.stringify({
        nodeId: exchange.credential.nodeId,
        protocolVersion: '1.0',
        manifest: manifest({ relayVersion: '0.1.1-test' }),
      }),
    });
    expect(heartbeatRes.status).toBe(200);

    const malformedHeartbeatRes = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${exchange.credential.token}`,
      },
      body: JSON.stringify({
        nodeId: exchange.credential.nodeId,
        protocolVersion: '1.0',
        manifest: { schemaVersion: 1, hostname: 'partial' },
      }),
    });
    expect(malformedHeartbeatRes.status).toBe(400);
    expect(await malformedHeartbeatRes.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });

    const nestedMalformedHeartbeatRes = await fetch(
      `${base}/hub/node-heartbeat`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${exchange.credential.token}`,
        },
        body: JSON.stringify({
          nodeId: exchange.credential.nodeId,
          protocolVersion: '1.0',
          manifest: nestedMalformedManifest(),
        }),
      }
    );
    expect(nestedMalformedHeartbeatRes.status).toBe(400);
    expect(await nestedMalformedHeartbeatRes.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });

    const agentArrayHeartbeatRes = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${exchange.credential.token}`,
      },
      body: JSON.stringify({
        nodeId: exchange.credential.nodeId,
        protocolVersion: '1.0',
        manifest: agentArrayManifest(),
      }),
    });
    expect(agentArrayHeartbeatRes.status).toBe(400);
    expect(await agentArrayHeartbeatRes.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });

    const nodesRes = await fetch(`${base}/nodes`, {
      headers: { 'x-test-auth': 'yes' },
    });
    expect(nodesRes.status).toBe(200);
    const nodesBody = await nodesRes.text();
    expect(nodesBody).toContain('0.1.1-test');
    expect(nodesBody).toContain('"tier":"dev"');
    expect(nodesBody).toContain('"policyVersion":"1.0"');
    expect(nodesBody).toContain('blast radius');
    expect(nodesBody).not.toContain(pair.pairToken);
    expect(nodesBody).not.toContain(exchange.credential.token);

    const revokeRes = await fetch(`${base}/nodes/${exchange.node.nodeId}`, {
      method: 'DELETE',
      headers: { 'x-test-auth': 'yes' },
    });
    expect(revokeRes.status).toBe(200);
    expect(await revokeRes.json()).toMatchObject({
      node: {
        nodeId: exchange.node.nodeId,
        status: 'revoked',
        credentialState: 'revoked',
        trust: { state: 'revoked', level: 'dev', tier: 'dev' },
      },
    });

    const revokedHeartbeatRes = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${exchange.credential.token}`,
      },
      body: JSON.stringify({
        nodeId: exchange.credential.nodeId,
        protocolVersion: '1.0',
      }),
    });
    const revokedHeartbeatBody = await revokedHeartbeatRes.text();
    expect(revokedHeartbeatRes.status).toBe(403);
    expect(JSON.parse(revokedHeartbeatBody)).toMatchObject({
      error: { code: 'NODE_REVOKED', retryable: false },
    });
    expect(revokedHeartbeatBody).not.toContain(exchange.credential.token);
  });

  it('accepts authenticated reverse websocket heartbeats and rejects incompatible protocol envelopes with typed errors', async () => {
    let now = new Date('2026-01-02T03:04:05.000Z');
    const { tmpDir, registry } = tmpRegistry(() => now);
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: manifest(),
    });

    const server = http.createServer(express());
    setupWebSocket(
      server,
      new Set(),
      null,
      undefined,
      false,
      undefined,
      registry
    );
    const port = await listen(server);
    cleanup.push(() => close(server));

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/hub/node-link?trace=test`,
      {
        headers: { authorization: `Bearer ${exchanged.credential.token}` },
      }
    );
    cleanup.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    now = new Date('2026-01-02T03:04:10.000Z');
    const ack = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      );
    });
    ws.send(
      JSON.stringify({
        protocol: 'relay-node-link',
        protocolVersion: '1.0',
        nodeId: exchanged.node.nodeId,
        channel: 'control',
        type: 'control.heartbeat',
        timestamp: now.toISOString(),
        payload: { manifest: manifest({ hostname: 'linked-host' }) },
      })
    );
    expect(await ack).toMatchObject({
      channel: 'control',
      type: 'control.heartbeat.ack',
      payload: { node: { hostname: 'linked-host', status: 'online' } },
    });

    const malformedManifestError = new Promise<Record<string, unknown>>(
      (resolve) => {
        ws.once('message', (data) =>
          resolve(JSON.parse(data.toString()) as Record<string, unknown>)
        );
      }
    );
    ws.send(
      JSON.stringify({
        protocol: 'relay-node-link',
        protocolVersion: '1.0',
        nodeId: exchanged.node.nodeId,
        channel: 'control',
        type: 'control.heartbeat',
        timestamp: now.toISOString(),
        payload: { manifest: nestedMalformedManifest() },
      })
    );
    expect(await malformedManifestError).toMatchObject({
      channel: 'control',
      type: 'control.error',
      error: { code: 'INVALID_REQUEST', retryable: false },
    });

    const agentArrayManifestError = new Promise<Record<string, unknown>>(
      (resolve) => {
        ws.once('message', (data) =>
          resolve(JSON.parse(data.toString()) as Record<string, unknown>)
        );
      }
    );
    ws.send(
      JSON.stringify({
        protocol: 'relay-node-link',
        protocolVersion: '1.0',
        nodeId: exchanged.node.nodeId,
        channel: 'control',
        type: 'control.heartbeat',
        timestamp: now.toISOString(),
        payload: { manifest: agentArrayManifest() },
      })
    );
    expect(await agentArrayManifestError).toMatchObject({
      channel: 'control',
      type: 'control.error',
      error: { code: 'INVALID_REQUEST', retryable: false },
    });

    const skewError = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      );
    });
    ws.send(
      JSON.stringify({
        protocol: 'relay-node-link',
        protocolVersion: '1.1',
        nodeId: exchanged.node.nodeId,
        channel: 'control',
        type: 'control.heartbeat',
        timestamp: now.toISOString(),
      })
    );
    expect(await skewError).toMatchObject({
      channel: 'control',
      type: 'control.error',
      error: { code: 'VERSION_SKEW', retryable: false },
    });

    const incompatibleError = new Promise<Record<string, unknown>>(
      (resolve) => {
        ws.once('message', (data) =>
          resolve(JSON.parse(data.toString()) as Record<string, unknown>)
        );
      }
    );
    ws.send(
      JSON.stringify({
        protocol: 'relay-node-link',
        protocolVersion: '2.0',
        nodeId: exchanged.node.nodeId,
        channel: 'control',
        type: 'control.heartbeat',
        timestamp: now.toISOString(),
      })
    );
    expect(await incompatibleError).toMatchObject({
      channel: 'control',
      type: 'control.error',
      error: { code: 'PROTOCOL_INCOMPATIBLE', retryable: false },
    });

    const revokedError = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      );
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) =>
        resolve({ code, reason: reason.toString() })
      );
    });
    registry.revokeNode(exchanged.node.nodeId);
    expect(await revokedError).toMatchObject({
      channel: 'control',
      type: 'control.error',
      error: { code: 'NODE_REVOKED', retryable: false },
    });
    expect(await closed).toEqual({ code: 4003, reason: 'node revoked' });
  });

  it('accepts heartbeat repo inventory and returns aggregated hub groups with local inventory', async () => {
    const { tmpDir, registry } = tmpRegistry();
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const app = express();
    app.use(express.json());
    const requireAuth: express.RequestHandler = (req, res, next) => {
      if (req.header('x-test-auth') === 'yes') next();
      else res.status(401).json({ error: 'Unauthorized' });
    };
    const repoInventoryFeature = createRepoInventoryFeature(registry);
    const collect = async () =>
      repoInventoryReport('local', '/Users/kyle/dev/relay-ide');
    app.use(
      createHubNodeRouter({
        registry,
        requireAuth,
        repoInventoryFeature,
        collectLocalRepoInventory: collect,
      })
    );
    app.use(
      createRepoFeatureRouter({
        registry,
        requireAuth,
        repoInventoryFeature,
        collectLocalRepoInventory: collect,
      })
    );
    const server = http.createServer(app);
    const port = await listen(server);
    cleanup.push(() => close(server));
    const base = `http://127.0.0.1:${port}`;

    const pairToken = registry.createPairToken({}).pairToken;
    const exchanged = registry.exchangePairToken({
      pairToken,
      manifest: manifest(),
    });
    const heartbeat = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${exchanged.credential.token}`,
      },
      body: JSON.stringify({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        repoInventory: repoInventoryReport(
          exchanged.node.nodeId,
          '/srv/repos/relay-ide'
        ),
      }),
    });
    expect(heartbeat.status).toBe(200);

    const inventory = await fetch(`${base}/hub/repo-inventory`, {
      headers: { 'x-test-auth': 'yes' },
    });
    expect(inventory.status).toBe(200);
    const payload = (await inventory.json()) as {
      groups: Array<{
        repoIdentity: string | null;
        instances: Array<{ nodeId: string; localPath: string }>;
      }>;
    };
    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]).toMatchObject({
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
    });
    expect(
      payload.groups[0]?.instances.map((instance) => instance.localPath).sort()
    ).toEqual(['/Users/kyle/dev/relay-ide', '/srv/repos/relay-ide']);
  });

  it('rejects heartbeat repo inventory for a different node id', async () => {
    const { tmpDir, registry } = tmpRegistry();
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const app = express();
    app.use(express.json());
    app.use(
      createHubNodeRouter({
        registry,
        requireAuth: (_req, res) =>
          res.status(401).json({ error: 'Unauthorized' }),
      })
    );
    const server = http.createServer(app);
    const port = await listen(server);
    cleanup.push(() => close(server));
    const base = `http://127.0.0.1:${port}`;

    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: manifest(),
    });
    const response = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${exchanged.credential.token}`,
      },
      body: JSON.stringify({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        repoInventory: repoInventoryReport(
          'spoofed-node',
          '/srv/repos/relay-ide'
        ),
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });
    expect(registry.listInventoryPayloads()).toHaveLength(0);
  });

  it('rejects websocket heartbeat repo inventory for a different node id', async () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const { tmpDir, registry } = tmpRegistry(() => now);
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: manifest(),
    });

    const server = http.createServer(express());
    const nodeLinks = createHubNodeLinkManager({
      inventoryValidator:
        createRepoInventoryFeature(registry).validateInventoryPayload,
    });
    setupWebSocket(
      server,
      new Set(),
      null,
      undefined,
      false,
      undefined,
      registry,
      nodeLinks
    );
    const port = await listen(server);
    cleanup.push(() => close(server));

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/hub/node-link?trace=test`,
      {
        headers: { authorization: `Bearer ${exchanged.credential.token}` },
      }
    );
    cleanup.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const mismatchError = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>)
      );
    });
    ws.send(
      JSON.stringify({
        protocol: 'relay-node-link',
        protocolVersion: '1.0',
        nodeId: exchanged.node.nodeId,
        channel: 'control',
        type: 'control.heartbeat',
        timestamp: now.toISOString(),
        payload: {
          repoInventory: repoInventoryReport(
            'spoofed-node',
            '/srv/repos/relay-ide'
          ),
        },
      })
    );

    expect(await mismatchError).toMatchObject({
      channel: 'control',
      type: 'control.error',
      error: { code: 'INVALID_REQUEST', retryable: false },
    });
    expect(registry.listInventoryPayloads()).toHaveLength(0);
  });

  it('lists and revokes scoped routed sessions through hub API', async () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const { tmpDir, registry } = tmpRegistry(() => now);
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const app = express();
    app.use(express.json());
    const sessionEnvelopes = createSessionEnvelopeRegistry();
    const auditEntries: unknown[] = [];
    const nodeLinks = {
      hasActiveNode: () => true,
      request: async () => ({
        session: {
          id: 'remote-session',
          type: 'agent',
          mode: 'pty',
          cwd: '/srv/app',
          displayName: 'remote session',
          createdAt: now.toISOString(),
          lastActivity: now.toISOString(),
          idle: false,
          customCommand: null,
          status: 'active',
          needsBranchRename: false,
          agentState: 'idle',
        },
      }),
    };
    app.use(
      createHubNodeRouter({
        registry,
        nodeLinks: nodeLinks as never,
        sessionEnvelopes,
        now: () => now,
        auditSink: { append: (entry) => auditEntries.push(entry) },
        requireAuth: (req, res, next) => {
          if (req.header('x-test-auth') === 'yes') next();
          else res.status(401).json({ error: 'Unauthorized' });
        },
        scopedSessionAuth: (req, res, next) => {
          if (
            req.header('x-test-auth') === 'yes' ||
            req.header('authorization') === 'Bearer scoped-session-token'
          ) {
            next();
          } else {
            res.status(401).json({ error: 'Unauthorized' });
          }
        },
      })
    );
    const server = http.createServer(app);
    const port = await listen(server);
    cleanup.push(() => close(server));
    const base = `http://127.0.0.1:${port}`;

    const scopedListRes = await fetch(`${base}/hub/scoped-sessions`, {
      headers: { authorization: 'Bearer scoped-session-token' },
    });
    expect(scopedListRes.status).toBe(200);

    const bearerNodesRes = await fetch(`${base}/nodes`, {
      headers: { authorization: 'Bearer scoped-session-token' },
    });
    expect(bearerNodesRes.status).toBe(401);

    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: manifest(),
    });
    const heartbeat = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${exchanged.credential.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        nodeId: exchanged.credential.nodeId,
        protocolVersion: '1.0',
        manifest: manifest(),
      }),
    });
    expect(heartbeat.status).toBe(200);

    const missingKillRes = await fetch(
      `${base}/hub/nodes/${exchanged.node.nodeId}/sessions/missing-session`,
      { method: 'DELETE', headers: { 'x-test-auth': 'yes' } }
    );
    expect(missingKillRes.status).toBe(404);
    expect(await missingKillRes.json()).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        details: { reasonCode: 'SESSION_ENVELOPE_NOT_FOUND' },
      },
    });
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      eventType: 'denial',
      decision: 'deny',
      reasonCode: 'SESSION_ENVELOPE_NOT_FOUND',
      intent: { action: 'sessions.kill', target: exchanged.node.nodeId },
    });

    const invalidTypeRes = await fetch(`${base}/hub/nodes/${exchanged.node.nodeId}/sessions`, {
      method: 'POST',
      headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'future-kind', cwd: '/srv/app' }),
    });
    expect(invalidTypeRes.status).toBe(400);
    expect(await invalidTypeRes.json()).toMatchObject({
      error: {
        code: 'INVALID_REQUEST',
        details: { reasonCode: 'INVALID_SESSION_TYPE', field: 'type' },
      },
    });

    for (const invalidLifecycle of [
      { expiresAt: 'not-a-date' },
      { ttlMs: 0 },
      { ttlSeconds: '60' },
    ]) {
      const invalidRes = await fetch(
        `${base}/hub/nodes/${exchanged.node.nodeId}/sessions`,
        {
          method: 'POST',
          headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'agent', cwd: '/srv/app', ...invalidLifecycle }),
        }
      );
      expect(invalidRes.status).toBe(400);
      expect(await invalidRes.json()).toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
          details: { reasonCode: 'INVALID_LIFECYCLE_INPUT' },
        },
      });
    }

    const createRes = await fetch(`${base}/hub/nodes/${exchanged.node.nodeId}/sessions`, {
      method: 'POST',
      headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'agent',
        cwd: '/srv/app',
        expiresAt: '2026-01-02T03:06:00.000Z',
      }),
    });
    expect(createRes.status).toBe(201);

    const listRes = await fetch(`${base}/hub/scoped-sessions`, {
      headers: { 'x-test-auth': 'yes' },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { sessions: Array<Record<string, unknown>> };
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]).toMatchObject({
      sessionId: 'remote-session',
      nodeId: exchanged.node.nodeId,
      status: 'active',
      expiresAt: '2026-01-02T03:06:00.000Z',
    });

    sessionEnvelopes.create({
      sessionId: 'remote-session',
      nodeId: 'other-node',
      globalSessionId: 'other-node:remote-session',
      cwd: '/srv/other',
      issuedAt: now.toISOString(),
    });

    const ambiguousRevokeRes = await fetch(
      `${base}/hub/scoped-sessions/remote-session/revoke`,
      {
        method: 'POST',
        headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'operator-test' }),
      }
    );
    expect(ambiguousRevokeRes.status).toBe(400);
    expect(await ambiguousRevokeRes.json()).toMatchObject({
      error: {
        code: 'INVALID_REQUEST',
        details: { reasonCode: 'AMBIGUOUS_LOCAL_SESSION_ID', matches: 2 },
      },
    });

    const revokeRes = await fetch(`${base}/hub/scoped-sessions/remote-session/revoke`, {
      method: 'POST',
      headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: exchanged.node.nodeId, reason: 'operator-test' }),
    });
    expect(revokeRes.status).toBe(200);
    expect(auditEntries).toHaveLength(3);
    expect(auditEntries[1]).toMatchObject({
      eventType: 'grant',
      decision: 'allow',
      reasonCode: 'POLICY_ALLOWED',
      intent: { action: 'sessions.create', target: exchanged.node.nodeId },
    });
    expect(auditEntries[2]).toMatchObject({
      eventType: 'revocation',
      decision: 'revoked',
      reasonCode: 'SESSION_REVOKED',
    });

    const activeOnlyRes = await fetch(`${base}/hub/scoped-sessions?includeRevoked=0`, {
      headers: { 'x-test-auth': 'yes' },
    });
    const activeOnly = (await activeOnlyRes.json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(activeOnly.sessions).toHaveLength(1);
    expect(activeOnly.sessions[0]).toMatchObject({
      sessionId: 'remote-session',
      nodeId: 'other-node',
      status: 'active',
    });
  });

  it('registers cold-reopen routed sessions before websocket attach validation', async () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const { tmpDir, registry } = tmpRegistry(() => now);
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const app = express();
    app.use(express.json());
    const requireAuth: express.RequestHandler = (req, res, next) => {
      if (req.header('x-test-auth') === 'yes') next();
      else res.status(401).json({ error: 'Unauthorized' });
    };
    const repoInventoryFeature = createRepoInventoryFeature(registry);
    const nodeLinks = createHubNodeLinkManager();
    const sessionEnvelopes = createSessionEnvelopeRegistry();
    app.use(
      createHubNodeRouter({
        registry,
        requireAuth,
        repoInventoryFeature,
        nodeLinks,
        sessionEnvelopes,
      })
    );
    app.use(
      createRepoFeatureRouter({
        registry,
        requireAuth,
        repoInventoryFeature,
        nodeLinks,
        sessionEnvelopes,
        now: () => now,
      })
    );
    const server = http.createServer(app);
    setupWebSocket(
      server,
      new Set(),
      null,
      undefined,
      true,
      undefined,
      registry,
      nodeLinks,
      sessionEnvelopes
    );
    const port = await listen(server);
    cleanup.push(() => close(server));
    const base = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;

    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: manifest(),
    });
    const heartbeat = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${exchanged.credential.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        manifest: manifest(),
        repoInventory: repoInventoryReport(
          exchanged.node.nodeId,
          '/srv/repos/relay-ide'
        ),
      }),
    });
    expect(heartbeat.status).toBe(200);

    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${exchanged.credential.token}` },
    });
    cleanup.push(() => nodeWs.close());
    await new Promise<void>((resolve, reject) => {
      nodeWs.once('open', resolve);
      nodeWs.once('error', reject);
    });

    for (const [field, invalidLifecycle] of [
      ['expiresAt', { expiresAt: 'not-a-date' }],
      ['ttlMs', { ttlMs: 0 }],
      ['ttlSeconds', { ttlSeconds: '60' }],
    ] as const) {
      const invalidLifecycleRes = await fetch(
        `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/sessions/reopen`,
        {
          method: 'POST',
          headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
          body: JSON.stringify({
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            ...invalidLifecycle,
          }),
        }
      );
      expect(invalidLifecycleRes.status).toBe(400);
      expect(await invalidLifecycleRes.json()).toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
          details: {
            reasonCode: 'INVALID_LIFECYCLE_INPUT',
            field,
          },
        },
      });
    }

    const reopenPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/sessions/reopen`,
      {
        method: 'POST',
        headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
        body: JSON.stringify({
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          type: 'terminal',
          ttlMs: 3_200_000_000_000,
        }),
      }
    );

    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      channel: 'rpc',
      type: 'sessions.create',
      payload: {
        repoPath: '/srv/repos/relay-ide',
        worktreePath: null,
        type: 'terminal',
        ttlMs: 3_200_000_000_000,
      },
    });
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId: exchanged.node.nodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: now.toISOString(),
        payload: {
          session: {
            id: 'reopened-session',
            type: 'terminal',
            agent: 'claude',
            mode: 'pty',
            repoPath: '/srv/repos/relay-ide',
            worktreePath: null,
            cwd: '/srv/repos/relay-ide',
            repoName: 'relay-ide',
            branchName: 'feature/inventory',
            displayName: 'reopened terminal',
            createdAt: now.toISOString(),
            lastActivity: now.toISOString(),
            idle: false,
            customCommand: null,
            status: 'active',
            needsBranchRename: false,
            agentState: 'idle',
          },
        },
      })
    );

    const reopenRes = await reopenPromise;
    expect(reopenRes.status).toBe(201);
    const reopened = (await reopenRes.json()) as {
      session: {
        id: string;
        nodeId: string;
        globalSessionId: string;
        sessionEnvelope: { expiresAt: string | null };
      };
    };
    expect(reopened.session).toMatchObject({
      id: 'reopened-session',
      nodeId: exchanged.node.nodeId,
      globalSessionId: `${exchanged.node.nodeId}:reopened-session`,
      sessionEnvelope: { expiresAt: '2127-05-30T03:57:25.000Z' },
    });
    expect(sessionEnvelopes.read('reopened-session', exchanged.node.nodeId)).toMatchObject({
      expiresAt: '2127-05-30T03:57:25.000Z',
    });

    const upgrade = await rawUpgrade(
      port,
      `/nodes/${encodeURIComponent(exchanged.node.nodeId)}/ws/sessions/reopened-session`
    );
    expect(upgrade).toContain('101 Switching Protocols');
  });

  it('exposes manual credential rotation and clear-failure operator routes', async () => {
    const { tmpDir, registry } = tmpRegistry();
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: manifest(),
    });
    const app = express();
    const auditEntries: unknown[] = [];
    app.use(express.json());
    app.use(
      createHubNodeRouter({
        registry,
        auditSink: { append: (entry) => auditEntries.push(entry) },
        requireAuth: (req, res, next) => {
          if (req.header('x-test-auth') === 'yes') next();
          else res.status(401).json({ error: 'Unauthorized' });
        },
      })
    );
    const server = http.createServer(app);
    const port = await listen(server);
    cleanup.push(() => close(server));
    const base = `http://127.0.0.1:${port}`;

    const unauthenticatedRotateRes = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/credential-rotation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delivery: 'manual' }),
      }
    );
    expect(unauthenticatedRotateRes.status).toBe(401);

    const rotateRes = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/credential-rotation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ delivery: 'manual' }),
      }
    );
    expect(rotateRes.status).toBe(201);
    const rotate = (await rotateRes.json()) as {
      credential: { token: string; credentialId: string };
      rotation: { rotationId: string; state: string };
      node: { credentialState: string };
    };
    expect(rotate.node.credentialState).toBe('rotating');
    expect(rotate.rotation.state).toBe('issuing');
    expect(rotate.credential.token).not.toBe(exchanged.credential.token);
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      eventType: 'rotation',
      decision: 'recorded',
      reasonCode: 'CREDENTIAL_ROTATION_ISSUED',
      peer: {
        kind: 'node',
        nodeId: exchanged.node.nodeId,
        credentialId: exchanged.credential.credentialId,
      },
      material: { params: { delivery: 'manual', rotationId: rotate.rotation.rotationId } },
    });
    expect(JSON.stringify(auditEntries)).not.toContain(rotate.credential.token);

    const nodesDuringRotationRes = await fetch(`${base}/nodes`, {
      headers: { 'x-test-auth': 'yes' },
    });
    expect(nodesDuringRotationRes.status).toBe(200);
    const nodesDuringRotationText = await nodesDuringRotationRes.text();
    expect(nodesDuringRotationText).not.toContain(rotate.credential.token);
    expect(nodesDuringRotationText).not.toContain(exchanged.credential.token);

    const collisionRes = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/credential-rotation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ delivery: 'manual' }),
      }
    );
    expect(collisionRes.status).toBe(409);
    const collision = (await collisionRes.json()) as {
      error: { code: string; details?: { rotationId?: string } };
    };
    expect(collision.error.code).toBe('ROTATION_IN_PROGRESS');
    expect(collision.error.details?.rotationId).toBe(rotate.rotation.rotationId);

    registry.failCredentialRotation(
      exchanged.node.nodeId,
      rotate.rotation.rotationId,
      'operator aborted'
    );
    const clearRes = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/credential-rotation/clear-failure`,
      {
        method: 'POST',
        headers: { 'x-test-auth': 'yes' },
      }
    );
    expect(clearRes.status).toBe(200);
    const clear = (await clearRes.json()) as {
      node: { credentialState: string; credentialRotation?: unknown };
    };
    expect(clear.node.credentialState).toBe('active');
    expect(clear.node.credentialRotation).toBeUndefined();
  });

  it('lets operators clear a delivered online rotation that never proves possession', async () => {
    const { tmpDir, registry } = tmpRegistry();
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: manifest(),
    });
    const deliveries: unknown[] = [];
    const nodeLinks = {
      hasActiveNode: (nodeId: string) => nodeId === exchanged.node.nodeId,
      request: async (_nodeId: string, _type: string, payload: unknown) => {
        deliveries.push(payload);
        return {};
      },
    };
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
    const port = await listen(server);
    cleanup.push(() => close(server));
    const base = `http://127.0.0.1:${port}`;

    const rotateRes = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/credential-rotation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ delivery: 'online' }),
      }
    );
    expect(rotateRes.status).toBe(202);
    const rotate = (await rotateRes.json()) as {
      rotation: { rotationId: string; state: string };
      node: { credentialState: string };
    };
    expect(rotate.node.credentialState).toBe('rotating');
    expect(rotate.rotation.state).toBe('delivered');
    const deliveredCredential = (deliveries[0] as {
      credential?: { token?: string; credentialId?: string };
    }).credential;
    expect(deliveredCredential?.token).toBeTruthy();

    const collisionRes = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/credential-rotation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ delivery: 'manual' }),
      }
    );
    expect(collisionRes.status).toBe(409);
    const collision = (await collisionRes.json()) as {
      error: { code: string; details?: { rotationId?: string } };
    };
    expect(collision.error.code).toBe('ROTATION_IN_PROGRESS');
    expect(collision.error.details?.rotationId).toBe(rotate.rotation.rotationId);

    const clearRes = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/credential-rotation/clear-failure`,
      {
        method: 'POST',
        headers: { 'x-test-auth': 'yes' },
      }
    );
    expect(clearRes.status).toBe(200);
    const clear = (await clearRes.json()) as {
      node: { credentialState: string; credentialRotation?: unknown };
    };
    expect(clear.node.credentialState).toBe('active');
    expect(clear.node.credentialRotation).toBeUndefined();
    expect(registry.authenticateCredential(exchanged.credential.token)).toMatchObject({
      credentialId: exchanged.credential.credentialId,
      credentialState: 'active',
    });
    expect(registry.authenticateCredential(deliveredCredential!.token!)).toBeNull();

    const retryRes = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/credential-rotation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ delivery: 'manual' }),
      }
    );
    expect(retryRes.status).toBe(201);
  });

  it('keeps a failed online rotation provable after a lost delivery ACK', async () => {
    const { tmpDir, registry } = tmpRegistry();
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: manifest(),
    });
    const deliveries: unknown[] = [];
    const nodeLinks = {
      hasActiveNode: (nodeId: string) => nodeId === exchanged.node.nodeId,
      request: async (_nodeId: string, _type: string, payload: unknown) => {
        deliveries.push(payload);
        throw new Error('rpc ack timeout');
      },
    };
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
    const port = await listen(server);
    cleanup.push(() => close(server));
    const base = `http://127.0.0.1:${port}`;

    const rotateRes = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/credential-rotation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ delivery: 'online' }),
      }
    );
    expect(rotateRes.status).toBe(502);
    const rotate = (await rotateRes.json()) as {
      rotation: { rotationId: string; state: string; failureReason?: string };
      node: { credentialState: string };
    };
    expect(rotate.node.credentialState).toBe('rotation-failed');
    expect(rotate.rotation.state).toBe('failed');
    expect(rotate.rotation.failureReason).toBe('rpc ack timeout');
    const deliveredCredential = (deliveries[0] as {
      credential?: { nodeId?: string; token?: string; credentialId?: string };
    }).credential;
    expect(deliveredCredential?.token).toBeTruthy();

    const heartbeatRes = await fetch(`${base}/hub/node-heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deliveredCredential!.token}`,
      },
      body: JSON.stringify({
        nodeId: deliveredCredential!.nodeId,
        protocolVersion: '1.0',
        manifest: manifest(),
      }),
    });
    expect(heartbeatRes.status).toBe(200);
    const heartbeat = (await heartbeatRes.json()) as {
      node: { credentialId: string; credentialState: string; credentialRotation?: { state: string } };
    };
    expect(heartbeat.node).toMatchObject({
      credentialId: deliveredCredential!.credentialId,
      credentialState: 'active',
      credentialRotation: { state: 'stable' },
    });
    expect(registry.authenticateCredential(exchanged.credential.token)).toBeNull();
  });

  it('gates hub node log proxy before RPC and forwards remote log errors/snapshots', async () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const { tmpDir, registry } = tmpRegistry(() => now);
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: manifest(),
    });
    const headers = { 'x-test-auth': 'yes' };

    const offlineRequest = vi.fn();
    const offlineApp = express();
    offlineApp.use(
      createHubNodeRouter({
        registry,
        nodeLinks: {
          hasActiveNode: () => false,
          request: offlineRequest,
        } as never,
        requireAuth: (req, res, next) => {
          if (req.header('x-test-auth') === 'yes') next();
          else res.status(401).json({ error: 'Unauthorized' });
        },
        now: () => now,
      })
    );
    const offlineServer = http.createServer(offlineApp);
    const offlinePort = await listen(offlineServer);
    cleanup.push(() => close(offlineServer));
    const offlineRes = await fetch(
      `http://127.0.0.1:${offlinePort}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/logs`,
      { headers }
    );
    expect(offlineRes.status).toBe(404);
    expect(await offlineRes.json()).toMatchObject({
      error: { code: 'NODE_OFFLINE', retryable: true },
    });
    expect(offlineRequest).not.toHaveBeenCalled();

    mutateStoredNode(tmpDir, exchanged.node.nodeId, (node) => {
      node['protocolVersion'] = '1.1';
    });
    const skewRegistry = createHubNodeRegistry({
      storagePath: path.join(tmpDir, 'nodes.json'),
      now: () => now,
    });
    const skewRequest = vi.fn();
    const skewApp = express();
    skewApp.use(
      createHubNodeRouter({
        registry: skewRegistry,
        nodeLinks: { hasActiveNode: () => true, request: skewRequest } as never,
        requireAuth: (req, res, next) => {
          if (req.header('x-test-auth') === 'yes') next();
          else res.status(401).json({ error: 'Unauthorized' });
        },
        now: () => now,
      })
    );
    const skewServer = http.createServer(skewApp);
    const skewPort = await listen(skewServer);
    cleanup.push(() => close(skewServer));
    const skewRes = await fetch(
      `http://127.0.0.1:${skewPort}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/logs`,
      { headers }
    );
    expect(skewRes.status).toBe(400);
    expect(await skewRes.json()).toMatchObject({
      error: { code: 'VERSION_SKEW', retryable: false },
    });
    expect(skewRequest).not.toHaveBeenCalled();

    mutateStoredNode(tmpDir, exchanged.node.nodeId, (node) => {
      node['protocolVersion'] = '1.0';
      const acl = node['acl'] as { grants: { allowed: string[] } };
      acl.grants.allowed = acl.grants.allowed.filter((bit) => bit !== 'rpc:fs:tail');
    });
    const deniedRegistry = createHubNodeRegistry({
      storagePath: path.join(tmpDir, 'nodes.json'),
      now: () => now,
    });
    const deniedRequest = vi.fn();
    const deniedApp = express();
    deniedApp.use(
      createHubNodeRouter({
        registry: deniedRegistry,
        nodeLinks: { hasActiveNode: () => true, request: deniedRequest } as never,
        requireAuth: (req, res, next) => {
          if (req.header('x-test-auth') === 'yes') next();
          else res.status(401).json({ error: 'Unauthorized' });
        },
        now: () => now,
      })
    );
    const deniedServer = http.createServer(deniedApp);
    const deniedPort = await listen(deniedServer);
    cleanup.push(() => close(deniedServer));
    const deniedRes = await fetch(
      `http://127.0.0.1:${deniedPort}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/logs`,
      { headers }
    );
    expect(deniedRes.status).toBe(401);
    expect(await deniedRes.json()).toMatchObject({
      error: {
        code: 'UNAUTHORIZED',
        details: { reasonCode: 'POLICY_CAPABILITY_DENIED' },
      },
    });
    expect(deniedRequest).not.toHaveBeenCalled();

    mutateStoredNode(tmpDir, exchanged.node.nodeId, (node) => {
      const acl = node['acl'] as { grants: { allowed: string[] } };
      acl.grants.allowed.push('rpc:fs:tail');
    });
    const routeRegistry = createHubNodeRegistry({
      storagePath: path.join(tmpDir, 'nodes.json'),
      now: () => now,
    });
    const routeRequest = vi
      .fn()
      .mockRejectedValueOnce(
        new HubNodeLinkError({
          code: 'NOT_FOUND',
          message: 'node log file was not found',
          retryable: false,
        })
      )
      .mockResolvedValueOnce({ status: 'empty', output: '', lines: 0 });
    const routeApp = express();
    routeApp.use(
      createHubNodeRouter({
        registry: routeRegistry,
        nodeLinks: { hasActiveNode: () => true, request: routeRequest } as never,
        requireAuth: (req, res, next) => {
          if (req.header('x-test-auth') === 'yes') next();
          else res.status(401).json({ error: 'Unauthorized' });
        },
        now: () => now,
      })
    );
    const routeServer = http.createServer(routeApp);
    const routePort = await listen(routeServer);
    cleanup.push(() => close(routeServer));
    const routeBase = `http://127.0.0.1:${routePort}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/logs`;

    const missingLogRes = await fetch(routeBase, { headers });
    expect(missingLogRes.status).toBe(404);
    expect(await missingLogRes.json()).toMatchObject({
      error: { code: 'NOT_FOUND', retryable: false },
    });

    const emptyLogRes = await fetch(routeBase, { headers });
    expect(emptyLogRes.status).toBe(200);
    expect(await emptyLogRes.json()).toMatchObject({
      log: { status: 'empty', output: '' },
    });
    expect(routeRequest).toHaveBeenCalledTimes(2);
  });

  it('sets node log follow headers before stream open and cancels if the client disconnects early', async () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const { tmpDir, registry } = tmpRegistry(() => now);
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: manifest(),
    });
    let closeCalled = false;
    let resolveStream: ((stream: { payload: unknown; close(): void }) => void) | undefined;
    const nodeLinks = {
      hasActiveNode: () => true,
      request: vi.fn(),
      streamRequest: vi.fn(
        () =>
          new Promise<{ payload: unknown; close(): void }>((resolve) => {
            resolveStream = resolve;
          })
      ),
    };
    const app = express();
    app.use(
      createHubNodeRouter({
        registry,
        nodeLinks: nodeLinks as never,
        requireAuth: (req, res, next) => {
          if (req.header('x-test-auth') === 'yes') next();
          else res.status(401).json({ error: 'Unauthorized' });
        },
        now: () => now,
      })
    );
    const server = http.createServer(app);
    const port = await listen(server);
    cleanup.push(() => close(server));

    const res = await fetch(
      `http://127.0.0.1:${port}/hub/nodes/${encodeURIComponent(exchanged.node.nodeId)}/logs?follow=1`,
      { headers: { 'x-test-auth': 'yes' } }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toBe('no-store');
    await res.body?.cancel();

    expect(resolveStream).toBeDefined();
    resolveStream?.({
      payload: { status: 'ok', output: 'initial\n' },
      close: () => {
        closeCalled = true;
      },
    });
    await vi.waitFor(() => expect(closeCalled).toBe(true));
  });

});
