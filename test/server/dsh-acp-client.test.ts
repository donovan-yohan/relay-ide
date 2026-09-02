/**
 * Transport-level tests for the dsh ACP stdio client.
 *
 * Everything runs against a fake subprocess (`makeHarness`) — no dsh install,
 * no network. The wire shapes asserted here are transcribed from a real
 * `deepseek-harness-acp` 0.0.1 capture; see `test/fixtures/dsh/README.md`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { DshAcpClient } from '../../server/dsh-acp-client.js';
import { makeHarness } from './protocol-adapters/support/claude-child-double.js';

type Harness = ReturnType<typeof makeHarness>;

function makeClient(
  harness: Harness,
  overrides: Partial<{
    readinessTimeoutMs: number;
    requestTimeoutMs: number;
    promptTimeoutMs: number;
    stopTimeoutMs: number;
    maxRecordBytes: number;
  }> = {}
): DshAcpClient {
  return new DshAcpClient({
    command: 'dsh',
    args: ['--profile', 'acp'],
    cwd: '/repo',
    env: { PATH: '/usr/bin' },
    readinessTimeoutMs: 500,
    requestTimeoutMs: 500,
    stopTimeoutMs: 20,
    ...overrides,
    spawn: harness.spawnFn as unknown as (
      command: string,
      args: string[],
      options: { cwd?: string; env?: Record<string, string>; stdio: 'pipe' }
    ) => ChildProcess,
  });
}

const INITIALIZE = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
};

/** The real `initialize` result, transcribed from the capture. */
const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
  agentCapabilities: {
    mcpCapabilities: { http: true },
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    sessionCapabilities: { close: {}, list: {}, resume: {} },
  },
  authMethods: [],
};

async function completeStart(
  harness: Harness,
  client: DshAcpClient
): Promise<void> {
  const started = client.start(INITIALIZE);
  const frames = await harness.latest().child.waitForFrames(1);
  harness
    .latest()
    .child.serverWrite({
      jsonrpc: '2.0',
      id: frames[0]!.id,
      result: INITIALIZE_RESULT,
    });
  await started;
}

describe('DshAcpClient', () => {
  it('start spawns the ACP profile and resolves on the correlated initialize', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    const started = client.start(INITIALIZE);
    const frames = await harness.latest().child.waitForFrames(1);
    expect(harness.latest().command).toBe('dsh');
    expect(harness.latest().args).toEqual(['--profile', 'acp']);
    expect(harness.latest().options.cwd).toBe('/repo');
    expect(frames[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: INITIALIZE,
    });
    harness
      .latest()
      .child.serverWrite({ jsonrpc: '2.0', id: 1, result: INITIALIZE_RESULT });
    await expect(started).resolves.toMatchObject({
      agentInfo: { name: 'deepseek-harness-acp' },
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    });
    await client.stop();
  });

  it('correlates responses by id regardless of order', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await completeStart(harness, client);

    const first = client.request('session/new', {
      cwd: '/repo',
      mcpServers: [],
    });
    const second = client.request('session/list', {});
    await harness.latest().child.waitForFrames(3);
    harness
      .latest()
      .child.serverWrite({ jsonrpc: '2.0', id: 3, result: { sessions: [] } });
    harness
      .latest()
      .child.serverWrite({
        jsonrpc: '2.0',
        id: 2,
        result: { sessionId: 's-1' },
      });

    await expect(second).resolves.toEqual({ sessions: [] });
    await expect(first).resolves.toEqual({ sessionId: 's-1' });
    await client.stop();
  });

  it('routes session/update to notification listeners', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    client.on('notification', (n) => seen.push(n));
    await completeStart(harness, client);

    harness.latest().child.serverWrite({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm-1',
          content: { type: 'text', text: 'DSH_LIVE_OK' },
        },
      },
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.method).toBe('session/update');
    await client.stop();
  });

  it('routes a frame carrying BOTH id and method as a peer request, not a response', async () => {
    // The ACP server is the only stdio peer that sends Relay requests; treating
    // one as an uncorrelated response would leave its turn blocked forever.
    const harness = makeHarness();
    const client = makeClient(harness);
    const peers: Array<{ id: string | number; method: string }> = [];
    const protocolErrors: Error[] = [];
    client.on('peerRequest', (r) => peers.push(r));
    client.on('protocolError', (e: Error) => protocolErrors.push(e));
    await completeStart(harness, client);

    harness.latest().child.serverWrite({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { toolCallId: 'call_1' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    expect(peers[0]).toMatchObject({
      id: 77,
      method: 'session/request_permission',
    });
    expect(protocolErrors).toHaveLength(0);

    client.respond(77, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    const frames = await harness.latest().child.waitForFrames(2);
    expect(frames[1]).toEqual({
      jsonrpc: '2.0',
      id: 77,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
    await client.stop();
  });

  it('respondError answers a peer request this client cannot form an answer for', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await completeStart(harness, client);
    client.respondError(
      9,
      -32601,
      'Relay does not implement fs/read_text_file'
    );
    const frames = await harness.latest().child.waitForFrames(2);
    expect(frames[1]).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: {
        code: -32601,
        message: 'Relay does not implement fs/read_text_file',
      },
    });
    await client.stop();
  });

  it('notify writes a client notification with no id', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await completeStart(harness, client);
    client.notify('session/cancel', { sessionId: 's-1' });
    const frames = await harness.latest().child.waitForFrames(2);
    expect(frames[1]).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 's-1' },
    });
    await client.stop();
  });

  it('prompt has no timeout by default, so a long healthy turn is not cut short', async () => {
    const harness = makeHarness();
    const client = makeClient(harness, { requestTimeoutMs: 10 });
    await completeStart(harness, client);
    const pending = client.prompt({ sessionId: 's-1', prompt: [] });
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true)
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    harness
      .latest()
      .child.serverWrite({
        jsonrpc: '2.0',
        id: 2,
        result: { stopReason: 'end_turn' },
      });
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });
    await client.stop();
  });

  it('rejects a request on a JSON-RPC error object, including its data', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await completeStart(harness, client);

    const pending = client.request('session/resume', { sessionId: 'gone' });
    await harness.latest().child.waitForFrames(2);
    harness.latest().child.serverWrite({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: -32602,
        message: 'Invalid params',
        data: { detail: 'unknown session' },
      },
    });
    await expect(pending).rejects.toThrow(/Invalid params.*unknown session/s);
    await client.stop();
  });

  it('emits protocolError on a malformed line and keeps reading', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    const errors: Error[] = [];
    const seen: unknown[] = [];
    client.on('protocolError', (e: Error) => errors.push(e));
    client.on('notification', (n) => seen.push(n));
    await completeStart(harness, client);

    harness.latest().child.stdout.push('{not json\n');
    harness.latest().child.serverWrite({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: { sessionUpdate: 'usage_update', used: 1, size: 2 },
      },
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(errors[0]?.message).toContain('Invalid dsh ACP JSON');
    await client.stop();
  });

  it('emits protocolError on an oversized record without losing framing', async () => {
    const harness = makeHarness();
    // Above the real `initialize` result, which must still get through.
    const client = makeClient(harness, { maxRecordBytes: 1024 });
    const errors: Error[] = [];
    const seen: unknown[] = [];
    client.on('protocolError', (e: Error) => errors.push(e));
    client.on('notification', (n) => seen.push(n));
    await completeStart(harness, client);

    harness.latest().child.stdout.push(`${'x'.repeat(2000)}\n`);
    harness.latest().child.serverWrite({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: { sessionUpdate: 'usage_update', used: 1, size: 2 },
      },
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(errors.some((e) => e.message.includes('exceeded 1024 bytes'))).toBe(
      true
    );
    await client.stop();
  });

  it('stop ends stdin, then SIGTERM, then SIGKILL', async () => {
    const harness = makeHarness();
    harness.setNextChildOptions({ closeOnStdinEnd: false });
    const client = makeClient(harness, { stopTimeoutMs: 10 });
    await completeStart(harness, client);
    const child = harness.latest().child;
    await client.stop();
    expect(child.kill.mock.calls.map((call) => call[0])).toEqual([
      'SIGTERM',
      'SIGKILL',
    ]);
  });

  it('rejects pending requests on close with the exit code and stderr tail', async () => {
    const harness = makeHarness();
    harness.setNextChildOptions({ closeOnStdinEnd: false });
    const client = makeClient(harness);
    await completeStart(harness, client);

    harness.latest().child.emitStderr('dsh: plugin tree failed to load');
    const pending = client.prompt({ sessionId: 's-1', prompt: [] });
    await harness.latest().child.waitForFrames(2);
    await vi.waitFor(() =>
      expect(client.stderrTailText).toContain('plugin tree failed to load')
    );
    harness.latest().child.emitClose(1);

    await expect(pending).rejects.toThrow(
      /dsh ACP server exited \(code=1\).*plugin tree failed to load/s
    );
  });

  it('stops the child and rethrows when the readiness barrier fails', async () => {
    const harness = makeHarness();
    harness.setNextChildOptions({ closeOnStdinEnd: false });
    const client = makeClient(harness, { readinessTimeoutMs: 20 });
    await expect(client.start(INITIALIZE)).rejects.toThrow(
      'dsh ACP initialize timed out after 20ms'
    );
    expect(harness.latest().child.kill).toHaveBeenCalled();
  });

  it('refuses a second start on the same client', async () => {
    const harness = makeHarness();
    const client = makeClient(harness);
    await completeStart(harness, client);
    await expect(client.start(INITIALIZE)).rejects.toThrow(
      'DshAcpClient already started'
    );
    await client.stop();
  });
});
