import type { ChildProcess } from 'node:child_process';
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
  AgentCapabilitySetV2,
  AgentSessionLiveStateV2,
} from '../../shared/agent-chat-protocol-v2.js';

const NOT_IMPLEMENTED = 'not implemented';
const DEFAULT_SESSION_ID = 'claude-v2-session';

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
  private config: AdapterConfig | null = null;
  private activeProcess: ChildProcess | null = null;

  get status(): AdapterStatus {
    return this._status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this._status = 'connected';
    this.emitLiveState({
      status: 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      proposedPlanItemId: null,
      queueLength: 0,
      fastModeAvailable: false,
      error: null,
    });
  }

  protected async onDisconnect(): Promise<void> {
    this.killActiveProcess();
    this._status = 'disconnected';
  }

  async reconnect(): Promise<void> {
    if (this.config === null) {
      throw new Error('Cannot reconnect before initial connect');
    }
    const config = this.config;
    await this.disconnect();
    await this.connect(config);
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

  private killActiveProcess(): void {
    if (this.activeProcess !== null) {
      try {
        this.activeProcess.kill('SIGTERM');
      } catch {
        // Process may already be dead. Ignore.
      }
      this.activeProcess = null;
    }
  }

  private emitLiveState(live: Partial<AgentSessionLiveStateV2>): void {
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      live,
    });
  }

  private get sessionId(): string {
    return this.config?.sessionId ?? DEFAULT_SESSION_ID;
  }
}
