import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { LineFramer } from './line-framer.js';

export interface PrimeAgentRpcMessage extends Record<string, unknown> {
  type: string;
}

/** A correlated native RPC failure, retaining the command and response shape. */
export class PrimeAgentRpcResponseError extends Error {
  constructor(
    readonly command: string,
    readonly response: PrimeAgentRpcMessage
  ) {
    const detail =
      typeof response.error === 'string'
        ? response.error
        : response.error &&
            typeof response.error === 'object' &&
            typeof (response.error as Record<string, unknown>).message ===
              'string'
          ? String((response.error as Record<string, unknown>).message)
          : `${command} failed`;
    super(detail);
    this.name = 'PrimeAgentRpcResponseError';
  }
}

export interface PrimeAgentRpcClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  readinessTimeoutMs?: number;
  maxBufferBytes?: number;
  maxRecordBytes?: number;
  stopTimeoutMs?: number;
  diagnosticRingSize?: number;
  spawn?: (
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; stdio: 'pipe' }
  ) => ChildProcess;
}

interface PendingCall {
  resolve: (value: PrimeAgentRpcMessage) => void;
  reject: (error: Error) => void;
  command: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Strict-LF JSONL client for `prime-agent --mode rpc`. */
export class PrimeAgentRpcClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly framer: LineFramer;
  private stopPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private readonly writes: string[] = [];
  private draining = false;
  private detachChildListeners: (() => void) | null = null;
  private detachDrainListener: (() => void) | null = null;
  private readonly diagnosticRing: string[] = [];
  private readonly diagnosticRingSize: number;
  private ready = false;

  constructor(private readonly options: PrimeAgentRpcClientOptions = {}) {
    super();
    this.diagnosticRingSize = options.diagnosticRingSize ?? 40;
    const maxRecordBytes = options.maxRecordBytes ?? 8 * 1024 * 1024;
    const maxBufferBytes = options.maxBufferBytes ?? 16 * 1024 * 1024;
    this.framer = new LineFramer({
      maxLineBytes: maxRecordBytes,
      maxBufferBytes,
      // prime-agent writes LF, but a CRLF peer must not leave a stray CR
      // inside the record handed to JSON.parse.
      trimTrailingCr: true,
      onOversized: () =>
        this.emit(
          'protocolError',
          new Error(`prime-agent RPC record exceeded ${maxRecordBytes} bytes`)
        ),
      onBufferOverflow: () => {
        this.emit(
          'protocolError',
          new Error(
            `prime-agent RPC input buffer exceeded ${maxBufferBytes} bytes`
          )
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
    // An EventEmitter `error` without a listener terminates Node. Transport
    // errors are still observable, but are safe during early process startup.
    this.on('error', () => undefined);
  }

  /** Newest-last stderr and pre-readiness diagnostic lines, newline-joined. */
  get diagnosticTail(): string {
    return this.diagnosticRing.join('\n');
  }

  private recordDiagnostic(text: string): void {
    for (const line of text.split('\n')) {
      const trimmed = line.replace(/\s+$/, '');
      if (trimmed.trim().length === 0) continue;
      this.diagnosticRing.push(trimmed);
      while (this.diagnosticRing.length > this.diagnosticRingSize) {
        this.diagnosticRing.shift();
      }
    }
  }

  async start(): Promise<PrimeAgentRpcMessage> {
    if (this.child || this.stopPromise)
      throw new Error('PrimeAgentRpcClient already started');
    const spawnFn = this.options.spawn ?? nodeSpawn;
    const child = spawnFn(
      this.options.command ?? 'prime-agent',
      this.options.args ?? ['--mode', 'rpc'],
      {
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        stdio: 'pipe',
      }
    );
    this.child = child;
    this.framer.reset();
    const onStdoutData = (chunk: Buffer | string) => this.consume(chunk);
    const onStderrData = (chunk: Buffer | string) => {
      const text = String(chunk);
      this.recordDiagnostic(text);
      this.emit('stderr', text);
    };
    const onStreamError = (error: Error) => this.emit('error', error);
    const onChildError = (error: Error) => {
      this.rejectPending(error);
      this.emit('error', error);
    };
    const onClose = (code: number | null) => {
      const lastLine =
        this.diagnosticRing.length > 0
          ? this.diagnosticRing[this.diagnosticRing.length - 1]
          : undefined;
      const exitMsg = lastLine
        ? `prime-agent rpc exited (code=${String(code)}): ${lastLine}`
        : `prime-agent rpc exited (code=${String(code)})`;
      const error = new Error(exitMsg);
      if (this.child === child) {
        this.child = null;
        this.resetTransportState(error);
        this.removeChildListeners();
      }
      this.rejectPending(error);
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

    // RPC has no initialize handshake. A correlated get_state response is the
    // readiness barrier and supplies durable session identity.
    try {
      const response = await this.callWithTimeout(
        'get_state',
        {},
        this.options.readinessTimeoutMs ?? 10_000
      );
      this.ready = true;
      return response;
    } catch (error) {
      // A failed readiness barrier must not leave a live child, drain handler,
      // or unsent request behind for a later start attempt.
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  call(
    type: string,
    fields: Record<string, unknown> = {}
  ): Promise<PrimeAgentRpcMessage> {
    return this.callWithTimeout(
      type,
      fields,
      this.options.requestTimeoutMs ?? 30_000
    );
  }

  private callWithTimeout(
    type: string,
    fields: Record<string, unknown>,
    timeoutMs: number
  ): Promise<PrimeAgentRpcMessage> {
    if (!this.child)
      return Promise.reject(new Error('PrimeAgentRpcClient is not started'));
    const id = `relay-${this.nextId++}`;
    const promise = new Promise<PrimeAgentRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`prime-agent RPC ${type} timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, command: type, timer });
    });
    this.enqueue({ id, type, ...fields });
    return promise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) {
      this.resetTransportState(new Error('PrimeAgentRpcClient stopped'));
      return;
    }

    this.child = null;
    this.resetTransportState(new Error('PrimeAgentRpcClient stopped'));
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

  /**
   * Framing (LF splitting, partial-line buffering, the record and buffer caps)
   * belongs to `LineFramer`; everything below is prime-agent's own RPC dialect
   * — JSON validation wording, response correlation, and event routing.
   */
  private consume(chunk: Buffer | string): void {
    this.framer.push(chunk, (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    if (line.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!this.ready) {
        this.recordDiagnostic(line);
        return;
      }
      this.emit(
        'protocolError',
        new Error(
          `Invalid prime-agent RPC JSON: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      if (!this.ready) {
        this.recordDiagnostic(line);
        return;
      }
      this.emit(
        'protocolError',
        new Error('Invalid prime-agent RPC record: expected object')
      );
      return;
    }
    const message = value as PrimeAgentRpcMessage;
    if (message.type === 'response' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit(
          'protocolError',
          new Error(`Uncorrelated prime-agent RPC response id: ${message.id}`)
        );
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.command !== pending.command) {
        pending.reject(
          new Error(
            `prime-agent RPC response command mismatch: expected ${pending.command}, got ${String(message.command)}`
          )
        );
      } else if (message.success !== true) {
        pending.reject(
          new PrimeAgentRpcResponseError(pending.command, message)
        );
      } else {
        pending.resolve(message);
      }
    } else if (
      message.type === 'response' &&
      typeof message.id !== 'string' &&
      message.success === false &&
      typeof message.command === 'string'
    ) {
      // 0.7.0 dialect quirk: prime-agent returns unknown-command errors with id: undefined
      // (rpc-mode.js:371-374: error(undefined, type, "Unknown command: <type>")).
      // Correlate to the oldest pending call for that command.
      let matchedId: string | undefined;
      let matchedPending: PendingCall | undefined;
      for (const [id, pending] of this.pending) {
        if (pending.command === message.command) {
          matchedId = id;
          matchedPending = pending;
          break;
        }
      }
      if (matchedId && matchedPending) {
        this.pending.delete(matchedId);
        clearTimeout(matchedPending.timer);
        matchedPending.reject(
          new PrimeAgentRpcResponseError(matchedPending.command, message)
        );
      } else {
        this.emit('event', message);
      }
    } else {
      this.emit('event', message);
    }
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

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resetTransportState(error: Error): void {
    this.ready = false;
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
