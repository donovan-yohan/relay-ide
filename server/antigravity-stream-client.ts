import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { LineFramer } from './line-framer.js';
import { createLogger } from './logger.js';

const logger = createLogger('antigravity-stream-client');

/**
 * Dependency-injection hook for tests. When provided it is called instead of
 * node:child_process.spawn.
 */
export type AntigravitySpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdio: 'pipe';
    detached?: boolean;
  }
) => ChildProcess;

export interface AntigravityStreamClientOptions {
  /** Default: 'agy' */
  command?: string;
  /** Full argv. */
  args: string[];
  cwd: string;
  env: Record<string, string>;
  spawn?: AntigravitySpawnFn;
  /** Maximum bytes for a single stdout line. Default 8 MiB. */
  maxLineBytes?: number;
  /** Number of stderr lines retained for crash diagnostics. Default 50. */
  stderrRingSize?: number;
  /** Teardown delays. Default 3000 / 5000 ms. */
  teardownDelays?: { afterStdinMs?: number; afterSigtermMs?: number };
}

export interface AntigravityStreamCloseEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface PendingAntigravityWrite {
  line: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_STDERR_RING = 50;
const DEFAULT_AFTER_STDIN_MS = 3000;
const DEFAULT_AFTER_SIGTERM_MS = 5000;

/**
 * AntigravityStreamClient — low-level persistent `agy` subprocess transport over
 * stream-json (stdin outbound, stdout inbound). Owns spawn, NDJSON line framing,
 * stdin backpressure, stderr ring buffer, and teardown ladder.
 *
 * Emits:
 *   'event'         (Record<string, unknown>) — one parsed stdout JSON object
 *   'stderr'        (string)                  — one stderr line
 *   'oversized-line'(number)                  — stdout line exceeded cap and was dropped
 *   'spawn-error'   (Error)                   — spawn/ENOENT or child error
 *   'close'         (AntigravityStreamCloseEvent) — child exited
 */
export class AntigravityStreamClient extends EventEmitter {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly spawnFn: AntigravitySpawnFn;
  private readonly maxLineBytes: number;
  private readonly stderrRingSize: number;
  private readonly afterStdinMs: number;
  private readonly afterSigtermMs: number;

  private child: ChildProcess | null = null;
  private started = false;
  private closed = false;
  private readonly framer: LineFramer;

  private readonly stderrRing: string[] = [];
  private writeQueue: PendingAntigravityWrite[] = [];
  private readonly writesInFlight = new Set<PendingAntigravityWrite>();
  private draining = false;
  private stopPromise: Promise<void> | null = null;

  constructor(options: AntigravityStreamClientOptions) {
    super();
    this.command = options.command ?? 'agy';
    this.args = options.args;
    this.cwd = options.cwd;
    this.env = options.env;
    this.spawnFn =
      options.spawn ?? (nodeSpawn as unknown as AntigravitySpawnFn);
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.framer = new LineFramer({
      maxLineBytes: this.maxLineBytes,
      oversizedPolicy: 'skip-resync',
      onOversized: (dropped) => this.emit('oversized-line', dropped),
      trimTrailingCr: true,
    });
    this.stderrRingSize = options.stderrRingSize ?? DEFAULT_STDERR_RING;
    this.afterStdinMs =
      options.teardownDelays?.afterStdinMs ?? DEFAULT_AFTER_STDIN_MS;
    this.afterSigtermMs =
      options.teardownDelays?.afterSigtermMs ?? DEFAULT_AFTER_SIGTERM_MS;
  }

  get running(): boolean {
    return this.started && !this.closed;
  }

  get pid(): number | undefined {
    return this.child?.pid ?? undefined;
  }

  get stderrTail(): string {
    return this.stderrRing.join('\n');
  }

  start(): void {
    if (this.started)
      throw new Error('AntigravityStreamClient already started');
    this.started = true;

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: 'pipe',
        ...(process.platform === 'linux' ? { detached: true } : {}),
      });
    } catch (err) {
      this.closed = true;
      const error = err instanceof Error ? err : new Error(String(err));
      queueMicrotask(() => this.emit('spawn-error', error));
      return;
    }
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));

    child.stdin?.on('error', (err: NodeJS.ErrnoException) =>
      this.onStdinError(err)
    );

    child.on('error', (err: Error) => {
      if (!this.closed) this.emit('spawn-error', err);
    });

    child.on('close', (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      this.rejectPendingWrites(
        new Error(
          'Antigravity subprocess closed before stdin write was accepted'
        )
      );
      this.emit('close', {
        code: code ?? null,
        signal: (signal as NodeJS.Signals | null) ?? null,
      } satisfies AntigravityStreamCloseEvent);
    });
  }

  write(msg: unknown): void {
    void this.writeAccepted(msg).catch(() => {});
  }

  writeAccepted(msg: unknown): Promise<void> {
    if (this.closed || !this.child) {
      return Promise.reject(new Error('Antigravity stdin is unavailable'));
    }
    let line: string;
    try {
      line = JSON.stringify(msg) + '\n';
    } catch (err) {
      logger.warn(
        'failed to serialize antigravity stdin frame: %s',
        String(err)
      );
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err))
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ line, resolve, reject });
      this.flush();
    });
  }

  signal(sig: NodeJS.Signals | number = 'SIGINT'): boolean {
    if (!this.child || this.closed) return false;
    try {
      return this.child.kill(sig);
    } catch {
      return false;
    }
  }

  private flush(): void {
    if (this.draining || this.closed) return;
    const stdin = this.child?.stdin;
    if (!stdin) return;

    while (this.writeQueue.length > 0) {
      const pending = this.writeQueue.shift()!;
      this.writesInFlight.add(pending);
      let ok: boolean;
      try {
        ok = stdin.write(pending.line, (err) => {
          this.writesInFlight.delete(pending);
          if (err) {
            const error = err as NodeJS.ErrnoException;
            pending.reject(error);
            this.onStdinError(error);
            return;
          }
          pending.resolve();
        });
      } catch (err) {
        this.writesInFlight.delete(pending);
        const error = err instanceof Error ? err : new Error(String(err));
        pending.reject(error);
        this.onStdinError(error as NodeJS.ErrnoException);
        return;
      }
      if (this.closed) return;
      if (!ok) {
        this.draining = true;
        stdin.once('drain', () => {
          this.draining = false;
          this.flush();
        });
        break;
      }
    }
  }

  private onStdinError(err: NodeJS.ErrnoException): void {
    if (this.closed) return;
    logger.warn(
      'antigravity stdin stream error (%s): %s',
      err?.code ?? 'unknown',
      err?.message ?? String(err)
    );
    this.rejectPendingWrites(err);
    this.draining = false;
    this.closed = true;
    this.emit('close', {
      code: null,
      signal: null,
    } satisfies AntigravityStreamCloseEvent);
  }

  private rejectPendingWrites(error: Error): void {
    for (const pending of this.writeQueue) pending.reject(error);
    this.writeQueue = [];
    for (const pending of this.writesInFlight) pending.reject(error);
    this.writesInFlight.clear();
  }

  private onStdout(chunk: Buffer): void {
    this.framer.push(chunk, (line) => this.handleLine(line));
  }

  private handleLine(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.warn(
        'antigravity-stream: malformed JSON line dropped (%d chars)',
        trimmed.length
      );
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      logger.warn('antigravity-stream: non-object stdout message dropped');
      return;
    }
    this.emit('event', msg as Record<string, unknown>);
  }

  private onStderr(chunk: Buffer): void {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.replace(/\s+$/, '');
      if (trimmed.trim().length === 0) continue;
      this.stderrRing.push(trimmed);
      while (this.stderrRing.length > this.stderrRingSize) {
        this.stderrRing.shift();
      }
      this.emit('stderr', trimmed);
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child || this.closed) {
      this.detach();
      return;
    }
    this.stopPromise = this.runTeardown(child);
    return this.stopPromise;
  }

  private async runTeardown(child: ChildProcess): Promise<void> {
    const closeWait = new Promise<void>((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }
      child.once('close', () => resolve());
    });

    try {
      child.stdin?.end();
    } catch {
      // stdin may already be closed.
    }
    if (await this.raceClose(closeWait, this.afterStdinMs)) {
      this.detach();
      return;
    }

    try {
      child.kill('SIGTERM');
    } catch {
      // Process may already be gone.
    }
    if (await this.raceClose(closeWait, this.afterSigtermMs)) {
      this.detach();
      return;
    }

    try {
      child.kill('SIGKILL');
    } catch {
      // Process may already be gone.
    }
    await this.raceClose(closeWait, this.afterSigtermMs);
    this.detach();
  }

  private raceClose(closeWait: Promise<void>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(this.closed);
      }, ms);
      timer.unref?.();
      void closeWait.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private detach(): void {
    const child = this.child;
    this.child = null;
    this.closed = true;
    if (!child) return;
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
  }
}
