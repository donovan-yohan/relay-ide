import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubNodeRegistry } from '../../server/hub-node-registry.js';
import { createHubNodeRouter } from '../../server/hub-node-router.js';
import { createHubNodeLinkManager } from '../../server/hub-node-link.js';
import { createLocalRelayNode } from '../../server/local-node.js';
import { createSessionEnvelopeRegistry } from '../../server/session-envelope-registry.js';
import { setupWebSocket } from '../../server/ws.js';
import type { NodeManifest } from '../../shared/node-manifest.js';
import {
  type RelayNodeEnvelope,
} from '../../shared/relay-node-protocol.js';
import {
  createRoutedNodeSessionEnvelope,
} from '../../shared/session-envelope.js';
import type { SecurityAuditEntryInput } from '../../shared/security-audit.js';
import type { RelayCapabilityBit } from '../../shared/security-policy.js';
import { mintPairTokenWithOperatorGrantForTest } from '../helpers/operator-pairing.js';

function manifest(overrides: Partial<NodeManifest> = {}): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    hostname: 'fs-write-test-node',
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
      clipboard: { id: 'clipboard', label: 'Clipboard', status: 'unknown', message: 'unknown' },
      browserAutomation: { id: 'browserAutomation', label: 'Browser automation', status: 'degraded', message: 'missing deps' },
      githubCli: { id: 'githubCli', label: 'GitHub CLI', status: 'available', message: 'ok' },
      tailscale: { id: 'tailscale', label: 'Tailscale CLI', status: 'unavailable', message: 'missing' },
      ssh: { id: 'ssh', label: 'SSH client', status: 'available', message: 'ok' },
      agents: {
        claude: { id: 'claude', label: 'Claude', status: 'available', message: 'ok' },
      },
    },
    ...overrides,
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
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
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as RelayNodeEnvelope));
  });
}

async function pairNode(base: string, nodeManifest = manifest()): Promise<{ token: string; nodeId: string }> {
  const pair = await mintPairTokenWithOperatorGrantForTest(base, {
    displayName: 'Write Test Node',
  });

  const exchangeRes = await fetch(`${base}/hub/pairing/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairToken: pair.pairToken, manifest: nodeManifest }),
  });
  expect(exchangeRes.status).toBe(201);
  const exchange = (await exchangeRes.json()) as { credential: { token: string; nodeId: string } };
  return { token: exchange.credential.token, nodeId: exchange.credential.nodeId };
}

function seedRemoteSessionEnvelope(
  sessionEnvelopes: ReturnType<typeof createSessionEnvelopeRegistry>,
  nodeId: string
): void {
  sessionEnvelopes.upsert(
    createRoutedNodeSessionEnvelope({
      sessionId: 'remote-session-1',
      globalSessionId: `${nodeId}:remote-session-1`,
      nodeId,
      repoPath: '/srv/relay-ide',
      cwd: '/srv/relay-ide',
      issuedAt: '2026-01-02T03:04:05.000Z',
    })
  );
}

function grantNodeCapabilitiesForTest(
  registry: ReturnType<typeof createHubNodeRegistry>,
  nodeId: string,
  capabilities: RelayCapabilityBit[]
): void {
  const state = (registry as unknown as {
    state: {
      nodes: Array<{
        nodeId: string;
        acl?: {
          grants: {
            allowed: RelayCapabilityBit[];
            requiresConfirmation: RelayCapabilityBit[];
          };
          lifecycle: { updatedAt: string };
        };
      }>;
    };
  }).state;
  const node = state.nodes.find((candidate) => candidate.nodeId === nodeId);
  expect(node?.acl).toBeDefined();
  for (const capability of capabilities) {
    if (!node!.acl!.grants.allowed.includes(capability)) {
      node!.acl!.grants.allowed.push(capability);
    }
  }
  node!.acl!.lifecycle.updatedAt = '2026-01-02T03:04:05.000Z';
}

describe('hub fs.write route', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  async function startHub(now = () => new Date('2026-01-02T03:04:05.000Z')) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hub-fs-write-'));
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const registry = createHubNodeRegistry({
      storagePath: path.join(tmpDir, 'nodes.json'),
      now,
    });
    const nodeLinks = createHubNodeLinkManager();
    const sessionEnvelopes = createSessionEnvelopeRegistry();
    const auditEntries: SecurityAuditEntryInput[] = [];
    const app = express();
    app.use(express.json());
    const requireAuth: express.RequestHandler = (req, res, next) => {
      if (req.header('x-test-auth') === 'yes') next();
      else res.status(401).json({ error: 'Unauthorized' });
    };
    app.use(
      createHubNodeRouter({
        registry,
        nodeLinks,
        sessionEnvelopes,
        auditSink: { append: (entry) => auditEntries.push(entry) },
        now,
        requireAuth,
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
      nodeLinks,
      sessionEnvelopes
    );
    const port = await listen(server);
    cleanup.push(() => close(server));
    return {
      base: `http://127.0.0.1:${port}`,
      wsBase: `ws://127.0.0.1:${port}`,
      port,
      nodeLinks,
      sessionEnvelopes,
      auditEntries,
      registry,
    };
  }

  it('happy path: routes fs.write and returns FileRpcWriteResponse shape', async () => {
    const { base, wsBase, sessionEnvelopes, registry } = await startHub();
    const { token, nodeId } = await pairNode(base);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    grantNodeCapabilitiesForTest(registry, nodeId, ['rpc:fs:write']);

    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const contentBase64 = Buffer.from('hello relay').toString('base64');
    const writePromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/remote-session-1/files/write`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ path: 'src/hello.ts', mode: 'create', contentBase64 }),
      }
    );

    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      nodeId,
      channel: 'rpc',
      type: 'fs.write',
      payload: {
        sessionId: 'remote-session-1',
        root: '/srv/relay-ide',
        cwd: '/srv/relay-ide',
        path: '/srv/relay-ide/src/hello.ts',
        mode: 'create',
        contentBase64,
      },
    });

    const writeResponse = {
      operation: 'write',
      root: '/srv/relay-ide',
      cwd: '/srv/relay-ide',
      path: '/srv/relay-ide/src/hello.ts',
      mode: 'create',
      bytesWritten: 11,
      newHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      newMtime: '2026-01-02T03:04:05.000Z',
      created: true,
    };
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'fs.write.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: writeResponse,
      })
    );

    const res = await writePromise;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      operation: 'write',
      bytesWritten: 11,
      created: true,
      newHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    });
  });

  // Reviewer Strong #3 (a): capability deny
  it('capability deny: peer creds lack rpc:fs:write → UNAUTHORIZED or FORBIDDEN denial with deniedBits', async () => {
    const { base, wsBase, sessionEnvelopes } = await startHub();
    const { token, nodeId } = await pairNode(base);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    // Do NOT grant rpc:fs:write — it is off by default

    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/remote-session-1/files/write`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          path: 'src/hello.ts',
          mode: 'create',
          contentBase64: Buffer.from('hello').toString('base64'),
        }),
      }
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    // policy deny: rpc:fs:write not in allowed list
    expect(body).toMatchObject({ error: { code: expect.stringMatching(/^(UNAUTHORIZED|FORBIDDEN)$/) } });
    expect(nodeWs.readyState).toBe(WebSocket.OPEN);
  });

  it('path-traversal rejection at hub layer before forwarding to node', async () => {
    const { base, wsBase, sessionEnvelopes, registry } = await startHub();
    const { token, nodeId } = await pairNode(base);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    grantNodeCapabilitiesForTest(registry, nodeId, ['rpc:fs:write']);

    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/remote-session-1/files/write`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({
          path: '../secret',
          mode: 'create',
          contentBase64: Buffer.from('evil').toString('base64'),
        }),
      }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', details: { reasonCode: 'FILE_RPC_ROOT_ESCAPE' } },
    });
    expect(nodeWs.readyState).toBe(WebSocket.OPEN);
  });

  // CRIT-5: both audit rows present after successful write
  it('two audit rows written after successful write: rpc.fs.write (pre-flight) + rpc.fs.write.completed (post)', async () => {
    const { base, wsBase, sessionEnvelopes, auditEntries, registry } = await startHub();
    const { token, nodeId } = await pairNode(base);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    grantNodeCapabilitiesForTest(registry, nodeId, ['rpc:fs:write']);

    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const contentBase64 = Buffer.from('audit test').toString('base64');
    const writePromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/remote-session-1/files/write`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ path: 'src/audit-file.ts', mode: 'create', contentBase64 }),
      }
    );

    const request = await nextJson(nodeWs);
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'fs.write.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          operation: 'write',
          root: '/srv/relay-ide',
          cwd: '/srv/relay-ide',
          path: '/srv/relay-ide/src/audit-file.ts',
          mode: 'create',
          bytesWritten: 10,
          newHash: 'cafebabe1234567890cafebabe1234567890cafebabe1234567890cafebabe12',
          newMtime: '2026-01-02T03:04:05.000Z',
          created: true,
        },
      })
    );

    const res = await writePromise;
    expect(res.status).toBe(200);

    // Pre-flight audit row (policy decision)
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        intent: expect.objectContaining({ action: 'rpc.fs.write' }),
        node: expect.objectContaining({ nodeId }),
        sessionId: 'remote-session-1',
      })
    );
    // Post-write completion audit row (CRIT-5)
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        intent: expect.objectContaining({ action: 'rpc.fs.write.completed' }),
        node: expect.objectContaining({ nodeId }),
        sessionId: 'remote-session-1',
      })
    );
    // Both rows present — exactly 2 rows with fs.write actions
    const writeAuditRows = auditEntries.filter(
      (e) => typeof e.intent?.['action'] === 'string' && (e.intent['action'] as string).startsWith('rpc.fs.write')
    );
    expect(writeAuditRows).toHaveLength(2);
  });
});
