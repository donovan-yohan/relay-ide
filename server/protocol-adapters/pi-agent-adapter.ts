import { PI_AGENT_CHANNEL_COMMAND } from './launch-commands.js';
import {
  buildChildEnv,
  createPatchSink,
  createTurnQueue,
  emitErrorPatch,
  emitLiveStatePatch,
  emitProviderExtensionPatch,
  emitTurnCompletedPatch,
  emitTurnStartedPatch,
  reconnectWithStoredConfig,
} from './adapter-utils.js';
import {
  nowIso,
  objectField as record,
  queueCount,
  stringField as string,
} from './wire-values.js';
import {
  AnonymousToolIdTracker,
  accumulateRpcUsage,
  isCommandTool,
  isFileTool,
  readValidatedImages,
  resultText,
  toolArguments,
  type RpcRecord,
} from './pi-rpc-shared.js';
import { spawn as nodeSpawn } from 'node:child_process';
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
import {
  PiAgentRpcClient,
  type PiAgentRpcClientOptions,
  type PiAgentRpcMessage,
} from '../pi-agent-rpc-client.js';

const CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: false,
  questions: false,
  plans: false,
  slashCommands: false,
  queue: true,
  // No native mid-turn injection boundary, and no `steerMessage` implementation.
  steer: false,
  cancelQueued: false,
  interrupt: true,
  resume: true,
  fork: false,
  rollback: false,
  compact: true,
  telemetry: true,
  rateLimits: false,
  streaming: true,
  // `Required<...>`: a new protocol capability must be answered here rather than
  // read as false by omission. See `Fidelity invariants` in AGENTS.md.
} satisfies Required<AgentCapabilitySetV2>;

/**
 * Why a queued message failed when the session went away underneath it. The
 * hand-written code simply emptied the array, so `sendMessage` had already
 * resolved and the message vanished without a trace; this reaches the caller.
 */
const QUEUE_ABANDONED_MESSAGE =
  'Pi session ended before this queued message was sent.';

type ClientFactory = (options: PiAgentRpcClientOptions) => PiAgentRpcClient;

export class PiAgentProtocolAdapter extends BaseProtocolAdapterV2 {
  /** Shared patch-emission conventions (adapter-utils). */
  private readonly patchSink = createPatchSink(
    () => this.sessionId,
    (patch) => this.emitPatch(patch)
  );
  readonly agentType = 'pi';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = CAPABILITIES;
  readonly resumesProviderSessionDuringConnect = true;

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private client: PiAgentRpcClient | null = null;
  private providerSessionId: string | null = null;
  private providerSessionFile: string | null = null;
  private activeTurnId: string | null = null;
  private activeStartedMs = 0;
  private abortRequested = false;
  private turnFailure: string | null = null;
  private assistantMessageSequence = -1;
  private turnUsage: AgentUsageV2 | undefined;
  private clientGeneration = 0;
  /**
   * Shared send queue (adapter-utils). Entries now settle when their turn
   * STARTS, where the hand-written array resolved `sendMessage` the moment the
   * message was pushed — see `createTurnQueue` for why that had to change.
   */
  private readonly queued = createTurnQueue<AgentSendMessageInputV2>({
    canDrain: () =>
      !this.queueAdvanceInFlight &&
      this.activeTurnId === null &&
      this._status === 'connected',
    startTurn: (input) => this.runQueuedTurn(input),
    // Teardown already publishes the live state that covers an emptied queue
    // (`handleTransportClose`), and a disconnecting adapter has no live state
    // left to describe. A bare depth patch here would be new noise in the
    // stream, so only an arriving message announces itself.
    onLengthChange: (queueLength, reason) => {
      if (reason === 'enqueued')
        this.emitLive({
          status: 'working',
          activeTurnId: this.activeTurnId,
          queueLength,
        });
    },
  });
  private readonly anonymousToolIds = new AnonymousToolIdTracker({
    activeTurnId: () => this.activeTurnId,
    assistantSeq: () => this.assistantMessageSequence,
  });
  private queueAdvanceInFlight = false;
  private providerExtensionSequence = 0;
  private readonly items = new Map<string, AgentItemV2>();
  // Empty-args guard state: a command/file tool with missing required fields
  // is rejected by the harness validator, returns no usable tool result, and the
  // model burns output tokens retrying the identical empty call. Counts are
  // tracked PER TOOL NAME so a valid invocation of an unrelated tool cannot
  // reset a stuck tool's streak (an empty `bash` loop keeps counting regardless
  // of interleaved `edit` calls).
  private readonly emptyToolCounts = new Map<string, number>();
  private readonly suppressedEmptyToolIds = new Set<string>();

  constructor(
    private readonly clientFactory: ClientFactory = (options) =>
      new PiAgentRpcClient({ ...options, spawn: nodeSpawn })
  ) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this._status = 'connecting';
    const args = ['--mode', 'rpc', '--no-extensions'];
    const provider = string(config.extra?.['provider']);
    const thinking = string(config.extra?.['effort']);
    if (provider) args.push('--provider', provider);
    if (config.model) args.push('--model', config.model);
    if (thinking) args.push('--thinking', thinking);
    if (config.systemPromptAppendix)
      args.push('--append-system-prompt', config.systemPromptAppendix);
    // Pi resumes a durable session by exact project session id (`--session-id`),
    // the analog of Prime Agent's `--resume <sessionId>`.
    if (config.resumeSessionId)
      args.push('--session-id', config.resumeSessionId);
    const env = buildChildEnv({ processEnv: config.processEnv });
    const client = this.clientFactory({
      command: PI_AGENT_CHANNEL_COMMAND,
      args,
      cwd: config.cwd,
      env,
    });
    this.client = client;
    const generation = ++this.clientGeneration;
    const current = (): boolean =>
      this.client === client && this.clientGeneration === generation;
    client.on('event', (event: PiAgentRpcMessage) => {
      if (current()) this.handleEvent(event);
    });
    client.on('protocolError', (error: Error) => {
      if (current()) this.handleTransportClose(error);
    });
    client.on('error', (error: Error) => {
      if (current()) this.handleTransportClose(error);
    });
    client.on('close', () => {
      if (current() && this._status !== 'disconnected')
        this.handleTransportClose(new Error('pi RPC transport closed'));
    });
    try {
      const response = await client.start();
      this.applyState(record(response.data));
      this._status = 'connected';
      this.emitSnapshot();
      this.emitLive({
        status: record(response.data).isStreaming === true ? 'working' : 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        proposedPlanItemId: null,
        queueLength: queueCount(record(response.data).pendingMessageCount),
        fastModeAvailable: false,
        error: null,
      });
    } catch (error) {
      this._status = 'disconnected';
      await client.stop().catch(() => undefined);
      throw error;
    }
  }

  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
    await this.teardownClient();
    this.activeTurnId = null;
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this.items.clear();
    this.anonymousToolIds.clear();
    this.suppressedEmptyToolIds.clear();
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
        ...(this.providerSessionId
          ? { resumeSessionId: this.providerSessionId }
          : {}),
      }),
      disconnect: async () => {
        this.resetForTransportSwitch('Pi transport reconnected');
        this._status = 'disconnected';
        await this.teardownClient();
      },
      connect: (config) => this.connect(config),
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (!this.config) throw new Error('Cannot resumeSession before connect');
    const config = { ...this.config, resumeSessionId: sessionId };
    this.resetForTransportSwitch('Pi session switched');
    this._status = 'disconnected';
    await this.teardownClient();
    await this.connect(config);
  }

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    const client = this.requireClient();
    const payload: RpcRecord = { message: input.content };
    const images = this.readImages(input.attachments);
    if (images.length) payload.images = images;
    if (this.activeTurnId) {
      // Pi `steer`/`follow_up` stay inside the current native run and therefore
      // have no separate agent_settled boundary that Relay can attribute to this
      // turn. Keep Relay turns local and submit a fresh prompt after settle.
      return this.queued.enqueue(input);
    }

    this.startTurn(input);
    try {
      await this.submitNativeInput(client, input, payload);
    } catch (error) {
      // A timeout is ambiguous: Pi may have accepted the prompt. Stop the
      // private runtime so late events/tools cannot outlive Relay attribution.
      this.handleTransportClose(
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    if (!this.activeTurnId) return;
    if (input.turnId && input.turnId !== this.activeTurnId) return;
    this.abortRequested = true;
    try {
      await this.requireClient().call('abort');
    } catch (error) {
      this.abortRequested = false;
      throw error;
    }
  }
  async respondToApproval(_input: AgentApprovalResponseInputV2): Promise<void> {
    throw new Error('Pi RPC approvals are not mapped');
  }
  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {
    throw new Error('Pi RPC questions are not mapped');
  }

  private handleEvent(event: PiAgentRpcMessage): void {
    const type = event.type;
    // Pi emits `agent_end` before `agent_settled`; `agent_end` may still be
    // followed by an automatic retry, compaction retry, or queued continuation.
    // `agent_settled` is the session-level settled boundary (emitted in a
    // `finally`, so it also fires on error/abort), and is the safe Relay turn
    // boundary.
    if (type === 'turn_start' || type === 'turn_end') return;
    if (type === 'agent_end') return;
    if (type === 'message_start') {
      if (record(event.message).role === 'assistant')
        this.assistantMessageSequence += 1;
      return;
    }
    if (type === 'agent_settled') {
      this.completeTurn(
        this.abortRequested
          ? 'interrupted'
          : this.turnFailure
            ? 'failed'
            : 'completed',
        this.turnFailure ?? undefined
      );
      this.advanceQueuedTurn();
      return;
    }
    if (type === 'message_update') {
      this.handleMessageUpdate(record(event.assistantMessageEvent));
      return;
    }
    if (type === 'message_end') {
      const message = record(event.message);
      if (message.stopReason === 'aborted') this.abortRequested = true;
      if (message.stopReason === 'error')
        this.turnFailure = string(message.errorMessage, 'Pi generation failed');
      this.finishMessageItems(
        this.abortRequested
          ? 'cancelled'
          : this.turnFailure
            ? 'failed'
            : 'completed'
      );
      this.captureUsage(message);
      return;
    }
    if (type === 'tool_execution_start') {
      this.startTool(event);
      return;
    }
    if (type === 'tool_execution_update') {
      this.updateTool(event, event.partialResult, false);
      return;
    }
    if (type === 'tool_execution_end') {
      this.updateTool(event, event.result, true);
      return;
    }
    if (type === 'queue_update') {
      // Pi queues steering/follow-up messages only; Relay submits one prompt per
      // message. Combine the native count with Relay's pending prompts: the
      // native event must not hide work already queued by Relay.
      const nativeQueueLength =
        (Array.isArray(event.steering) ? event.steering.length : 0) +
        (Array.isArray(event.followUp) ? event.followUp.length : 0);
      this.emitLive({
        queueLength: this.queued.length + nativeQueueLength,
      });
      return;
    }
    if (type === 'compaction_end') {
      this.emitProviderExtension({
        kind: 'contextCompaction',
        reason: string(event.reason, 'threshold'),
        ...(event.result ? { result: record(event.result) } : {}),
      });
      return;
    }
    if (type === 'extension_error') {
      this.emitProviderExtension(
        {
          kind: 'extensionError',
          error: string(event.error, 'Pi extension error'),
        },
        'debug'
      );
      return;
    }
    if (type === 'auto_retry_end' && event.success === false) {
      this.turnFailure = string(event.finalError, 'Pi retry failed');
      this.emitError(this.turnFailure);
    }
  }

  private handleMessageUpdate(delta: RpcRecord): void {
    if (!this.activeTurnId) return;
    const kind = string(delta.type);
    const index = Number(delta.contentIndex ?? 0);
    if (kind === 'text_start' || kind === 'text_delta') {
      const id = `${this.activeTurnId}-assistant-${Math.max(0, this.assistantMessageSequence)}-${index}`;
      this.ensureItem(id, {
        type: 'assistantMessage',
        id,
        text: '',
        phase: 'answer',
        status: 'running',
        startedAt: nowIso(),
      });
      if (kind === 'text_delta' && typeof delta.delta === 'string')
        this.emitDelta(id, { text: delta.delta });
    } else if (kind === 'thinking_start' || kind === 'thinking_delta') {
      const id = `${this.activeTurnId}-reasoning-${Math.max(0, this.assistantMessageSequence)}-${index}`;
      this.ensureItem(id, {
        type: 'reasoning',
        id,
        summary: '',
        visibility: 'full',
        status: 'running',
        startedAt: nowIso(),
      });
      if (kind === 'thinking_delta' && typeof delta.delta === 'string')
        this.emitDelta(id, { summary: delta.delta });
    } else if (kind === 'toolcall_end') {
      const toolCall = record(delta.toolCall);
      const id = this.toolIdForPreview(toolCall, index);
      this.ensureTool(
        id,
        string(toolCall.name, 'tool'),
        toolArguments(toolCall.arguments ?? toolCall.args)
      );
    } else if (kind === 'error') {
      if (delta.reason === 'aborted') this.abortRequested = true;
      else {
        this.turnFailure = string(
          delta.error,
          string(delta.reason, 'Pi generation error')
        );
        this.emitError(this.turnFailure);
      }
    }
  }

  private startTool(event: RpcRecord): void {
    if (!this.activeTurnId) return;
    const id = this.toolIdForStart(event);
    const name = string(event.toolName, 'tool');
    const args = toolArguments(event.args);
    // Empty-args guard: a command/file tool with missing required fields is
    // rejected by the harness validator (no usable tool result), which makes the
    // model retry the identical empty call until it exhausts output tokens.
    if (this.isEmptyToolCall(name, args)) {
      this.suppressedEmptyToolIds.add(id);
      this.handleEmptyToolCall(name);
      return;
    }
    // A non-empty invocation of this tool is legitimate progress — clear only
    // THIS tool's empty streak (an unrelated tool's valid call must not reset it).
    this.emptyToolCounts.delete(name);
    this.ensureTool(id, name, args);
  }

  private isEmptyToolCall(name: string, args: RpcRecord): boolean {
    if (isCommandTool(name)) return string(args.command).trim().length === 0;
    if (isFileTool(name))
      return string(args.path ?? args.file_path).trim().length === 0;
    return false;
  }

  private handleEmptyToolCall(name: string): void {
    if (!this.activeTurnId) return;
    // Per-tool consecutive count: `bash, edit, edit` only counts the `edit`
    // repeats, and an interleaved valid call of another tool never resets `bash`.
    const count = (this.emptyToolCounts.get(name) ?? 0) + 1;
    this.emptyToolCounts.set(name, count);
    this.emitError(
      `Pi ${name} call received empty arguments (missing required field); the model should re-issue it with a concrete command/path or answer directly`
    );
    // Once the same empty tool has repeated, inject a corrective prompt into the
    // harness so it self-corrects instead of burning output tokens on retries.
    // Trigger exactly at count === 3 so a burst of empty calls (5+) queues only
    // one corrective steer, not one per extra call.
    if (count === 3) {
      this.injectCorrectivePrompt(name);
    }
  }

  private injectCorrectivePrompt(name: string): void {
    const client = this._status === 'connected' ? this.client : null;
    if (!client) return;
    const corrective =
      `Your previous ${name} tool call omitted the required arguments (received empty). ` +
      `Re-issue the call with a concrete command/path, or if no tool is needed, ` +
      `answer directly without calling ${name}.`;
    // Pi is actively streaming when this fires (tool_execution_start). A `prompt`
    // without `streamingBehavior` is rejected in that state (pi RPC docs), so use
    // `steer`: it queues while running and is delivered after the current turn's
    // tool calls finish, before the next LLM call.
    void client.call('steer', { message: corrective }).catch((error) => {
      if (this._status === 'connected') {
        this.emitError(
          `Failed to send corrective prompt to Pi: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  private ensureTool(id: string, name: string, args: RpcRecord): void {
    if (!this.activeTurnId || this.items.has(id)) return;
    let item: AgentItemV2;
    if (isCommandTool(name))
      item = {
        type: 'commandExecution',
        id,
        command: string(args.command, JSON.stringify(args)),
        ...(string(args.cwd) ? { cwd: string(args.cwd) } : {}),
        output: '',
        status: 'running',
        startedAt: nowIso(),
      };
    else if (
      isFileTool(name) &&
      string(args.path ?? args.file_path).length > 0
    ) {
      const path = string(args.path ?? args.file_path);
      item = {
        type: 'fileChange',
        id,
        paths: [{ path, status: /delete/i.test(name) ? 'deleted' : 'edited' }],
        applyStatus: 'pending',
        status: 'running',
        startedAt: nowIso(),
      };
    } else
      item = {
        type: 'dynamicToolCall',
        id,
        namespace: 'pi',
        tool: name,
        arguments: args,
        status: 'running',
        startedAt: nowIso(),
      };
    this.ensureItem(id, item);
  }

  private updateTool(event: RpcRecord, result: unknown, done: boolean): void {
    if (!this.activeTurnId) return;
    const id = this.toolIdForUpdate(event);
    if (this.suppressedEmptyToolIds.has(id)) {
      if (done) {
        this.suppressedEmptyToolIds.delete(id);
        this.forgetAnonymousToolId(event, id);
      }
      return;
    }
    this.ensureTool(
      id,
      string(event.toolName, 'tool'),
      toolArguments(event.args)
    );
    const item = this.items.get(id);
    if (!item) return;
    const text = resultText(result);
    if (!done) {
      if (item.type === 'commandExecution')
        this.emitDelta(id, { output: text }, 'replace');
      else if (item.type === 'dynamicToolCall')
        this.emitDelta(id, { content: text }, 'replace');
      return;
    }
    let updated: AgentItemV2;
    if (item.type === 'commandExecution')
      updated = {
        ...item,
        output: text,
        exitCode: event.isError === true ? 1 : 0,
        status: event.isError === true ? 'failed' : 'completed',
        completedAt: nowIso(),
      };
    else if (item.type === 'fileChange')
      updated = {
        ...item,
        applyStatus: event.isError === true ? 'failed' : 'applied',
        status: event.isError === true ? 'failed' : 'completed',
        completedAt: nowIso(),
      };
    else if (item.type === 'dynamicToolCall')
      updated = {
        ...item,
        result,
        status: event.isError === true ? 'failed' : 'completed',
        completedAt: nowIso(),
      };
    else return;
    this.items.set(id, updated);
    this.emitItemUpdated(updated);
    if (done) this.forgetAnonymousToolId(event, id);
  }

  private finishMessageItems(
    status: 'completed' | 'failed' | 'cancelled' = 'completed'
  ): void {
    for (const [id, item] of this.items) {
      if (
        item.status !== 'running' ||
        (item.type !== 'assistantMessage' && item.type !== 'reasoning')
      )
        continue;
      const updated: AgentItemV2 = {
        ...item,
        status,
        completedAt: nowIso(),
        ...(status === 'failed' && this.turnFailure
          ? { error: this.turnFailure }
          : {}),
      };
      this.items.set(id, updated);
      this.emitItemUpdated(updated);
    }
  }

  private terminalizeRunningItems(
    status: 'completed' | 'failed' | 'cancelled',
    error?: string
  ): void {
    this.finishMessageItems(status);
    for (const [id, item] of this.items) {
      if (item.status !== 'running') continue;
      let updated: AgentItemV2;
      if (item.type === 'fileChange')
        updated = {
          ...item,
          status,
          applyStatus: status === 'completed' ? 'applied' : 'failed',
          completedAt: nowIso(),
          ...(error ? { error } : {}),
        };
      else
        updated = {
          ...item,
          status,
          completedAt: nowIso(),
          ...(error ? { error } : {}),
        };
      this.items.set(id, updated);
      this.emitItemUpdated(updated);
    }
  }

  private captureUsage(message: RpcRecord): void {
    this.turnUsage = accumulateRpcUsage(this.turnUsage, message);
  }
  private async submitNativeInput(
    client: PiAgentRpcClient,
    input: AgentSendMessageInputV2,
    payload: RpcRecord
  ): Promise<void> {
    if (input.content.trim() !== '/compact') {
      await client.call('prompt', payload);
      return;
    }
    const response = await client.call('compact');
    this.emitProviderExtension({
      kind: 'contextCompaction',
      ...record(response.data),
    });
    this.completeTurn('completed');
    this.advanceQueuedTurn();
  }

  private advanceQueuedTurn(): void {
    this.queued.drain();
  }

  /**
   * Start one queued turn. Failure handling is unchanged — a dead transport
   * still closes the transport, and a bad attachment still fails only its own
   * turn — but the error now also propagates so the queue can reject the
   * waiting `sendMessage` caller instead of leaving it resolved on a message
   * that never ran.
   */
  private async runQueuedTurn(next: AgentSendMessageInputV2): Promise<void> {
    this.queueAdvanceInFlight = true;
    this.startTurn(next);
    let attributedLocally = false;
    try {
      const payload: RpcRecord = { message: next.content };
      try {
        const images = this.readImages(next.attachments);
        if (images.length) payload.images = images;
      } catch (error) {
        // Attachment files are Relay-local input. A file can be removed or
        // invalidated after enqueue, which must fail only this attributed turn;
        // the provider transport remains usable for later queued messages.
        const failure =
          error instanceof Error ? error : new Error(String(error));
        attributedLocally = true;
        this.emitError(failure.message);
        this.completeTurn('failed', failure.message);
        throw failure;
      }
      // `requireClient()` is evaluated here on purpose: a disconnected adapter
      // is a transport failure, not an attachment one.
      await this.submitNativeInput(this.requireClient(), next, payload);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // Anything not already attributed to this turn above is the transport
      // going down, which fails the turn and rejects the rest of the queue.
      if (!attributedLocally) this.handleTransportClose(failure);
      throw failure;
    } finally {
      this.queueAdvanceInFlight = false;
      // This drain runs BEFORE the thrown failure reaches the queue's
      // `onRejected`, which drains a second time. Both are gated by
      // `canDrain` (`queueAdvanceInFlight`, no active turn, connected), so the
      // second is a no-op and no turn can start twice. The ordering that
      // follows is the invariant to preserve: on a locally attributed failure
      // the NEXT queued turn starts before the failed entry's `sendMessage`
      // promise rejects, so the binder observes turn N+1's start-side effects
      // ahead of turn N's delivery failure. Loosening `canDrain`, or adding a
      // `continueDrain` hook here, changes both properties.
      if (!this.activeTurnId) this.advanceQueuedTurn();
    }
  }

  private startTurn(input: AgentSendMessageInputV2): void {
    this.activeTurnId = input.turnId;
    this.activeStartedMs = Date.now();
    this.abortRequested = false;
    this.turnFailure = null;
    this.assistantMessageSequence = -1;
    this.turnUsage = undefined;
    this.items.clear();
    this.anonymousToolIds.reset();
    this.emptyToolCounts.clear();
    this.suppressedEmptyToolIds.clear();
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
      ...(input.attachments
        ? {
            attachments: input.attachments.map((attachment) => ({
              type: attachment.type,
              path: attachment.path,
              mimeType: attachment.mimeType,
            })),
          }
        : {}),
    });
    this.emitLive({
      status: 'working',
      activeTurnId: input.turnId,
      queueLength: this.queued.length,
    });
  }

  private completeTurn(
    status: 'completed' | 'interrupted' | 'failed',
    error?: string
  ): void {
    const turnId = this.activeTurnId;
    if (!turnId) return;
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
      // Truthiness, not `!== undefined`: an empty error string stays omitted.
      error: error || undefined,
    });
    this.activeTurnId = null;
    this.items.clear();
    this.abortRequested = false;
    this.turnFailure = null;
    this.turnUsage = undefined;
    this.emptyToolCounts.clear();
    this.anonymousToolIds.clear();
    this.suppressedEmptyToolIds.clear();
    this.emitLive({
      status: this.queued.length ? 'working' : 'idle',
      activeTurnId: null,
      queueLength: this.queued.length,
      error: error ?? null,
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
  private fallbackToolId(index?: number): string {
    return this.anonymousToolIds.fallbackId(index);
  }
  private toolIdForStart(event: RpcRecord): string {
    return this.anonymousToolIds.idForStart(event);
  }
  private toolIdForUpdate(event: RpcRecord): string {
    return this.anonymousToolIds.idForUpdate(event);
  }
  private toolIdForPreview(toolCall: RpcRecord, index: number): string {
    return this.anonymousToolIds.reserveForPreview(toolCall, index);
  }
  private forgetAnonymousToolId(event: RpcRecord, id: string): void {
    this.anonymousToolIds.forget(event, id);
  }
  private emitDelta(
    id: string,
    delta: {
      text?: string;
      summary?: string;
      output?: string;
      content?: string;
    },
    mode?: 'replace'
  ): void {
    if (!this.activeTurnId) return;
    const item = this.items.get(id);
    if (item && mode !== 'replace') {
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
      ...(mode ? { mode } : {}),
      delta,
    });
  }
  private emitItemUpdated(item: AgentItemV2): void {
    if (this.activeTurnId)
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
    // Guard stays here: the active turn is this adapter's own state.
    if (!this.activeTurnId) return;
    emitProviderExtensionPatch(this.patchSink, {
      turnId: this.activeTurnId,
      namespace: 'pi',
      seq: ++this.providerExtensionSequence,
      payload,
      visibility,
    });
  }

  private resetForTransportSwitch(reason: string): void {
    if (this.activeTurnId) this.completeTurn('failed', reason);
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this.items.clear();
    this.emptyToolCounts.clear();
    this.anonymousToolIds.clear();
    this.suppressedEmptyToolIds.clear();
  }

  private emitLive(live: Partial<AgentSessionLiveStateV2>): void {
    emitLiveStatePatch(this.patchSink, live);
  }

  private applyState(data: RpcRecord): void {
    this.providerSessionId = string(data.sessionId) || this.providerSessionId;
    this.providerSessionFile =
      string(data.sessionFile) || this.providerSessionFile;
  }
  private emitSnapshot(): void {
    if (!this.config) return;
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: this.sessionId,
        provider: 'pi',
        cwd: this.config.cwd,
        capabilities: this.capabilities,
        providerSession: this.providerSession,
      }),
    });
  }
  private get providerSession(): Record<string, string> {
    return {
      ...(this.providerSessionId
        ? { piSessionId: this.providerSessionId }
        : {}),
      ...(this.providerSessionFile
        ? { piSessionFile: this.providerSessionFile }
        : {}),
    };
  }
  private get sessionId(): string {
    return this.config?.sessionId ?? 'pi';
  }
  private requireClient(): PiAgentRpcClient {
    if (this._status !== 'connected' || !this.client)
      throw new Error('Pi adapter is not connected');
    return this.client;
  }
  private handleTransportClose(error: Error): void {
    if (this._status === 'disconnected') return;
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
      queueLength: 0,
      error: error.message,
    });
  }
  private readImages(
    attachments: AgentSendMessageInputV2['attachments'] = []
  ): RpcRecord[] {
    return readValidatedImages(attachments, { providerLabel: 'Pi' });
  }
}
