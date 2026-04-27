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
import type { AgentCapabilitySetV2 } from '../../shared/agent-chat-protocol-v2.js';
import { mapChatEventToAgentPatchV2 } from '../../shared/agent-chat-v1-compat.js';

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
    await this.inner.respondToApproval(input.requestId, input.decision);
  }

  async respondToInput(input: AgentInputResponseInputV2): Promise<void> {
    await this.inner.respondToInput(input.requestId, input.answers);
  }
}
