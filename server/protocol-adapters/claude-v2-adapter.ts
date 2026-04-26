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
import type {
  AgentCapabilitySetV2,
  AgentItemV2,
  AgentSessionLiveStateV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';
import { cleanEnv } from '../utils.js';

const NOT_IMPLEMENTED = 'not implemented';
const ITEM_STARTED = 'agent-item-started-v2' as const;
const ITEM_UPDATED = 'agent-item-updated-v2' as const;
const ITEM_DELTA = 'agent-item-delta-v2' as const;

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
  private streamBuffer = '';
  private _currentTurnId: string | null = null;
  private blockIdx = 0;
  private _providerSessionId: string | null = null;
  private toolUseRegistry = new Map<
    string,
    {
      itemId: string;
      discriminator: 'commandExecution' | 'fileChange' | 'dynamicToolCall';
      name: string;
      input: Record<string, unknown>;
    }
  >();
  private blockIndexToItem = new Map<
    number,
    {
      itemId: string;
      discriminator:
        | 'assistantMessage'
        | 'reasoning'
        | 'commandExecution'
        | 'fileChange'
        | 'dynamicToolCall';
    }
  >();
  private pendingMessageDelta: {
    stopReason?: string;
    usage?: Record<string, number>;
  } = {};

  constructor(options: ClaudeProtocolAdapterV2Options = {}) {
    super();
    this.spawnFn = options.spawn ?? defaultSpawn;
  }

  get status(): AdapterStatus {
    return this._status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this._status = 'connecting';

    const args = this.buildSpawnArgs(config);
    const env = this.buildSpawnEnv();
    this.process = this.spawnFn('claude', args, {
      cwd: config.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) =>
      this.handleStreamData(chunk.toString('utf8'))
    );
    this.process.on('exit', (code, signal) =>
      this.handleProcessExit(code, signal)
    );
    this.process.on('error', (err) => this.handleProcessError(err));

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
    if (this.process !== null) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // process may already be dead
      }
      this.process = null;
    }
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

  private buildSpawnArgs(config: AdapterConfig): string[] {
    const args = [
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--include-hook-events',
      '--permission-prompt-tool',
      'stdio',
      '--no-session-persistence',
      '--session-id',
      config.sessionId,
    ];
    if (config.model !== undefined) args.push('--model', config.model);
    if (config.permissionMode !== undefined)
      args.push('--permission-mode', config.permissionMode);
    return args;
  }

  private buildSpawnEnv(): Record<string, string> {
    const env = cleanEnv();
    delete env['CLAUDECODE'];
    return env;
  }

  private emitLiveState(live: Partial<AgentSessionLiveStateV2>): void {
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sessionId,
      timestamp: this.now(),
      live,
    });
  }

  private now(): string {
    return new Date().toISOString();
  }

  private get sessionId(): string {
    return this.config?.sessionId ?? 'claude-v2-session';
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
    if (typeof obj['hook_event_name'] === 'string') {
      this.handleHookEvent(obj);
      return;
    }
    switch (type) {
      case 'system':
        this.handleSystem(obj);
        break;
      case 'assistant':
        this.handleAssistantBlock(obj);
        break;
      case 'user':
        this.handleUserBlock(obj);
        break;
      case 'stream_event':
        this.handleStreamEvent(obj);
        break;
      case 'control_request':
        this.handleControlRequest(obj);
        break;
      case 'result':
        this.handleResult(obj);
        break;
      default:
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
    if (typeof initObj['session_id'] === 'string') {
      providerSession['sessionId'] = initObj['session_id'];
    }
    if (typeof initObj['model'] === 'string') {
      providerSession['model'] = initObj['model'];
    }
    if (typeof initObj['cwd'] === 'string') {
      providerSession['cwd'] = initObj['cwd'];
    }

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
      type: ITEM_UPDATED,
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
      type: ITEM_UPDATED,
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
    let discriminator: 'commandExecution' | 'fileChange' | 'dynamicToolCall';
    if (name === 'Bash') {
      discriminator = 'commandExecution';
      item = {
        type: 'commandExecution',
        id: `exec-${id}`,
        command: String(input['command'] ?? ''),
        output: '',
        status: 'running',
        startedAt: this.now(),
      };
    } else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
      discriminator = 'fileChange';
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
      discriminator = 'dynamicToolCall';
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

    this.toolUseRegistry.set(id, {
      itemId: item.id,
      discriminator,
      name,
      input,
    });

    this.emitPatch({
      type: ITEM_STARTED,
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      item,
    });
  }

  private handleUserBlock(_obj: Record<string, unknown>): void {
    // Filled in Task 1.7
  }

  private handleStreamEvent(obj: Record<string, unknown>): void {
    const turnId = this._currentTurnId;
    if (turnId === null) return;
    const event = obj['event'] as Record<string, unknown> | undefined;
    if (event === undefined) return;
    switch (event['type']) {
      case 'message_start':
        /* envelope only — no patch */ break;
      case 'content_block_start':
        this.handleContentBlockStart(turnId, event);
        break;
      case 'content_block_delta':
        this.handleContentBlockDelta(turnId, event);
        break;
      case 'content_block_stop':
        this.handleContentBlockStop(turnId, event);
        break;
      case 'message_delta':
        this.handleMessageDelta(event);
        break;
      case 'message_stop':
        /* turn end is `result` */ break;
      default:
        /* unknown — silently ignore */ break;
    }
  }

  private handleContentBlockStart(
    turnId: string,
    event: Record<string, unknown>
  ): void {
    const index = typeof event['index'] === 'number' ? event['index'] : -1;
    if (index < 0) return;
    const block = event['content_block'] as Record<string, unknown> | undefined;
    if (block === undefined) return;
    const blockType = block['type'];

    if (blockType === 'text') {
      const itemId = `msg-${turnId}-${index}`;
      this.blockIndexToItem.set(index, {
        itemId,
        discriminator: 'assistantMessage',
      });
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
      return;
    }

    if (blockType === 'thinking') {
      const itemId = `thinking-${turnId}-${index}`;
      this.blockIndexToItem.set(index, { itemId, discriminator: 'reasoning' });
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
      return;
    }

    if (blockType === 'tool_use') {
      const id = String(block['id'] ?? `tu-${index}`);
      const name = String(block['name'] ?? 'unknown');
      const input = (block['input'] ?? {}) as Record<string, unknown>;

      let item: AgentItemV2;
      let discriminator: 'commandExecution' | 'fileChange' | 'dynamicToolCall';
      if (name === 'Bash') {
        discriminator = 'commandExecution';
        item = {
          type: 'commandExecution',
          id: `exec-${id}`,
          command: String(input['command'] ?? ''),
          output: '',
          status: 'running',
          startedAt: this.now(),
        };
      } else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
        discriminator = 'fileChange';
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
        discriminator = 'dynamicToolCall';
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

      this.blockIndexToItem.set(index, { itemId: item.id, discriminator });
      this.toolUseRegistry.set(id, {
        itemId: item.id,
        discriminator,
        name,
        input,
      });

      this.emitPatch({
        type: ITEM_STARTED,
        sessionId: this.sessionId,
        timestamp: this.now(),
        turnId,
        item,
      });
    }
  }

  private handleContentBlockDelta(
    turnId: string,
    event: Record<string, unknown>
  ): void {
    const index = typeof event['index'] === 'number' ? event['index'] : -1;
    const entry = this.blockIndexToItem.get(index);
    if (entry === undefined) return;
    const delta = event['delta'] as Record<string, unknown> | undefined;
    if (delta === undefined) return;

    let deltaPayload:
      | { text?: string; summary?: string; content?: string }
      | undefined;
    if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
      deltaPayload = { text: delta['text'] };
    } else if (
      delta['type'] === 'thinking_delta' &&
      typeof delta['thinking'] === 'string'
    ) {
      deltaPayload = { summary: delta['thinking'] };
    } else if (
      delta['type'] === 'input_json_delta' &&
      typeof delta['partial_json'] === 'string'
    ) {
      deltaPayload = { content: delta['partial_json'] };
    }

    if (deltaPayload === undefined) return;

    this.emitPatch({
      type: ITEM_DELTA,
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      itemId: entry.itemId,
      delta: deltaPayload,
    });
  }

  private handleContentBlockStop(
    turnId: string,
    event: Record<string, unknown>
  ): void {
    const index = typeof event['index'] === 'number' ? event['index'] : -1;
    const entry = this.blockIndexToItem.get(index);
    if (entry === undefined) return;

    let item: AgentItemV2;
    switch (entry.discriminator) {
      case 'assistantMessage':
        item = {
          type: 'assistantMessage',
          id: entry.itemId,
          text: '',
          phase: 'answer',
          status: 'completed',
          completedAt: this.now(),
        };
        break;
      case 'reasoning':
        item = {
          type: 'reasoning',
          id: entry.itemId,
          summary: '',
          visibility: 'summary',
          status: 'completed',
          completedAt: this.now(),
        };
        break;
      case 'commandExecution':
      case 'fileChange':
      case 'dynamicToolCall':
        // Tool items only complete via tool_result (Task 1.7), not content_block_stop.
        return;
    }

    this.emitPatch({
      type: ITEM_UPDATED,
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
      item,
    });
  }

  private handleMessageDelta(event: Record<string, unknown>): void {
    const delta = event['delta'] as Record<string, unknown> | undefined;
    if (delta !== undefined && typeof delta['stop_reason'] === 'string') {
      this.pendingMessageDelta.stopReason = delta['stop_reason'];
    }
    const usage = event['usage'] as Record<string, unknown> | undefined;
    if (usage !== undefined) {
      const usageMap: Record<string, number> = {};
      for (const [k, v] of Object.entries(usage)) {
        if (typeof v === 'number') usageMap[k] = v;
      }
      this.pendingMessageDelta.usage = usageMap;
    }
  }

  private handleControlRequest(_obj: Record<string, unknown>): void {
    // Filled in Task 1.9
  }

  private handleResult(_obj: Record<string, unknown>): void {
    // Filled in Task 1.10
  }

  private handleHookEvent(_obj: Record<string, unknown>): void {
    // Filled in Task 1.8
  }

  private emitProviderExtension(obj: Record<string, unknown>): void {
    const turnId = this._currentTurnId;
    if (turnId === null) return;
    this.emitPatch({
      type: ITEM_STARTED,
      sessionId: this.sessionId,
      timestamp: this.now(),
      turnId,
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

  private handleProcessExit(
    _code: number | null,
    _signal: NodeJS.Signals | null
  ): void {
    // Filled in Task 1.10
  }

  private handleProcessError(_err: Error): void {
    // Filled in Task 1.10
  }
}
