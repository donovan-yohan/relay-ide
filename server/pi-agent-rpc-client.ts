import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface PiAgentRpcMessage extends Record<string, unknown> {
  type: string;
}

export interface PiAgentRpcClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  readinessTimeoutMs?: number;
  maxBufferBytes?: number;
  maxRecordBytes?: number;
  stopTimeoutMs?: number;
  spawn?: (
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; stdio: 'pipe' }
  ) => ChildProcess;
}

interface PendingCall {
  resolve: (value: PiAgentRpcMessage) => void;
  reject: (error: Error) => void;
  command: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Strict-LF JSONL client for `pi --mode rpc`. */
export class PiAgentRpcClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private stopPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private readonly writes: string[] = [];
  private draining = false;
  private detachChildListeners: (() => void) | null = null;
  private detachDrainListener: (() => void) | null = null;

  constructor(private readonly options: PiAgentRpcClientOptions = {}) {
    super();
    // An EventEmitter `error` without a listener terminates Node. Transport
    // errors are still observable, but are safe during early process startup.
    this.on('error', () => undefined);
  }

  async start(): Promise<PiAgentRpcMessage> {
    if (this.child || this.stopPromise)
      throw new Error('PiAgentRpcClient already started');
    const spawnFn = this.options.spawn ?? nodeSpawn;
    const child = spawnFn(
      this.options.command ?? 'pi',
      this.options.args ?? ['--mode', 'rpc'],
      {
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        stdio: 'pipe',
      }
    );
    this.child = child;
    this.buffer = Buffer.alloc(0);
    const onStdoutData = (chunk: Buffer | string) => this.consume(chunk);
    const onStderrData = (chunk: Buffer | string) =>
      this.emit('stderr', String(chunk));
    const onStreamError = (error: Error) => this.emit('error', error);
    const onChildError = (error: Error) => {
      this.rejectPending(error);
      this.emit('error', error);
    };
    const onClose = (code: number | null) => {
      if (this.child === child) {
        this.child = null;
        this.resetTransportState(
          new Error(`pi rpc exited (code=${String(code)})`)
        );
        this.removeChildListeners();
      }
      const error = new Error(`pi rpc exited (code=${String(code)})`);
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
      return await this.callWithTimeout(
        'get_state',
        {},
        this.options.readinessTimeoutMs ?? 10_000
      );
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
  ): Promise<PiAgentRpcMessage> {
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
  ): Promise<PiAgentRpcMessage> {
    if (!this.child)
      return Promise.reject(new Error('PiAgentRpcClient is not started'));
    const id = `relay-${this.nextId++}`;
    const promise = new Promise<PiAgentRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi RPC ${type} timed out after ${timeoutMs}ms`));
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
      this.resetTransportState(new Error('PiAgentRpcClient stopped'));
      return;
    }

    this.child = null;
    this.resetTransportState(new Error('PiAgentRpcClient stopped'));
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

  private consume(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const maxBufferBytes = this.options.maxBufferBytes ?? 16 * 1024 * 1024;
    let newline: number;
    // Deliberately split only on ASCII LF. U+2028/U+2029 are JSON content.
    while ((newline = this.buffer.indexOf(0x0a)) !== -1) {
      let lineBytes = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
      if (lineBytes.length === 0) continue;
      const maxRecordBytes = this.options.maxRecordBytes ?? 8 * 1024 * 1024;
      if (lineBytes.length > maxRecordBytes) {
        this.emit(
          'protocolError',
          new Error(`pi RPC record exceeded ${maxRecordBytes} bytes`)
        );
        continue;
      }
      const line = lineBytes.toString('utf8');
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        this.emit(
          'protocolError',
          new Error(
            `Invalid pi RPC JSON: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        this.emit(
          'protocolError',
          new Error('Invalid pi RPC record: expected object')
        );
        continue;
      }
      const message = value as PiAgentRpcMessage;
      if (message.type === 'response' && typeof message.id === 'string') {
        const pending = this.pending.get(message.id);
        if (!pending) {
          this.emit(
            'protocolError',
            new Error(`Uncorrelated pi RPC response id: ${message.id}`)
          );
          continue;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.command !== pending.command) {
          pending.reject(
            new Error(
              `pi RPC response command mismatch: expected ${pending.command}, got ${String(message.command)}`
            )
          );
        } else if (message.success !== true) {
          pending.reject(
            new Error(
              typeof message.error === 'string'
                ? message.error
                : `${pending.command} failed`
            )
          );
        } else {
          pending.resolve(message);
        }
      } else {
        this.emit('event', message);
      }
    }

    // Check again after consuming complete records: a chunk can contain valid
    // lines followed by an oversized unterminated tail.
    if (this.buffer.length > maxBufferBytes) {
      this.buffer = Buffer.alloc(0);
      const error = new Error(
        `pi RPC input buffer exceeded ${maxBufferBytes} bytes`
      );
      this.emit('protocolError', error);
      // Discarding an unterminated record loses framing. Stop rather than risk
      // interpreting a later suffix as a fresh trusted record.
      void this.stop().catch((stopError: unknown) =>
        this.emit(
          'error',
          stopError instanceof Error ? stopError : new Error(String(stopError))
        )
      );
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
    this.rejectPending(error);
    this.buffer = Buffer.alloc(0);
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
