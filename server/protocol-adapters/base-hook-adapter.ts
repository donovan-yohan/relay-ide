import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { BaseProtocolAdapter } from '../protocol-adapter.js';
import type {
  AdapterConfig,
  AdapterStatus,
  SessionOptions,
  Attachment,
} from '../protocol-adapter.js';
import type { ChatEvent, ChatEventSource } from '../chat-events.js';
import { createLogger } from '../logger.js';

const logger = createLogger('hook-adapter');

/** Common hook event payload from all three agent backends */
export interface HookEventPayload {
  type: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export abstract class BaseHookAdapter extends BaseProtocolAdapter {
  protected _status: AdapterStatus = 'disconnected';
  protected _config: AdapterConfig | null = null;
  protected _process: ChildProcess | null = null;
  protected _turnCounter = 0;
  protected _currentTurnId: string | null = null;

  get status(): AdapterStatus {
    return this._status;
  }

  get process(): ChildProcess | null {
    return this._process;
  }

  /** Subclasses implement to build spawn command + args + env */
  protected abstract buildSpawnCommand(config: AdapterConfig): {
    command: string;
    args: string[];
    env: Record<string, string>;
  };

  /** Subclasses implement to set up hook infrastructure (config files, plugins) */
  protected abstract setupHooks(config: AdapterConfig): Promise<void>;

  /** Subclasses implement to clean up hook infrastructure */
  protected abstract cleanupHooks(config: AdapterConfig): Promise<void>;

  /** Subclasses implement to map an incoming hook event to ChatEvents (call fire() directly) */
  protected abstract mapHookEvent(payload: HookEventPayload): void;

  async connect(config: AdapterConfig): Promise<void> {
    this._config = config;
    this._status = 'connecting';

    await this.setupHooks(config);

    const { command, args, env } = this.buildSpawnCommand(config);

    this._process = spawn(command, args, {
      cwd: config.cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._process.on('exit', (code) => {
      logger.info(`[${this.agentType}] process exited with code ${code}`);
      if (this._status === 'connected') {
        this._status = 'error';
        this.fire({
          type: 'chat:error',
          kind: 'protocol',
          message: `Agent process exited with code ${code}`,
          retryable: true,
        });
        this.fire({ type: 'chat:session-status', status: 'disconnected' });
      }
    });

    this._process.on('error', (err) => {
      logger.error(`[${this.agentType}] process error:`, err);
      this._status = 'error';
      this.fire({
        type: 'chat:error',
        kind: 'protocol',
        message: err.message,
        retryable: false,
      });
    });

    this._status = 'connected';
    this.fire({
      type: 'chat:session-started',
      sessionId: config.sessionId,
      agentType: this.agentType,
    });
    this.fire({ type: 'chat:session-status', status: 'idle' });
  }

  protected async onDisconnect(): Promise<void> {
    if (this._process) {
      try {
        this._process.kill('SIGTERM');
      } catch {
        /* may already be dead */
      }
      this._process = null;
    }
    if (this._config) {
      await this.cleanupHooks(this._config).catch(() => {});
    }
    this._status = 'disconnected';
  }

  async reconnect(): Promise<void> {
    if (!this._config)
      throw new Error('Cannot reconnect before initial connect');
    const config = this._config;
    await this.disconnect();
    await this.connect(config);
  }

  /** Called by the web-session HTTP handler when a hook event arrives */
  handleHookEvent(payload: HookEventPayload): void {
    this.mapHookEvent(payload);
  }

  async sendMessage(
    turnId: string,
    content: string,
    _attachments?: Attachment[]
  ): Promise<void> {
    if (!this._process?.stdin?.writable) {
      throw new Error('Agent process stdin not available');
    }
    this._currentTurnId = turnId;
    // Write first — only emit lifecycle events after successful write
    try {
      this._process.stdin.write(content + '\n');
    } catch (err) {
      this.fire({
        type: 'chat:error',
        kind: 'protocol',
        message: `stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
        turnId,
      });
      throw err;
    }
    this.fire({ type: 'chat:session-status', status: 'active' });
    this.fire({
      type: 'chat:turn-started',
      turnId,
      turnIndex: this._turnCounter++,
    });
  }

  async interrupt(_turnId: string): Promise<void> {
    if (this._process) {
      this._process.kill('SIGINT');
    }
  }

  async respondToApproval(
    _requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<void> {
    if (!this._process?.stdin?.writable) {
      this.fire({
        type: 'chat:error',
        kind: 'protocol',
        message: 'Cannot deliver approval — agent stdin unavailable',
        retryable: false,
      });
      throw new Error('Agent process stdin not available for approval');
    }
    if (decision === 'allow' || decision === 'allow-always') {
      this._process.stdin.write('y\n');
    } else {
      this._process.stdin.write('n\n');
    }
  }

  async respondToInput(
    _requestId: string,
    answers: Record<string, string[]>
  ): Promise<void> {
    if (!this._process?.stdin?.writable) {
      this.fire({
        type: 'chat:error',
        kind: 'protocol',
        message: 'Cannot deliver input — agent stdin unavailable',
        retryable: false,
      });
      throw new Error('Agent process stdin not available for input');
    }
    const firstAnswer = Object.values(answers)[0]?.[0];
    if (firstAnswer) this._process.stdin.write(firstAnswer + '\n');
  }

  async createSession(
    _cwd: string,
    _options?: SessionOptions
  ): Promise<string> {
    return this._config?.sessionId ?? crypto.randomBytes(8).toString('hex');
  }

  async resumeSession(_sessionId: string): Promise<void> {
    // no-op — resume handled by spawn args
  }

  async forkSession(_sessionId: string): Promise<string> {
    return crypto.randomBytes(8).toString('hex');
  }

  /** Helper to build full ChatEvent from partial fields. */
  protected fire(
    partial: { type: ChatEvent['type'] } & Record<string, unknown>
  ): void {
    const sessionId = this._config?.sessionId ?? '';
    this.emit({
      ...partial,
      sessionId,
      timestamp: new Date().toISOString(),
      source: this.agentType as ChatEventSource,
    } as ChatEvent);
  }
}
