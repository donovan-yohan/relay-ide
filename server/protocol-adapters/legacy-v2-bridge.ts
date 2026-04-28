import type { ProtocolAdapter } from '../protocol-adapter.js';
import { BaseProtocolAdapterV2 } from '../protocol-adapter-v2.js';
import type {
  AdapterConfig,
  AdapterStatus,
  AgentApprovalResponseInputV2,
  AgentInputResponseInputV2,
  AgentInterruptInputV2,
  AgentSendMessageInputV2,
} from '../protocol-adapter-v2.js';
import type {
  AgentApprovalDecisionV2,
  AgentCapabilitySetV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { mapChatEventToAgentPatchV2 } from '../../shared/agent-chat-v1-compat.js';

/**
 * Translate a V2 decision back to the v1 binary form expected by legacy adapters.
 * Legacy adapters (opencode, hermes) only support once/permanent accept and deny.
 * Unsupported decisions (cancel, session/turn scope, amendments) fall back to deny.
 */
function v2DecisionToLegacy(
  decision: AgentApprovalDecisionV2
): 'allow' | 'allow-always' | 'deny' {
  if (decision.kind === 'decline' || decision.kind === 'cancel') {
    return 'deny';
  }
  // kind === 'accept'
  const scope = decision.scope ?? 'once';
  if (scope === 'permanent') return 'allow-always';
  return 'allow';
}

export class LegacyProtocolAdapterV2Bridge extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership: 'spawned' | 'attached';
  readonly agentType: string;

  private unlisten: (() => void) | null = null;

  constructor(
    private readonly inner: ProtocolAdapter,
    readonly capabilities: AgentCapabilitySetV2
  ) {
    super();
    this.agentType = inner.agentType;
    this.runtimeOwnership = inner.runtimeOwnership;
  }

  get status(): AdapterStatus {
    return this.inner.status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.unlisten = this.inner.on((event) => {
      for (const patch of mapChatEventToAgentPatchV2(event)) {
        this.emitPatch(patch);
      }
    });
    await this.inner.connect(config);
  }

  protected async onDisconnect(): Promise<void> {
    this.unlisten?.();
    this.unlisten = null;
    await this.inner.disconnect();
  }

  async reconnect(): Promise<void> {
    await this.inner.reconnect();
  }

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    await this.inner.sendMessage(
      input.turnId,
      input.content,
      input.attachments
    );
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    await this.inner.interrupt(input.turnId ?? '');
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    await this.inner.respondToApproval(
      input.requestId,
      v2DecisionToLegacy(input.decision)
    );
  }

  async respondToInput(input: AgentInputResponseInputV2): Promise<void> {
    await this.inner.respondToInput(input.requestId, input.answers);
  }
}
