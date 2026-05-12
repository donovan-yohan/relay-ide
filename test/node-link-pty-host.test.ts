import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { IPty, IPtyForkOptions } from 'node-pty';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeLinkManager } from '../server/hub-node-link.js';
import { setupWebSocket } from '../server/ws.js';
import { createNodeLinkClient } from '../server/node-link-client.js';
import { createNodeLinkPtyHost } from '../server/node-link-pty-host.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type RelayNodeEnvelope,
} from '../shared/relay-node-protocol.js';

type DataHandler = (chunk: string) => void;
type ExitHandler = (event: { exitCode: number; signal?: number }) => void;

class FakePty {
  cols: number;
  rows: number;
  written: string[] = [];
  killed = false;
  private dataHandlers: DataHandler[] = [];
  private exitHandlers: ExitHandler[] = [];

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  onData(handler: DataHandler): { dispose: () => void } {
    this.dataHandlers.push(handler);
    return {
      dispose: () => {
        this.dataHandlers = this.dataHandlers.filter((h) => h !== handler);
      },
    };
  }

  onExit(handler: ExitHandler): { dispose: () => void } {
    this.exitHandlers.push(handler);
    return {
      dispose: () => {
        this.exitHandlers = this.exitHandlers.filter((h) => h !== handler);
      },
    };
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  kill(): void {
    this.killed = true;
  }

  emitData(chunk: string): void {
    for (const handler of this.dataHandlers.slice()) handler(chunk);
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const handler of this.exitHandlers.slice()) handler({ exitCode, signal });
  }
}

function envelopeBuilder(nodeId: string) {
  return (
    channel: RelayNodeEnvelope['channel'],
    type: string,
    extras: Partial<RelayNodeEnvelope> = {}
  ): RelayNodeEnvelope => ({
    protocol: RELAY_NODE_LINK_PROTOCOL,
    protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    nodeId,
    channel,
    type,
    timestamp: new Date().toISOString(),
    ...extras,
  });
}

describe('node link pty host (unit)', () => {
  it('spawns on pty.attach, forwards data, kills on detach', () => {
    let lastPty: FakePty | undefined;
    const sent: RelayNodeEnvelope[] = [];
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      spawn: (command: string, args: string[], options: IPtyForkOptions) => {
        lastPty = new FakePty(options.cols ?? 80, options.rows ?? 24);
        return lastPty as unknown as IPty;
      },
    });
    const build = envelopeBuilder('node-1');
    const ctx = {
      send: (env: RelayNodeEnvelope) => sent.push(env),
      buildEnvelope: build,
    };

    host.handle(
      build('pty', 'pty.attach', {
        streamId: 's1',
        payload: { sessionId: 'session-a', cols: 100, rows: 30 },
      }),
      ctx
    );
    expect(lastPty).toBeDefined();
    expect(lastPty!.cols).toBe(100);

    lastPty!.emitData('hello');
    expect(sent.map((e) => e.type)).toEqual(['pty.data']);
    expect((sent[0]!.payload as { data: string }).data).toBe('hello');

    host.handle(
      build('pty', 'pty.input', {
        streamId: 's1',
        payload: { data: 'ls\n' },
      }),
      ctx
    );
    expect(lastPty!.written).toEqual(['ls\n']);

    host.handle(
      build('pty', 'pty.resize', {
        streamId: 's1',
        payload: { cols: 120, rows: 40 },
      }),
      ctx
    );
    expect(lastPty!.cols).toBe(120);
    expect(lastPty!.rows).toBe(40);

    host.handle(
      build('pty', 'pty.detach', { streamId: 's1' }),
      ctx
    );
    expect(lastPty!.killed).toBe(true);

    // After detach the host marks the stream closing but waits for onExit
    // before deleting the entry + emitting pty.exit. Simulate the OS-level
    // exit signal that kill() would normally produce.
    const sentBeforeExit = sent.length;
    lastPty!.emitExit(0, 15);
    const exit = sent.slice(sentBeforeExit).find((e) => e.type === 'pty.exit');
    expect(exit).toBeDefined();
    expect((exit!.payload as { exitCode: number }).exitCode).toBe(0);
  });

  it('emits pty.exit when the underlying pty exits', () => {
    let lastPty: FakePty | undefined;
    const sent: RelayNodeEnvelope[] = [];
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      spawn: (_c, _a, options: IPtyForkOptions) => {
        lastPty = new FakePty(options.cols ?? 80, options.rows ?? 24);
        return lastPty as unknown as IPty;
      },
    });
    const build = envelopeBuilder('node-1');
    host.handle(
      build('pty', 'pty.attach', { streamId: 's1', payload: {} }),
      { send: (e) => sent.push(e), buildEnvelope: build }
    );
    lastPty!.emitExit(0);
    const exit = sent.find((e) => e.type === 'pty.exit');
    expect(exit).toBeDefined();
    expect((exit!.payload as { exitCode: number }).exitCode).toBe(0);
  });

  it('emits pty.error when spawn throws', () => {
    const sent: RelayNodeEnvelope[] = [];
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      spawn: () => {
        throw new Error('boom');
      },
    });
    const build = envelopeBuilder('node-1');
    host.handle(
      build('pty', 'pty.attach', { streamId: 's1', payload: {} }),
      { send: (e) => sent.push(e), buildEnvelope: build }
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('pty.error');
    expect(sent[0]!.error?.code).toBe('INTERNAL');
  });

  it('rejects duplicate attach for the same streamId', () => {
    const sent: RelayNodeEnvelope[] = [];
    const ptys: FakePty[] = [];
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      spawn: (_c, _a, options: IPtyForkOptions) => {
        const p = new FakePty(options.cols ?? 80, options.rows ?? 24);
        ptys.push(p);
        return p as unknown as IPty;
      },
    });
    const build = envelopeBuilder('node-1');
    const ctx = { send: (e: RelayNodeEnvelope) => sent.push(e), buildEnvelope: build };
    host.handle(
      build('pty', 'pty.attach', { streamId: 's1', payload: {} }),
      ctx
    );
    host.handle(
      build('pty', 'pty.attach', { streamId: 's1', payload: {} }),
      ctx
    );
    expect(ptys).toHaveLength(1);
    const err = sent.find((e) => e.type === 'pty.error');
    expect(err).toBeDefined();
  });
});

function fakeManifest(): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    hostname: 'node-pty-host',
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

function tmpRegistry(now = () => new Date('2026-01-02T03:04:05.000Z')) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-link-pty-'));
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

describe('node link pty host (integration)', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  it('round-trips PTY data through hub.attachPty -> node-link client -> fake pty', async () => {
    const { tmpDir, registry } = tmpRegistry();
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: fakeManifest(),
    });

    const linkManager = createHubNodeLinkManager();
    const server = http.createServer(express());
    setupWebSocket(
      server,
      new Set(),
      null,
      undefined,
      false,
      undefined,
      registry,
      linkManager
    );
    const port = await listen(server);
    cleanup.push(() => close(server));

    let lastPty: FakePty | undefined;
    const ptyHost = createNodeLinkPtyHost({
      nodeId: exchanged.credential.nodeId,
      spawn: (_c, _a, options: IPtyForkOptions) => {
        lastPty = new FakePty(options.cols ?? 80, options.rows ?? 24);
        return lastPty as unknown as IPty;
      },
    });

    const client = createNodeLinkClient({
      hubUrl: `http://127.0.0.1:${port}`,
      credential: {
        nodeId: exchanged.credential.nodeId,
        token: exchanged.credential.token,
      },
      getManifest: () => fakeManifest(),
      heartbeatIntervalMs: 60_000,
      onPtyEnvelope: (envelope, ctx) => ptyHost.handle(envelope, ctx),
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
    // Wait briefly so hub registers the link before attach.
    for (let i = 0; i < 50; i++) {
      if (linkManager.hasActiveNode(exchanged.credential.nodeId)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(linkManager.hasActiveNode(exchanged.credential.nodeId)).toBe(true);

    const browserSent: string[] = [];
    type StubListener = (...args: unknown[]) => void;
    const stubListeners = new Map<string, StubListener[]>();
    const browserStub = {
      readyState: 1,
      OPEN: 1,
      send: (data: string) => {
        browserSent.push(data);
      },
      on: (event: string, listener: StubListener) => {
        const list = stubListeners.get(event) ?? [];
        list.push(listener);
        stubListeners.set(event, list);
      },
      once: (event: string, listener: StubListener) => {
        const wrapper: StubListener = (...args) => {
          const list = stubListeners.get(event) ?? [];
          stubListeners.set(
            event,
            list.filter((l) => l !== wrapper)
          );
          listener(...args);
        };
        const list = stubListeners.get(event) ?? [];
        list.push(wrapper);
        stubListeners.set(event, list);
      },
      close: () => {
        const list = stubListeners.get('close') ?? [];
        for (const handler of list.slice()) handler(1000, Buffer.from(''));
      },
    } as unknown as WebSocket;

    linkManager.attachPty(
      exchanged.credential.nodeId,
      'session-int',
      browserStub
    );

    // Wait for the node-side PTY to be spawned.
    for (let i = 0; i < 100; i++) {
      if (lastPty) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(lastPty).toBeDefined();

    // Simulate the PTY emitting output; expect the hub to forward to browser.
    lastPty!.emitData('node-says-hi');
    for (let i = 0; i < 100; i++) {
      if (browserSent.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(browserSent.length).toBeGreaterThan(0);
    expect(browserSent.join('')).toContain('node-says-hi');

    // Simulate browser typing -> input -> node PTY.
    const messageListeners = stubListeners.get('message') ?? [];
    for (const handler of messageListeners) handler('echo hi');
    for (let i = 0; i < 100; i++) {
      if (lastPty!.written.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(lastPty!.written.join('')).toContain('echo hi');
  });
});
