import * as fs from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeRouter } from '../server/hub-node-router.js';
import { createRepoFeatureRouter } from '../server/features/repo-router.js';
import { createHubNodeLinkManager } from '../server/hub-node-link.js';
import { createRepoInventoryFeature } from '../server/features/repo-inventory.js';
import { setupWebSocket } from '../server/ws.js';
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
});
