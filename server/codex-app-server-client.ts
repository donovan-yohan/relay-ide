import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createLogger } from './logger.js';

const logger = createLogger('codex-app-server-client');

// ── Public types ─────────────────────────────────────────────────────────────

export interface CodexAppServerClientOptions {
  /** Default: 'codex' */
  command?: string;
  /** Default: ['app-server'] */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  clientInfo: { name: string; title: string; version: string };
  optOutNotificationMethods?: string[];
  /**
   * Dependency-injection hook for tests. When provided it is called instead
   * of node:child_process.spawn. The returned object must expose
   * stdin/stdout/stderr streams and a `kill` method.
   */
  spawn?: (
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; stdio: 'pipe' },
  ) => ChildProcess;
}

export interface CodexNotification {
  method: string;
  params?: unknown;
}

export interface CodexServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type OutboundMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * JSON-RPC 2.0 client for the `codex app-server` child-process transport.
 *
 * Wire format: newline-delimited JSON (one JSON object per line) over
 * child process stdin (outbound) and stdout (inbound).
 *
 * Emits:
 *   'notification' (CodexNotification)  — server notification (no id)
 *   'request'      (CodexServerRequest) — server-initiated request (has id)
 *   'error'        (Error)              — unrecoverable transport error
 *   'close'        (code: number|null)  — child process exited
 */
export class CodexAppServerClient extends EventEmitter {
  private readonly options: Required<
    Pick<CodexAppServerClientOptions, 'command' | 'args'>
  > &
    CodexAppServerClientOptions;

  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingCall>();

  // Outbound write queue + backpressure state
  private writeQueue: string[] = [];
  private draining = false;

  // Line-buffer for partial stdout reads
  private lineBuffer = '';

  constructor(options: CodexAppServerClientOptions) {
    super();
    this.options = {
      command: 'codex',
      // Conductor passes --listen stdio:// explicitly. Newer codex
      // versions default to TCP, so stdio must be opted in.
      args: ['app-server', '--listen', 'stdio://'],
      ...options,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Spawn the child process, send the `initialize` request, wait for the
   * response, send the `initialized` notification, and return server metadata.
   */
  async start(): Promise<{
    userAgent?: string;
    codexHome?: string;
    platform?: string;
  }> {
    if (this.child) {
      throw new Error('CodexAppServerClient already started');
    }

    const spawnFn = this.options.spawn ?? nodeSpawn;
    const { command, args, cwd, env } = this.options;

    const child = spawnFn(command, args, {
      ...(cwd !== undefined ? { cwd } : {}),
      env: env ?? (process.env as Record<string, string>),
      stdio: 'pipe',
    });
    this.child = child;

    // Stderr → warn
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          logger.warn('[stderr] %s', trimmed);
        }
      }
    });

    // Stdout → line-delimited JSON parser
    child.stdout?.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString();
      let idx: number;
      while ((idx = this.lineBuffer.indexOf('\n')) !== -1) {
        const line = this.lineBuffer.slice(0, idx);
        this.lineBuffer = this.lineBuffer.slice(idx + 1);
        this.handleLine(line);
      }
    });

    child.on('close', (code) => {
      const err = new Error(`codex app-server exited (code=${code})`);
      this.rejectAllPending(err);
      this.emit('close', code);
    });

    child.on('error', (err) => {
      this.rejectAllPending(err);
      this.emit('error', err);
    });

    // Send initialize
    const initResult = await this.call<{
      serverInfo?: { name?: string; version?: string };
      capabilities?: unknown;
      codexHome?: string;
      platform?: string;
      userAgent?: string;
    }>('initialize', {
      clientInfo: this.options.clientInfo,
      capabilities: {
        ...(this.options.optOutNotificationMethods?.length
          ? { optOutNotificationMethods: this.options.optOutNotificationMethods }
          : {}),
      },
    });

    // Send initialized notification (no id, no params)
    this.enqueue({
      jsonrpc: '2.0',
      method: 'initialized',
    });

    return {
      ...(initResult.userAgent !== undefined ? { userAgent: initResult.userAgent } : {}),
      ...(initResult.codexHome !== undefined ? { codexHome: initResult.codexHome } : {}),
      ...(initResult.platform !== undefined ? { platform: initResult.platform } : {}),
    };
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
    });
    this.enqueue({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  /**
   * Reply to a server-initiated request with a successful result.
   */
  respondToServerRequest(id: number | string, result: unknown): void {
    this.enqueue({ jsonrpc: '2.0', id, result });
  }

  /**
   * Reply to a server-initiated request with a JSON-RPC error.
   */
  respondToServerRequestError(
    id: number | string,
    code: number,
    message: string,
  ): void {
    this.enqueue({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /**
   * Terminate the child process.  Rejects all pending calls.
   */
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (!this.child) return;

    const child = this.child;
    this.child = null;

    const waitClose = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });

    child.kill(signal);
    await waitClose;

    this.rejectAllPending(new Error('CodexAppServerClient stopped'));
    child.removeAllListeners();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /** Parse a single stdout line as JSON-RPC and dispatch. */
  private handleLine(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;

    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.warn('codex-app-server: malformed JSON line: %s', trimmed);
      return;
    }

    if (typeof msg !== 'object' || msg === null) {
      logger.warn('codex-app-server: unexpected non-object message');
      return;
    }

    const obj = msg as Record<string, unknown>;

    // Response to one of our outbound requests
    if ('id' in obj && !('method' in obj)) {
      const id = obj['id'] as number | string;
      const pending = this.pending.get(id);
      if (!pending) {
        logger.warn(
          'codex-app-server: response for unknown id %s',
          String(id),
        );
        return;
      }
      this.pending.delete(id);

      if ('error' in obj && obj['error'] != null) {
        const err = obj['error'] as { code?: number; message?: string };
        pending.reject(
          new Error(
            err.message ??
              `JSON-RPC error (code=${String(err.code ?? 'unknown')})`,
          ),
        );
      } else {
        pending.resolve(obj['result']);
      }
      return;
    }

    // Server-initiated request (has both id and method)
    if ('method' in obj && 'id' in obj) {
      const req: CodexServerRequest = {
        id: obj['id'] as number | string,
        method: obj['method'] as string,
        params: obj['params'],
      };
      this.emit('request', req);
      return;
    }

    // Notification (method only, no id)
    if ('method' in obj) {
      const notification: CodexNotification = {
        method: obj['method'] as string,
        params: obj['params'],
      };
      this.emit('notification', notification);
      return;
    }

    logger.warn('codex-app-server: unrecognised message shape');
  }

  /** Serialize a message and push it onto the outbound queue, then flush. */
  private enqueue(msg: OutboundMessage): void {
    this.writeQueue.push(JSON.stringify(msg) + '\n');
    this.flush();
  }

  /** Flush the outbound queue respecting stdin backpressure. */
  private flush(): void {
    if (this.draining) return;
    const stdin = this.child?.stdin;
    if (!stdin) return;

    while (this.writeQueue.length > 0) {
      const line = this.writeQueue.shift()!;
      const ok = stdin.write(line);
      if (!ok) {
        // stdin buffer full — wait for 'drain' before writing more
        this.draining = true;
        stdin.once('drain', () => {
          this.draining = false;
          this.flush();
        });
        break;
      }
    }
  }

  /** Reject every pending call with the given error. */
  private rejectAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}
