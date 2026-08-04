import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createLogger } from './logger.js';

const logger = createLogger('claude-stream-client');

/**
 * Dependency-injection hook for tests, mirroring
 * {@link CodexAppServerClientOptions.spawn}. When provided it is called
 * instead of node:child_process.spawn. The returned object must expose
 * stdin/stdout/stderr streams, a `kill` method, and emit `close`/`error`.
 */
export type ClaudeSpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: 'pipe' }
) => ChildProcess;

export interface ClaudeStreamClientOptions {
  /** Default: 'claude' */
  command?: string;
  /** Full argv (the adapter composes the reserved/config/resume flags). */
  args: string[];
  /** Required — `--resume` lookup is scoped to the project directory. */
  cwd: string;
  env: Record<string, string>;
  spawn?: ClaudeSpawnFn;
  /**
   * Maximum characters buffered for a single stdout line before it is skipped
   * (not fatal) with resync at the next newline. Default 32 MiB — huge `Edit`
   * tool_use inputs are real.
   */
  maxLineChars?: number;
  /** Number of stderr lines retained for crash diagnostics. Default 50. */
  stderrRingSize?: number;
  /**
   * Teardown ladder delays. stdin end → afterStdinMs → SIGTERM → afterSigtermMs
   * → SIGKILL. Defaults 3000 / 5000. Tests shrink these.
   */
  teardownDelays?: { afterStdinMs?: number; afterSigtermMs?: number };
}

export interface ClaudeStreamCloseEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const DEFAULT_MAX_LINE_CHARS = 32 * 1024 * 1024;
const DEFAULT_STDERR_RING = 50;
const DEFAULT_AFTER_STDIN_MS = 3000;
const DEFAULT_AFTER_SIGTERM_MS = 5000;

/**
 * ClaudeStreamClient — low-level persistent `claude` subprocess transport over
 * stream-json (stdin outbound, stdout inbound), modeled on
 * {@link CodexAppServerClient}. Owns spawn, NDJSON line splitting with an
 * oversized-line cap, stdin backpressure, a stderr ring buffer, and the
 * teardown ladder. It performs no protocol interpretation — every parsed
 * stdout object is forwarded verbatim to the adapter via the `message` event.
 *
 * Emits:
 *   'message'       (Record<string, unknown>) — one parsed stdout JSON object
 *   'stderr'        (string)                  — one stderr line (also ring-buffered)
 *   'oversized-line'(number)                  — a stdout line exceeded the cap and was dropped
 *   'spawn-error'   (Error)                   — spawn/ENOENT or child `error`
 *   'close'         (ClaudeStreamCloseEvent)  — child exited
 */
export class ClaudeStreamClient extends EventEmitter {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly spawnFn: ClaudeSpawnFn;
  private readonly maxLineChars: number;
  private readonly stderrRingSize: number;
  private readonly afterStdinMs: number;
  private readonly afterSigtermMs: number;

  private child: ChildProcess | null = null;
  private started = false;
  private closed = false;

  private lineBuffer = '';
  private skipping = false;

  private readonly stderrRing: string[] = [];
  private writeQueue: string[] = [];
  private draining = false;
  private stopPromise: Promise<void> | null = null;

  constructor(options: ClaudeStreamClientOptions) {
    super();
    this.command = options.command ?? 'claude';
    this.args = options.args;
    this.cwd = options.cwd;
    this.env = options.env;
    this.spawnFn = options.spawn ?? (nodeSpawn as unknown as ClaudeSpawnFn);
    this.maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
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

  /** Newest-last stderr lines, newline-joined, for crash error messages. */
  get stderrTail(): string {
    return this.stderrRing.join('\n');
  }

  /**
   * Spawn the child. The first user line may be written immediately after —
   * the CLI buffers stdin, so there is no readiness handshake.
   */
  start(): void {
    if (this.started) throw new Error('ClaudeStreamClient already started');
    this.started = true;

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: 'pipe',
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

    // Without an 'error' listener a stdin EPIPE (child closed its read end while
    // still alive — internal abort, CLI closing stdin after a -p run, teardown
    // race) surfaces as an unhandled stream 'error' that throws at process level
    // and takes down the whole relay hub, not just this session. Route it to the
    // client error path instead.
    child.stdin?.on('error', (err: NodeJS.ErrnoException) =>
      this.onStdinError(err)
    );

    child.on('error', (err: Error) => {
      // Spawn ENOENT or a runtime transport error. Node may not emit 'close'
      // after an ENOENT, so surface it as a distinct signal.
      if (!this.closed) this.emit('spawn-error', err);
    });

    child.on('close', (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close', {
        code: code ?? null,
        signal: (signal as NodeJS.Signals | null) ?? null,
      } satisfies ClaudeStreamCloseEvent);
    });
  }

  /** Serialize one JSON frame + `\n` onto the drain-honoring stdin queue. */
  write(msg: unknown): void {
    if (this.closed || !this.child) return;
    let line: string;
    try {
      line = JSON.stringify(msg) + '\n';
    } catch (err) {
      logger.warn('failed to serialize claude stdin frame: %s', String(err));
      return;
    }
    this.writeQueue.push(line);
    this.flush();
  }

  /** Flush the outbound queue respecting stdin backpressure (drain gating). */
  private flush(): void {
    if (this.draining || this.closed) return;
    const stdin = this.child?.stdin;
    if (!stdin) return;

    while (this.writeQueue.length > 0) {
      const line = this.writeQueue.shift()!;
      let ok: boolean;
      try {
        // The write callback catches asynchronous stream errors (e.g. a late
        // EPIPE) that would otherwise land on the stdin 'error' listener; the
        // try/catch catches a synchronous throw on an already-destroyed stream.
        ok = stdin.write(line, (err) => {
          if (err) this.onStdinError(err as NodeJS.ErrnoException);
        });
      } catch (err) {
        this.onStdinError(err as NodeJS.ErrnoException);
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

  /**
   * A broken/errored stdin pipe means the child can no longer receive input.
   * EPIPE specifically signals the child's read end is gone, so treat any stdin
   * error as the child being effectively dead: drop the outbound queue and emit
   * a synthetic `close` so the adapter fails the turn and can respawn with
   * `--resume`, rather than letting an unhandled 'error' crash the process.
   */
  private onStdinError(err: NodeJS.ErrnoException): void {
    if (this.closed) return;
    logger.warn(
      'claude stdin stream error (%s): %s',
      err?.code ?? 'unknown',
      err?.message ?? String(err)
    );
    this.writeQueue = [];
    this.draining = false;
    this.closed = true;
    this.emit('close', {
      code: null,
      signal: null,
    } satisfies ClaudeStreamCloseEvent);
  }

  private onStdout(chunk: Buffer): void {
    this.lineBuffer += chunk.toString('utf8');
    for (;;) {
      const idx = this.lineBuffer.indexOf('\n');
      if (idx === -1) {
        if (this.skipping) {
          // Still inside an oversized line — discard the partial tail.
          if (this.lineBuffer.length > 0) this.lineBuffer = '';
          return;
        }
        if (this.lineBuffer.length > this.maxLineChars) {
          // No newline yet and the buffer blew the cap — enter skip mode and
          // resync at the next newline.
          const dropped = this.lineBuffer.length;
          this.skipping = true;
          this.lineBuffer = '';
          this.emit('oversized-line', dropped);
        }
        return;
      }

      const line = this.lineBuffer.slice(0, idx);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);

      if (this.skipping) {
        // This newline terminates the oversized line — resume normal parsing.
        this.skipping = false;
        continue;
      }
      if (line.length > this.maxLineChars) {
        this.emit('oversized-line', line.length);
        continue;
      }
      this.handleLine(line);
    }
  }

  private handleLine(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.warn(
        'claude-stream: malformed JSON line dropped (%d chars)',
        trimmed.length
      );
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      logger.warn('claude-stream: non-object stdout message dropped');
      return;
    }
    this.emit('message', msg as Record<string, unknown>);
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

  /**
   * Teardown ladder: end stdin (clean `-p` shutdown) → afterStdinMs → SIGTERM
   * → afterSigtermMs → SIGKILL → detach readers. Idempotent.
   */
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

  /** Resolves true if the child closed within `ms`, false on timeout. */
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
