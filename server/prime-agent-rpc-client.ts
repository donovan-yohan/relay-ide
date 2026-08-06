import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface PrimeAgentRpcMessage extends Record<string, unknown> {
  type: string;
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
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private readonly writes: string[] = [];
  private draining = false;

  constructor(private readonly options: PrimeAgentRpcClientOptions = {}) {
    super();
    // An EventEmitter `error` without a listener terminates Node. Transport
    // errors are still observable, but are safe during early process startup.
    this.on('error', () => undefined);
  }

  async start(): Promise<PrimeAgentRpcMessage> {
    if (this.child) throw new Error('PrimeAgentRpcClient already started');
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
    child.stdout?.on('data', (chunk: Buffer | string) =>
      this.consume(String(chunk))
    );
    child.stderr?.on('data', (chunk: Buffer | string) =>
      this.emit('stderr', String(chunk))
    );
    child.stdin?.on('error', (error: Error) => this.emit('error', error));
    child.stdout?.on('error', (error: Error) => this.emit('error', error));
    child.stderr?.on('error', (error: Error) => this.emit('error', error));
    child.on('error', (error: Error) => {
      this.rejectPending(error);
      this.emit('error', error);
    });
    child.on('close', (code) => {
      this.child = null;
      const error = new Error(`prime-agent rpc exited (code=${String(code)})`);
      this.rejectPending(error);
      this.emit('close', code);
    });

    // RPC has no initialize handshake. A correlated get_state response is the
    // readiness barrier and supplies durable session identity.
    return this.callWithTimeout(
      'get_state',
      {},
      this.options.readinessTimeoutMs ?? 10_000
    );
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
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.rejectPending(new Error('PrimeAgentRpcClient stopped'));
    child.kill('SIGTERM');
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const maxBufferBytes = this.options.maxBufferBytes ?? 16 * 1024 * 1024;
    if (
      Buffer.byteLength(this.buffer) > maxBufferBytes &&
      !this.buffer.includes('\n')
    ) {
      this.buffer = '';
      this.emit(
        'protocolError',
        new Error(
          `prime-agent RPC input buffer exceeded ${maxBufferBytes} bytes`
        )
      );
      return;
    }
    let newline: number;
    // Deliberately split only on ASCII LF. U+2028/U+2029 are JSON content.
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length === 0) continue;
      const maxRecordBytes = this.options.maxRecordBytes ?? 8 * 1024 * 1024;
      if (Buffer.byteLength(line) > maxRecordBytes) {
        this.emit(
          'protocolError',
          new Error(`prime-agent RPC record exceeded ${maxRecordBytes} bytes`)
        );
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        this.emit(
          'protocolError',
          new Error(
            `Invalid prime-agent RPC JSON: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        this.emit(
          'protocolError',
          new Error('Invalid prime-agent RPC record: expected object')
        );
        continue;
      }
      const message = value as PrimeAgentRpcMessage;
      if (message.type === 'response' && typeof message.id === 'string') {
        const pending = this.pending.get(message.id);
        if (!pending) {
          this.emit(
            'protocolError',
            new Error(`Uncorrelated prime-agent RPC response id: ${message.id}`)
          );
          continue;
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
      if (!stdin.write(line)) {
        this.draining = true;
        stdin.once('drain', () => {
          this.draining = false;
          this.flush();
        });
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
}
