import { BaseProtocolAdapter } from '../protocol-adapter.js';
import type {
  AdapterConfig,
  AdapterStatus,
  Attachment,
  SessionOptions,
} from '../protocol-adapter.js';
import { createLogger } from '../logger.js';
import crypto from 'node:crypto';

const _logger = createLogger('attached-adapter');

/**
 * Base class for adapters that attach to an already-running agent runtime
 * (e.g. opencode serve/web) rather than spawning their own process.
 *
 * Subclasses implement the HTTP/SSE transport to the external server.
 */
export abstract class AttachedRuntimeAdapter extends BaseProtocolAdapter {
  protected _status: AdapterStatus = 'disconnected';
  protected _config: AdapterConfig | null = null;

  readonly runtimeOwnership = 'attached' as const;

  get status(): AdapterStatus {
    return this._status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this._config = config;
    this._status = 'connecting';
    await this.onConnect(config);
    this._status = 'connected';
    this.fire({
      type: 'chat:session-started',
      sessionId: config.sessionId,
      agentType: this.agentType,
    });
    this.fire({ type: 'chat:session-status', status: 'idle' });
  }

  /** Subclass hook: perform the actual network connection to the runtime */
  protected abstract onConnect(config: AdapterConfig): Promise<void>;

  protected async onDisconnect(): Promise<void> {
    await this.onDetach();
    this._status = 'disconnected';
  }

  /** Subclass hook: tear down network connections */
  protected abstract onDetach(): Promise<void>;

  async reconnect(): Promise<void> {
    if (!this._config)
      throw new Error('Cannot reconnect before initial connect');
    const config = this._config;
    // For attached runtimes, reconnect means re-attaching to the same endpoint,
    // not respawning a new process.
    await this.onDetach().catch(() => {});
    this._status = 'connecting';
    await this.onConnect(config);
    this._status = 'connected';
  }

  abstract sendMessage(
    turnId: string,
    content: string,
    attachments?: Attachment[]
  ): Promise<void>;

  abstract interrupt(turnId: string): Promise<void>;

  abstract respondToApproval(
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<void>;

  abstract respondToInput(
    requestId: string,
    answers: Record<string, string[]>
  ): Promise<void>;

  async createSession(
    _cwd: string,
    _options?: SessionOptions
  ): Promise<string> {
    return this._config?.sessionId ?? crypto.randomBytes(8).toString('hex');
  }

  async resumeSession(_sessionId: string): Promise<void> {
    // no-op for attached runtimes — session lives in the external server
  }

  async forkSession(_sessionId: string): Promise<string> {
    return crypto.randomBytes(8).toString('hex');
  }

  /** Helper to build full ChatEvent from partial fields. */
  protected fire(
    partial: {
      type: import('../../shared/chat-events.js').ChatEvent['type'];
    } & Record<string, unknown>
  ): void {
    const sessionId = this._config?.sessionId ?? '';
    this.emit({
      ...partial,
      sessionId,
      timestamp: new Date().toISOString(),
      source: this
        .agentType as import('../../shared/chat-events.js').ChatEvent['source'],
    } as import('../../shared/chat-events.js').ChatEvent);
  }
}
