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
  AgentSessionLiveStateV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { cleanEnv } from '../utils.js';

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
  private streamBuffer = '';
  private _currentTurnId: string | null = null;
  private blockIdx = 0;

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
    // Filled in Task 1.4
    this.emitProviderExtension(obj);
  }

  private handleAssistantBlock(_obj: Record<string, unknown>): void {
    // Filled in Task 1.5
  }

  private handleUserBlock(_obj: Record<string, unknown>): void {
    // Filled in Task 1.7
  }

  private handleStreamEvent(_obj: Record<string, unknown>): void {
    // Filled in Task 1.6
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
      type: 'agent-item-started-v2',
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
