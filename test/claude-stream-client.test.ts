/**
 * Unit tests for ClaudeStreamClient.
 *
 * All tests use a mock child process (PassThrough stdin/stdout/stderr + kill())
 * injected via the `spawn` option. No real `claude` binary is invoked.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  ClaudeStreamClient,
  type ClaudeStreamClientOptions,
  type ClaudeStreamCloseEvent,
} from '../server/claude-stream-client.js';

interface MockChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  closed: boolean;
  serverWrite(text: string): void;
  emitClose(code: number | null, signal?: NodeJS.Signals | null): void;
  readStdin(): string[];
  waitForStdin(count: number, timeoutMs?: number): Promise<string[]>;
}

function makeMockChild(options?: { closeOnKill?: boolean }): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.closed = false;

  const lines: string[] = [];
  const waiters: Array<{ count: number; resolve: (l: string[]) => void }> = [];
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lines.push(trimmed);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (lines.length >= waiters[i]!.count) {
          waiters.splice(i, 1)[0]!.resolve([...lines]);
        }
      }
    }
  });

  child.emitClose = (code, signal = null) => {
    if (child.closed) return;
    child.closed = true;
    child.emit('close', code, signal);
    child.stdout.push(null);
  };
  child.kill = vi.fn((_signal?: string) => {
    if (options?.closeOnKill !== false) {
      setImmediate(() => child.emitClose(0, null));
    }
    return true;
  });
  child.serverWrite = (text: string) => child.stdout.push(text);
  child.readStdin = () => [...lines];
  child.waitForStdin = (count, timeoutMs = 1000) => {
    if (lines.length >= count) return Promise.resolve([...lines]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`timeout: ${lines.length}/${count} stdin lines`)),
        timeoutMs
      );
      waiters.push({
        count,
        resolve: (l) => {
          clearTimeout(timer);
          resolve(l);
        },
      });
    });
  };
  return child;
}

function makeClient(
  child: MockChild,
  extra?: Partial<ClaudeStreamClientOptions>
): ClaudeStreamClient {
  return new ClaudeStreamClient({
    args: ['-p'],
    cwd: '/tmp/repo',
    env: { PATH: '/usr/bin' },
    spawn: vi.fn().mockReturnValue(child as unknown as ChildProcess),
    ...extra,
  });
}

function tick(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ClaudeStreamClient', () => {
  it('launches an owned Linux process group for descendant cleanup', () => {
    const child = makeMockChild();
    const spawn = vi.fn().mockReturnValue(child as unknown as ChildProcess);
    const client = new ClaudeStreamClient({
      args: ['-p'],
      cwd: '/tmp/repo',
      env: { PATH: '/usr/bin' },
      spawn,
    });
    client.start();

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      ['-p'],
      expect.objectContaining({
        stdio: 'pipe',
        ...(process.platform === 'linux' ? { detached: true } : {}),
      })
    );
  });

  it('reassembles chunk-split lines into parsed messages', async () => {
    const child = makeMockChild();
    const client = makeClient(child);
    const messages: Record<string, unknown>[] = [];
    client.on('message', (m: Record<string, unknown>) => messages.push(m));
    client.start();

    child.serverWrite('{"type":"sys');
    child.serverWrite('tem","subtype":"init"}\n{"type":"result"}\n');
    await tick();

    expect(messages).toEqual([
      { type: 'system', subtype: 'init' },
      { type: 'result' },
    ]);
  });

  it('drops malformed JSON without emitting or throwing', async () => {
    const child = makeMockChild();
    const client = makeClient(child);
    const messages: unknown[] = [];
    const errors: unknown[] = [];
    client.on('message', (m) => messages.push(m));
    client.on('spawn-error', (e) => errors.push(e));
    client.start();

    child.serverWrite('{ not valid json }\n');
    child.serverWrite('[1,2,3]\n'); // non-object
    child.serverWrite('{"type":"ok"}\n');
    await tick();

    expect(messages).toEqual([{ type: 'ok' }]);
    expect(errors).toHaveLength(0);
  });

  it('skips an oversized line and resyncs at the next newline', async () => {
    const child = makeMockChild();
    const client = makeClient(child, { maxLineChars: 64 });
    const messages: Record<string, unknown>[] = [];
    const oversized: number[] = [];
    client.on('message', (m: Record<string, unknown>) => messages.push(m));
    client.on('oversized-line', (n: number) => oversized.push(n));
    client.start();

    // First line exceeds the cap (no newline for a long time), then a valid one.
    child.serverWrite('{"huge":"' + 'x'.repeat(200) + '"}\n');
    child.serverWrite('{"type":"recovered"}\n');
    await tick();

    expect(oversized.length).toBeGreaterThanOrEqual(1);
    expect(messages).toEqual([{ type: 'recovered' }]);
  });

  it('honors stdin backpressure and preserves write order', async () => {
    const child = makeMockChild();
    const client = makeClient(child);
    // Force write() to report a full buffer once, then drain.
    const realWrite = child.stdin.write.bind(child.stdin);
    let calls = 0;
    child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      calls++;
      realWrite(chunk as string, ...(rest as []));
      if (calls === 1) {
        setImmediate(() => child.stdin.emit('drain'));
        return false; // backpressure on the first write
      }
      return true;
    }) as typeof child.stdin.write;

    client.start();
    client.write({ n: 1 });
    client.write({ n: 2 });
    client.write({ n: 3 });

    const lines = await child.waitForStdin(3);
    expect(lines.map((l) => JSON.parse(l).n)).toEqual([1, 2, 3]);
  });

  it('resolves writeAccepted only after stdin accepts the frame', async () => {
    const child = makeMockChild();
    const client = makeClient(child);
    client.start();

    await expect(
      client.writeAccepted({ steer: 'next tool boundary' })
    ).resolves.toBeUndefined();
    expect(child.readStdin().map((line) => JSON.parse(line))).toEqual([
      { steer: 'next tool boundary' },
    ]);
  });

  it('captures stderr into a bounded ring buffer', async () => {
    const child = makeMockChild();
    const client = makeClient(child, { stderrRingSize: 2 });
    client.start();

    child.stderr.push('line-a\nline-b\nline-c\n');
    await tick();

    // Ring keeps only the newest 2 lines.
    expect(client.stderrTail).toBe('line-b\nline-c');
  });

  it('emits close with the exit code', async () => {
    const child = makeMockChild();
    const client = makeClient(child);
    const closes: ClaudeStreamCloseEvent[] = [];
    client.on('close', (evt: ClaudeStreamCloseEvent) => closes.push(evt));
    client.start();

    child.emitClose(137, 'SIGKILL');
    await tick();

    expect(closes).toEqual([{ code: 137, signal: 'SIGKILL' }]);
    expect(client.running).toBe(false);
  });

  it('surfaces a spawn throw as spawn-error (ENOENT)', async () => {
    const child = makeMockChild();
    const client = new ClaudeStreamClient({
      args: [],
      cwd: '/tmp/repo',
      env: {},
      spawn: () => {
        const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    });
    const errors: Error[] = [];
    client.on('spawn-error', (e: Error) => errors.push(e));
    client.start();
    await tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/ENOENT/);
    void child;
  });

  it('runs the teardown ladder stdin-end → SIGTERM → SIGKILL when the child never exits', async () => {
    const child = makeMockChild({ closeOnKill: false });
    const client = makeClient(child, {
      teardownDelays: { afterStdinMs: 10, afterSigtermMs: 10 },
    });
    client.start();

    const stdinEnded = vi.fn();
    child.stdin.on('finish', stdinEnded);

    const stopPromise = client.stop();
    // Let the ladder run: stdin end (immediate) → SIGTERM (10ms) → SIGKILL (10ms).
    await tick(60);
    // The child ignores signals; force-close so stop() resolves.
    child.emitClose(null, 'SIGKILL');
    await stopPromise;

    expect(stdinEnded).toHaveBeenCalled();
    const signals = child.kill.mock.calls.map((c) => c[0]);
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
    // SIGTERM must precede SIGKILL.
    expect(signals.indexOf('SIGTERM')).toBeLessThan(signals.indexOf('SIGKILL'));
  });

  it('routes a synchronous stdin write throw (EPIPE) to a close, not a process crash', async () => {
    const child = makeMockChild();
    const client = makeClient(child);
    const closes: ClaudeStreamCloseEvent[] = [];
    client.on('close', (evt: ClaudeStreamCloseEvent) => closes.push(evt));
    client.start();

    // Model a broken pipe: the next write throws EPIPE synchronously.
    child.stdin.write = (() => {
      const err = new Error('write EPIPE') as NodeJS.ErrnoException;
      err.code = 'EPIPE';
      throw err;
    }) as typeof child.stdin.write;

    expect(() => client.write({ hello: 1 })).not.toThrow();
    await tick();

    expect(closes).toHaveLength(1);
    expect(client.running).toBe(false);
    // A subsequent write is a silent no-op (client is closed).
    expect(() => client.write({ hello: 2 })).not.toThrow();
  });

  it('handles a stdin "error" event as a child-dead close instead of an unhandled error', async () => {
    const child = makeMockChild();
    const client = makeClient(child);
    const closes: ClaudeStreamCloseEvent[] = [];
    client.on('close', (evt: ClaudeStreamCloseEvent) => closes.push(evt));
    client.start();

    const err = new Error('EPIPE') as NodeJS.ErrnoException;
    err.code = 'EPIPE';
    // Without an attached stdin 'error' listener this would throw at the
    // process level; the client must absorb it.
    expect(() => child.stdin.emit('error', err)).not.toThrow();
    await tick();

    expect(closes).toHaveLength(1);
    expect(client.running).toBe(false);
  });

  it('resolves stop() early when the child exits on stdin close', async () => {
    const child = makeMockChild();
    const client = makeClient(child, {
      teardownDelays: { afterStdinMs: 5000, afterSigtermMs: 5000 },
    });
    client.start();
    // Model a clean `-p` shutdown: the child exits shortly after stdin closes.
    child.stdin.on('finish', () =>
      setImmediate(() => child.emitClose(0, null))
    );

    const start = Date.now();
    await client.stop();
    // Resolves well under the 5s afterStdinMs grace — never reaches SIGTERM.
    expect(Date.now() - start).toBeLessThan(2000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
