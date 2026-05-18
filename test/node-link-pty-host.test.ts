import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeLinkManager } from '../server/hub-node-link.js';
import { setupWebSocket } from '../server/ws.js';
import { createNodeLinkClient } from '../server/node-link-client.js';
import { createNodeLinkPtyHost } from '../server/node-link-pty-host.js';
import {
  createMockAttachmentFactory,
  type MockAttachmentFactory,
} from '../server/session-attachment.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type RelayNodeEnvelope,
} from '../shared/relay-node-protocol.js';

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

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor<T>(
  probe: () => T | undefined,
  attempts = 100
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

function fakeLivePtySession(id = 'session-a') {
  const dataHandlers: Array<(data: string) => void> = [];
  const exitHandlers: Array<
    (event: { exitCode: number | null; signal?: number }) => void
  > = [];
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const pty = {
    pid: 123,
    process: 'codex',
    handleFlowControl: false,
    onData(handler: (data: string) => void) {
      dataHandlers.push(handler);
      return {
        dispose: () => {
          const index = dataHandlers.indexOf(handler);
          if (index >= 0) dataHandlers.splice(index, 1);
        },
      };
    },
    onExit(
      handler: (event: { exitCode: number | null; signal?: number }) => void
    ) {
      exitHandlers.push(handler);
      return {
        dispose: () => {
          const index = exitHandlers.indexOf(handler);
          if (index >= 0) exitHandlers.splice(index, 1);
        },
      };
    },
    write(data: string) {
      writes.push(data);
    },
    resize(cols: number, rows: number) {
      resizes.push({ cols, rows });
    },
    clear() {},
    pause() {},
    resume() {},
    kill() {},
    emit(data: string) {
      for (const handler of dataHandlers.slice()) handler(data);
    },
    exit(exitCode = 0) {
      for (const handler of exitHandlers.slice()) handler({ exitCode });
    },
  };
  return {
    session: {
      id,
      mode: 'pty',
      pty,
      scrollback: ['selected runtime: codex\n'],
    },
    pty,
    writes,
    resizes,
  };
}

describe('node link pty host (unit)', () => {
  it('opens attachment on pty.attach, forwards data, closes on detach', async () => {
    const sent: RelayNodeEnvelope[] = [];
    const factory: MockAttachmentFactory = createMockAttachmentFactory();
    const inputRecords: Array<{ sessionId: string; data: string }> = [];
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      attachmentFactory: factory,
      inputRecorder: (input) => inputRecords.push(input),
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
    await waitFor(() => factory.attachments[0]);
    expect(factory.attachments[0]!.sessionId).toBe('session-a');

    factory.emit('hello');
    await flush();
    expect(sent.map((e) => e.type)).toContain('pty.data');
    const data = sent.find((e) => e.type === 'pty.data');
    expect((data!.payload as { data: string }).data).toBe('hello');

    host.handle(
      build('pty', 'pty.input', {
        streamId: 's1',
        payload: { data: 'ls\n' },
      }),
      ctx
    );
    expect(factory.records[0]!.written.map((b) => b.toString('utf8'))).toEqual([
      'ls\n',
    ]);
    expect(inputRecords).toEqual([{ sessionId: 'session-a', data: 'ls\n' }]);

    host.handle(
      build('pty', 'pty.resize', {
        streamId: 's1',
        payload: { cols: 120, rows: 40 },
      }),
      ctx
    );
    expect(factory.records[0]!.resizes).toContainEqual({ cols: 120, rows: 40 });

    host.handle(build('pty', 'pty.detach', { streamId: 's1' }), ctx);
    await flush();
    expect(factory.records[0]!.closed).toBe(true);
    const exit = sent.find((e) => e.type === 'pty.exit');
    expect(exit).toBeDefined();
  });

  it('attaches routed streams to an existing node-local PTY session instead of spawning a shell fallback', async () => {
    const sent: RelayNodeEnvelope[] = [];
    const factory: MockAttachmentFactory = createMockAttachmentFactory();
    const live = fakeLivePtySession('native-codex-session');
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      attachmentFactory: factory,
      defaultShell: '/bin/zsh',
      localRelayNode: {
        sessions: { get: () => live.session },
      } as never,
    });
    const build = envelopeBuilder('node-1');
    const ctx = {
      send: (env: RelayNodeEnvelope) => sent.push(env),
      buildEnvelope: build,
    };

    host.handle(
      build('pty', 'pty.attach', {
        streamId: 's1',
        payload: { sessionId: 'native-codex-session', cols: 100, rows: 30 },
      }),
      ctx
    );

    const data = await waitFor(() => sent.find((e) => e.type === 'pty.data'));
    expect(factory.attachments).toHaveLength(0);
    expect((data.payload as { data: string }).data).toBe(
      'selected runtime: codex\n'
    );

    live.pty.emit('codex live output\n');
    await flush();
    expect(
      sent
        .filter((e) => e.type === 'pty.data')
        .map((e) => (e.payload as { data: string }).data)
    ).toContain('codex live output\n');

    host.handle(
      build('pty', 'pty.input', {
        streamId: 's1',
        payload: { data: 'hello codex\n' },
      }),
      ctx
    );
    expect(live.writes).toEqual(['hello codex\n']);
  });

  it('emits pty.exit when the underlying attachment exits', async () => {
    const sent: RelayNodeEnvelope[] = [];
    const factory = createMockAttachmentFactory();
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      attachmentFactory: factory,
    });
    const build = envelopeBuilder('node-1');
    host.handle(build('pty', 'pty.attach', { streamId: 's1', payload: {} }), {
      send: (e) => sent.push(e),
      buildEnvelope: build,
    });
    await waitFor(() => factory.attachments[0]);
    factory.exit({ exitCode: 0 });
    await flush();
    const exit = sent.find((e) => e.type === 'pty.exit');
    expect(exit).toBeDefined();
    expect((exit!.payload as { exitCode: number }).exitCode).toBe(0);
  });

  it('emits pty.error when factory.open throws', async () => {
    const sent: RelayNodeEnvelope[] = [];
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      attachmentFactory: {
        mode: 'raw',
        async open() {
          throw new Error('boom');
        },
      },
    });
    const build = envelopeBuilder('node-1');
    host.handle(build('pty', 'pty.attach', { streamId: 's1', payload: {} }), {
      send: (e) => sent.push(e),
      buildEnvelope: build,
    });
    await flush();
    const err = sent.find((e) => e.type === 'pty.error');
    expect(err).toBeDefined();
    expect(err!.error?.code).toBe('INTERNAL');
  });

  it('rejects duplicate attach for the same streamId', async () => {
    const sent: RelayNodeEnvelope[] = [];
    const factory = createMockAttachmentFactory();
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      attachmentFactory: factory,
    });
    const build = envelopeBuilder('node-1');
    const ctx = {
      send: (e: RelayNodeEnvelope) => sent.push(e),
      buildEnvelope: build,
    };
    host.handle(
      build('pty', 'pty.attach', { streamId: 's1', payload: {} }),
      ctx
    );
    host.handle(
      build('pty', 'pty.attach', { streamId: 's1', payload: {} }),
      ctx
    );
    await flush();
    expect(factory.attachments).toHaveLength(1);
    const err = sent.find((e) => e.type === 'pty.error');
    expect(err).toBeDefined();
  });

  it('selects tmux factory when sessionResume = tmux', () => {
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      sessionResume: 'tmux',
    });
    expect(host.mode).toBe('tmux');
  });

  it('falls back to raw factory when sessionResume = none', () => {
    const host = createNodeLinkPtyHost({
      nodeId: 'node-1',
      sessionResume: 'none',
    });
    expect(host.mode).toBe('raw');
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
      ssh: {
        id: 'ssh',
        label: 'SSH client',
        status: 'available',
        message: 'ok',
      },
      sessionResume: 'tmux',
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

  it('round-trips PTY data through hub.attachPty -> node-link client -> mock attachment', async () => {
    const { tmpDir, registry } = tmpRegistry();
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const exchanged = registry.exchangePairToken({
      pairToken: registry.createPairToken({}).pairToken,
      manifest: fakeManifest(),
    });

    const remoteInputRecords: Array<{ nodeId: string; sessionId: string; data: string }> = [];
    const linkManager = createHubNodeLinkManager({
      ptyInputRecorder: (input) => remoteInputRecords.push(input),
    });
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

    const factory = createMockAttachmentFactory();
    const ptyHost = createNodeLinkPtyHost({
      nodeId: exchanged.credential.nodeId,
      attachmentFactory: factory,
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

    for (let i = 0; i < 100; i++) {
      if (factory.attachments[0]) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(factory.attachments[0]).toBeDefined();

    factory.emit('node-says-hi');
    for (let i = 0; i < 100; i++) {
      if (browserSent.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(browserSent.length).toBeGreaterThan(0);
    expect(browserSent.join('')).toContain('node-says-hi');

    const messageListeners = stubListeners.get('message') ?? [];
    for (const handler of messageListeners) handler('echo hi');
    for (let i = 0; i < 100; i++) {
      if (factory.records[0]!.written.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(
      factory.records[0]!.written.map((b) => b.toString('utf8')).join('')
    ).toContain('echo hi');
    expect(remoteInputRecords).toEqual([
      { nodeId: exchanged.credential.nodeId, sessionId: 'session-int', data: 'echo hi' },
    ]);
  });
});
