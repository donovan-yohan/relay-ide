import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
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
  AgentUsageV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';
import { createLogger } from '../logger.js';

const logger = createLogger('claude-adapter');

type QueryParams = {
  prompt: string;
  options?: {
    abortController?: AbortController;
    cwd?: string;
    model?: string;
    permissionMode?: PermissionMode;
    additionalDirectories?: string[];
    env?: Record<string, string | undefined>;
    includePartialMessages?: boolean;
    includeHookEvents?: boolean;
    canUseTool?: CanUseTool;
  };
};

export type ClaudeQuery = AsyncGenerator<unknown, void> & {
  interrupt?: () => Promise<void>;
  close?: () => void;
};

export type ClaudeQueryFunction = (params: QueryParams) => ClaudeQuery;

interface QueuedClaudeMessage {
  input: AgentSendMessageInputV2;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const CLAUDE_CAPABILITIES: AgentCapabilitySetV2 = {
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

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function objectField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const nativeMessage = objectField(message.message);
  const content = nativeMessage.content;
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function usageFromResult(message: Record<string, unknown>): AgentUsageV2 {
  const usage = objectField(message.usage);
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens);
  const cacheReadTokens = Number(
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens
  );
  const cacheWriteTokens = Number(
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens
  );
  const costUsd = Number(message.total_cost_usd ?? message.totalCostUsd);

  return {
    ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    ...(Number.isFinite(cacheReadTokens) ? { cacheReadTokens } : {}),
    ...(Number.isFinite(cacheWriteTokens) ? { cacheWriteTokens } : {}),
    ...(Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

function targetFromToolInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') return stringField(input.command, JSON.stringify(input));
  return stringField(input.file_path ?? input.path, JSON.stringify(input));
}

function filePathsFromToolInput(input: Record<string, unknown>): Array<{ path: string; status?: string }> {
  const paths: Array<{ path: string; status?: string }> = [];
  const filePath = input.file_path ?? input.path;
  if (typeof filePath === 'string') paths.push({ path: filePath, status: 'edited' });
  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (isRecord(edit) && typeof edit.file_path === 'string') {
        paths.push({ path: edit.file_path, status: 'edited' });
      }
    }
  }
  return paths.length > 0 ? paths : [{ path: 'unknown', status: 'pending' }];
}

function permissionMode(value: string | undefined): PermissionMode | undefined {
  if (
    value === 'default' ||
    value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'plan' ||
    value === 'dontAsk' ||
    value === 'auto'
  ) {
    return value;
  }
  return undefined;
}

export class ClaudeProtocolAdapter extends BaseProtocolAdapterV2 {
  readonly agentType = 'claude';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private activeTurnId: string | null = null;
  private activeStartedAt: string | null = null;
  private activeController: AbortController | null = null;
  private activeQuery: ClaudeQuery | null = null;
  private readonly queue: QueuedClaudeMessage[] = [];
  private readonly pendingApprovals = new Map<
    string,
    (decision: AgentApprovalResponseInputV2['decision']) => void
  >();
  private completedActiveTurn = false;
  private readonly queryFn: ClaudeQueryFunction;

  constructor(queryFn: ClaudeQueryFunction = sdkQuery as unknown as ClaudeQueryFunction) {
    super();
    this.queryFn = queryFn;
  }

  get status(): AdapterStatus {
    return this._status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this._status = 'connected';
    this.emitSnapshot();
    this.emitLiveState({
      status: 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      proposedPlanItemId: null,
      queueLength: 0,
      fastModeAvailable: true,
      error: null,
    });
  }

  protected async onDisconnect(): Promise<void> {
    this.activeController?.abort();
    this.activeQuery?.close?.();
    this.rejectQueued(new Error('Claude adapter disconnected'));
    this.pendingApprovals.clear();
    this.activeTurnId = null;
    this.activeStartedAt = null;
    this.activeController = null;
    this.activeQuery = null;
    this._status = 'disconnected';
  }

  async reconnect(): Promise<void> {
    if (!this.config) throw new Error('Cannot reconnect before connect');
    const config = this.config;
    await this.disconnect();
    await this.connect(config);
  }

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    if (this._status !== 'connected') {
      throw new Error('Cannot send a Claude message before connect');
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
      await this.activeQuery?.interrupt?.().catch((err: unknown) => {
        logger.warn('Claude interrupt request failed:', err);
      });
      this.activeController?.abort();
      this.completeActiveTurn('interrupted');
      return;
    }
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    const resolver = this.pendingApprovals.get(input.requestId);
    if (!resolver) return;
    this.pendingApprovals.delete(input.requestId);
    resolver(input.decision);
  }

  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {
    // Claude Agent SDK questions are not mapped in this phase.
  }

  private async startTurn(input: AgentSendMessageInputV2): Promise<void> {
    if (!this.config) throw new Error('Cannot start Claude turn before connect');

    const startedAt = nowIso();
    this.activeTurnId = input.turnId;
    this.activeStartedAt = startedAt;
    this.completedActiveTurn = false;
    this.activeController = new AbortController();

    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.config.sessionId,
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
      type: 'agent-item-started-v2',
      sessionId: this.config.sessionId,
      timestamp: startedAt,
      turnId: input.turnId,
      item: {
        id: `user-${input.turnId}`,
        type: 'userMessage',
        text: input.content,
        status: 'completed',
        completedAt: startedAt,
      },
    });
    this.emitLiveState({
      status: 'working',
      activeTurnId: input.turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
      error: null,
    });

    try {
      const mode = permissionMode(this.config.permissionMode);
      const query = this.queryFn({
        prompt: input.content,
        options: {
          abortController: this.activeController,
          cwd: this.config.cwd,
          ...(this.config.model ? { model: this.config.model } : {}),
          ...(mode ? { permissionMode: mode } : {}),
          ...(Array.isArray(this.config.extra?.additionalDirectories)
            ? {
                additionalDirectories: this.config.extra
                  .additionalDirectories as string[],
              }
            : {}),
          env: {
            ...process.env,
            CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
          },
          includePartialMessages: true,
          includeHookEvents: true,
          canUseTool: this.handleCanUseTool,
        },
      });
      this.activeQuery = query;

      for await (const message of query) {
        this.handleSdkMessage(input.turnId, message);
      }

      if (!this.completedActiveTurn) {
        this.completeActiveTurn('completed');
      }
    } catch (err) {
      if (!this.completedActiveTurn) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitPatch({
          type: 'agent-error-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId: input.turnId,
          message,
        });
        this.completeActiveTurn('failed', undefined, message);
      }
    } finally {
      this.activeController = null;
      this.activeQuery = null;
      if (this.activeTurnId === input.turnId) {
        this.activeTurnId = null;
        this.activeStartedAt = null;
      }
      this.drainQueue();
    }
  }

  private readonly handleCanUseTool: CanUseTool = async (toolName, input, options) => {
    const turnId = this.activeTurnId ?? 'turn-unknown';
    const requestId = options.toolUseID;
    const target = targetFromToolInput(toolName, input);
    const startedAt = nowIso();

    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: startedAt,
      turnId,
      item: {
        type: 'approval',
        id: `approval-${requestId}`,
        requestId,
        kind: 'permission',
        description: options.title ?? options.displayName ?? `Claude wants to use ${toolName}`,
        target,
        ...(options.description ? { detail: options.description } : {}),
        status: 'pending',
        startedAt,
      },
    });
    this.emitLiveState({
      status: 'waiting',
      activeTurnId: turnId,
      waitingOn: 'approval',
      activeRequestIds: [requestId],
      queueLength: this.queue.length,
    });

    const decision = await new Promise<AgentApprovalResponseInputV2['decision']>(
      (resolve, reject) => {
        this.pendingApprovals.set(requestId, resolve);
        options.signal.addEventListener(
          'abort',
          () => {
            this.pendingApprovals.delete(requestId);
            reject(new Error('approval aborted'));
          },
          { once: true }
        );
      }
    );

    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'approval',
        id: `approval-${requestId}`,
        requestId,
        kind: 'permission',
        description: options.title ?? options.displayName ?? `Claude wants to use ${toolName}`,
        target,
        ...(options.description ? { detail: options.description } : {}),
        decision,
        respondedBy: 'user',
        status: 'completed',
        completedAt: nowIso(),
      },
    });
    this.emitLiveState({
      status: 'working',
      activeTurnId: turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
    });

    if (decision === 'deny') {
      return {
        behavior: 'deny',
        message: 'Denied by user',
        toolUseID: requestId,
        decisionClassification: 'user_reject',
      } satisfies PermissionResult;
    }

    return {
      behavior: 'allow',
      toolUseID: requestId,
      ...(decision === 'allow-always' && options.suggestions
        ? { updatedPermissions: options.suggestions }
        : {}),
      decisionClassification:
        decision === 'allow-always' ? 'user_permanent' : 'user_temporary',
    } satisfies PermissionResult;
  };

  private handleSdkMessage(turnId: string, message: unknown): void {
    if (!isRecord(message)) return;

    if (message.type === 'system' && message.subtype === 'init') {
      this.emitSnapshot(stringField(message.session_id));
      return;
    }

    if (message.type === 'assistant') {
      this.handleAssistantMessage(turnId, message);
      return;
    }

    if (message.type === 'result') {
      if (message.subtype !== 'success') {
        const errors = Array.isArray(message.errors) ? message.errors.join('\n') : 'Claude turn failed';
        this.emitPatch({
          type: 'agent-error-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          message: errors,
        });
        this.completeActiveTurn('failed', usageFromResult(message), errors);
      } else {
        this.completeActiveTurn('completed', usageFromResult(message));
      }
      return;
    }

    this.emitProviderExtension(turnId, message);
  }

  private handleAssistantMessage(turnId: string, message: Record<string, unknown>): void {
    let blockIndex = 0;
    for (const block of contentBlocks(message)) {
      const type = block.type;
      const itemIndex = blockIndex++;
      if (type === 'text') {
        const text = stringField(block.text);
        const id = `msg-${turnId}-${itemIndex}`;
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'assistantMessage',
            id,
            text: '',
            phase: 'answer',
            status: 'running',
            startedAt: nowIso(),
            providerMessageId: stringField(objectField(message.message).id),
          },
        });
        this.emitPatch({
          type: 'agent-item-delta-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          itemId: id,
          delta: { text },
        });
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'assistantMessage',
            id,
            text,
            phase: 'answer',
            status: 'completed',
            completedAt: nowIso(),
            providerMessageId: stringField(objectField(message.message).id),
          },
        });
      } else if (type === 'thinking') {
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'reasoning',
            id: `thinking-${turnId}-${itemIndex}`,
            summary: stringField(block.thinking ?? block.text ?? block.summary),
            visibility: 'summary',
            status: 'completed',
            completedAt: nowIso(),
          },
        });
      } else if (type === 'tool_use') {
        this.emitToolUse(turnId, block);
      } else {
        this.emitProviderExtension(turnId, block);
      }
    }
  }

  private emitToolUse(turnId: string, block: Record<string, unknown>): void {
    const toolUseId = stringField(block.id, `unknown-${Date.now()}`);
    const name = stringField(block.name, 'unknown');
    const input = objectField(block.input);

    if (name === 'Bash') {
      this.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        item: {
          type: 'commandExecution',
          id: `exec-${toolUseId}`,
          providerItemId: toolUseId,
          command: stringField(input.command, JSON.stringify(input)),
          output: '',
          status: 'running',
          startedAt: nowIso(),
        },
      });
      return;
    }

    if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
      this.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        item: {
          type: 'fileChange',
          id: `file-${toolUseId}`,
          providerItemId: toolUseId,
          paths: filePathsFromToolInput(input),
          applyStatus: 'pending',
          status: 'pending',
          startedAt: nowIso(),
        },
      });
      return;
    }

    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'dynamicToolCall',
        id: `tool-${toolUseId}`,
        providerItemId: toolUseId,
        namespace: 'claude',
        tool: name,
        arguments: input,
        status: 'running',
        startedAt: nowIso(),
      },
    });
  }

  private completeActiveTurn(
    status: 'completed' | 'interrupted' | 'failed',
    usage?: AgentUsageV2,
    error?: string
  ): void {
    if (this.completedActiveTurn || this.activeTurnId === null) return;
    this.completedActiveTurn = true;
    const completedAt = nowIso();
    const durationMs = this.activeStartedAt
      ? Date.now() - Date.parse(this.activeStartedAt)
      : undefined;

    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sessionId,
      timestamp: completedAt,
      turnId: this.activeTurnId,
      status,
      completedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    this.emitLiveState({
      status: this.queue.length > 0 ? 'working' : 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queue.length,
      error: error ?? null,
    });
  }

  private drainQueue(): void {
    if (this._status !== 'connected' || this.activeTurnId !== null) return;
    const queued = this.queue.shift();
    if (!queued) return;
    this.startTurn(queued.input).then(queued.resolve, queued.reject);
  }

  private rejectQueued(err: unknown): void {
    const queued = this.queue.splice(0);
    for (const message of queued) message.reject(err);
    if (queued.length > 0) this.emitLiveState({ queueLength: 0 });
  }

  private emitSnapshot(claudeSessionId?: string): void {
    if (!this.config) return;
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.config.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: this.config.sessionId,
        provider: 'claude',
        cwd: this.config.cwd,
        capabilities: this.capabilities,
        ...(claudeSessionId ? { providerSession: { claudeSessionId } } : {}),
        config: {
          ...(this.config.model ? { model: this.config.model } : {}),
          ...(this.config.permissionMode
            ? { permissionMode: this.config.permissionMode }
            : {}),
        },
      }),
    });
  }

  private emitProviderExtension(turnId: string, payload: Record<string, unknown>): void {
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'providerExtension',
        id: `ext-claude-${turnId}-${Date.now()}`,
        namespace: 'claude',
        payload,
        status: 'completed',
        startedAt: nowIso(),
        completedAt: nowIso(),
      },
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
    return this.config?.sessionId ?? 'claude-v2-session';
  }
}
