// ProtocolAdapter — the compatibility abstraction for channel agent runtimes.
// Each agent backend (Codex, OpenCode, Claude Code) implements this interface
// to normalize their native protocol into the canonical ChatEvent type system.
//
// relay-ide server is the proxy — browsers never talk to agent backends directly.
// Adapters connect to agent processes/servers and emit ChatEvents over the event bus.

import { createLogger } from './logger.js';
import type { ChatEvent } from '../shared/chat-events.js';

const logger = createLogger('protocol-adapter');

export interface AdapterConfig {
  /** Working directory for the adapter-private channel runtime */
  cwd: string;
  /** relay-ide server port (for hooks callbacks) */
  port: number;
  /** Private channel runtime ID */
  sessionId: string;
  /** Token for authenticating inbound hook callbacks */
  hookToken: string;
  /** relay-ide config directory path */
  configDir: string;
  /** Agent permission mode (e.g. 'default' | 'acceptEdits' | 'bypassPermissions') */
  permissionMode?: string;
  /** Model override (e.g. 'claude-opus-4-6') */
  model?: string;
  /**
   * Runtime-only subprocess environment overlay. Credentials belong here, not
   * in `extra`, because provider options are persisted with channel bindings.
   */
  processEnv?: Record<string, string>;
  /**
   * Relay-authored system-prompt appendix. Adapters translate this semantic
   * field into their provider-specific launch argument.
   */
  systemPromptAppendix?: string;
  /** Additional agent-specific configuration */
  extra?: Record<string, unknown>;
}

export interface SessionOptions {
  /** Resume provider-native conversation state by its provider ID */
  resumeSessionId?: string;
  /** Additional context dirs to include in the agent's workspace */
  additionalDirs?: string[];
  /** Custom system prompt override */
  systemPrompt?: string;
}

export interface Attachment {
  type: 'file' | 'image' | 'url';
  /** File path (for file/image) or URL (for url) */
  path: string;
  /** MIME type (optional, detected if omitted) */
  mimeType?: string;
}

export type AdapterStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

/** Handler for ChatEvents emitted by the adapter */
export type ChatEventHandler = (event: ChatEvent) => void;

/**
 * ProtocolAdapter — implemented by each agent backend.
 *
 * Lifecycle: disconnected → connect() → connected → disconnect() → disconnected
 * Reconnect is supported via reconnect() which reuses existing config.
 */
export interface ProtocolAdapter {
  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Connect to the agent backend and start the session */
  connect(config: AdapterConfig): Promise<void>;

  /** Gracefully disconnect and clean up resources */
  disconnect(): Promise<void>;

  /** Reconnect after a connection drop (reuses existing config) */
  reconnect(): Promise<void>;

  // ── User Actions ──────────────────────────────────────────────────────────

  /**
   * Send a user message to the agent to start a new turn.
   * Emits TurnStartedEvent, then streaming content events.
   */
  sendMessage(
    turnId: string,
    content: string,
    attachments?: Attachment[]
  ): Promise<void>;

  /** Interrupt the currently active turn */
  interrupt(turnId: string): Promise<void>;

  /** Respond to a pending approval request */
  respondToApproval(
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<void>;

  /** Respond to a structured input request from the agent */
  respondToInput(
    requestId: string,
    answers: Record<string, string[]>
  ): Promise<void>;

  // ── Provider Conversation State ───────────────────────────────────────────

  /** Create provider-native conversation state for a private channel runtime */
  createSession(cwd: string, options?: SessionOptions): Promise<string>;

  /** Resume provider-native conversation state; not a public Relay Session */
  resumeSession(sessionId: string): Promise<void>;

  /** Fork provider-native conversation state and return its provider ID */
  forkSession(sessionId: string): Promise<string>;

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Register a handler for ChatEvents emitted by this adapter.
   * Returns an unsubscribe function.
   */
  on(handler: ChatEventHandler): () => void;

  // ── State ─────────────────────────────────────────────────────────────────

  /** Current connection status */
  readonly status: AdapterStatus;

  /** Who owns the agent runtime process */
  readonly runtimeOwnership: 'spawned' | 'attached';

  /** Agent type identifier (e.g. 'codex', 'opencode', 'claude', 'mock') */
  readonly agentType: string;
}

/**
 * Base class for ProtocolAdapter implementations.
 * Handles event subscription management — subclasses call emit() to fire events.
 */
export abstract class BaseProtocolAdapter implements ProtocolAdapter {
  private readonly handlers = new Set<ChatEventHandler>();

  abstract connect(config: AdapterConfig): Promise<void>;

  /**
   * Gracefully disconnect and clean up resources.
   * Calls onDisconnect() then clears all event handlers — subclasses must not
   * override this method; implement onDisconnect() instead so cleanup is guaranteed.
   */
  async disconnect(): Promise<void> {
    try {
      await this.onDisconnect();
    } finally {
      this.handlers.clear();
    }
  }

  /** Subclass hook: tear down connections and release resources before handlers are cleared */
  protected abstract onDisconnect(): Promise<void>;

  abstract reconnect(): Promise<void>;
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
  abstract createSession(
    cwd: string,
    options?: SessionOptions
  ): Promise<string>;
  abstract resumeSession(sessionId: string): Promise<void>;
  abstract forkSession(sessionId: string): Promise<string>;
  abstract readonly status: AdapterStatus;
  abstract readonly runtimeOwnership: 'spawned' | 'attached';
  abstract readonly agentType: string;

  on(handler: ChatEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  protected emit(event: ChatEvent): void {
    // Snapshot to prevent issues if a handler adds/removes subscribers during dispatch
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (err) {
        // Prevent one bad handler from breaking the event pipeline
        logger.error(`[${this.agentType}] ChatEvent handler error:`, err);
      }
    }
  }
}
