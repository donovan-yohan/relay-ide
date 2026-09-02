import { spawn as nodeSpawn } from 'node:child_process';
import { DSH_CHANNEL_COMMAND } from './launch-commands.js';
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
  AgentSessionLiveStateV2,
  AgentUsageV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';
import {
  DshAcpClient,
  type DshAcpClientOptions,
  type DshAcpNotification,
  type DshAcpPeerRequest,
} from '../dsh-acp-client.js';

const logger = createLogger('dsh-adapter');

/**
 * Honest capabilities for the DeepSeek Harness ACP lane (`dsh --profile acp`).
 *
 * The `true`s that carry weight, and where they come from on the wire:
 *  - `interrupt`: `session/cancel` is a real cancellation — the in-flight
 *    `session/prompt` settles with `stopReason: 'cancelled'`. Nothing is killed.
 *  - `resume`: `initialize` advertises `sessionCapabilities.resume`, and a
 *    closed session reopened with `session/resume` still remembers its history.
 *  - `approvals`: the server sends `session/request_permission` as a
 *    server-to-client REQUEST and blocks the turn until it is answered.
 *
 * The `false`s are the ACP server's own documented non-surface: it omits or
 * rejects `session/load`, deletion, fork, modes, commands, plans, terminals,
 * client filesystem operations, and elicitation.
 */
const CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  questions: false,
  plans: false,
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
  // `Required<...>`: a new protocol capability must be answered here rather than
  // read as false by omission. See `Fidelity invariants` in AGENTS.md.
} satisfies Required<AgentCapabilitySetV2>;

const QUEUE_ABANDONED_MESSAGE =
  'dsh session ended before this queued message was sent.';

/** The ACP major version this adapter speaks. */
const ACP_PROTOCOL_VERSION = 1;

/** Profile that boots the harness's ACP stdio server. */
const DSH_ACP_PROFILE = 'acp';

/**
 * The permission choices the harness offers, byte for byte
 * (`packages/acp/acp/src/index.ts`, the `approval/request` bridge). It
 * hard-codes exactly these two one-shot options and infers no durable grant, so
 * Relay advertises `once` alone: an `allow-always` decision has nowhere to go.
 */
const DSH_ALLOW_OPTION_ID = 'allow-once';
const DSH_REJECT_OPTION_ID = 'reject-once';
const DSH_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once'],
  amendmentTypes: [],
  canCancel: true,
};

/** Native tool names Relay renders as a command card. */
const COMMAND_TOOL_NAMES = new Set(['bash', 'pwsh', 'terminal_bash']);
/** Native tool names Relay renders as a file-change card. */
const FILE_TOOL_NAMES = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'str_replace_based_edit_tool',
]);

type ClientFactory = (options: DshAcpClientOptions) => DshAcpClient;

interface PendingApproval {
  turnId: string;
  /** The JSON-RPC id of the server request still waiting for our answer. */
  peerRequestId: string | number;
  card: AgentApprovalItemV2;
}

export class DshProtocolAdapter extends BaseProtocolAdapterV2 {
  private readonly patchSink = createPatchSink(
    () => this.sessionId,
    (patch) => this.emitPatch(patch)
  );
  readonly agentType = 'dsh';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = CAPABILITIES;
  /** `connect()` consumes `resumeSessionId` via `session/resume`, atomically. */
  readonly resumesProviderSessionDuringConnect = true;

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private client: DshAcpClient | null = null;
  private clientGeneration = 0;
  private dshSessionId: string | null = null;
  private activeTurnId: string | null = null;
  private activeStartedMs = 0;
  private abortRequested = false;
  private turnUsage: AgentUsageV2 | undefined;
  private providerExtensionSequence = 0;
  private queueAdvanceInFlight = false;
  private readonly items = new Map<string, AgentItemV2>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** Set when a requested resume was refused and a fresh session was opened. */
  private resumeFallbackReason: string | null = null;
  /** `configOptions` from the last session open, for the debug extension. */
  private sessionConfigOptions: unknown[] | null = null;

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
      new DshAcpClient({ ...options, spawn: nodeSpawn })
  ) {
    super();
  }

  get status(): AdapterStatus {
    return this._status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this._status = 'connecting';
    const client = this.clientFactory({
      command: DSH_CHANNEL_COMMAND,
      args: ['--profile', DSH_ACP_PROFILE],
      cwd: config.cwd,
      env: this.buildEnv(config),
    });
    this.client = client;
    const generation = ++this.clientGeneration;
    const current = (): boolean =>
      this.client === client && this.clientGeneration === generation;
    client.on('notification', (notification: DshAcpNotification) => {
      if (current()) this.handleNotification(notification);
    });
    client.on('peerRequest', (request: DshAcpPeerRequest) => {
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
            `dsh ACP transport closed${client.stderrTailText ? `: ${client.stderrTailText}` : ''}`
          )
        );
    });

    try {
      await client.start({
        protocolVersion: ACP_PROTOCOL_VERSION,
        // Relay owns its own filesystem and terminal surfaces; the agent must
        // not ask this client to perform them.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      const opened = await this.openSession(client, config);
      // `session/resume` answers without echoing the id it reopened.
      this.dshSessionId =
        string(opened.sessionId) || config.resumeSessionId || null;
      this.sessionConfigOptions = Array.isArray(opened.configOptions)
        ? opened.configOptions
        : null;
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

  /**
   * One ACP session per Relay runtime. `session/resume` reopens the persisted
   * conversation; `session/new` starts one. Either way the workspace is the
   * Relay-assigned cwd, which the server validates before publishing.
   */
  private async openSession(
    client: DshAcpClient,
    config: AdapterConfig
  ): Promise<Record<string, unknown>> {
    const params = { cwd: config.cwd, mcpServers: [] };
    if (!config.resumeSessionId)
      return record(await client.request('session/new', params));
    try {
      return record(
        await client.request('session/resume', {
          sessionId: config.resumeSessionId,
          ...params,
        })
      );
    } catch (error) {
      // A resume the server refuses (session gone, workspace moved) must not
      // strand the channel: start a fresh conversation and say so on the
      // transcript, rather than failing connect and leaving the channel mute.
      this.resumeFallbackReason =
        error instanceof Error ? error.message : String(error);
      logger.warn('[dsh] session/resume failed; starting a fresh session', {
        message: this.resumeFallbackReason,
      });
      return record(await client.request('session/new', params));
    }
  }

  /**
   * Adapter-set keys land AFTER `buildChildEnv` so a named profile cannot break
   * the one the server's own composition reads from the environment.
   */
  private buildEnv(config: AdapterConfig): Record<string, string> {
    // No provider extras in the denylist: the harness reads its credentials
    // from `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`, which a named profile MUST
    // stay able to set. Only the universal nesting set is stripped.
    const env = buildChildEnv({ processEnv: config.processEnv });
    // The ACP composition derives BOTH its sandbox mode and its approval policy
    // from this one variable. Relay states it rather than inheriting whatever
    // the hub environment held.
    env.DSH_PERMISSION_MODE =
      config.processEnv?.DSH_PERMISSION_MODE ??
      config.permissionMode ??
      'workspace-write';
    return env;
  }

  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
    // Release the provider on its own wire BEFORE the client goes away, so a
    // blocked turn is not left waiting on an answer that can never arrive.
    this.releaseApprovals(ABANDONED_APPROVAL_REASON);
    await this.teardownClient();
    this.activeTurnId = null;
    this.dshSessionId = null;
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
      // A transport reconnect keeps the SAME dsh conversation: the ACP server
      // persists it, so the new process resumes rather than starting over.
      transformConfig: (config) => ({
        ...config,
        ...(this.dshSessionId ? { resumeSessionId: this.dshSessionId } : {}),
      }),
      disconnect: async () => {
        this.resetForTransportSwitch('dsh transport reconnected');
        this._status = 'disconnected';
        await this.teardownClient();
      },
      connect: (config) => this.connect(config),
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (!this.config) throw new Error('Cannot resumeSession before connect');
    const config = { ...this.config, resumeSessionId: sessionId };
    this.resetForTransportSwitch('dsh session switched');
    this._status = 'disconnected';
    await this.teardownClient();
    await this.connect(config);
  }

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    const client = this.requireClient();
    // Rejected BEFORE any turn patch, and before the queue: `initialize`
    // reported `promptCapabilities.image: false` on this route, so accepting an
    // attachment would silently drop the user's file. Nothing about that answer
    // depends on the file, so the caller learns immediately.
    this.assertNoAttachments(input);
    if (this.activeTurnId) return this.queued.enqueue(input);

    this.startTurn(input);
    this.beginPrompt(client, input);
  }

  /**
   * Issue the prompt and let it settle in the background.
   *
   * `sendMessage` deliberately does NOT await it. On this wire the prompt
   * response is the whole TURN's outcome, not an acceptance receipt, and the
   * binder treats `sendMessage` resolution as its delivery boundary — awaiting
   * here would hold every message "undelivered" until its turn finished and
   * would stall the send queue behind it. A prompt that rejects is ambiguous
   * (the server may have admitted it), so it takes the transport down rather
   * than leaving a turn Relay has given up on still streaming.
   */
  private beginPrompt(
    client: DshAcpClient,
    input: AgentSendMessageInputV2
  ): void {
    void this.runPrompt(client, input).catch((error: unknown) => {
      this.handleTransportClose(
        error instanceof Error ? error : new Error(String(error))
      );
    });
  }

  /**
   * Send one prompt and complete the Relay turn on its RESPONSE.
   *
   * `session/prompt` settles only when the whole turn has: the ACP server waits
   * for agent idle and ordered update delivery before answering, so its
   * `stopReason` IS the turn outcome. There is no separate settled event to
   * wait for, and no window in which a completed turn is still streaming.
   */
  private async runPrompt(
    client: DshAcpClient,
    input: AgentSendMessageInputV2
  ): Promise<void> {
    const response = record(
      await client.prompt({
        sessionId: this.dshSessionId,
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

  /**
   * Stop the active turn. `session/cancel` is a real cancellation: the pending
   * `session/prompt` settles with `stopReason: 'cancelled'`, so nothing is
   * killed and the conversation survives for the next turn.
   */
  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    if (!this.activeTurnId) return;
    if (input.turnId && input.turnId !== this.activeTurnId) return;
    const client = this.client;
    if (!client || !this.dshSessionId) return;
    this.abortRequested = true;
    // An outstanding approval owns the turn; answering it first releases the
    // agent so the cancel is not queued behind a question nobody will answer.
    this.releaseApprovals(TURN_ENDED_APPROVAL_REASON);
    client.notify('session/cancel', { sessionId: this.dshSessionId });
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    const pending = this.pendingApprovals.get(input.requestId);
    if (!pending) throw new Error(`Unknown dsh approval: ${input.requestId}`);
    const client = this.requireClient();
    this.pendingApprovals.delete(input.requestId);
    const outcome =
      input.decision.kind === 'cancel'
        ? { outcome: 'cancelled' }
        : {
            outcome: 'selected',
            optionId:
              input.decision.kind === 'accept'
                ? DSH_ALLOW_OPTION_ID
                : DSH_REJECT_OPTION_ID,
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
    this.emitLive({
      status: 'working',
      waitingOn: this.pendingApprovals.size ? 'approval' : null,
      activeRequestIds: [...this.pendingApprovals.keys()],
    });
  }

  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {
    // The ACP server explicitly does not implement elicitation.
    throw new Error('dsh ACP questions are not mapped');
  }

  // ── Wire routing ───────────────────────────────────────────────────────────

  private handleNotification(notification: DshAcpNotification): void {
    const { method, params } = notification;
    if (method !== 'session/update') {
      logger.debug('[dsh] unmapped native notification', { method });
      return;
    }
    const sessionId = string(params.sessionId);
    if (this.dshSessionId && sessionId && sessionId !== this.dshSessionId) {
      logger.debug('[dsh] ignoring update for another session', { sessionId });
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
      case 'config_option_update':
        this.sessionConfigOptions = Array.isArray(update.configOptions)
          ? update.configOptions
          : this.sessionConfigOptions;
        this.emitProviderExtension(
          { kind: 'configOptions', options: this.sessionConfigOptions ?? [] },
          'debug'
        );
        return;
      default:
        // A logged gap, never a silent drop.
        logger.debug('[dsh] unmapped native session update', { kind });
    }
  }

  /**
   * The ACP server is the only stdio harness Relay talks to that can send US a
   * request. An unanswered one blocks the agent's turn forever, so every branch
   * here must answer — including the unknown-method one.
   */
  private handlePeerRequest(request: DshAcpPeerRequest): void {
    const client = this.client;
    if (!client) return;
    if (request.method !== 'session/request_permission') {
      logger.debug('[dsh] unmapped native peer request', {
        method: request.method,
      });
      // JSON-RPC "method not found": the server learns immediately instead of
      // waiting on an answer this client cannot form.
      client.respondError(
        request.id,
        -32601,
        `Relay does not implement ${request.method}`
      );
      return;
    }
    const turnId = this.activeTurnId;
    if (!turnId) {
      // No Relay turn owns this request, so there is no card to raise and
      // nobody to ask. `cancelled` is ACP's own "the client did not choose"
      // and releases the agent immediately.
      client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const toolCallId = string(record(request.params.toolCall).toolCallId);
    const requestId = `dsh-approval-${String(request.id)}`;
    const target = this.approvalTarget(toolCallId);
    const startedAt = nowIso();
    const card: AgentApprovalItemV2 = {
      type: 'approval',
      id: `approval-${requestId}`,
      requestId,
      kind: 'permission',
      description: `dsh wants to run ${target}`,
      target,
      supported: DSH_APPROVAL_SUPPORT,
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
    this.emitLive({
      status: 'waiting',
      activeTurnId: turnId,
      waitingOn: 'approval',
      activeRequestIds: [...this.pendingApprovals.keys()],
      queueLength: this.queued.length,
    });
  }

  /** The best human label for what is being approved: the tool card, or its id. */
  private approvalTarget(toolCallId: string): string {
    const item = this.items.get(toolCallId);
    if (item?.type === 'commandExecution') return item.command;
    if (item?.type === 'fileChange') return item.paths[0]?.path ?? toolCallId;
    if (item?.type === 'dynamicToolCall') return item.tool;
    return toolCallId || 'a tool';
  }

  // ── Update mapping ─────────────────────────────────────────────────────────

  /**
   * ACP chunks carry a native `messageId`, so one assistant message keeps one
   * card across however many chunks the server commits for it, and a later
   * message in the same turn opens its own.
   */
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
    // `rawInput` is the parsed tool arguments; the server falls back to the raw
    // string when the model emitted invalid JSON, which is not a record.
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
            status: name === 'write' ? 'added' : 'edited',
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
        namespace: 'dsh',
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
    // ACP streams tool PROGRESS through the same `tool_call_update` it uses to
    // report the result, distinguished only by `status`. Terminalizing the item
    // on a progress update told the channel binder the tool had finished while
    // it was still running, which (#1548) reopens the inactivity watchdog on a
    // turn that is busy. The result update that follows carries the full output
    // anyway, so nothing is lost by ignoring the progress ones.
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

  /**
   * ACP reports context OCCUPANCY (`used` of `size`), not per-turn input and
   * output tokens, so the turn total is the LAST reading rather than a sum.
   */
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
      text: input.content,
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
    // An approval still on screen when the turn ends is answered on the wire
    // and terminalized, never left actionable.
    this.releaseApprovals(TURN_ENDED_APPROVAL_REASON);
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

  /**
   * Start one queued turn. Attachments are already excluded — `sendMessage`
   * rejects them before the queue ever sees them — so the only failure left
   * here is a dead transport, which rejects this entry and lets the queue
   * reject the rest.
   */
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
        'dsh channel runtime does not accept attachments on this lane'
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

  /**
   * Answer every outstanding permission request on the wire and terminalize its
   * card. Shared choreography owns the card; the `denyOnWire` hook is the dsh
   * quirk — the ACP `cancelled` outcome, which is the protocol's own "the
   * client did not choose".
   */
  private releaseApprovals(reason: string): void {
    if (this.pendingApprovals.size === 0) return;
    const client = this.client;
    const entries = [...this.pendingApprovals.entries()];
    const approvals: AbandonedApprovalV2[] = entries.map(
      ([requestId, pending]) => ({
        requestId,
        turnId: pending.turnId,
        card: pending.card,
      })
    );
    const peerIds = new Map(
      entries.map(([requestId, pending]) => [requestId, pending.peerRequestId])
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
      namespace: 'dsh',
      seq: ++this.providerExtensionSequence,
      payload,
      visibility,
    });
  }

  private emitLive(live: Partial<AgentSessionLiveStateV2>): void {
    emitLiveStatePatch(this.patchSink, live);
  }

  private emitSnapshot(): void {
    if (!this.config) return;
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: this.sessionId,
        provider: 'dsh',
        cwd: this.config.cwd,
        capabilities: this.capabilities,
        // The persisted ACP session id. This IS the resume key — the descriptor
        // names it `dshSessionId` and `session/resume` reopens it.
        providerSession: this.dshSessionId
          ? { dshSessionId: this.dshSessionId }
          : {},
      }),
    });
    if (this.resumeFallbackReason) {
      // Say it once, on the transcript: the operator asked to continue a
      // conversation and got a fresh one instead.
      emitErrorPatch(
        this.patchSink,
        `dsh could not resume the previous session (${this.resumeFallbackReason}); started a new one.`
      );
      this.resumeFallbackReason = null;
    }
  }

  private resetForTransportSwitch(reason: string): void {
    this.releaseApprovals(ABANDONED_APPROVAL_REASON);
    if (this.activeTurnId) this.completeTurn('failed', reason);
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this.items.clear();
  }

  private get sessionId(): string {
    return this.config?.sessionId ?? 'dsh';
  }

  private requireClient(): DshAcpClient {
    if (this._status !== 'connected' || !this.client)
      throw new Error('dsh adapter is not connected');
    return this.client;
  }

  private handleTransportClose(error: Error): void {
    if (this._status === 'disconnected') return;
    this.releaseApprovals(ABANDONED_APPROVAL_REASON);
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

/** Operator-facing text for the non-`end_turn` ACP stop reasons. */
function stopReasonMessage(stopReason: string): string {
  if (stopReason === 'max_tokens') return 'dsh hit its output-token limit';
  if (stopReason === 'max_turn_requests')
    return 'dsh hit its per-turn request limit';
  if (stopReason === 'refusal') return 'dsh refused this request';
  return `dsh ended the turn: ${stopReason}`;
}

/** Flatten an ACP `ToolCallContent[]` to its text. */
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
