import { spawn as nodeSpawn } from 'node:child_process';
import { CURSOR_CHANNEL_COMMAND } from './launch-commands.js';
import {
  ABANDONED_APPROVAL_REASON,
  TURN_ENDED_APPROVAL_REASON,
  buildChildEnv,
  createPatchSink,
  createTurnQueue,
  emitErrorPatch,
  emitLiveStatePatch,
  emitProviderExtensionPatch,
  emitTurnCompletedPatch,
  emitTurnStartedPatch,
  reconnectWithStoredConfig,
  resolveAbandonedApprovals,
  type AbandonedApprovalV2,
} from './adapter-utils.js';
import {
  isRecord,
  nowIso,
  numberOr,
  objectField as record,
  stringField as string,
} from './wire-values.js';
import { createLogger } from '../logger.js';
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
  AgentApprovalItemV2,
  AgentApprovalSupportV2,
  AgentCapabilitySetV2,
  AgentItemV2,
  AgentPlanItemV2,
  AgentQuestionItemV2,
  AgentSessionLiveStateV2,
  AgentUsageV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';
import {
  AcpClient,
  type AcpClientOptions,
  type AcpNotification,
  type AcpPeerRequest,
} from '../acp-client.js';

const logger = createLogger('cursor-adapter');

/**
 * Deterministic native-event -> AgentPatchV2 mapping table for Cursor ACP:
 *
 * Native Event / Method               | Direction | Relay AgentPatchV2 / Item
 * -----------------------------------|-----------|------------------------------------------
 * initialize                         | -> Server | (readiness barrier)
 * authenticate (cursor_login)        | -> Server | (auth handshake)
 * session/new                        | -> Server | agent-session-snapshot-v2 (providerSession.cursorSessionId)
 * session/load                       | -> Server | agent-session-snapshot-v2 (history suppressed during replay)
 * session/prompt                     | -> Server | response stopReason settles turn outcome
 * session/cancel                     | -> Server | cancels active prompt; completes turn interrupted
 * session/update (agent_message_chunk)| <- Server | agent-item-started-v2 + agent-item-delta-v2 (assistantMessage)
 * session/update (agent_thought_chunk)| <- Server | agent-item-started-v2 + agent-item-delta-v2 (reasoning)
 * session/update (tool_call)         | <- Server | agent-item-started-v2 (commandExecution/fileChange/dynamicToolCall)
 * session/update (tool_call_update)  | <- Server | agent-item-updated-v2 (completed/failed output)
 * session/update (usage_update)      | <- Server | folded into turnUsage (totalTokens/contextPercent)
 * session/request_permission (peer)  | <- Server | agent-item-started-v2 (approval card); -> respond allow-once/reject-once
 * cursor/ask_question (peer)         | <- Server | agent-item-started-v2 (question item); -> respond answered/cancelled
 * cursor/create_plan (peer)          | <- Server | agent-item-started-v2 + updated (plan card); -> respond accepted
 * cursor/update_todos (notif/peer)   | <- Server | agent-provider-extension-v2 (todos); -> respond completed if peer
 * cursor/task (notif/peer)           | <- Server | agent-provider-extension-v2 (task); -> respond completed if peer
 * cursor/generate_image (notif/peer) | <- Server | agent-provider-extension-v2 (image); -> respond completed if peer
 * unknown peer request               | <- Server | -> respondError -32601 (Method not found)
 */

/**
 * Honest capabilities for the Cursor CLI ACP lane (`cursor-agent acp`).
 */
const CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  questions: true,
  plans: true,
  slashCommands: false,
  queue: true,
  steer: false,
  cancelQueued: false,
  interrupt: true,
  resume: true,
  fork: false,
  rollback: false,
  compact: false,
  telemetry: true,
  rateLimits: false,
  streaming: true,
} satisfies Required<AgentCapabilitySetV2>;

const QUEUE_ABANDONED_MESSAGE =
  'cursor session ended before this queued message was sent.';

/** The ACP major version this adapter speaks. */
const ACP_PROTOCOL_VERSION = 1;

/** Option IDs for Cursor permission requests. */
const CURSOR_ALLOW_ONCE_ID = 'allow-once';
const CURSOR_ALLOW_ALWAYS_ID = 'allow-always';
const CURSOR_REJECT_ONCE_ID = 'reject-once';

const CURSOR_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once', 'session'],
  amendmentTypes: [],
  canCancel: true,
};

/** Native tool names Relay renders as a command card. */
const COMMAND_TOOL_NAMES = new Set([
  'bash',
  'pwsh',
  'terminal_bash',
  'shell',
  'command',
  'exec',
]);

/** Native tool names Relay renders as a file-change card. */
const FILE_TOOL_NAMES = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'file_edit',
  'create_file',
  'delete_file',
]);

type ClientFactory = (options: AcpClientOptions) => AcpClient;

interface PendingApproval {
  turnId: string;
  peerRequestId: string | number;
  card: AgentApprovalItemV2;
}

interface PendingInputRequest {
  turnId: string;
  peerRequestId: string | number;
  card: AgentQuestionItemV2;
}

export class CursorProtocolAdapter extends BaseProtocolAdapterV2 {
  private readonly patchSink = createPatchSink(
    () => this.sessionId,
    (patch) => this.emitPatch(patch)
  );
  readonly agentType = 'cursor';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = CAPABILITIES;
  /** `connect()` consumes `resumeSessionId` via `session/load`, atomically. */
  readonly resumesProviderSessionDuringConnect = true;

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private client: AcpClient | null = null;
  private clientGeneration = 0;
  private cursorSessionId: string | null = null;
  private activeTurnId: string | null = null;
  private activeStartedMs = 0;
  private abortRequested = false;
  private turnUsage: AgentUsageV2 | undefined;
  private providerExtensionSequence = 0;
  private queueAdvanceInFlight = false;
  private isReplaying = false;
  private readonly items = new Map<string, AgentItemV2>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingInputRequests = new Map<
    string,
    PendingInputRequest
  >();
  /** Set when a requested resume was refused and a fresh session was opened. */
  private resumeFallbackReason: string | null = null;

  private readonly queued = createTurnQueue<AgentSendMessageInputV2>({
    canDrain: () =>
      !this.queueAdvanceInFlight &&
      this.activeTurnId === null &&
      this._status === 'connected',
    startTurn: (input) => this.runQueuedTurn(input),
    onLengthChange: (queueLength, reason) => {
      if (reason === 'enqueued')
        this.emitLive({
          status: 'working',
          activeTurnId: this.activeTurnId,
          queueLength,
        });
    },
  });

  constructor(
    private readonly clientFactory: ClientFactory = (options) =>
      new AcpClient({ ...options, spawn: nodeSpawn })
  ) {
    super();
  }

  get status(): AdapterStatus {
    return this._status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this._status = 'connecting';
    const args = this.buildLaunchArgs(config);
    const client = this.clientFactory({
      command: CURSOR_CHANNEL_COMMAND,
      args,
      cwd: config.cwd,
      env: this.buildEnv(config),
    });
    this.client = client;
    const generation = ++this.clientGeneration;
    const current = (): boolean =>
      this.client === client && this.clientGeneration === generation;
    client.on('notification', (notification: AcpNotification) => {
      if (current()) this.handleNotification(notification);
    });
    client.on('peerRequest', (request: AcpPeerRequest) => {
      if (current()) this.handlePeerRequest(request);
    });
    client.on('protocolError', (error: Error) => {
      if (current()) this.handleTransportClose(error);
    });
    client.on('error', (error: Error) => {
      if (current()) this.handleTransportClose(error);
    });
    client.on('close', () => {
      if (current() && this._status !== 'disconnected')
        this.handleTransportClose(
          new Error(
            `cursor ACP transport closed${client.stderrTailText ? `: ${client.stderrTailText}` : ''}`
          )
        );
    });

    try {
      await client.start({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: 'relay-ide',
          version: '0.1.0',
        },
      });

      // Cursor authentication handshake
      try {
        await client.request('authenticate', { methodId: 'cursor_login' });
      } catch (authError) {
        logger.debug('[cursor] authenticate step notice', {
          error:
            authError instanceof Error ? authError.message : String(authError),
        });
      }

      const opened = await this.openSession(client, config);
      this.cursorSessionId =
        string(opened.sessionId) || config.resumeSessionId || null;
    } catch (error) {
      this._status = 'disconnected';
      this.client = null;
      this.clientGeneration += 1;
      await client.stop().catch(() => undefined);
      throw error;
    }

    this._status = 'connected';
    this.emitSnapshot();
    this.emitLive({
      status: 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      proposedPlanItemId: null,
      queueLength: this.queued.length,
      fastModeAvailable: false,
      error: null,
    });
  }

  private buildLaunchArgs(config: AdapterConfig): string[] {
    const args: string[] = [];
    if (config.model) {
      args.push('--model', config.model);
    }
    if (
      config.permissionMode === 'yolo' ||
      config.permissionMode === 'force' ||
      config.permissionMode === 'bypassPermissions' ||
      config.permissionMode === 'danger-full-access'
    ) {
      args.push('--yolo');
    }
    args.push('acp');
    return args;
  }

  private async openSession(
    client: AcpClient,
    config: AdapterConfig
  ): Promise<Record<string, unknown>> {
    const params = { cwd: config.cwd, mcpServers: [] };
    if (!config.resumeSessionId)
      return record(await client.request('session/new', params));

    try {
      this.isReplaying = true;
      const result = record(
        await client.request('session/load', {
          sessionId: config.resumeSessionId,
          ...params,
        })
      );
      this.isReplaying = false;
      return result;
    } catch (error) {
      this.isReplaying = false;
      this.resumeFallbackReason =
        error instanceof Error ? error.message : String(error);
      logger.warn('[cursor] session/load failed; starting a fresh session', {
        message: this.resumeFallbackReason,
      });
      return record(await client.request('session/new', params));
    }
  }

  private buildEnv(config: AdapterConfig): Record<string, string> {
    return buildChildEnv({ processEnv: config.processEnv });
  }

  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
    this.releasePendingRequests(ABANDONED_APPROVAL_REASON);
    await this.teardownClient();
    this.activeTurnId = null;
    this.cursorSessionId = null;
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this.items.clear();
  }

  private async teardownClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientGeneration += 1;
    await client?.stop();
  }

  async reconnect(): Promise<void> {
    await reconnectWithStoredConfig({
      config: this.config,
      transformConfig: (config) => ({
        ...config,
        ...(this.cursorSessionId
          ? { resumeSessionId: this.cursorSessionId }
          : {}),
      }),
      disconnect: async () => {
        this.resetForTransportSwitch('cursor transport reconnected');
        this._status = 'disconnected';
        await this.teardownClient();
      },
      connect: (config) => this.connect(config),
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (!this.config) throw new Error('Cannot resumeSession before connect');
    const config = { ...this.config, resumeSessionId: sessionId };
    this.resetForTransportSwitch('cursor session switched');
    this._status = 'disconnected';
    await this.teardownClient();
    await this.connect(config);
  }

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    const client = this.requireClient();
    this.assertNoAttachments(input);
    if (this.activeTurnId) return this.queued.enqueue(input);

    this.startTurn(input);
    this.beginPrompt(client, input);
  }

  private beginPrompt(client: AcpClient, input: AgentSendMessageInputV2): void {
    void this.runPrompt(client, input).catch((error: unknown) => {
      this.handleTransportClose(
        error instanceof Error ? error : new Error(String(error))
      );
    });
  }

  private async runPrompt(
    client: AcpClient,
    input: AgentSendMessageInputV2
  ): Promise<void> {
    const response = record(
      await client.prompt({
        sessionId: this.cursorSessionId,
        prompt: [{ type: 'text', text: input.content }],
      })
    );
    const stopReason = string(response.stopReason, 'end_turn');
    if (this.activeTurnId !== input.turnId) return;
    if (stopReason === 'cancelled' || this.abortRequested) {
      this.completeTurn('interrupted');
    } else if (stopReason === 'end_turn') {
      this.completeTurn('completed');
    } else {
      const message = stopReasonMessage(stopReason);
      this.emitError(message);
      this.completeTurn('failed', message);
    }
    this.queued.drain();
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    if (!this.activeTurnId) return;
    if (input.turnId && input.turnId !== this.activeTurnId) return;
    const client = this.client;
    if (!client || !this.cursorSessionId) return;
    this.abortRequested = true;
    this.releasePendingRequests(TURN_ENDED_APPROVAL_REASON);
    client.notify('session/cancel', { sessionId: this.cursorSessionId });
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    const pending = this.pendingApprovals.get(input.requestId);
    if (!pending)
      throw new Error(`Unknown cursor approval: ${input.requestId}`);
    const client = this.requireClient();
    this.pendingApprovals.delete(input.requestId);
    const outcome =
      input.decision.kind === 'cancel'
        ? { outcome: 'cancelled' }
        : {
            outcome: 'selected',
            optionId:
              input.decision.kind === 'accept'
                ? input.decision.scope === 'session' ||
                  input.decision.scope === 'permanent'
                  ? CURSOR_ALLOW_ALWAYS_ID
                  : CURSOR_ALLOW_ONCE_ID
                : CURSOR_REJECT_ONCE_ID,
          };
    client.respond(pending.peerRequestId, { outcome });
    const resolved: AgentApprovalItemV2 = {
      ...pending.card,
      decision: input.decision,
      respondedBy: 'user',
      status: input.decision.kind === 'accept' ? 'completed' : 'cancelled',
      completedAt: nowIso(),
    };
    this.items.set(resolved.id, resolved);
    this.emitItemUpdated(resolved);
    this.emitLiveStateUpdate();
  }

  async respondToInput(input: AgentInputResponseInputV2): Promise<void> {
    const pending = this.pendingInputRequests.get(input.requestId);
    if (!pending)
      throw new Error(`Unknown cursor question: ${input.requestId}`);
    const client = this.requireClient();
    this.pendingInputRequests.delete(input.requestId);

    const formattedAnswers = Object.entries(input.answers).map(
      ([questionId, selectedOptionIds]) => ({
        questionId,
        selectedOptionIds,
      })
    );

    client.respond(pending.peerRequestId, {
      outcome: {
        outcome: 'answered',
        answers: formattedAnswers,
      },
    });

    const resolved: AgentQuestionItemV2 = {
      ...pending.card,
      answers: input.answers,
      status: 'completed',
      completedAt: nowIso(),
    };
    this.items.set(resolved.id, resolved);
    this.emitItemUpdated(resolved);
    this.emitLiveStateUpdate();
  }

  // ── Wire routing ───────────────────────────────────────────────────────────

  private handleNotification(notification: AcpNotification): void {
    const { method, params } = notification;
    if (this.isReplaying) return;

    if (method === 'cursor/update_todos') {
      this.emitProviderExtension(
        { kind: 'todos', todos: params.todos ?? [] },
        'debug'
      );
      return;
    }
    if (method === 'cursor/task') {
      this.emitProviderExtension({ kind: 'task', ...params }, 'debug');
      return;
    }
    if (method === 'cursor/generate_image') {
      this.emitProviderExtension(
        { kind: 'generate_image', ...params },
        'debug'
      );
      return;
    }

    if (method !== 'session/update') {
      logger.debug('[cursor] unmapped native notification', { method });
      return;
    }
    const sessionId = string(params.sessionId);
    if (
      this.cursorSessionId &&
      sessionId &&
      sessionId !== this.cursorSessionId
    ) {
      logger.debug('[cursor] ignoring update for another session', {
        sessionId,
      });
      return;
    }
    const update = record(params.update);
    const kind = string(update.sessionUpdate);
    switch (kind) {
      case 'agent_message_chunk':
        this.appendMessageChunk('assistant', update);
        return;
      case 'agent_thought_chunk':
        this.appendMessageChunk('reasoning', update);
        return;
      case 'tool_call':
        this.startTool(update);
        return;
      case 'tool_call_update':
        this.finishTool(update);
        return;
      case 'usage_update':
        this.applyUsage(update);
        return;
      default:
        logger.debug('[cursor] unmapped native session update', { kind });
    }
  }

  private handlePeerRequest(request: AcpPeerRequest): void {
    const client = this.client;
    if (!client) return;

    if (request.method === 'session/request_permission') {
      this.handlePermissionRequest(request);
      return;
    }
    if (request.method === 'cursor/ask_question') {
      this.handleQuestionRequest(request);
      return;
    }
    if (request.method === 'cursor/create_plan') {
      this.handlePlanRequest(request);
      return;
    }
    if (request.method === 'cursor/update_todos') {
      this.emitProviderExtension(
        { kind: 'todos', todos: request.params.todos ?? [] },
        'debug'
      );
      client.respond(request.id, { outcome: { outcome: 'completed' } });
      return;
    }
    if (request.method === 'cursor/task') {
      this.emitProviderExtension({ kind: 'task', ...request.params }, 'debug');
      client.respond(request.id, { outcome: { outcome: 'completed' } });
      return;
    }
    if (request.method === 'cursor/generate_image') {
      this.emitProviderExtension(
        { kind: 'generate_image', ...request.params },
        'debug'
      );
      client.respond(request.id, { outcome: { outcome: 'completed' } });
      return;
    }

    logger.debug('[cursor] unmapped native peer request', {
      method: request.method,
    });
    client.respondError(
      request.id,
      -32601,
      `Relay does not implement ${request.method}`
    );
  }

  private handlePermissionRequest(request: AcpPeerRequest): void {
    const client = this.client;
    if (!client) return;
    const turnId = this.activeTurnId;
    if (!turnId) {
      client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const toolCallId = string(record(request.params.toolCall).toolCallId);
    const requestId = `cursor-approval-${String(request.id)}`;
    const target = this.approvalTarget(toolCallId);
    const startedAt = nowIso();
    const card: AgentApprovalItemV2 = {
      type: 'approval',
      id: `approval-${requestId}`,
      requestId,
      kind: 'permission',
      description: `Cursor wants to run ${target}`,
      target,
      supported: CURSOR_APPROVAL_SUPPORT,
      status: 'pending',
      startedAt,
    };
    this.pendingApprovals.set(requestId, {
      turnId,
      peerRequestId: request.id,
      card,
    });
    this.items.set(card.id, card);
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: startedAt,
      turnId,
      item: card,
    });
    this.emitLiveStateUpdate();
  }

  private handleQuestionRequest(request: AcpPeerRequest): void {
    const client = this.client;
    if (!client) return;
    const turnId = this.activeTurnId;
    if (!turnId) {
      client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }

    const requestId = `cursor-question-${String(request.id)}`;
    const startedAt = nowIso();
    const rawQuestions = Array.isArray(request.params.questions)
      ? (request.params.questions as Array<Record<string, unknown>>)
      : [];
    const title = string(request.params.title);

    const questionText =
      rawQuestions
        .map((q) => string(q.prompt))
        .filter(Boolean)
        .join(' / ') ||
      title ||
      'Cursor requires input';

    const card: AgentQuestionItemV2 = {
      type: 'question',
      id: `question-${requestId}`,
      requestId,
      question: questionText,
      fields: rawQuestions.map((q) => ({
        id: string(q.id),
        prompt: string(q.prompt),
        options: Array.isArray(q.options) ? q.options : [],
        allowMultiple: Boolean(q.allowMultiple),
      })),
      status: 'running',
      startedAt,
    };

    this.pendingInputRequests.set(requestId, {
      turnId,
      peerRequestId: request.id,
      card,
    });
    this.items.set(card.id, card);
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: startedAt,
      turnId,
      item: card,
    });
    this.emitLiveStateUpdate();
  }

  private handlePlanRequest(request: AcpPeerRequest): void {
    const client = this.client;
    if (!client) return;
    const turnId = this.activeTurnId;
    const planText =
      string(request.params.plan) ||
      string(request.params.overview) ||
      string(request.params.name) ||
      'Proposed plan';
    const toolCallId = string(request.params.toolCallId);
    const planId = toolCallId || `plan-${String(request.id)}`;

    if (turnId) {
      const rawTodos = Array.isArray(request.params.todos)
        ? (request.params.todos as Array<Record<string, unknown>>)
        : [];
      const steps = rawTodos.map((todo) => ({
        step: string(todo.content, string(todo.id, 'Task')),
        status: (string(todo.status) === 'completed'
          ? 'completed'
          : string(todo.status) === 'in_progress'
            ? 'inProgress'
            : 'pending') as 'pending' | 'inProgress' | 'completed',
      }));

      const planItem: AgentPlanItemV2 = {
        type: 'plan',
        id: planId,
        text: planText,
        ...(steps.length > 0 ? { steps } : {}),
        status: 'completed',
        startedAt: nowIso(),
        completedAt: nowIso(),
      };

      this.ensureItem(planId, planItem);
    }

    // Accept the plan so Cursor continues execution without blocking
    client.respond(request.id, { outcome: { outcome: 'accepted' } });
  }

  private approvalTarget(toolCallId: string): string {
    const item = this.items.get(toolCallId);
    if (item?.type === 'commandExecution') return item.command;
    if (item?.type === 'fileChange') return item.paths[0]?.path ?? toolCallId;
    if (item?.type === 'dynamicToolCall') return item.tool;
    return toolCallId || 'a tool';
  }

  // ── Update mapping ─────────────────────────────────────────────────────────

  private appendMessageChunk(
    role: 'assistant' | 'reasoning',
    update: Record<string, unknown>
  ): void {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    const text = string(record(update.content).text);
    if (!text) return;
    const messageId = string(update.messageId, 'anonymous');
    const id = `${turnId}-${role}-${messageId}`;
    this.ensureItem(
      id,
      role === 'assistant'
        ? {
            type: 'assistantMessage',
            id,
            text: '',
            phase: 'answer',
            status: 'running',
            startedAt: nowIso(),
          }
        : {
            type: 'reasoning',
            id,
            summary: '',
            visibility: 'full',
            status: 'running',
            startedAt: nowIso(),
          }
    );
    this.emitDelta(id, role === 'assistant' ? { text } : { summary: text });
  }

  private startTool(update: Record<string, unknown>): void {
    if (!this.activeTurnId) return;
    const id = string(update.toolCallId);
    if (!id || this.items.has(id)) return;
    const name = string(update.title, 'tool');
    const args = isRecord(update.rawInput) ? update.rawInput : {};
    let item: AgentItemV2;
    if (COMMAND_TOOL_NAMES.has(name))
      item = {
        type: 'commandExecution',
        id,
        command: string(args.command, JSON.stringify(args)),
        ...(string(args.cwd) ? { cwd: string(args.cwd) } : {}),
        output: '',
        status: 'running',
        startedAt: nowIso(),
      };
    else if (FILE_TOOL_NAMES.has(name) && string(args.file_path ?? args.path))
      item = {
        type: 'fileChange',
        id,
        paths: [
          {
            path: string(args.file_path ?? args.path),
            status:
              name === 'write' || name === 'create_file' ? 'added' : 'edited',
          },
        ],
        applyStatus: 'pending',
        status: 'running',
        startedAt: nowIso(),
      };
    else
      item = {
        type: 'dynamicToolCall',
        id,
        namespace: 'cursor',
        tool: name,
        arguments: args,
        status: 'running',
        startedAt: nowIso(),
      };
    this.ensureItem(id, item);
  }

  private finishTool(update: Record<string, unknown>): void {
    if (!this.activeTurnId) return;
    const id = string(update.toolCallId);
    const item = this.items.get(id);
    if (!item) return;
    const acpStatus = string(update.status);
    if (acpStatus === 'pending' || acpStatus === 'in_progress') return;
    const failed = acpStatus === 'failed';
    const text = toolContentText(update.content);
    let updated: AgentItemV2;
    if (item.type === 'commandExecution')
      updated = {
        ...item,
        output: text,
        exitCode: failed ? 1 : 0,
        status: failed ? 'failed' : 'completed',
        completedAt: nowIso(),
      };
    else if (item.type === 'fileChange')
      updated = {
        ...item,
        applyStatus: failed ? 'failed' : 'applied',
        status: failed ? 'failed' : 'completed',
        completedAt: nowIso(),
      };
    else if (item.type === 'dynamicToolCall')
      updated = {
        ...item,
        result: text,
        status: failed ? 'failed' : 'completed',
        completedAt: nowIso(),
      };
    else return;
    this.items.set(id, updated);
    this.emitItemUpdated(updated);
  }

  private applyUsage(update: Record<string, unknown>): void {
    const used = numberOr(update.used, -1);
    const size = numberOr(update.size, -1);
    if (used < 0) return;
    const usage: AgentUsageV2 = { totalTokens: used };
    if (size > 0) {
      usage.contextWindowSize = size;
      usage.contextPercent = Math.min(100, (used / size) * 100);
    }
    this.turnUsage = usage;
  }

  // ── Turn lifecycle ─────────────────────────────────────────────────────────

  private startTurn(input: AgentSendMessageInputV2): void {
    this.activeTurnId = input.turnId;
    this.activeStartedMs = Date.now();
    this.abortRequested = false;
    this.turnUsage = undefined;
    this.items.clear();
    const timestamp = nowIso();
    emitTurnStartedPatch(this.patchSink, {
      turnId: input.turnId,
      startedAt: timestamp,
    });
    this.ensureItem(`user-${input.turnId}`, {
      type: 'userMessage',
      id: `user-${input.turnId}`,
      text: input.content ?? '',
      status: 'completed',
      completedAt: timestamp,
    });
    this.emitLive({
      status: 'working',
      activeTurnId: input.turnId,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queued.length,
    });
  }

  private completeTurn(
    status: 'completed' | 'interrupted' | 'failed',
    error?: string
  ): void {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.releasePendingRequests(TURN_ENDED_APPROVAL_REASON);
    this.terminalizeRunningItems(
      status === 'completed'
        ? 'completed'
        : status === 'interrupted'
          ? 'cancelled'
          : 'failed',
      error
    );
    emitTurnCompletedPatch(this.patchSink, {
      turnId,
      status,
      completedAt: nowIso(),
      durationMs: Date.now() - this.activeStartedMs,
      usage: this.turnUsage,
      error: error || undefined,
    });
    this.activeTurnId = null;
    this.items.clear();
    this.abortRequested = false;
    this.turnUsage = undefined;
    this.emitLive({
      status: this.queued.length ? 'working' : 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: this.queued.length,
      error: error ?? null,
    });
  }

  private runQueuedTurn(next: AgentSendMessageInputV2): void {
    this.queueAdvanceInFlight = true;
    try {
      const client = this.requireClient();
      this.startTurn(next);
      this.beginPrompt(client, next);
    } finally {
      this.queueAdvanceInFlight = false;
    }
  }

  private assertNoAttachments(input: AgentSendMessageInputV2): void {
    if (input.attachments && input.attachments.length > 0)
      throw new Error(
        'cursor channel runtime does not accept attachments on this lane'
      );
  }

  // ── Items and patches ──────────────────────────────────────────────────────

  private terminalizeRunningItems(
    status: 'completed' | 'failed' | 'cancelled',
    error?: string
  ): void {
    for (const [id, item] of this.items) {
      if (item.status !== 'running') continue;
      const updated: AgentItemV2 =
        item.type === 'fileChange'
          ? {
              ...item,
              status,
              applyStatus: status === 'completed' ? 'applied' : 'failed',
              completedAt: nowIso(),
              ...(error ? { error } : {}),
            }
          : {
              ...item,
              status,
              completedAt: nowIso(),
              ...(error ? { error } : {}),
            };
      this.items.set(id, updated);
      this.emitItemUpdated(updated);
    }
  }

  private releasePendingRequests(reason: string): void {
    const client = this.client;

    // Approvals
    if (this.pendingApprovals.size > 0) {
      const entries = [...this.pendingApprovals.entries()];
      const approvals: AbandonedApprovalV2[] = entries.map(
        ([requestId, pending]) => ({
          requestId,
          turnId: pending.turnId,
          card: pending.card,
        })
      );
      const peerIds = new Map(
        entries.map(([requestId, pending]) => [
          requestId,
          pending.peerRequestId,
        ])
      );
      this.pendingApprovals.clear();
      resolveAbandonedApprovals({
        sessionId: this.sessionId,
        approvals,
        emitPatch: (patch) => this.emitPatch(patch),
        denyOnWire: (approval) => {
          const peerId = peerIds.get(approval.requestId);
          if (client && peerId !== undefined)
            client.respond(peerId, { outcome: { outcome: 'cancelled' } });
        },
        reason,
      });
    }

    // Questions / Inputs
    if (this.pendingInputRequests.size > 0) {
      for (const [requestId, pending] of this.pendingInputRequests) {
        if (client) {
          client.respond(pending.peerRequestId, {
            outcome: { outcome: 'cancelled' },
          });
        }
        const updated: AgentQuestionItemV2 = {
          ...pending.card,
          status: 'cancelled',
          completedAt: nowIso(),
        };
        this.items.set(requestId, updated);
        this.emitItemUpdated(updated);
      }
      this.pendingInputRequests.clear();
    }
  }

  private ensureItem(id: string, item: AgentItemV2): void {
    if (this.items.has(id) || !this.activeTurnId) return;
    this.items.set(id, item);
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      item,
    });
  }

  private emitDelta(
    id: string,
    delta: { text?: string; summary?: string }
  ): void {
    if (!this.activeTurnId) return;
    const item = this.items.get(id);
    if (item) {
      if (item.type === 'assistantMessage' && delta.text)
        item.text += delta.text;
      if (item.type === 'reasoning' && delta.summary)
        item.summary += delta.summary;
    }
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      itemId: id,
      delta,
    });
  }

  private emitItemUpdated(item: AgentItemV2): void {
    if (!this.activeTurnId) return;
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId: this.activeTurnId,
      item,
    });
  }

  private emitError(message: string): void {
    emitErrorPatch(this.patchSink, message, this.activeTurnId);
  }

  private emitProviderExtension(
    payload: Record<string, unknown>,
    visibility: 'normal' | 'debug' = 'normal'
  ): void {
    if (!this.activeTurnId) return;
    emitProviderExtensionPatch(this.patchSink, {
      turnId: this.activeTurnId,
      namespace: 'cursor',
      seq: ++this.providerExtensionSequence,
      payload,
      visibility,
    });
  }

  private emitLive(live: Partial<AgentSessionLiveStateV2>): void {
    emitLiveStatePatch(this.patchSink, live);
  }

  private emitLiveStateUpdate(): void {
    const activeRequestIds = [
      ...this.pendingApprovals.keys(),
      ...this.pendingInputRequests.keys(),
    ];
    const waitingOn = this.pendingApprovals.size
      ? 'approval'
      : this.pendingInputRequests.size
        ? 'question'
        : null;

    this.emitLive({
      status: waitingOn ? 'waiting' : 'working',
      activeTurnId: this.activeTurnId,
      waitingOn,
      activeRequestIds,
      queueLength: this.queued.length,
    });
  }

  private emitSnapshot(): void {
    if (!this.config) return;
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: this.sessionId,
        provider: 'cursor',
        cwd: this.config.cwd,
        capabilities: this.capabilities,
        providerSession: this.cursorSessionId
          ? { cursorSessionId: this.cursorSessionId }
          : {},
      }),
    });
    if (this.resumeFallbackReason) {
      emitErrorPatch(
        this.patchSink,
        `cursor could not resume the previous session (${this.resumeFallbackReason}); started a new one.`
      );
      this.resumeFallbackReason = null;
    }
  }

  private resetForTransportSwitch(reason: string): void {
    this.releasePendingRequests(ABANDONED_APPROVAL_REASON);
    if (this.activeTurnId) this.completeTurn('failed', reason);
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this.items.clear();
  }

  private get sessionId(): string {
    return this.config?.sessionId ?? 'cursor';
  }

  private requireClient(): AcpClient {
    if (this._status !== 'connected' || !this.client)
      throw new Error('cursor adapter is not connected');
    return this.client;
  }

  private handleTransportClose(error: Error): void {
    if (this._status === 'disconnected') return;
    this.releasePendingRequests(ABANDONED_APPROVAL_REASON);
    if (this.activeTurnId) this.completeTurn('failed', error.message);
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this._status = 'disconnected';
    const client = this.client;
    this.client = null;
    this.clientGeneration += 1;
    void client?.stop().catch(() => undefined);
    this.emitError(error.message);
    this.emitLive({
      status: 'disconnected',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      queueLength: 0,
      error: error.message,
    });
  }
}

function stopReasonMessage(stopReason: string): string {
  if (stopReason === 'max_tokens') return 'cursor hit its output-token limit';
  if (stopReason === 'max_turn_requests')
    return 'cursor hit its per-turn request limit';
  if (stopReason === 'refusal') return 'cursor refused this request';
  return `cursor ended the turn: ${stopReason}`;
}

function toolContentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => {
      if (!isRecord(entry)) return '';
      const content = entry.content;
      return isRecord(content) && typeof content.text === 'string'
        ? content.text
        : '';
    })
    .join('');
}
