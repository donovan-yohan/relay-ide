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

const NOT_IMPLEMENTED = 'not implemented';

export class ClaudeProtocolAdapterV2 extends BaseProtocolAdapterV2 {
  readonly agentType = 'claude';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    reasoning: true,
    tools: true,
    commandExecution: true,
    fileChanges: true,
    approvals: true,
    questions: false,
    plans: false,
    slashCommands: true,
    queue: true,
    interrupt: true,
    cancelQueued: false,
    resume: true,
    fork: false,
    rollback: false,
    compact: true,
    telemetry: true,
    rateLimits: true,
  };

  private _status: AdapterStatus = 'disconnected';
  get status(): AdapterStatus {
    return this._status;
  }

  async connect(_config: AdapterConfig): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  protected async onDisconnect(): Promise<void> {}
  async reconnect(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async sendMessage(_input: AgentSendMessageInputV2): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async interrupt(_input: AgentInterruptInputV2): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async respondToApproval(_input: AgentApprovalResponseInputV2): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
