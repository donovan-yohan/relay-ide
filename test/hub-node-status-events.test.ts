import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createHubNodeLinkManager } from '../server/hub-node-link.js';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { setupWebSocket } from '../server/ws.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
} from '../shared/relay-node-protocol.js';
import { buildManifestWithAgents } from './helpers/manifest-fixtures.js';

const cleanupFns: Array<() => Promise<void> | void> = [];

function manifest(hostname: string): NodeManifest {
  return buildManifestWithAgents({
    agents: [{ id: 'claude', label: 'Claude', status: 'available' }],
    overrides: {
      hostname,
      platform: 'linux',
      arch: 'x64',
      relayVersion: '0.1.0-test',
    },
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port');
  }
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await once(ws, 'open');
}

async function nextNodeStatus(ws: WebSocket): Promise<Record<string, unknown>> {
  for (;;) {
    const [raw] = (await once(ws, 'message')) as [Buffer];
    const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (payload['type'] === 'node.status') return payload;
  }
}

async function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  const [raw] = (await once(ws, 'message')) as [Buffer];
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(async () => {
  while (cleanupFns.length > 0) await cleanupFns.pop()?.();
});

describe('hub node status event websocket', () => {
  it('fans out registry online/stale/offline/revoked transitions to browser event clients', async () => {
    let currentTime = new Date('2026-01-02T03:04:05.000Z');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-status-events-'));
    cleanupFns.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const registry = createHubNodeRegistry({
      storagePath: path.join(tmpDir, 'hub', 'nodes.json'),
      now: () => currentTime,
      staleMs: 45_000,
      offlineMs: 90_000,
      heartbeatPersistDebounceMs: 1,
    });
    const server = http.createServer();
    const { wss } = setupWebSocket(
      server,
      new Set<string>(),
      null,
      undefined,
      true,
      undefined,
      registry
    );
    cleanupFns.push(() => wss.close());
    cleanupFns.push(() => closeServer(server));
    const port = await listen(server);

    const browser = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    cleanupFns.push(() => browser.close());
    await waitForOpen(browser);

    const online = nextNodeStatus(browser);
    const pair = registry.createPairToken({ displayName: 'status-node' });
    const exchanged = registry.exchangePairToken({
      pairToken: pair.pairToken,
      manifest: manifest('status-node'),
      protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    });
    await expect(online).resolves.toMatchObject({
      type: 'node.status',
      nodeId: exchanged.node.nodeId,
      status: 'online',
      lastSeenAt: '2026-01-02T03:04:05.000Z',
      manifest: expect.objectContaining({ hostname: 'status-node' }),
    });

    const stale = nextNodeStatus(browser);
    currentTime = new Date('2026-01-02T03:04:51.000Z');
    expect(registry.refreshNodeStatuses()).toEqual([
      expect.objectContaining({
        nodeId: exchanged.node.nodeId,
        status: 'stale',
        lastSeenAt: '2026-01-02T03:04:05.000Z',
      }),
    ]);
    await expect(stale).resolves.toMatchObject({
      type: 'node.status',
      nodeId: exchanged.node.nodeId,
      status: 'stale',
      lastSeenAt: '2026-01-02T03:04:05.000Z',
    });

    const offline = nextNodeStatus(browser);
    currentTime = new Date('2026-01-02T03:05:36.000Z');
    expect(registry.refreshNodeStatuses()).toEqual([
      expect.objectContaining({
        nodeId: exchanged.node.nodeId,
        status: 'offline',
        lastSeenAt: '2026-01-02T03:04:05.000Z',
      }),
    ]);
    await expect(offline).resolves.toMatchObject({
      type: 'node.status',
      nodeId: exchanged.node.nodeId,
      status: 'offline',
      lastSeenAt: '2026-01-02T03:04:05.000Z',
    });

    const backOnline = nextNodeStatus(browser);
    registry.recordHeartbeat({
      nodeId: exchanged.node.nodeId,
      protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
      manifest: manifest('status-node-reconnected'),
    });
    await expect(backOnline).resolves.toMatchObject({
      type: 'node.status',
      nodeId: exchanged.node.nodeId,
      status: 'online',
      lastSeenAt: '2026-01-02T03:05:36.000Z',
      manifest: expect.objectContaining({ hostname: 'status-node-reconnected' }),
    });

    const revoked = nextNodeStatus(browser);
    registry.revokeNode(exchanged.node.nodeId);
    await expect(revoked).resolves.toMatchObject({
      type: 'node.status',
      nodeId: exchanged.node.nodeId,
      status: 'revoked',
      lastSeenAt: '2026-01-02T03:05:36.000Z',
    });
  });

  it('emits offline promptly when a fresh live reverse node-link closes', async () => {
    const currentTime = new Date('2026-01-02T03:04:05.000Z');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-link-offline-'));
    cleanupFns.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const registry = createHubNodeRegistry({
      storagePath: path.join(tmpDir, 'hub', 'nodes.json'),
      now: () => currentTime,
      staleMs: 45_000,
      offlineMs: 90_000,
      heartbeatPersistDebounceMs: 1,
    });
    const nodeLinks = createHubNodeLinkManager();
    const server = http.createServer();
    const { wss } = setupWebSocket(
      server,
      new Set<string>(),
      null,
      undefined,
      true,
      undefined,
      registry,
      nodeLinks
    );
    cleanupFns.push(() => wss.close());
    cleanupFns.push(() => closeServer(server));
    const port = await listen(server);

    const browser = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    cleanupFns.push(() => browser.close());
    await waitForOpen(browser);

    const online = nextNodeStatus(browser);
    const pair = registry.createPairToken({ displayName: 'link-close-node' });
    const exchanged = registry.exchangePairToken({
      pairToken: pair.pairToken,
      manifest: manifest('link-close-node'),
      protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    });
    await expect(online).resolves.toMatchObject({
      type: 'node.status',
      nodeId: exchanged.node.nodeId,
      status: 'online',
      lastSeenAt: '2026-01-02T03:04:05.000Z',
    });

    const nodeLink = new WebSocket(`ws://127.0.0.1:${port}/hub/node-link`, {
      headers: { authorization: `Bearer ${exchanged.credential.token}` },
    });
    cleanupFns.push(() => nodeLink.close());
    await waitForOpen(nodeLink);
    nodeLink.send(
      JSON.stringify({
        protocol: RELAY_NODE_LINK_PROTOCOL,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        nodeId: exchanged.node.nodeId,
        channel: 'control',
        type: 'control.hello',
        requestId: 'hello-1',
        timestamp: currentTime.toISOString(),
        payload: { manifest: manifest('link-close-node') },
      })
    );
    await expect(nextJson(nodeLink)).resolves.toMatchObject({
      type: 'control.hello.result',
      requestId: 'hello-1',
    });
    expect(registry.listNodes()).toEqual([
      expect.objectContaining({
        nodeId: exchanged.node.nodeId,
        status: 'online',
      }),
    ]);

    const offline = withTimeout(nextNodeStatus(browser), 1_000);
    nodeLink.close();
    await expect(offline).resolves.toMatchObject({
      type: 'node.status',
      nodeId: exchanged.node.nodeId,
      status: 'offline',
      lastSeenAt: '2026-01-02T03:04:05.000Z',
    });
    expect(registry.listNodes()).toEqual([
      expect.objectContaining({
        nodeId: exchanged.node.nodeId,
        status: 'offline',
        lastSeenAt: '2026-01-02T03:04:05.000Z',
      }),
    ]);
  });
});
