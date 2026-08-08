import { createLogger } from './logger.js';
import type {
  AdapterConfig,
  AdapterStatus,
  Attachment,
} from './protocol-adapter.js';
import {
  isAgentPatchV2,
  withAgentDetailCards,
  type AgentApprovalDecisionV2,
  type AgentCapabilitySetV2,
  type AgentPatchV2,
} from '../shared/agent-chat-protocol-v2.js';
import type { PromptAttachment } from '../shared/prompt-attachment.js';

export type { AdapterConfig, AdapterStatus, Attachment };

const logger = createLogger('protocol-adapter-v2');

export interface AgentSendMessageInputV2 {
  turnId: string;
  content: string;
  /** Legacy adapter-shaped attachments — local path + mime. */
  attachments?: Attachment[];
  /**
   * Typed federated attachments routed in via slice 3 of #616. Adapters
   * that do not yet consume these MUST ignore the field; behavior change
   * lands per-adapter in a follow-on slice.
   */
  promptAttachments?: PromptAttachment[];
  clientMessageId?: string;
}

/** Explicit Relay control invocation. Never represents a user prompt. */
export interface AgentControlCommandInputV2 {
  command: string;
  args?: string;
  confirmed?: boolean;
}

export interface AgentInterruptInputV2 {
  turnId?: string;
}

/** A provider explicitly declined a steer before accepting its input. */
export class AgentSteerRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSteerRejectedError';
  }
}

export interface AgentApprovalResponseInputV2 {
  requestId: string;
  decision: AgentApprovalDecisionV2;
}

export interface AgentInputResponseInputV2 {
  requestId: string;
  answers: Record<string, string[]>;
}

export type AgentPatchHandlerV2 = (patch: AgentPatchV2) => void;

export interface ProtocolAdapterV2 {
  connect(config: AdapterConfig): Promise<void>;
  /**
   * When true, `connect()` consumes `AdapterConfig.resumeSessionId` atomically.
   * The runtime manager must not follow it with a second `resumeSession()`.
   */
  readonly resumesProviderSessionDuringConnect?: boolean;
  disconnect(): Promise<void>;
  /**
   * Replace the runtime-only environment used by an owned subprocess.
   * Implementations must prevent later queued work from using the old process.
   */
  refreshRuntimeEnv?(processEnv: Record<string, string>): Promise<void>;
  /**
   * Transport-level reconnect with no state change. Tears down and re-establishes
   * the underlying connection using the same session configuration as before.
   * Use when the transport drops and you want to continue the same session state.
   */
  reconnect(): Promise<void>;
  /**
   * Provider-level reattach to a prior session identified by `sessionId`.
   * The adapter loads or replays conversation history for that session so the
   * UI can continue where it left off. Distinct from `reconnect()`: this
   * carries explicit provider-session identity and may replay server state.
   * Providers that do not support resume must emit `capabilities.resume = false`
   * and throw with a clear error if this method is called.
   */
  resumeSession(sessionId: string): Promise<void>;
  sendMessage(input: AgentSendMessageInputV2): Promise<void>;
  /**
   * Add an operator message to the active provider turn at its native safe
   * boundary. Optional because legacy harnesses can only queue a follow-up.
   */
  steerMessage?(input: AgentSendMessageInputV2): Promise<void>;
  /** Provider-owned Relay control lane; absent means commands are unsupported. */
  executeControlCommand?(
    input: AgentControlCommandInputV2
  ): Promise<{ config?: Record<string, unknown> }>;
  interrupt(input: AgentInterruptInputV2): Promise<void>;
  respondToApproval(input: AgentApprovalResponseInputV2): Promise<void>;
  respondToInput(input: AgentInputResponseInputV2): Promise<void>;
  onPatch(handler: AgentPatchHandlerV2): () => void;
  broadcastPatch(patch: AgentPatchV2): void;
  readonly capabilities: AgentCapabilitySetV2;
  readonly status: AdapterStatus;
  readonly runtimeOwnership: 'spawned' | 'attached';
  /** Roots of subprocess trees owned by this adapter, if any. */
  ownedProcessRootPids?(): number[];
  readonly agentType: string;
  /** Redaction-safe command previews for a currently connected session. */
  getSlashCommands?(): import('../shared/agent-chat-protocol-v2.js').AgentSlashCommandV2[];
}

export abstract class BaseProtocolAdapterV2 implements ProtocolAdapterV2 {
  private readonly handlers = new Set<AgentPatchHandlerV2>();

  abstract connect(config: AdapterConfig): Promise<void>;

  async disconnect(): Promise<void> {
    try {
      await this.onDisconnect();
    } finally {
      this.handlers.clear();
    }
  }

  protected abstract onDisconnect(): Promise<void>;

  abstract reconnect(): Promise<void>;
  abstract resumeSession(sessionId: string): Promise<void>;
  abstract sendMessage(input: AgentSendMessageInputV2): Promise<void>;
  abstract interrupt(input: AgentInterruptInputV2): Promise<void>;
  abstract respondToApproval(
    input: AgentApprovalResponseInputV2
  ): Promise<void>;
  abstract respondToInput(input: AgentInputResponseInputV2): Promise<void>;
  abstract readonly capabilities: AgentCapabilitySetV2;
  abstract readonly status: AdapterStatus;
  abstract readonly runtimeOwnership: 'spawned' | 'attached';
  abstract readonly agentType: string;

  onPatch(handler: AgentPatchHandlerV2): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Broadcast a patch to all currently-registered onPatch handlers.
   *
   * Used when a runtime needs to emit one patch to every channel listener.
   */
  broadcastPatch(patch: AgentPatchV2): void {
    this.emitPatch(patch);
  }

  protected emitPatch(patch: AgentPatchV2): void {
    const normalizedPatch = withAgentDetailCards(patch);
    if (!isAgentPatchV2(normalizedPatch)) {
      logger.error(`[${this.agentType}] invalid AgentPatchV2:`, patch);
      throw new Error(
        `[${this.agentType}] attempted to emit invalid AgentPatchV2`
      );
    }

    for (const handler of [...this.handlers]) {
      try {
        handler(normalizedPatch);
      } catch (err) {
        logger.error(`[${this.agentType}] AgentPatchV2 handler error:`, err);
      }
    }
  }
}
