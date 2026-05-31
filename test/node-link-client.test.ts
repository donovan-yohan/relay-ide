import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeLinkManager } from '../server/hub-node-link.js';
import { setupWebSocket } from '../server/ws.js';
import {
  createNodeLinkClient,
  type NodeLinkWebSocketFactory,
  type NodeLinkWebSocketLike,
} from '../server/node-link-client.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type RelayNodeEnvelope,
} from '../shared/relay-node-protocol.js';
import { testBrowserAuthTokens } from './helpers/ws-auth.js';

type Listener = (...args: unknown[]) => void;

class FakeSocket implements NodeLinkWebSocketLike {
  readyState = 0;
  readonly OPEN = 1;
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  on(event: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  emit(event: string, ...args: unknown[]): void {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const listener of list.slice()) listener(...args);
  }

  open(): void {
    this.readyState = this.OPEN;
    this.emit('open');
  }

  push(envelope: RelayNodeEnvelope): void {
    this.emit('message', Buffer.from(JSON.stringify(envelope)));
  }
}

function fakeManifest(): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    hostname: 'node-link-host',
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
      ssh: { id: 'ssh', label: 'SSH client', status: 'available', message: 'ok' },
      agents: {},
    },
  };
}

interface FakeTimerEnv {
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  run(): void;
  scheduled(): Array<{ delay: number }>;
}

function fakeTimerEnv(): FakeTimerEnv {
  const timers: Array<{ id: number; delay: number; fn: () => void }> = [];
  let nextId = 1;
  const setTimeoutFn = ((fn: () => void, delay: number) => {
    const id = nextId++;
    timers.push({ id, delay, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = ((id: unknown) => {
    const idx = timers.findIndex((t) => t.id === id);
    if (idx >= 0) timers.splice(idx, 1);
  }) as typeof clearTimeout;
  return {
    setTimeoutFn,
    clearTimeoutFn,
    run() {
      const due = timers.slice();
      timers.length = 0;
      for (const timer of due) timer.fn();
    },
    scheduled() {
      return timers.map((t) => ({ delay: t.delay }));
    },
  };
}

describe('node link client (unit)', () => {
  it('sends control.hello with manifest after open', async () => {
    const fake = new FakeSocket();
    const factory: NodeLinkWebSocketFactory = () => fake;
    const timers = fakeTimerEnv();
    const client = createNodeLinkClient({
      hubUrl: 'http://hub.test',
      credential: { nodeId: 'node-1', token: 't' },
      getManifest: () => fakeManifest(),
      webSocketFactory: factory,
      ...timers,
    });
    client.start();
    fake.open();
    await new Promise((r) => setImmediate(r));
    expect(fake.sent).toHaveLength(1);
    const env = JSON.parse(fake.sent[0]!) as RelayNodeEnvelope;
    expect(env.protocol).toBe(RELAY_NODE_LINK_PROTOCOL);
    expect(env.protocolVersion).toBe(RELAY_NODE_LINK_PROTOCOL_VERSION);
    expect(env.nodeId).toBe('node-1');
    expect(env.channel).toBe('control');
    expect(env.type).toBe('control.hello');
    expect((env.payload as { manifest: NodeManifest }).manifest.hostname).toBe(
      'node-link-host'
    );
  });

  it('schedules exponential backoff with jitter on close', async () => {
    const sockets: FakeSocket[] = [];
    const factory: NodeLinkWebSocketFactory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const timers = fakeTimerEnv();
    const client = createNodeLinkClient({
      hubUrl: 'http://hub.test',
      credential: { nodeId: 'node-1', token: 't' },
      getManifest: () => fakeManifest(),
      webSocketFactory: factory,
      initialReconnectDelayMs: 100,
      maxReconnectDelayMs: 10_000,
      reconnectJitterMs: 0,
      random: () => 0,
      ...timers,
    });
    client.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.close(1006, 'lost');
    expect(timers.scheduled().map((s) => s.delay)).toEqual([100]);
    timers.run();
    expect(sockets).toHaveLength(2);
    sockets[1]!.close(1006, 'lost');
    expect(timers.scheduled().map((s) => s.delay)).toEqual([200]);
    void client.stop();
  });

  it('stops permanently on NODE_REVOKED control.error', async () => {
    const fake = new FakeSocket();
    const factory: NodeLinkWebSocketFactory = () => fake;
    const timers = fakeTimerEnv();
    const client = createNodeLinkClient({
      hubUrl: 'http://hub.test',
      credential: { nodeId: 'node-1', token: 't' },
      getManifest: () => fakeManifest(),
      webSocketFactory: factory,
      ...timers,
    });
    client.start();
    fake.open();
    await new Promise((r) => setImmediate(r));
    fake.push({
      protocol: RELAY_NODE_LINK_PROTOCOL,
      protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
      nodeId: 'node-1',
      channel: 'control',
      type: 'control.error',
      timestamp: new Date().toISOString(),
      error: { code: 'NODE_REVOKED', message: 'revoked', retryable: false },
    });
    await new Promise((r) => setImmediate(r));
    expect(client.getState()).toBe('stopped');
    expect(timers.scheduled()).toEqual([]);
  });
});

function tmpRegistry(now = () => new Date('2026-01-02T03:04:05.000Z')) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-link-client-'));
  const registry = createHubNodeRegistry({
    storagePath: path.join(tmpDir, 'nodes.json'),
    now,
  });
  return { tmpDir, registry };
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

describe('node link client (integration)', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  it('establishes link against a real hub and marks node online via heartbeat', async () => {
    let now = new Date('2026-01-02T03:04:05.000Z');
    const { tmpDir, registry } = tmpRegistry(() => now);
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: fakeManifest(),
    });

    const server = http.createServer(express());
    setupWebSocket(
      server,
      testBrowserAuthTokens(),
      null,
      undefined,
      false,
      undefined,
      registry,
      createHubNodeLinkManager()
    );
    const port = await listen(server);
    cleanup.push(() => close(server));

    now = new Date('2026-01-02T03:04:10.000Z');
    const client = createNodeLinkClient({
      hubUrl: `http://127.0.0.1:${port}`,
      credential: {
        nodeId: exchanged.credential.nodeId,
        token: exchanged.credential.token,
      },
      getManifest: () => fakeManifest(),
      heartbeatIntervalMs: 60_000,
      initialReconnectDelayMs: 50,
      maxReconnectDelayMs: 200,
      reconnectJitterMs: 0,
    });
    cleanup.push(() => client.stop());

    const connected = new Promise<void>((resolve) => {
      const off = client.onStateChange((state) => {
        if (state === 'connected') {
          off();
          resolve();
        }
      });
    });
    client.start();
    await connected;

    // Wait for hub to record heartbeat; poll registry briefly.
    let online = false;
    for (let i = 0; i < 100; i++) {
      const summary = registry
        .listNodes()
        .find((n) => n.nodeId === exchanged.credential.nodeId);
      if (summary && summary.status === 'online') {
        online = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(online).toBe(true);
  });

  it('reconnects after a transient hub close', async () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const { tmpDir, registry } = tmpRegistry(() => now);
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: fakeManifest(),
    });
    const server = http.createServer(express());
    setupWebSocket(
      server,
      testBrowserAuthTokens(),
      null,
      undefined,
      false,
      undefined,
      registry,
      createHubNodeLinkManager()
    );
    const port = await listen(server);
    cleanup.push(() => close(server));

    const client = createNodeLinkClient({
      hubUrl: `http://127.0.0.1:${port}`,
      credential: {
        nodeId: exchanged.credential.nodeId,
        token: exchanged.credential.token,
      },
      getManifest: () => fakeManifest(),
      initialReconnectDelayMs: 50,
      maxReconnectDelayMs: 200,
      reconnectJitterMs: 0,
    });
    cleanup.push(() => client.stop());

    let connects = 0;
    const reachedTwo = new Promise<void>((resolve) => {
      const off = client.onStateChange((state) => {
        if (state === 'connected') {
          connects += 1;
          if (connects === 1) {
            // Force a remote close to trigger reconnect.
            // Open a second client connection to the same node — hub-side
            // registerNodeLink replaces the older socket with code 1012.
            const replacement = new WebSocket(
              `ws://127.0.0.1:${port}/hub/node-link`,
              {
                headers: { authorization: `Bearer ${exchanged.credential.token}` },
              }
            );
            replacement.once('open', () => replacement.close());
          }
          if (connects === 2) {
            off();
            resolve();
          }
        }
      });
    });
    client.start();
    await reachedTwo;
    expect(connects).toBeGreaterThanOrEqual(2);
  });
});
