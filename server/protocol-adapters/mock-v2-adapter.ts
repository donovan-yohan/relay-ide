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
  AgentItemV2,
  AgentSessionLiveStateV2,
  AgentTurnV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';

export interface MockProtocolAdapterV2Delays {
  connectMs: number;
  stepMs: number;
}

interface QueuedMessage {
  input: AgentSendMessageInputV2;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const DEFAULT_DELAYS: MockProtocolAdapterV2Delays = {
  connectMs: 50,
  stepMs: 20,
};

function queuedDisconnectError(count: number): Error {
  return new Error(
    `MockProtocolAdapterV2 disconnected with ${count} queued message(s)`
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export class MockProtocolAdapterV2 extends BaseProtocolAdapterV2 {
  readonly agentType = 'mock';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    reasoning: true,
    tools: true,
    commandExecution: true,
    fileChanges: true,
    approvals: true,
    questions: true,
    plans: true,
    slashCommands: true,
    queue: true,
    interrupt: true,
    cancelQueued: true,
    resume: true,
    fork: true,
    rollback: true,
    compact: true,
    telemetry: true,
    rateLimits: true,
  };

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private activeTurnId: string | null = null;
  private activeController: AbortController | null = null;
  private readonly queue: QueuedMessage[] = [];
  private readonly pendingApprovals = new Map<
    string,
    (decision: AgentApprovalDecisionV2) => void
  >();
  private readonly delays: MockProtocolAdapterV2Delays;
  private connectGeneration = 0;

  constructor(delays: Partial<MockProtocolAdapterV2Delays> = {}) {
    super();
    this.delays = { ...DEFAULT_DELAYS, ...delays };
  }

  get status(): AdapterStatus {
    return this._status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    const generation = ++this.connectGeneration;
    this.config = config;
    this._status = 'connecting';
    await sleep(this.delays.connectMs);

    if (
      generation !== this.connectGeneration ||
      this._status !== 'connecting'
    ) {
      return;
    }

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
    this.connectGeneration++;
    this.rejectQueuedMessages();
    this.activeController?.abort();
    this.pendingApprovals.clear();
    this.activeTurnId = null;
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

  async resumeSession(sessionId: string): Promise<void> {
    if (this.config === null) {
      throw new Error('Cannot resumeSession before initial connect');
    }

    // Emit a snapshot reflecting the resumed provider session.
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: this.sessionId,
        provider: 'mock',
        cwd: this.config.cwd,
        capabilities: this.capabilities,
        providerSession: { mockSessionId: sessionId },
      }),
    });

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

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    if (this._status !== 'connected') {
      throw new Error('Cannot send a v2 message before connect');
    }

    if (this.activeTurnId !== null) {
      return new Promise((resolve, reject) => {
        this.queue.push({ input, resolve, reject });
        this.emitLiveState({
          status: 'working',
          activeTurnId: this.activeTurnId,
          queueLength: this.queue.length,
        });
      });
    }

    return this.startTurn(input);
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    if (
      this.activeTurnId !== null &&
      (input.turnId === undefined || input.turnId === this.activeTurnId)
    ) {
      this.activeController?.abort();
      return;
    }

    if (input.turnId !== undefined) {
      const index = this.queue.findIndex(
        (queued) => queued.input.turnId === input.turnId
      );
      if (index !== -1) {
        const [queued] = this.queue.splice(index, 1);
        queued?.resolve();
        this.emitLiveState({
          queueLength: this.queue.length,
        });
      }
    }
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    const resolver = this.pendingApprovals.get(input.requestId);

    if (resolver === undefined) {
      return;
    }

    this.pendingApprovals.delete(input.requestId);
    resolver(input.decision);
  }

  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {
    // The v2 mock currently has no question/input scenario.
  }

  private async startTurn(input: AgentSendMessageInputV2): Promise<void> {
    const controller = new AbortController();
    this.activeController = controller;
    this.activeTurnId = input.turnId;

    try {
      await this.runTurn(input, controller.signal);
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }
      if (this.activeTurnId === input.turnId) {
        this.activeTurnId = null;
      }
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    if (this._status !== 'connected') {
      return;
    }

    const queued = this.queue.shift();

    if (queued === undefined) {
      return;
    }

    this.startTurn(queued.input).then(queued.resolve, queued.reject);
  }

  private rejectQueuedMessages(): void {
    const queued = this.queue.splice(0);

    if (queued.length === 0) {
      return;
    }

    this.emitLiveState({
      queueLength: 0,
    });

    const err = queuedDisconnectError(queued.length);
    for (const message of queued) {
      message.reject(err);
    }
  }

  private async runTurn(
    input: AgentSendMessageInputV2,
    signal: AbortSignal
  ): Promise<void> {
    const startedAt = nowIso();
    const turn: AgentTurnV2 = {
      id: input.turnId,
      status: 'running',
      inputMessageId: `user-${input.turnId}`,
      items: [],
      startedAt,
    };
    let completionStatus: 'completed' | 'interrupted' | 'failed' = 'completed';

    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sessionId,
      timestamp: startedAt,
      turn,
    });
    this.emitItemStarted(input.turnId, {
      type: 'userMessage',
      id: `user-${input.turnId}`,
      text: input.content,
      completedAt: startedAt,
      status: 'completed',
      ...(input.attachments !== undefined
        ? {
            attachments: input.attachments.map((attachment) => ({
              ...attachment,
            })),
          }
        : {}),
    });

    try {
      if (this.isApprovalScenario(input.content)) {
        await this.runApprovalScenario(input.turnId, signal);
      } else {
        await this.runHappyPath(input.turnId, signal);
      }
    } catch (err) {
      if (isAbortError(err)) {
        completionStatus = 'interrupted';
      } else {
        completionStatus = 'failed';
        this.emitPatch({
          type: 'agent-error-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          message: err instanceof Error ? err.message : String(err),
          turnId: input.turnId,
        });
      }
    }

    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId: input.turnId,
      status: completionStatus,
      completedAt: nowIso(),
      durationMs: Date.now() - Date.parse(startedAt),
    });
    this.emitLiveState({
      status: this.queue.length > 0 ? 'working' : 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
      error: null,
    });
  }

  private async runHappyPath(
    turnId: string,
    signal: AbortSignal
  ): Promise<void> {
    const text = 'Mock v2 response complete.';
    const assistant: AgentItemV2 = {
      type: 'assistantMessage',
      id: `assistant-${turnId}`,
      text: '',
      phase: 'answer',
      status: 'running',
      startedAt: nowIso(),
    };

    this.emitItemStarted(turnId, {
      type: 'reasoning',
      id: `reasoning-${turnId}`,
      summary: 'Mock reasoning summary.',
      visibility: 'summary',
      status: 'completed',
      startedAt: nowIso(),
      completedAt: nowIso(),
    });

    this.emitItemStarted(turnId, assistant);
    await sleep(this.delays.stepMs, signal);
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      itemId: `assistant-${turnId}`,
      delta: { text },
    });
    await sleep(this.delays.stepMs, signal);
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        ...assistant,
        text,
        status: 'completed',
        completedAt: nowIso(),
      },
    });

    this.emitItemStarted(turnId, {
      type: 'commandExecution',
      id: `command-${turnId}`,
      command: 'npm test -- test/components/chat-v2-rendering.test.ts',
      output: 'Mock command output.',
      exitCode: 0,
      durationMs: 42,
      status: 'completed',
      startedAt: nowIso(),
      completedAt: nowIso(),
    });

    this.emitItemStarted(turnId, {
      type: 'fileChange',
      id: `file-${turnId}`,
      paths: [
        {
          path: 'frontend/src/components/chat/ChatView.tsx',
          status: 'edited',
        },
      ],
      patch: '@@ -1 +1 @@\n-old\n+new',
      applyStatus: 'applied',
      status: 'completed',
      startedAt: nowIso(),
      completedAt: nowIso(),
    });

    this.emitItemStarted(turnId, {
      type: 'dynamicToolCall',
      id: `dynamic-${turnId}`,
      namespace: 'mock',
      tool: 'grep',
      arguments: { pattern: 'chat' },
      result: { matches: 1 },
      status: 'completed',
      startedAt: nowIso(),
      completedAt: nowIso(),
    });

    this.emitItemStarted(turnId, {
      type: 'providerExtension',
      id: `extension-${turnId}`,
      namespace: 'mock',
      payload: { kind: 'mockExtension', message: 'Mock provider extension.' },
      status: 'completed',
      startedAt: nowIso(),
      completedAt: nowIso(),
    });
  }

  private async runApprovalScenario(
    turnId: string,
    signal: AbortSignal
  ): Promise<void> {
    const approvalId = `approval-${turnId}`;
    const toolId = `tool-${turnId}`;

    this.emitItemStarted(turnId, {
      type: 'approval',
      id: approvalId,
      requestId: approvalId,
      kind: 'command',
      description: 'Run mock command',
      target: 'npm test',
      detail: 'Mock v2 approval scenario',
      status: 'pending',
      startedAt: nowIso(),
      metadata: { toolId },
    });
    this.emitLiveState({
      status: 'waiting',
      activeTurnId: turnId,
      waitingOn: 'approval',
      activeRequestIds: [approvalId],
      queueLength: this.queue.length,
    });

    const decision = await this.waitForApproval(approvalId, signal);

    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'approval',
        id: approvalId,
        requestId: approvalId,
        kind: 'command',
        description: 'Run mock command',
        target: 'npm test',
        detail: 'Mock v2 approval scenario',
        status: 'completed',
        decision,
        respondedBy: 'user',
        completedAt: nowIso(),
        metadata: { toolId },
      },
    });
    this.emitLiveState({
      status: 'working',
      activeTurnId: turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
    });

    await this.runHappyPath(turnId, signal);
  }

  private waitForApproval(
    requestId: string,
    signal: AbortSignal
  ): Promise<AgentApprovalDecisionV2> {
    return new Promise((resolve, reject) => {
      this.pendingApprovals.set(requestId, resolve);
      signal.addEventListener(
        'abort',
        () => {
          this.pendingApprovals.delete(requestId);
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true }
      );
    });
  }

  private isApprovalScenario(content: string): boolean {
    return /\bapproval\b/i.test(content);
  }

  private emitItemStarted(turnId: string, item: AgentItemV2): void {
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item,
    });
  }

  private emitLiveState(live: Partial<AgentSessionLiveStateV2>): void {
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      live,
    });
  }

  private get sessionId(): string {
    return this.config?.sessionId ?? 'mock-v2-session';
  }
}
