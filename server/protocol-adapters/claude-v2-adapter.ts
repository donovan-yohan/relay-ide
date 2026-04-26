import type { ChildProcess } from 'node:child_process';
import { spawn as defaultSpawn } from 'node:child_process';
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

type SpawnFn = typeof defaultSpawn;

export interface ClaudeProtocolAdapterV2Options {
  spawn?: SpawnFn;
}

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
    plans: true,
    slashCommands: true,
    queue: false,
    interrupt: true,
    cancelQueued: false,
    resume: true,
    fork: true,
    rollback: false,
    compact: true,
    telemetry: true,
    rateLimits: true,
  };

  private readonly spawnFn: SpawnFn;
  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private process: ChildProcess | null = null;

  constructor(options: ClaudeProtocolAdapterV2Options = {}) {
    super();
    this.spawnFn = options.spawn ?? defaultSpawn;
  }

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
