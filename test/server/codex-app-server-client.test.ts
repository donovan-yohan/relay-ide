/**
 * Unit tests for CodexAppServerClient.
 *
 * All tests use a mock child process (Readable/Writable pair + kill()) injected
 * via the `spawn` option. No real `codex` binary is invoked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  CodexAppServerClient,
  type CodexNotification,
  type CodexServerRequest,
  type CodexAppServerClientOptions,
} from '../../server/codex-app-server-client.js';
import { CHANNEL_ADAPTER_LAUNCH_CONTRACTS } from '../../server/protocol-adapters/index.js';

// ── Mock child process ────────────────────────────────────────────────────────

/**
 * A fake ChildProcess with:
 *   - controllable stdout (server→client)
 *   - readable stdin (client→server, buffered line-by-line)
 *   - kill() that emits 'close' automatically, like a real process would
 */
interface MockChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  /** Send a JSON message from the server to the client. */
  serverWrite(obj: unknown): void;
  /** Read all complete lines sent by the client so far. */
  readStdinLines(): string[];
  /** Wait until at least `count` lines have been written to stdin. */
  waitForStdinLines(count: number, timeoutMs?: number): Promise<string[]>;
  /** Simulate the process exiting unexpectedly. */
  exit(code: number | null): void;
}

function makeMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;

  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const stdinLines: string[] = [];
  const lineWaiters: Array<{
    count: number;
    resolve: (lines: string[]) => void;
  }> = [];

  child.stdin.on('data', (chunk: Buffer) => {
    const raw = chunk.toString();
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t) {
        stdinLines.push(t);
        // Notify waiters
        for (let i = lineWaiters.length - 1; i >= 0; i--) {
          const w = lineWaiters[i]!;
          if (stdinLines.length >= w.count) {
            lineWaiters.splice(i, 1);
            w.resolve([...stdinLines]);
          }
        }
      }
    }
  });

  child.kill = vi.fn((_signal?: string) => {
    // Simulate process exiting when killed
    setImmediate(() => {
      child.emit('close', 0);
      child.stdout.push(null);
    });
    return true;
  });

  child.serverWrite = (obj: unknown) => {
    child.stdout.push(JSON.stringify(obj) + '\n');
  };

  child.readStdinLines = () => [...stdinLines];

  child.waitForStdinLines = (
    count: number,
    timeoutMs = 2000
  ): Promise<string[]> => {
    if (stdinLines.length >= count) return Promise.resolve([...stdinLines]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timeout: waited for ${count} stdin line(s), got ${stdinLines.length}`
          )
        );
      }, timeoutMs);
      lineWaiters.push({
        count,
        resolve: (lines) => {
          clearTimeout(timer);
          resolve(lines);
        },
      });
    });
  };

  child.exit = (code: number | null) => {
    child.emit('close', code);
    child.stdout.push(null);
  };

  return child;
}

// ── Client factory ────────────────────────────────────────────────────────────

const DEFAULT_CLIENT_INFO = {
  name: 'relay-ide',
  title: 'Relay IDE',
  version: '0.0.1',
};

function makeClient(
  mockChild: MockChild,
  extra?: Partial<CodexAppServerClientOptions>
): CodexAppServerClient {
  return new CodexAppServerClient({
    clientInfo: DEFAULT_CLIENT_INFO,
    spawn: vi.fn().mockReturnValue(mockChild as unknown as ChildProcess),
    ...extra,
  });
}

/** Build a minimal server-side `initialize` response. */
function makeInitResponse(
  id: number | string,
  overrides?: Record<string, unknown>
) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      userAgent: 'codex/0.1.0',
      codexHome: '/home/user/.codex',
      platform: 'darwin',
      ...overrides,
    },
  };
}

/**
 * Complete the initialize handshake:
 *   1. Wait for the client to write the `initialize` request
 *   2. Reply with an initialize result
 *   3. Return the resolved start() value and the parsed request
 */
async function performHandshake(
  client: CodexAppServerClient,
  mock: MockChild,
  initResultOverrides?: Record<string, unknown>
) {
  const startPromise = client.start();

  // Wait for initialize to appear on stdin
  const lines = await mock.waitForStdinLines(1);
  const initLine = lines[0]!;
  const req = JSON.parse(initLine) as Record<string, unknown>;

  // Reply from server
  mock.serverWrite(makeInitResponse(req['id'] as number, initResultOverrides));

  const startResult = await startPromise;
  return { startResult, initRequest: req };
}

/** Drain a tick of the event loop. */
function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CodexAppServerClient', () => {
  let mock: MockChild;
  let client: CodexAppServerClient;

  beforeEach(() => {
    mock = makeMockChild();
    client = makeClient(mock);
  });

  afterEach(async () => {
    // Best-effort cleanup — stop() will kill the mock child which auto-emits close
    await client.stop().catch(() => undefined);
  });

  // ── Initialize handshake ──────────────────────────────────────────────────

  describe('initialize handshake', () => {
    it('spawns Codex with detailed provider reasoning summaries by default', async () => {
      const spawn = vi.fn().mockReturnValue(mock as unknown as ChildProcess);
      client = new CodexAppServerClient({
        clientInfo: DEFAULT_CLIENT_INFO,
        spawn,
      });

      const startPromise = client.start();
      const launchRequirement =
        CHANNEL_ADAPTER_LAUNCH_CONTRACTS.codex.requirement;
      expect(launchRequirement.kind).toBe('command');
      if (launchRequirement.kind !== 'command') {
        throw new Error('Codex must remain a command-backed channel adapter');
      }
      expect(spawn).toHaveBeenCalledWith(
        launchRequirement.command,
        [
          'app-server',
          '--listen',
          'stdio://',
          '-c',
          'model_reasoning_summary="detailed"',
        ],
        expect.objectContaining({ stdio: 'pipe' })
      );

      const lines = await mock.waitForStdinLines(1);
      const request = JSON.parse(lines[0]!) as Record<string, unknown>;
      mock.serverWrite(makeInitResponse(request['id'] as number));
      await startPromise;
    });

    it('preserves explicitly configured app-server args', async () => {
      const spawn = vi.fn().mockReturnValue(mock as unknown as ChildProcess);
      const args = ['app-server', '--listen', 'stdio://', '--experimental'];
      client = new CodexAppServerClient({
        clientInfo: DEFAULT_CLIENT_INFO,
        spawn,
        args,
      });

      const startPromise = client.start();
      expect(spawn).toHaveBeenCalledWith(
        'codex',
        args,
        expect.objectContaining({ stdio: 'pipe' })
      );

      const lines = await mock.waitForStdinLines(1);
      const request = JSON.parse(lines[0]!) as Record<string, unknown>;
      mock.serverWrite(makeInitResponse(request['id'] as number));
      await startPromise;
    });

    it('sends initialize with clientInfo and resolves with server metadata', async () => {
      const startPromise = client.start();

      const lines = await mock.waitForStdinLines(1);
      const req = JSON.parse(lines[0]!) as Record<string, unknown>;

      expect(req['jsonrpc']).toBe('2.0');
      expect(req['method']).toBe('initialize');
      expect(typeof req['id']).toBe('number');
      expect(req['params']).toMatchObject({ clientInfo: DEFAULT_CLIENT_INFO });

      mock.serverWrite(
        makeInitResponse(req['id'] as number, {
          userAgent: 'codex/1.2.3',
          codexHome: '/codex-home',
          platform: 'linux',
        })
      );

      const result = await startPromise;
      expect(result.userAgent).toBe('codex/1.2.3');
      expect(result.codexHome).toBe('/codex-home');
      expect(result.platform).toBe('linux');
    });

    it('sends the initialized notification after the initialize response', async () => {
      await performHandshake(client, mock);

      // After handshake: initialize (1 line) + initialized notification (2nd line)
      const lines = await mock.waitForStdinLines(2);
      const messages = lines.map(
        (l) => JSON.parse(l) as Record<string, unknown>
      );

      const notification = messages.find((m) => m['method'] === 'initialized');
      expect(notification).toBeDefined();
      expect(notification!['id']).toBeUndefined();
      expect(notification!['jsonrpc']).toBe('2.0');
    });

    it('includes jsonrpc "2.0" on the initialize request', async () => {
      const startPromise = client.start();
      const lines = await mock.waitForStdinLines(1);
      const req = JSON.parse(lines[0]!) as Record<string, unknown>;

      expect(req['jsonrpc']).toBe('2.0');

      mock.serverWrite(makeInitResponse(req['id'] as number));
      await startPromise;
    });

    it('throws if start() is called twice', async () => {
      const startPromise = client.start();
      await expect(client.start()).rejects.toThrow('already started');

      // Finish the first start
      const lines = await mock.waitForStdinLines(1);
      const req = JSON.parse(lines[0]!) as Record<string, unknown>;
      mock.serverWrite(makeInitResponse(req['id'] as number));
      await startPromise;
    });
  });

  // ── call() round-trip ────────────────────────────────────────────────────

  describe('call()', () => {
    it('sends a request and resolves with the result', async () => {
      await performHandshake(client, mock);

      const callPromise = client.call<{ threadId: string }>('thread/start', {
        prompt: 'hello',
      });

      // Line 1 = initialize, line 2 = initialized, line 3 = thread/start
      const lines = await mock.waitForStdinLines(3);
      const req = JSON.parse(lines[2]!) as Record<string, unknown>;

      expect(req['jsonrpc']).toBe('2.0');
      expect(req['method']).toBe('thread/start');
      expect(req['params']).toMatchObject({ prompt: 'hello' });

      mock.serverWrite({
        jsonrpc: '2.0',
        id: req['id'],
        result: { threadId: 'thread-abc' },
      });

      const result = await callPromise;
      expect(result.threadId).toBe('thread-abc');
    });

    it('rejects when server returns a JSON-RPC error', async () => {
      await performHandshake(client, mock);

      const callPromise = client.call('thread/start');

      const lines = await mock.waitForStdinLines(3);
      const req = JSON.parse(lines[2]!) as Record<string, unknown>;

      mock.serverWrite({
        jsonrpc: '2.0',
        id: req['id'],
        error: { code: -32000, message: 'session not found' },
      });

      await expect(callPromise).rejects.toThrow('session not found');
    });

    it('assigns monotonically increasing numeric ids', async () => {
      await performHandshake(client, mock);

      // Fire three calls concurrently
      const p1 = client.call('model/list');
      const p2 = client.call('skills/list');
      const p3 = client.call('account/rateLimits/read');

      // wait for lines: initialize(1) + initialized(2) + 3 calls = 5
      const lines = await mock.waitForStdinLines(5);
      const callLines = lines
        .slice(2)
        .map((l) => JSON.parse(l) as Record<string, unknown>);

      const ids = callLines.map((m) => m['id'] as number);
      expect(ids[0]).toBeLessThan(ids[1]!);
      expect(ids[1]).toBeLessThan(ids[2]!);

      // Reply to all so promises settle
      for (const msg of callLines) {
        mock.serverWrite({ jsonrpc: '2.0', id: msg['id'], result: {} });
      }
      await Promise.all([p1, p2, p3]);
    });

    it('routes concurrent responses to the correct promise', async () => {
      await performHandshake(client, mock);

      const p1 = client.call<{ value: string }>('model/list');
      const p2 = client.call<{ value: string }>('skills/list');

      const lines = await mock.waitForStdinLines(4); // init + initialized + 2 calls
      const [msg1, msg2] = lines
        .slice(2)
        .map((l) => JSON.parse(l) as Record<string, unknown>);

      // Reply out of order
      mock.serverWrite({
        jsonrpc: '2.0',
        id: msg2!['id'],
        result: { value: 'skills' },
      });
      mock.serverWrite({
        jsonrpc: '2.0',
        id: msg1!['id'],
        result: { value: 'models' },
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.value).toBe('models');
      expect(r2.value).toBe('skills');
    });
  });

  // ── Notifications ────────────────────────────────────────────────────────

  describe('notifications', () => {
    it('emits notification event with method and params', async () => {
      await performHandshake(client, mock);

      const received: CodexNotification[] = [];
      client.on('notification', (n: CodexNotification) => received.push(n));

      mock.serverWrite({
        jsonrpc: '2.0',
        method: 'turn/started',
        params: { turnId: 'turn-1' },
      });

      await tick();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        method: 'turn/started',
        params: { turnId: 'turn-1' },
      });
    });

    it('emits multiple notifications in order', async () => {
      await performHandshake(client, mock);

      const received: string[] = [];
      client.on('notification', (n: CodexNotification) =>
        received.push(n.method)
      );

      mock.serverWrite({ jsonrpc: '2.0', method: 'turn/started', params: {} });
      mock.serverWrite({ jsonrpc: '2.0', method: 'item/started', params: {} });
      mock.serverWrite({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {},
      });

      await tick();

      expect(received).toEqual([
        'turn/started',
        'item/started',
        'turn/completed',
      ]);
    });
  });

  // ── Server-initiated requests ────────────────────────────────────────────

  describe('server-initiated requests', () => {
    it('emits request event when server sends a message with id and method', async () => {
      await performHandshake(client, mock);

      const received: CodexServerRequest[] = [];
      client.on('request', (r: CodexServerRequest) => received.push(r));

      mock.serverWrite({
        jsonrpc: '2.0',
        id: 'srv-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'ls /' },
      });

      await tick();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        id: 'srv-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'ls /' },
      });
    });

    it('respondToServerRequest writes a result response over stdin', async () => {
      await performHandshake(client, mock);

      client.on('request', (r: CodexServerRequest) => {
        client.respondToServerRequest(r.id, { approved: true });
      });

      mock.serverWrite({
        jsonrpc: '2.0',
        id: 'srv-2',
        method: 'item/fileChange/requestApproval',
        params: {},
      });

      // wait for initialize + initialized + response to server request
      const lines = await mock.waitForStdinLines(3);
      const response = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((m) => m['id'] === 'srv-2' && 'result' in m);

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 'srv-2',
        result: { approved: true },
      });
    });

    it('respondToServerRequestError writes an error response over stdin', async () => {
      await performHandshake(client, mock);

      client.on('request', (r: CodexServerRequest) => {
        client.respondToServerRequestError(r.id, -32601, 'method not found');
      });

      mock.serverWrite({
        jsonrpc: '2.0',
        id: 'srv-3',
        method: 'item/permissions/requestApproval',
        params: {},
      });

      const lines = await mock.waitForStdinLines(3);
      const errResponse = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((m) => m['id'] === 'srv-3' && 'error' in m);

      expect(errResponse).toMatchObject({
        jsonrpc: '2.0',
        id: 'srv-3',
        error: { code: -32601, message: 'method not found' },
      });
    });
  });

  // ── Malformed JSON ────────────────────────────────────────────────────────

  describe('malformed JSON handling', () => {
    it('logs and skips a malformed JSON line without throwing', async () => {
      await performHandshake(client, mock);

      const received: CodexNotification[] = [];
      client.on('notification', (n: CodexNotification) => received.push(n));

      // Bad line goes directly to stdout
      mock.stdout.push('{ this is not valid json }\n');
      // Good line follows
      mock.serverWrite({
        jsonrpc: '2.0',
        method: 'skills/changed',
        params: {},
      });

      await tick();

      // Malformed line is dropped; good one still arrives
      expect(received).toHaveLength(1);
      expect(received[0]!.method).toBe('skills/changed');
    });

    it('does not emit error on a malformed line', async () => {
      await performHandshake(client, mock);

      const errors: unknown[] = [];
      client.on('error', (e: unknown) => errors.push(e));

      mock.stdout.push('NOT_JSON\n');
      await tick();

      expect(errors).toHaveLength(0);
    });
  });

  // ── stop() ────────────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('rejects pending calls when stopped', async () => {
      await performHandshake(client, mock);

      const hanging = client.call('thread/start');

      // stop() kills child; mock.kill emits 'close' via setImmediate
      await client.stop();

      await expect(hanging).rejects.toThrow();
    });

    it('kills the child process with SIGTERM by default', async () => {
      await performHandshake(client, mock);
      await client.stop();
      expect(mock.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('uses the supplied signal when given', async () => {
      await performHandshake(client, mock);
      await client.stop('SIGKILL');
      expect(mock.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('emits close with the exit code on unexpected exit', async () => {
      await performHandshake(client, mock);

      const closeCodes: Array<number | null> = [];
      client.on('close', (code: number | null) => closeCodes.push(code));

      mock.exit(137);
      await tick();

      expect(closeCodes).toContain(137);
    });

    it('does nothing on a second stop()', async () => {
      await performHandshake(client, mock);
      await client.stop();
      await expect(client.stop()).resolves.toBeUndefined();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('rejects all pending calls on unexpected child exit', async () => {
      await performHandshake(client, mock);

      // Attach .catch() immediately to prevent PromiseRejectionHandledWarning
      // when the rejection fires synchronously in the close handler.
      const p1 = client.call('thread/start');
      const p2 = client.call('turn/start');
      const r1 = p1.then(
        () => 'ok' as const,
        (e: unknown) => e
      );
      const r2 = p2.then(
        () => 'ok' as const,
        (e: unknown) => e
      );

      mock.exit(1);
      await tick();

      expect(await r1).toBeInstanceOf(Error);
      expect(await r2).toBeInstanceOf(Error);
    });

    it('handles a response with no matching pending id gracefully', async () => {
      await performHandshake(client, mock);

      const errors: unknown[] = [];
      client.on('error', (e: unknown) => errors.push(e));

      // Response for an id we never requested
      mock.serverWrite({ jsonrpc: '2.0', id: 9999, result: {} });
      await tick();

      // Should not emit error or crash
      expect(errors).toHaveLength(0);
    });
  });
});
