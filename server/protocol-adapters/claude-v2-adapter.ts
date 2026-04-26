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
  AgentItemV2,
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
  private _currentTurnId: string | null = null;
  private blockIdx = 0;
  private streamBuffer = '';
  private startedItemIds = new Set<string>();

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

  private now(): string {
    return new Date().toISOString();
  }

  private handleStreamData(data: string): void {
    this.streamBuffer += data;
    const lines = this.streamBuffer.split('\n');
    this.streamBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.dispatchStreamJson(obj);
    }
  }

  private dispatchStreamJson(obj: Record<string, unknown>): void {
    const type = obj['type'];
    if (type === 'assistant') {
      this.handleAssistantBlock(obj);
    } else {
      this.emitProviderExtension(obj);
    }
  }

  private handleAssistantBlock(obj: Record<string, unknown>): void {
    const turnId = this._currentTurnId;
    if (turnId === null) return;
    const message = obj['message'] as
      | { content?: Array<Record<string, unknown>> }
      | undefined;
    for (const block of message?.content ?? []) {
      const t = block['type'];
      if (t === 'text') this.handleTextBlock(turnId, block);
      else if (t === 'thinking') this.handleThinkingBlock(turnId, block);
      else if (t === 'tool_use') this.handleToolUseBlock(turnId, block);
    }
  }

  private handleTextBlock(
    turnId: string,
    block: Record<string, unknown>
  ): void {
    const idx = this.blockIdx++;
    const itemId = `msg-${turnId}-${idx}`;
    const text = String(block['text'] ?? '');
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      item: {
        type: 'assistantMessage',
        id: itemId,
        text: '',
        phase: 'answer',
        status: 'running',
        startedAt: this.now(),
      },
    });
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      itemId,
      delta: { text },
    });
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      item: {
        type: 'assistantMessage',
        id: itemId,
        text,
        phase: 'answer',
        status: 'completed',
        completedAt: this.now(),
      },
    });
  }

  private handleThinkingBlock(
    _turnId: string,
    _block: Record<string, unknown>
  ): void {
    // Filled in step 1.3.C
  }

  private handleToolUseBlock(
    turnId: string,
    block: Record<string, unknown>
  ): void {
    const id = String(block['id'] ?? `tu-${this.blockIdx++}`);
    const name = String(block['name'] ?? 'unknown');
    const input = (block['input'] ?? {}) as Record<string, unknown>;

    let item: AgentItemV2;
    if (name === 'Bash') {
      item = {
        type: 'commandExecution',
        id: `exec-${id}`,
        command: String(input['command'] ?? ''),
        output: '',
        status: 'running',
        startedAt: this.now(),
      };
    } else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
      item = {
        type: 'fileChange',
        id: `file-${id}`,
        paths: [
          { path: String(input['file_path'] ?? input['filePath'] ?? '') },
        ],
        applyStatus: 'pending',
        status: 'running',
        startedAt: this.now(),
      };
    } else {
      item = {
        type: 'dynamicToolCall',
        id: `tool-${id}`,
        namespace: 'claude',
        tool: name,
        arguments: input,
        status: 'running',
        startedAt: this.now(),
      };
    }

    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      item,
    });
  }

  private emitProviderExtension(obj: Record<string, unknown>): void {
    if (this._currentTurnId === null) return;
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId: this._currentTurnId,
      item: {
        type: 'providerExtension',
        id: `ext-${Date.now()}-${this.blockIdx++}`,
        namespace: 'claude',
        payload: obj,
        status: 'completed',
        startedAt: this.now(),
        completedAt: this.now(),
      },
    });
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
