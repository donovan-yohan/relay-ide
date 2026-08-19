/**
 * Fake `claude` child process + spawn harness shared by the Claude deep tests
 * and the adapter conformance suite.
 *
 * Lifted verbatim from `claude-adapter.test.ts` (import swap only) with one
 * behavior change the conformance suite requires: pids are assigned from a
 * deterministic per-harness counter instead of `Math.random()`, so a replayed
 * transcript produces byte-identical patches.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { vi } from 'vitest';
import type { ClaudeSpawnFn } from '../../../../server/claude-stream-client.js';

/** First pid handed out by a harness; later children increment from here. */
export const DEFAULT_BASE_PID = 4242;

export interface MockChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  closed: boolean;
  serverWrite(obj: unknown): void;
  emitClose(code: number | null, signal?: NodeJS.Signals | null): void;
  emitStderr(text: string): void;
  frames(): Record<string, unknown>[];
  waitForFrames(
    count: number,
    timeoutMs?: number
  ): Promise<Record<string, unknown>[]>;
}

export interface MockChildOptions {
  closeOnStdinEnd?: boolean;
  pid?: number;
}

export function makeMockChild(options?: MockChildOptions): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = options?.pid ?? DEFAULT_BASE_PID;
  child.closed = false;

  const frames: Record<string, unknown>[] = [];
  const waiters: Array<{
    count: number;
    resolve: (f: Record<string, unknown>[]) => void;
  }> = [];
  let buf = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        frames.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        frames.push({ __raw: line });
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (frames.length >= waiters[i]!.count) {
          waiters.splice(i, 1)[0]!.resolve([...frames]);
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
  child.kill = vi.fn((_signal?: string) => true);
  if (options?.closeOnStdinEnd !== false) {
    child.stdin.on('finish', () =>
      setImmediate(() => child.emitClose(0, null))
    );
  }
  child.serverWrite = (obj) => child.stdout.push(JSON.stringify(obj) + '\n');
  child.emitStderr = (text) =>
    child.stderr.push(text.endsWith('\n') ? text : text + '\n');
  child.frames = () => [...frames];
  child.waitForFrames = (count, timeoutMs = 1000) => {
    if (frames.length >= count) return Promise.resolve([...frames]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`timeout: ${frames.length}/${count} stdin frames`)),
        timeoutMs
      );
      waiters.push({
        count,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  };
  return child;
}

export interface SpawnRecord {
  command: string;
  args: string[];
  options: { cwd: string; env: Record<string, string>; stdio: 'pipe' };
  child: MockChild;
}

export interface ClaudeChildHarness {
  spawnFn: ClaudeSpawnFn;
  spawns: SpawnRecord[];
  latest(): SpawnRecord;
  setNextChildOptions(o: { closeOnStdinEnd?: boolean }): void;
}

export function makeHarness(options?: {
  basePid?: number;
}): ClaudeChildHarness {
  const basePid = options?.basePid ?? DEFAULT_BASE_PID;
  const spawns: SpawnRecord[] = [];
  let nextOpts: { closeOnStdinEnd?: boolean } | undefined;
  const spawnFn: ClaudeSpawnFn = (command, args, opts) => {
    const child = makeMockChild({ ...nextOpts, pid: basePid + spawns.length });
    nextOpts = undefined;
    spawns.push({ command, args, options: opts, child });
    return child as unknown as ChildProcess;
  };
  return {
    spawnFn,
    spawns,
    latest: (): SpawnRecord => spawns[spawns.length - 1]!,
    setNextChildOptions: (o: { closeOnStdinEnd?: boolean }) => {
      nextOpts = o;
    },
  };
}

/** Conformance alias — the suite reads this name in fixture files. */
export const makeClaudeChildHarness = makeHarness;
