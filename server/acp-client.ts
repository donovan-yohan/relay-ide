import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { LineFramer } from './line-framer.js';

/**
 * Transport for Agent Client Protocol (ACP) stdio servers.
 *
 * The wire is the Agent Client Protocol over newline-delimited JSON-RPC 2.0 on
 * stdio, and it is BIDIRECTIONAL in a way other stdio harnesses are not:
 * besides answering client requests and pushing `session/update` notifications,
 * the server can send the client a request (such as `session/request_permission`
 * or `cursor/ask_question`) and block until the client answers. That is why
 * this client exposes `respond`/`respondError` alongside `request` — a peer
 * request left unanswered hangs the agent's turn.
 *
 * Everything here is transport plumbing: framing (LF splitting, record and
 * buffer caps) belongs to the shared `LineFramer`, and provider-specific ACP
 * vocabularies live in their respective protocol adapters.
 */

/** A server-to-client notification, split into method and params. */
export interface AcpNotification {
  method: string;
  params: Record<string, unknown>;
}

/** A server-to-client REQUEST. The adapter must answer it or the turn hangs. */
export interface AcpPeerRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export interface AcpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  readinessTimeoutMs?: number;
  /**
   * `session/prompt` is answered only when the whole turn has settled, so it
   * cannot share the ordinary request timeout. Omit for no timeout.
   */
  promptTimeoutMs?: number;
  maxBufferBytes?: number;
  maxRecordBytes?: number;
  /** Per rung of the stop ladder (stdin EOF, SIGTERM, SIGKILL). */
  stopTimeoutMs?: number;
  spawn?: (
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; stdio: 'pipe' }
  ) => ChildProcess;
}

/** `initialize` params. */
export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: Record<string, unknown>;
  clientInfo?: { name: string; version: string };
}

/** `initialize` result: agent identity and the capabilities it actually mounts. */
export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name: string; version: string };
  agentCapabilities?: Record<string, unknown>;
  authMethods?: unknown[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** How many stderr lines to keep for transport-close diagnostics. */
const STDERR_TAIL_LINES = 40;

export class AcpClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly framer: LineFramer;
  private stopPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly writes: string[] = [];
  private draining = false;
  private detachChildListeners: (() => void) | null = null;
  private detachDrainListener: (() => void) | null = null;
  private readonly stderrTail: string[] = [];

  constructor(private readonly options: AcpClientOptions) {
    super();
    const maxRecordBytes = options.maxRecordBytes ?? 8 * 1024 * 1024;
    const maxBufferBytes = options.maxBufferBytes ?? 16 * 1024 * 1024;
    this.framer = new LineFramer({
      maxLineBytes: maxRecordBytes,
      maxBufferBytes,
      trimTrailingCr: true,
      onOversized: () =>
        this.emit(
          'protocolError',
          new Error(`ACP record exceeded ${maxRecordBytes} bytes`)
        ),
      onBufferOverflow: () => {
        this.emit(
          'protocolError',
          new Error(`ACP input buffer exceeded ${maxBufferBytes} bytes`)
        );
        // Discarding an unterminated record loses framing. Stop rather than
        // risk interpreting a later suffix as a fresh trusted record.
        void this.stop().catch((stopError: unknown) =>
          this.emit(
            'error',
            stopError instanceof Error
              ? stopError
              : new Error(String(stopError))
          )
        );
      },
    });
    // An EventEmitter `error` without a listener terminates Node.
    this.on('error', () => undefined);
  }

  /** Last stderr lines, newest last. Empty when the child wrote nothing. */
  get stderrTailText(): string {
    return this.stderrTail.join('\n');
  }

  /**
   * Spawn the ACP server and complete the `initialize` handshake, which is the
   * readiness barrier: the server answers it only once its plugin/server tree
   * is mounted, so a resolved response means subsequent requests will be accepted.
   */
  async start(init: AcpInitializeParams): Promise<AcpInitializeResult> {
    if (this.child || this.stopPromise)
      throw new Error('AcpClient already started');
    const spawnFn = this.options.spawn ?? nodeSpawn;
    const child = spawnFn(this.options.command, this.options.args ?? ['acp'], {
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      stdio: 'pipe',
    });
    this.child = child;
    this.framer.reset();
    this.stderrTail.length = 0;
    const onStdoutData = (chunk: Buffer | string) => this.consume(chunk);
    const onStderrData = (chunk: Buffer | string) => {
      const text = String(chunk);
      this.pushStderrTail(text);
      this.emit('stderr', text);
    };
    const onStreamError = (error: Error) => this.emit('error', error);
    const onChildError = (error: Error) => {
      this.rejectPending(error);
      this.emit('error', error);
    };
    const onClose = (code: number | null) => {
      const exit = this.exitError(code);
      if (this.child === child) {
        this.child = null;
        this.resetTransportState(exit);
        this.removeChildListeners();
      }
      this.rejectPending(exit);
      this.emit('close', code);
    };
    child.stdout?.on('data', onStdoutData);
    child.stderr?.on('data', onStderrData);
    child.stdin?.on('error', onStreamError);
    child.stdout?.on('error', onStreamError);
    child.stderr?.on('error', onStreamError);
    child.on('error', onChildError);
    child.on('close', onClose);
    this.detachChildListeners = () => {
      child.stdout?.removeListener('data', onStdoutData);
      child.stderr?.removeListener('data', onStderrData);
      child.stdin?.removeListener('error', onStreamError);
      child.stdout?.removeListener('error', onStreamError);
      child.stderr?.removeListener('error', onStreamError);
      child.removeListener('error', onChildError);
      child.removeListener('close', onClose);
    };

    try {
      const result = await this.requestWithTimeout(
        'initialize',
        init as unknown as Record<string, unknown>,
        this.options.readinessTimeoutMs ?? 20_000
      );
      return result as AcpInitializeResult;
    } catch (error) {
      // A failed readiness barrier must not leave a live child, drain handler,
      // or unsent request behind for a later start attempt.
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  /** One correlated JSON-RPC request. Resolves with `result`. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.requestWithTimeout(
      method,
      params,
      this.options.requestTimeoutMs ?? 30_000
    );
  }

  /**
   * `session/prompt`, which the server answers only once the whole turn has
   * settled. It gets its own (by default absent) timeout so an ordinary
   * request budget cannot cut a long but healthy turn short; the turn is
   * bounded by `interrupt()` and by transport death instead.
   */
  prompt(params: Record<string, unknown>): Promise<unknown> {
    return this.requestWithTimeout(
      'session/prompt',
      params,
      this.options.promptTimeoutMs ?? 0
    );
  }

  /** A client-to-server notification, e.g. `session/cancel`. */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child) return;
    this.enqueue({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  /** Answer a server-to-client request. */
  respond(id: string | number, result: unknown): void {
    this.enqueue({ jsonrpc: '2.0', id, result });
  }

  /** Fail a server-to-client request we cannot answer. */
  respondError(id: string | number, code: number, message: string): void {
    this.enqueue({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private requestWithTimeout(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    if (!this.child)
      return Promise.reject(new Error('AcpClient is not started'));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, method, timer });
    });
    this.enqueue({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    return promise;
  }

  /**
   * Stop ladder: end stdin (the server disposes and exits 0 on EOF), then
   * SIGTERM, then SIGKILL. Idempotent — concurrent callers share one promise.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) {
      this.resetTransportState(new Error('AcpClient stopped'));
      return;
    }

    this.child = null;
    this.resetTransportState(new Error('AcpClient stopped'));
    this.removeChildListeners();
    this.stopPromise = this.terminate(child).finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async terminate(child: ChildProcess): Promise<void> {
    let closed = false;
    const onClose = () => {
      closed = true;
    };
    child.once('close', onClose);
    const waitForClose = (timeoutMs: number): Promise<boolean> =>
      new Promise((resolve) => {
        if (closed) {
          resolve(true);
          return;
        }
        const onWaitClose = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child.removeListener('close', onWaitClose);
          resolve(closed);
        }, timeoutMs);
        timer.unref?.();
        child.once('close', onWaitClose);
      });
    const timeoutMs = this.options.stopTimeoutMs ?? 2_000;

    try {
      // Rung 1: stdin EOF is the server's own documented shutdown path.
      try {
        child.stdin?.end();
      } catch {
        // The stream may already be closed.
      }
      if (await waitForClose(timeoutMs)) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // The process may already have exited.
      }
      if (await waitForClose(timeoutMs)) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited.
      }
      await waitForClose(timeoutMs);
    } finally {
      child.removeListener('close', onClose);
    }
  }

  private consume(chunk: Buffer | string): void {
    this.framer.push(chunk, (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    if (line.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.emit(
        'protocolError',
        new Error(
          `Invalid ACP JSON: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.emit(
        'protocolError',
        new Error('Invalid ACP record: expected object')
      );
      return;
    }
    const frame = value as Record<string, unknown>;
    const hasId = frame.id !== undefined && frame.id !== null;
    const method = typeof frame.method === 'string' ? frame.method : null;
    // Order matters: a frame with BOTH an id and a method is a peer REQUEST,
    // not a response to one of ours.
    if (hasId && method) {
      this.emit('peerRequest', {
        id: frame.id as string | number,
        method,
        params:
          frame.params && typeof frame.params === 'object'
            ? (frame.params as Record<string, unknown>)
            : {},
      } satisfies AcpPeerRequest);
      return;
    }
    if (hasId) {
      this.settle(frame, frame.id as string | number);
      return;
    }
    if (method) {
      this.emit('notification', {
        method,
        params:
          frame.params && typeof frame.params === 'object'
            ? (frame.params as Record<string, unknown>)
            : {},
      } satisfies AcpNotification);
      return;
    }
    this.emit(
      'protocolError',
      new Error(
        'Invalid ACP record: neither request, response, nor notification'
      )
    );
  }

  private settle(frame: Record<string, unknown>, id: string | number): void {
    const numericId = typeof id === 'number' ? id : Number(id);
    const pending = this.pending.get(numericId);
    if (!pending) {
      this.emit(
        'protocolError',
        new Error(`Uncorrelated ACP response id: ${String(id)}`)
      );
      return;
    }
    this.pending.delete(numericId);
    if (pending.timer) clearTimeout(pending.timer);
    const error = frame.error;
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      const detail =
        record.data && typeof record.data === 'object'
          ? ` (${JSON.stringify(record.data)})`
          : '';
      const message =
        typeof record.message === 'string' && record.message.length > 0
          ? `${record.message}${detail}`
          : `${pending.method} failed`;
      pending.reject(new Error(message));
      return;
    }
    pending.resolve(frame.result);
  }

  private enqueue(message: Record<string, unknown>): void {
    this.writes.push(`${JSON.stringify(message)}\n`);
    this.flush();
  }

  private flush(): void {
    if (this.draining) return;
    const stdin = this.child?.stdin;
    if (!stdin) return;
    while (this.writes.length) {
      const line = this.writes.shift()!;
      let accepted: boolean;
      try {
        accepted = stdin.write(line);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.writes.length = 0;
        this.rejectPending(failure);
        this.emit('error', failure);
        return;
      }
      if (!accepted) {
        this.draining = true;
        const onDrain = () => {
          this.detachDrainListener = null;
          this.draining = false;
          this.flush();
        };
        this.detachDrainListener = () => stdin.removeListener('drain', onDrain);
        stdin.once('drain', onDrain);
        return;
      }
    }
  }

  private exitError(code: number | null): Error {
    const tail = this.stderrTailText;
    return new Error(
      `ACP server exited (code=${String(code)})${tail ? `: ${tail}` : ''}`
    );
  }

  private pushStderrTail(text: string): void {
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      this.stderrTail.push(line);
    }
    while (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resetTransportState(error: Error): void {
    this.rejectPending(error);
    this.framer.reset();
    this.writes.length = 0;
    this.nextId = 1;
    this.detachDrainListener?.();
    this.detachDrainListener = null;
    this.draining = false;
  }

  private removeChildListeners(): void {
    this.detachChildListeners?.();
    this.detachChildListeners = null;
  }
}
