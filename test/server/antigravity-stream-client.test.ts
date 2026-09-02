import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  AntigravityStreamClient,
  type AntigravityStreamClientOptions,
  type AntigravityStreamCloseEvent,
} from '../../server/antigravity-stream-client.js';

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
  extra?: Partial<AntigravityStreamClientOptions>
): AntigravityStreamClient {
  return new AntigravityStreamClient({
    args: ['-p', ''],
    cwd: '/tmp/repo',
    env: { PATH: '/usr/bin' },
    spawn: vi.fn().mockReturnValue(child as unknown as ChildProcess),
    ...extra,
  });
}

function tick(ms = 15): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('AntigravityStreamClient', () => {
  it('writeAccepted rejects when closed', async () => {
    const child = makeMockChild();
    const client = makeClient(child);
    client.start();
    child.emitClose(0, null);
    await tick();

    await expect(
      client.writeAccepted({
        event: 'user',
        message: { role: 'user', content: 'hi' },
      })
    ).rejects.toThrow('Antigravity stdin is unavailable');
  });

  it('stdin end leads to close', async () => {
    const child = makeMockChild({ closeOnKill: false });
    const client = makeClient(child, {
      teardownDelays: { afterStdinMs: 10, afterSigtermMs: 10 },
    });
    client.start();

    let closedEvent: AntigravityStreamCloseEvent | undefined;
    client.on('close', (e) => {
      closedEvent = e;
    });

    child.stdin.on('finish', () => {
      child.emitClose(0, null);
    });

    await client.stop();
    expect(client.running).toBe(false);
    expect(closedEvent).toEqual({ code: 0, signal: null });
  });

  it('runs SIGTERM/SIGKILL ladder when stdin end does not close', async () => {
    const child = makeMockChild({ closeOnKill: false });
    const client = makeClient(child, {
      teardownDelays: { afterStdinMs: 10, afterSigtermMs: 10 },
    });
    client.start();

    const stopPromise = client.stop();
    await tick(15);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emitClose(143, 'SIGTERM');
    await stopPromise;
    expect(client.running).toBe(false);
  });

  it('skips oversized line and emits oversized-line', async () => {
    const child = makeMockChild();
    const client = makeClient(child, { maxLineBytes: 50 });
    client.start();

    const oversizedEvents: number[] = [];
    client.on('oversized-line', (dropped) => oversizedEvents.push(dropped));

    const events: Array<Record<string, unknown>> = [];
    client.on('event', (e) => events.push(e));

    const hugeLine = JSON.stringify({ huge: 'x'.repeat(100) }) + '\n';
    const normalLine = JSON.stringify({ normal: 'ok' }) + '\n';

    child.serverWrite(hugeLine);
    child.serverWrite(normalLine);
    await tick();

    expect(oversizedEvents.length).toBeGreaterThan(0);
    expect(events).toEqual([{ normal: 'ok' }]);
  });

  it('emits stderr lines and updates stderrTail', async () => {
    const child = makeMockChild();
    const client = makeClient(child);
    client.start();

    const stderrLines: string[] = [];
    client.on('stderr', (line) => stderrLines.push(line));

    child.stderr.push('jetski: warning 1\njetski: warning 2\n');
    await tick();

    expect(stderrLines).toEqual(['jetski: warning 1', 'jetski: warning 2']);
    expect(client.stderrTail).toBe('jetski: warning 1\njetski: warning 2');
  });

  it('signal forwards to child kill', () => {
    const child = makeMockChild({ closeOnKill: false });
    const client = makeClient(child);
    client.start();

    client.signal('SIGINT');
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
  });
});
