import { spawn as defaultSpawn } from 'node:child_process';
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
import { cleanEnv } from '../utils.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';
import type {
  AgentCapabilitySetV2,
  AgentItemV2,
  AgentSessionLiveStateV2,
} from '../../shared/agent-chat-protocol-v2.js';

const NOT_IMPLEMENTED = 'not implemented';
const DEFAULT_SESSION_ID = 'claude-v2-session';
const ITEM_STARTED = 'agent-item-started-v2' as const;

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

  private readonly spawnFn: SpawnFn;
  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private activeProcess: ChildProcess | null = null;
  private _currentTurnId: string | null = null;
  private blockIdx = 0;
  private streamBuffer = '';
  private _providerSessionId: string | null = null;

  constructor(options: ClaudeProtocolAdapterV2Options = {}) {
    super();
    this.spawnFn = options.spawn ?? defaultSpawn;
  }

  private get providerSessionId(): string | null {
    return this._providerSessionId;
  }

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

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    if (this._status !== 'connected') {
      throw new Error('Cannot send message before connect');
    }

    this._currentTurnId = input.turnId;
    this.blockIdx = 0;

    const startedAt = this.now();
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sessionId,
      timestamp: startedAt,
      turn: {
        id: input.turnId,
        status: 'running',
        inputMessageId: `user-${input.turnId}`,
        items: [],
        startedAt,
      },
    });
    this.emitPatch({
      type: ITEM_STARTED,
      sessionId: this.sessionId,
      timestamp: startedAt,
      turnId: input.turnId,
      item: {
        type: 'userMessage',
        id: `user-${input.turnId}`,
        text: input.content,
        status: 'completed',
        startedAt,
        completedAt: startedAt,
      },
    });
    this.emitLiveState({
      status: 'working',
      activeTurnId: input.turnId,
      error: null,
    });

    const args = this.buildSpawnArgs(input.content);
    const env = this.buildSpawnEnv();
    const cwd = this.config?.cwd ?? process.cwd();

    const proc = this.spawnFn('claude', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.activeProcess = proc;

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.handleStreamData(chunk.toString('utf8'));
    });
  }

  async interrupt(_input: AgentInterruptInputV2): Promise<void> {
    this.killActiveProcess();
  }

  async respondToApproval(_input: AgentApprovalResponseInputV2): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {
    // Claude has no structured input flow; intentionally no-op.
  }

  private buildSpawnArgs(prompt: string): string[] {
    const args = [
      '--output-format',
      'stream-json',
      '--print',
      '-p',
      prompt,
      '--permission-mode',
      'bypassPermissions',
    ];
    if (this._providerSessionId !== null) {
      args.push('--resume', this._providerSessionId);
    }
    if (this.config?.model !== undefined) {
      args.push('--model', this.config.model);
    }
    return args;
  }

  private buildSpawnEnv(): Record<string, string> {
    const env = cleanEnv();
    // Strip CLAUDECODE so a relay-launched claude doesn't refuse to nest under another claude.
    delete env['CLAUDECODE'];
    return env;
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
    } else if (type === 'system') {
      this.handleSystem(obj);
    } else if (type === 'result') {
      this.handleResult(obj);
    } else {
      this.emitProviderExtension(obj);
    }
  }

  private handleSystem(obj: Record<string, unknown>): void {
    if (obj['subtype'] !== 'init') {
      this.emitProviderExtension(obj);
      return;
    }
    const sessionId = obj['session_id'];
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this._providerSessionId = sessionId;
    }
    this.emitSessionSnapshot(obj);
  }

  private emitSessionSnapshot(initObj: Record<string, unknown>): void {
    const providerSession: Record<string, string> = {};
    if (typeof initObj['session_id'] === 'string')
      providerSession['sessionId'] = String(initObj['session_id']);
    if (typeof initObj['model'] === 'string')
      providerSession['model'] = String(initObj['model']);
    if (typeof initObj['cwd'] === 'string')
      providerSession['cwd'] = String(initObj['cwd']);

    const session = emptyAgentSessionV2({
      id: this.sessionId,
      provider: 'claude',
      cwd: this.config?.cwd ?? '',
      capabilities: this.capabilities,
      providerSession,
    });

    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.sessionId,
      timestamp: this.now(),
      session,
    });
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
      type: ITEM_STARTED,
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
    turnId: string,
    block: Record<string, unknown>
  ): void {
    const idx = this.blockIdx++;
    const itemId = `thinking-${turnId}-${idx}`;
    const summary = String(block['thinking'] ?? '');
    this.emitPatch({
      type: ITEM_STARTED,
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      item: {
        type: 'reasoning',
        id: itemId,
        summary: '',
        visibility: 'summary',
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
      delta: { summary },
    });
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      item: {
        type: 'reasoning',
        id: itemId,
        summary,
        visibility: 'summary',
        status: 'completed',
        completedAt: this.now(),
      },
    });
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
      type: ITEM_STARTED,
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      item,
    });
  }

  private emitProviderExtension(obj: Record<string, unknown>): void {
    if (this._currentTurnId === null) return;
    this.emitPatch({
      type: ITEM_STARTED,
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

  private handleResult(obj: Record<string, unknown>): void {
    const turnId = this._currentTurnId;
    if (turnId === null) return;

    const subtype = String(obj['subtype'] ?? 'success');
    const isError = subtype !== 'success' || obj['is_error'] === true;
    const durationMs =
      typeof obj['duration_ms'] === 'number' ? obj['duration_ms'] : 0;
    const usage = obj['usage'] as Record<string, unknown> | undefined;

    if (isError) {
      this.emitPatch({
        type: 'agent-error-v2',
        sessionId: this.sessionId,
        timestamp: this.now(),
        message: typeof obj['error'] === 'string' ? obj['error'] : subtype,
        turnId,
      });
    }

    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      status: isError ? 'failed' : 'completed',
      completedAt: this.now(),
      durationMs,
      ...(usage !== undefined ? { usage: this.mapUsage(usage) } : {}),
      ...(isError ? { error: subtype } : {}),
    });

    this._currentTurnId = null;
    this.blockIdx = 0;
    this.emitLiveState({
      status: 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      error: null,
    });
  }

  private mapUsage(usage: Record<string, unknown>): {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } {
    const result: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    } = {};
    if (typeof usage['input_tokens'] === 'number')
      result.inputTokens = usage['input_tokens'];
    if (typeof usage['output_tokens'] === 'number')
      result.outputTokens = usage['output_tokens'];
    if (typeof usage['cache_read_input_tokens'] === 'number')
      result.cacheReadTokens = usage['cache_read_input_tokens'];
    if (typeof usage['cache_creation_input_tokens'] === 'number')
      result.cacheWriteTokens = usage['cache_creation_input_tokens'];
    return result;
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
