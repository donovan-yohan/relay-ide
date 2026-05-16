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
import { createGlobalSessionId } from '../shared/identity.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type RelayNodeEnvelope,
} from '../shared/relay-node-protocol.js';
import { buildManifestWithAgents } from './helpers/manifest-fixtures.js';

const AGENTS = [
  { id: 'claude', label: 'Claude', status: 'available' as const },
  { id: 'codex', label: 'Codex', status: 'available' as const },
];
const STRESS_DURATION_MS = 2_050;
const STRESS_CHUNK_BYTES = 512;
const STRESS_TOTAL_BYTES = 10 * 1024;

type Cleanup = () => Promise<void> | void;

function manifest(hostname: string): NodeManifest {
  return buildManifestWithAgents({
    agents: AGENTS,
    overrides: {
      platform: 'linux',
      arch: 'x64',
      hostname,
      relayVersion: '0.1.0-smoke',
      capabilities: {
        tmux: { id: 'tmux', label: 'tmux', status: 'available', message: 'ok' },
        git: { id: 'git', label: 'Git', status: 'available', message: 'ok' },
        clipboard: {
          id: 'clipboard',
          label: 'Clipboard',
          status: 'unknown',
          message: 'not relevant to PTY smoke',
        },
        browserAutomation: {
          id: 'browserAutomation',
          label: 'Browser automation',
          status: 'degraded',
          message: 'not relevant to PTY smoke',
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
          message: 'not relevant to PTY smoke',
        },
        ssh: {
          id: 'ssh',
          label: 'SSH client',
          status: 'available',
          message: 'ok',
        },
        agents: Object.fromEntries(
          AGENTS.map((agent) => [
            agent.id,
            {
              id: agent.id,
              label: agent.label,
              status: agent.status,
              message: 'ok',
            },
          ])
        ),
      },
    },
  });
}

function remoteSession(input: {
  nodeId: string;
  hostname: string;
  sessionId: string;
}): SessionSummary {
  const repoPath = `/nodes/${input.hostname}/relay-ide`;
  return {
    id: input.sessionId,
    type: 'terminal',
    agent: 'claude',
    mode: 'pty',
    repoPath,
    worktreePath: null,
    cwd: repoPath,
    repoName: 'relay-ide',
    branchName: 'nightly',
    displayName: `${input.hostname} terminal`,
    createdAt: '2026-01-02T03:04:05.000Z',
    lastActivity: '2026-01-02T03:04:05.000Z',
    idle: false,
    customCommand: null,
    nodeId: input.nodeId,
    globalSessionId: createGlobalSessionId(input.nodeId, input.sessionId),
    repoInstanceId: `${encodeURIComponent(input.nodeId)}:${encodeURIComponent(repoPath)}`,
    useTmux: true,
    tmuxSessionName: `relay-ide-${input.sessionId}`,
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const cleanupListeners = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error: Error) => {
      cleanupListeners();
      reject(error);
    };
    const onListening = () => {
      cleanupListeners();
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
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

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  if (ws.readyState === WebSocket.CLOSED) return { code: 1005, reason: '' };
  return await new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function sendNodeEnvelope(
  ws: WebSocket,
  nodeId: string,
  type: string,
  channel: RelayNodeEnvelope['channel'],
  extras: Partial<RelayNodeEnvelope> = {}
): void {
  ws.send(
    JSON.stringify({
      protocol: RELAY_NODE_LINK_PROTOCOL,
      protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
      nodeId,
      channel,
      type,
      timestamp: new Date().toISOString(),
      ...extras,
    })
  );
}

class SimulatedNode {
  readonly messages: RelayNodeEnvelope[] = [];
  private readonly consumedMessageIndexes = new Set<number>();
  private readonly waiters: Array<{
    label: string;
    predicate: (message: RelayNodeEnvelope) => boolean;
    resolve: (message: RelayNodeEnvelope) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    readonly nodeId: string,
    readonly token: string,
    readonly hostname: string,
    readonly ws: WebSocket
  ) {
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as RelayNodeEnvelope;
      this.messages.push(message);
      const messageIndex = this.messages.length - 1;
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        this.consumedMessageIndexes.add(messageIndex);
        this.removeWaiter(waiter);
        waiter.resolve(message);
        break;
      }
    });
    ws.on('close', () => this.rejectWaiters(`${this.hostname} node link closed`));
    ws.on('error', (error) =>
      this.rejectWaiters(`${this.hostname} node link error: ${error.message}`)
    );
  }

  waitFor(
    predicate: (message: RelayNodeEnvelope) => boolean,
    label: string,
    timeoutMs = 2_000
  ): Promise<RelayNodeEnvelope> {
    const existingIndex = this.messages.findIndex(
      (message, index) => !this.consumedMessageIndexes.has(index) && predicate(message)
    );
    if (existingIndex >= 0) {
      this.consumedMessageIndexes.add(existingIndex);
      return Promise.resolve(this.messages[existingIndex]!);
    }
    return new Promise<RelayNodeEnvelope>((resolve, reject) => {
      const waiter = {
        label,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  hello(): Promise<RelayNodeEnvelope> {
    sendNodeEnvelope(this.ws, this.nodeId, 'control.hello', 'control', {
      payload: { manifest: manifest(this.hostname) },
    });
    return this.waitFor(
      (message) => message.type === 'control.hello.result',
      `${this.hostname} control.hello.result`
    );
  }

  answerCreate(request: RelayNodeEnvelope, sessionId: string): void {
    sendNodeEnvelope(this.ws, this.nodeId, 'sessions.create.result', 'rpc', {
      requestId: request.requestId,
      payload: {
        session: {
          ...remoteSession({ nodeId: this.nodeId, hostname: this.hostname, sessionId }),
          // Deliberately spoof these; the hub must own routing identity.
          nodeId: 'spoofed-by-node',
          globalSessionId: 'spoofed-by-node:session',
        },
      },
    });
  }

  sendPtyData(streamId: string, data: string): void {
    sendNodeEnvelope(this.ws, this.nodeId, 'pty.data', 'pty', {
      streamId,
      payload: { data },
    });
  }

  close(): void {
    this.ws.close();
  }

  private removeWaiter(waiter: (typeof this.waiters)[number]): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
  }

  private rejectWaiters(reason: string): void {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(new Error(`stopped waiting for ${waiter.label}: ${reason}`));
    }
  }
}

class BrowserClient {
  readonly messages: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  private readonly waiters: Array<{
    label: string;
    predicate: (message: string) => boolean;
    resolve: (message: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = data.toString();
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        this.removeWaiter(waiter);
        waiter.resolve(message);
        break;
      }
    });
    ws.on('close', (code, reason) => {
      this.closes.push({ code, reason: reason.toString() });
      this.rejectWaiters(
        `browser socket closed (${code}${reason.length ? ` ${reason.toString()}` : ''})`
      );
    });
    ws.on('error', (error) =>
      this.rejectWaiters(`browser socket error: ${error.message}`)
    );
  }

  waitFor(
    predicate: (message: string) => boolean,
    label: string,
    timeoutMs = 2_000
  ): Promise<string> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<string>((resolve, reject) => {
      const waiter = {
        label,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error(`timed out waiting for browser message ${label}`));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  waitForBytes(
    predicate: (message: string) => boolean,
    expectedBytes: number,
    label: string,
    timeoutMs = 4_000
  ): Promise<number> {
    const receivedBytes = () => this.countBytes(predicate);
    const existingBytes = receivedBytes();
    if (existingBytes >= expectedBytes) return Promise.resolve(existingBytes);

    return new Promise<number>((resolve, reject) => {
      const waiter = {
        label,
        predicate: () => {
          const bytes = receivedBytes();
          if (bytes < expectedBytes) return false;
          resolve(bytes);
          return true;
        },
        resolve: () => {},
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(
            new Error(
              `timed out waiting for ${expectedBytes} browser bytes for ${label}; received ${receivedBytes()}`
            )
          );
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }

  private removeWaiter(waiter: (typeof this.waiters)[number]): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
  }

  private countBytes(predicate: (message: string) => boolean): number {
    return this.messages.reduce(
      (total, message) =>
        predicate(message) ? total + Buffer.byteLength(message) : total,
      0
    );
  }

  private rejectWaiters(reason: string): void {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(new Error(`stopped waiting for ${waiter.label}: ${reason}`));
    }
  }
}

async function startHub() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cross-node-pty-'));
  const registry = createHubNodeRegistry({
    storagePath: path.join(tmpDir, 'hub', 'nodes.json'),
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
    new Set(),
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
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
  };
}

async function pairAndConnectNode(input: {
  base: string;
  wsBase: string;
  hostname: string;
}): Promise<SimulatedNode> {
  const pairRes = await fetch(`${input.base}/hub/pair-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
    body: JSON.stringify({ displayName: input.hostname }),
  });
  expect(pairRes.status, `pair-token creation failed for ${input.hostname}`).toBe(201);
  const pair = (await pairRes.json()) as { pairToken: string };

  const exchangeRes = await fetch(`${input.base}/hub/pairing/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairToken: pair.pairToken, manifest: manifest(input.hostname) }),
  });
  expect(exchangeRes.status, `pair exchange failed for ${input.hostname}`).toBe(201);
  const exchange = (await exchangeRes.json()) as {
    credential: { token: string; nodeId: string };
  };
  const ws = new WebSocket(`${input.wsBase}/hub/node-link`, {
    headers: { authorization: `Bearer ${exchange.credential.token}` },
  });
  await waitForOpen(ws);
  return new SimulatedNode(
    exchange.credential.nodeId,
    exchange.credential.token,
    input.hostname,
    ws
  );
}

async function createRemoteSession(input: {
  base: string;
  node: SimulatedNode;
  sessionId: string;
}): Promise<SessionSummary> {
  const createController = new AbortController();
  const createPromise = fetch(
    `${input.base}/hub/nodes/${encodeURIComponent(input.node.nodeId)}/sessions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
      signal: createController.signal,
      body: JSON.stringify({
        repoPath: `/nodes/${input.node.hostname}/relay-ide`,
        type: 'terminal',
      }),
    }
  );
  let createRequest: RelayNodeEnvelope;
  try {
    createRequest = await input.node.waitFor(
      (message) => message.channel === 'rpc' && message.type === 'sessions.create',
      `${input.node.hostname} sessions.create`
    );
  } catch (error) {
    createController.abort();
    await createPromise.catch(() => undefined);
    throw error;
  }
  input.node.answerCreate(createRequest, input.sessionId);
  const createRes = await createPromise;
  expect(createRes.status, `${input.node.hostname} session create failed`).toBe(201);
  return (await createRes.json()) as SessionSummary;
}

async function attachBrowser(input: {
  wsBase: string;
  node: SimulatedNode;
  sessionId: string;
}): Promise<{ browser: BrowserClient; attach: RelayNodeEnvelope }> {
  const browserWs = new WebSocket(
    `${input.wsBase}/nodes/${encodeURIComponent(input.node.nodeId)}/ws/sessions/${encodeURIComponent(input.sessionId)}`
  );
  await waitForOpen(browserWs);
  const browser = new BrowserClient(browserWs);
  const attach = await input.node.waitFor(
    (message) => message.channel === 'pty' && message.type === 'pty.attach',
    `${input.node.hostname} pty.attach`
  );
  expect(attach).toMatchObject({
    nodeId: input.node.nodeId,
    payload: { sessionId: input.sessionId },
  });
  expect(attach.streamId).toBeTruthy();
  return { browser, attach };
}

async function runSustainedEcho(input: {
  node: SimulatedNode;
  browser: BrowserClient;
  streamId: string;
  marker: string;
}): Promise<{
  bytesFromBrowser: number;
  bytesObservedByNode: number;
  bytesToBrowser: number;
}> {
  let bytesFromBrowser = 0;
  let bytesObservedByNode = 0;
  const deadline = Date.now() + STRESS_DURATION_MS;
  const inputPump = (async () => {
    while (Date.now() < deadline || bytesFromBrowser < STRESS_TOTAL_BYTES) {
      const sequence = Math.floor(bytesFromBrowser / STRESS_CHUNK_BYTES);
      const prefix = `${input.marker}:${sequence}:`;
      const data = prefix.padEnd(STRESS_CHUNK_BYTES, input.marker[0]);
      input.browser.send(data);
      bytesFromBrowser += Buffer.byteLength(data);
      await delay(100);
    }
  })();

  while (bytesObservedByNode < STRESS_TOTAL_BYTES) {
    const ptyInput = await input.node.waitFor(
      (message) =>
        message.channel === 'pty' &&
        message.type === 'pty.input' &&
        message.streamId === input.streamId,
      `${input.node.hostname} stress pty.input`,
      4_000
    );
    const data = (ptyInput.payload as { data?: unknown } | undefined)?.data;
    expect(typeof data).toBe('string');
    expect(data as string).toContain(input.marker);
    bytesObservedByNode += Buffer.byteLength(data as string);
    input.node.sendPtyData(input.streamId, data as string);
  }
  const bytesToBrowser = await input.browser.waitForBytes(
    (message) => message.includes(input.marker),
    STRESS_TOTAL_BYTES,
    `${input.marker} echoed browser bytes`,
    4_000
  );
  await inputPump;
  return { bytesFromBrowser, bytesObservedByNode, bytesToBrowser };
}

describe('hub cross-node PTY smoke harness', () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  it('routes concurrent two-node PTY streams without cross-talk and isolates one node link failure', async () => {
    const hub = await startHub();
    cleanup.push(() => fs.rmSync(hub.tmpDir, { recursive: true, force: true }));
    cleanup.push(() => closeServer(hub.server));

    const [nodeA, nodeB] = await Promise.all([
      pairAndConnectNode({ base: hub.base, wsBase: hub.wsBase, hostname: 'smoke-node-a' }),
      pairAndConnectNode({ base: hub.base, wsBase: hub.wsBase, hostname: 'smoke-node-b' }),
    ]);
    cleanup.push(() => nodeA.close());
    cleanup.push(() => nodeB.close());

    await Promise.all([nodeA.hello(), nodeB.hello()]);

    const [sessionA, sessionB] = await Promise.all([
      createRemoteSession({ base: hub.base, node: nodeA, sessionId: 'terminal-a' }),
      createRemoteSession({ base: hub.base, node: nodeB, sessionId: 'terminal-b' }),
    ]);
    expect(sessionA).toMatchObject({
      id: 'terminal-a',
      nodeId: nodeA.nodeId,
      globalSessionId: createGlobalSessionId(nodeA.nodeId, 'terminal-a'),
    });
    expect(sessionB).toMatchObject({
      id: 'terminal-b',
      nodeId: nodeB.nodeId,
      globalSessionId: createGlobalSessionId(nodeB.nodeId, 'terminal-b'),
    });

    const [{ browser: browserA, attach: attachA }, { browser: browserB, attach: attachB }] =
      await Promise.all([
        attachBrowser({ wsBase: hub.wsBase, node: nodeA, sessionId: 'terminal-a' }),
        attachBrowser({ wsBase: hub.wsBase, node: nodeB, sessionId: 'terminal-b' }),
      ]);
    cleanup.push(() => browserA.close());
    cleanup.push(() => browserB.close());

    const markerA = 'node-a-marker';
    const markerB = 'node-b-marker';
    const firstA = browserA.waitFor(
      (message) => message.includes(markerA),
      'node A marker'
    );
    const firstB = browserB.waitFor(
      (message) => message.includes(markerB),
      'node B marker'
    );
    nodeA.sendPtyData(attachA.streamId!, `${markerA}:hello-browser-a`);
    nodeB.sendPtyData(attachB.streamId!, `${markerB}:hello-browser-b`);
    await expect(firstA).resolves.toContain(markerA);
    await expect(firstB).resolves.toContain(markerB);
    expect(browserA.messages.join('\n')).not.toContain(markerB);
    expect(browserB.messages.join('\n')).not.toContain(markerA);

    const [stressA, stressB] = await Promise.all([
      runSustainedEcho({
        node: nodeA,
        browser: browserA,
        streamId: attachA.streamId!,
        marker: 'AAAA',
      }),
      runSustainedEcho({
        node: nodeB,
        browser: browserB,
        streamId: attachB.streamId!,
        marker: 'BBBB',
      }),
    ]);
    expect(stressA.bytesFromBrowser).toBeGreaterThanOrEqual(STRESS_TOTAL_BYTES);
    expect(stressA.bytesObservedByNode).toBeGreaterThanOrEqual(STRESS_TOTAL_BYTES);
    expect(stressA.bytesToBrowser).toBeGreaterThanOrEqual(STRESS_TOTAL_BYTES);
    expect(stressB.bytesFromBrowser).toBeGreaterThanOrEqual(STRESS_TOTAL_BYTES);
    expect(stressB.bytesObservedByNode).toBeGreaterThanOrEqual(STRESS_TOTAL_BYTES);
    expect(stressB.bytesToBrowser).toBeGreaterThanOrEqual(STRESS_TOTAL_BYTES);
    expect(browserA.messages.join('')).not.toContain('BBBB');
    expect(browserB.messages.join('')).not.toContain('AAAA');

    const browserBClose = waitForClose(browserB.ws);
    nodeB.close();
    await expect(browserBClose).resolves.toMatchObject({
      code: 1011,
      reason: 'node link closed',
    });

    const nodeASurvives = browserA.waitFor(
      (message) => message.includes('node-a-after-b-disconnect'),
      'node A survives node B disconnect'
    );
    nodeA.sendPtyData(attachA.streamId!, 'node-a-after-b-disconnect');
    await expect(nodeASurvives).resolves.toBe('node-a-after-b-disconnect');
    expect(nodeA.ws.readyState).toBe(WebSocket.OPEN);
  });
});
