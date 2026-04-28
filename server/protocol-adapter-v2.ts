import { createLogger } from './logger.js';
import type {
  AdapterConfig,
  AdapterStatus,
  Attachment,
} from './protocol-adapter.js';
import {
  isAgentPatchV2,
  type AgentApprovalDecisionV2,
  type AgentCapabilitySetV2,
  type AgentPatchV2,
} from '../shared/agent-chat-protocol-v2.js';

export type { AdapterConfig, AdapterStatus, Attachment };

const logger = createLogger('protocol-adapter-v2');

export interface AgentSendMessageInputV2 {
  turnId: string;
  content: string;
  attachments?: Attachment[];
  clientMessageId?: string;
}

export interface AgentInterruptInputV2 {
  turnId?: string;
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
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  sendMessage(input: AgentSendMessageInputV2): Promise<void>;
  interrupt(input: AgentInterruptInputV2): Promise<void>;
  respondToApproval(input: AgentApprovalResponseInputV2): Promise<void>;
  respondToInput(input: AgentInputResponseInputV2): Promise<void>;
  onPatch(handler: AgentPatchHandlerV2): () => void;
  readonly capabilities: AgentCapabilitySetV2;
  readonly status: AdapterStatus;
  readonly runtimeOwnership: 'spawned' | 'attached';
  readonly agentType: string;
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

  protected emitPatch(patch: AgentPatchV2): void {
    if (!isAgentPatchV2(patch)) {
      logger.error(`[${this.agentType}] invalid AgentPatchV2:`, patch);
      throw new Error(
        `[${this.agentType}] attempted to emit invalid AgentPatchV2`
      );
    }

    for (const handler of [...this.handlers]) {
      try {
        handler(patch);
      } catch (err) {
        logger.error(`[${this.agentType}] AgentPatchV2 handler error:`, err);
      }
    }
  }
}
