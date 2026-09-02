import { PRIME_AGENT_CHANNEL_COMMAND } from './launch-commands.js';
import {
  buildChildEnv,
  createPatchSink,
  createTurnQueue,
  emitErrorPatch,
  emitLiveStatePatch,
  emitProviderExtensionPatch,
  emitSessionUpdatePatch,
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
import {
  AgentControlUnavailableError,
  BaseProtocolAdapterV2,
} from '../protocol-adapter-v2.js';
import type {
  AdapterConfig,
  AdapterStatus,
  AgentApprovalResponseInputV2,
  AgentInputResponseInputV2,
  AgentInterruptInputV2,
  AgentSendMessageInputV2,
  AgentControlCommandInputV2,
} from '../protocol-adapter-v2.js';
import type {
  AgentCapabilitySetV2,
  AgentItemV2,
  AgentSessionLiveStateV2,
  AgentSlashCommandV2,
  AgentUsageV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';
import { primeAgentControlDefinitions } from '../../shared/agent-command-catalog.js';
import { createLogger } from '../logger.js';
import {
  PrimeAgentRpcClient,
  PrimeAgentRpcResponseError,
  type PrimeAgentRpcClientOptions,
  type PrimeAgentRpcMessage,
} from '../prime-agent-rpc-client.js';

const logger = createLogger('prime-agent-adapter');

export interface PrimeLaunchFailureClassification {
  kind:
    | 'auth'
    | 'stale-session'
    | 'cwd-missing'
    | 'cwd-mismatch'
    | 'lease-held'
    | 'timeout'
    | 'unknown';
  message: string;
}

export function classifyPrimeLaunchFailure(
  error: unknown,
  tail: string,
  resumeSessionId?: string
): PrimeLaunchFailureClassification {
  const errText = error instanceof Error ? error.message : String(error);
  const combined = tail ? `${errText}\n${tail}` : errText;

  if (
    /^No models available/m.test(combined) ||
    /No models available/i.test(combined)
  ) {
    return {
      kind: 'auth',
      message:
        'prime-agent has no model available (not logged in or no provider configured). Run `prime-agent` and complete /login, then mention @<profile> again.',
    };
  }
  if (/No session found matching/i.test(combined)) {
    return {
      kind: 'stale-session',
      message: tail || errText,
    };
  }
  if (/MissingSessionCwd|session.*working directory/i.test(combined)) {
    return {
      kind: 'cwd-missing',
      message: tail || errText,
    };
  }
  if (/Session found in different project/i.test(combined)) {
    return {
      kind: 'cwd-mismatch',
      message: tail || errText,
    };
  }
  // Verbatim Prime Agent 0.7.0 stderr on concurrent session resume:
  // "Error: Session is already active in <workerId>: <sessionPath>"
  if (/Session is already active/i.test(combined)) {
    const sessionPrefix = resumeSessionId
      ? `Prime session ${resumeSessionId}`
      : 'Prime session';
    return {
      kind: 'lease-held',
      message: `${sessionPrefix} is open in another prime-agent process. Close it (prime-agent stop/attach) or restart this agent to start a fresh session.`,
    };
  }
  if (/timed?\s*out/i.test(errText)) {
    const detail = tail && !errText.includes(tail) ? `: ${tail}` : '';
    return {
      kind: 'timeout',
      message: `prime-agent did not answer get_state within 10s${detail}`,
    };
  }
  const detail = tail && !errText.includes(tail) ? `: ${tail}` : '';
  return {
    kind: 'unknown',
    message: `${errText}${detail}`,
  };
}

const CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: false,
  questions: false,
  plans: false,
  slashCommands: true,
  queue: true,
  // No native mid-turn injection boundary, and no `steerMessage` implementation.
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

/**
 * Why a queued message failed when the session went away underneath it. The
 * hand-written code simply emptied the array, so `sendMessage` had already
 * resolved and the message vanished without a trace; this reaches the caller.
 */
const QUEUE_ABANDONED_MESSAGE =
  'Prime Agent session ended before this queued message was sent.';

type ClientFactory = (
  options: PrimeAgentRpcClientOptions
) => PrimeAgentRpcClient;

export class PrimeAgentProtocolAdapter extends BaseProtocolAdapterV2 {
  /** Shared patch-emission conventions (adapter-utils). */
  private readonly patchSink = createPatchSink(
    () => this.sessionId,
    (patch) => this.emitPatch(patch)
  );
  readonly agentType = 'prime-agent';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = CAPABILITIES;
  readonly resumesProviderSessionDuringConnect = true;

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private client: PrimeAgentRpcClient | null = null;
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
  private commandCatalog: AgentSlashCommandV2[] = [];
  private modelCatalog: RpcRecord[] = [];
  private currentModel: RpcRecord | null = null;
  private thinkingLevel: string | null = null;
  private readonly unavailableControlKeys = new Set<string>();
  private nextControlId = 0;
  private controlInFlightId: number | null = null;

  private resumeFallbackNotice: {
    kind: string;
    previousSessionId: string;
  } | null = null;

  constructor(
    private readonly clientFactory: ClientFactory = (options) =>
      new PrimeAgentRpcClient({ ...options, spawn: nodeSpawn })
  ) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }

  getSlashCommands(): AgentSlashCommandV2[] {
    return this.commandCatalog.map((command) => ({
      ...command,
      ...(command.aliases ? { aliases: [...command.aliases] } : {}),
      ...(command.args
        ? { args: command.args.map((arg) => ({ ...arg })) }
        : {}),
    }));
  }

  private launchArgs(
    config: AdapterConfig,
    mode: 'resume' | 'fork' | 'fresh'
  ): string[] {
    const args = ['--mode', 'rpc', '--no-extensions'];
    const provider = string(config.extra?.['provider']);
    const thinking = string(config.extra?.['effort']);
    if (provider) args.push('--provider', provider);
    if (config.model) args.push('--model', config.model);
    if (thinking) args.push('--thinking', thinking);
    if (config.systemPromptAppendix)
      args.push('--append-system-prompt', config.systemPromptAppendix);
    if (config.resumeSessionId && mode === 'resume')
      args.push('--resume', config.resumeSessionId);
    else if (config.resumeSessionId && mode === 'fork')
      args.push('--fork', config.resumeSessionId);
    return args;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this._status = 'connecting';
    this.clearControlDiscovery();
    this.resumeFallbackNotice = null;
    return this.connectOnce(config, 'resume');
  }

  private async connectOnce(
    config: AdapterConfig,
    mode: 'resume' | 'fork' | 'fresh'
  ): Promise<void> {
    const args = this.launchArgs(config, mode);
    const env = buildChildEnv({ processEnv: config.processEnv });
    const client = this.clientFactory({
      command: PRIME_AGENT_CHANNEL_COMMAND,
      args,
      cwd: config.cwd,
      env,
    });
    this.client = client;
    const generation = ++this.clientGeneration;
    const current = (): boolean =>
      this.client === client && this.clientGeneration === generation;
    client.on('event', (event: PrimeAgentRpcMessage) => {
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
        this.handleTransportClose(
          new Error('prime-agent RPC transport closed')
        );
    });
    try {
      const response = await client.start();
      if (!current()) return;
      this.applyState(record(response.data));
      this._status = 'connected';
      await this.refreshControlCommands(client, generation);
      if (!current()) return;
      this.emitSnapshot();
      this.emitSessionUpdate();
      this.emitLive({
        status: record(response.data).isStreaming === true ? 'working' : 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        proposedPlanItemId: null,
        queueLength: queueCount(
          record(record(response.data).sessionActions).queuedCount
        ),
        fastModeAvailable: false,
        error: null,
      });
    } catch (error) {
      if (current()) {
        this._status = 'disconnected';
        this.clearControlDiscovery();
        await client.stop().catch(() => undefined);
      }
      const classified = classifyPrimeLaunchFailure(
        error,
        client.diagnosticTail,
        config.resumeSessionId
      );
      if (config.resumeSessionId && mode === 'resume') {
        if (
          classified.kind === 'stale-session' ||
          classified.kind === 'cwd-missing'
        ) {
          logger.warn(
            'prime-agent resume failed, falling back to fresh session',
            {
              kind: classified.kind,
              previousSessionId: config.resumeSessionId,
            }
          );
          this.resumeFallbackNotice = {
            kind: classified.kind,
            previousSessionId: config.resumeSessionId,
          };
          return await this.connectOnce(config, 'fresh');
        }
        if (classified.kind === 'cwd-mismatch') {
          logger.warn(
            'prime-agent resume failed due to cwd mismatch, falling back to --fork',
            {
              kind: classified.kind,
              previousSessionId: config.resumeSessionId,
            }
          );
          this.resumeFallbackNotice = {
            kind: classified.kind,
            previousSessionId: config.resumeSessionId,
          };
          return await this.connectOnce(config, 'fork');
        }
      }
      logger.warn('prime-agent launch failed', {
        kind: classified.kind,
        message: classified.message,
      });
      throw new Error(classified.message, { cause: error });
    }
  }

  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
    await this.teardownClient();
    this.activeTurnId = null;
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this.clearControlDiscovery();
    this.items.clear();
    this.anonymousToolIds.clear();
  }

  private async teardownClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientGeneration += 1;
    this.clearControlDiscovery();
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
        this.resetForTransportSwitch('Prime Agent transport reconnected');
        this._status = 'disconnected';
        await this.teardownClient();
      },
      connect: (config) => this.connect(config),
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (!this.config) throw new Error('Cannot resumeSession before connect');
    const config = { ...this.config, resumeSessionId: sessionId };
    this.resetForTransportSwitch('Prime Agent session switched');
    this._status = 'disconnected';
    await this.teardownClient();
    await this.connect(config);
  }

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    if (this.controlInFlightId !== null) {
      throw new Error('Prime Agent control command is in progress');
    }
    const client = this.requireClient();
    const payload: RpcRecord = { message: input.content };
    const images = this.readImages(input.attachments);
    if (images.length) payload.images = images;
    if (this.activeTurnId) {
      // Prime `steer` stays inside the current native agent run and therefore
      // has no separate agent_end boundary that Relay can attribute to this
      // turn. Keep Relay turns local and submit a fresh prompt after agent_end.
      return this.queued.enqueue(input);
    }

    this.startTurn(input);
    try {
      await this.submitNativeInput(client, input, payload);
    } catch (error) {
      // A timeout is ambiguous: Prime may have accepted the prompt. Stop the
      // private runtime so late events/tools cannot outlive Relay attribution.
      this.handleTransportClose(
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  async executeControlCommand(
    input: AgentControlCommandInputV2
  ): Promise<{ config?: Record<string, unknown> }> {
    const client = this.requireClient();
    const generation = this.clientGeneration;
    if (this.activeTurnId || this.queued.length > 0) {
      throw new Error(
        'Prime Agent controls are unavailable while a turn is active'
      );
    }
    if (this.controlInFlightId !== null) {
      throw new Error('another Prime Agent control command is in progress');
    }
    const controlId = ++this.nextControlId;
    this.controlInFlightId = controlId;
    try {
      const command = input.command.trim().toLowerCase();
      const known = this.commandCatalog.find(
        (entry) =>
          entry.dispatch === 'relay-control' &&
          (entry.name === command || (entry.aliases ?? []).includes(command))
      );
      if (!known) throw new Error('unsupported Prime Agent control command');
      if (known.destructive && input.confirmed !== true) {
        throw new Error('Prime Agent control command requires confirmation');
      }
      const action = known.collisionKey ?? known.name;
      const args = input.args?.trim() ?? '';

      switch (action) {
        case 'model': {
          const selected = this.modelCatalog.find(
            (model) => this.modelValue(model) === args
          );
          if (!selected) {
            throw new Error(
              'model must be selected from the live Prime Agent catalog'
            );
          }
          await this.callNativeControl(
            client,
            generation,
            action,
            'set_model',
            {
              provider: string(selected.provider),
              modelId: string(selected.id),
            }
          );
          break;
        }
        case 'thinking': {
          const allowed = this.availableThinkingLevels(this.currentModel);
          if (!allowed.includes(args)) {
            throw new Error(
              `thinking must be one of: ${allowed.join(', ') || 'none available'}`
            );
          }
          await this.callNativeControl(
            client,
            generation,
            action,
            'set_thinking_level',
            { level: args }
          );
          break;
        }
        default:
          throw new Error('unsupported Prime Agent control command');
      }

      const state = await client.call('get_state');
      if (!this.isCurrentClient(client, generation)) {
        throw new Error('Prime Agent control connection changed');
      }
      this.applyState(record(state.data));
      this.recomputeControlCommands();
      this.emitSessionUpdate();
      return { config: this.currentControlConfig() };
    } finally {
      if (this.controlInFlightId === controlId) this.controlInFlightId = null;
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
    throw new Error('Prime Agent RPC approvals are not mapped');
  }
  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {
    throw new Error('Prime Agent RPC questions are not mapped');
  }

  private handleEvent(event: PrimeAgentRpcMessage): void {
    const type = event.type;
    if (type === 'agent_start') {
      logger.debug('prime-agent agent_start', {
        activeTurnId: this.activeTurnId,
      });
      return;
    }
    if (type === 'turn_start' || type === 'turn_end') return;
    if (type === 'message_start') {
      if (record(event.message).role === 'assistant')
        this.assistantMessageSequence += 1;
      return;
    }
    if (type === 'agent_end') {
      this.handleAgentEnd();
      return;
    }
    if (type === 'message_update') {
      this.handleMessageUpdate(record(event.assistantMessageEvent));
      return;
    }
    if (type === 'message_end') {
      this.handleMessageEnd(event);
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
    if (type === 'session_action_update') {
      const actions = record(event.actions);
      this.emitLive({
        queueLength: this.queued.length + queueCount(actions.queuedCount),
      });
      return;
    }
    if (type === 'extension_error') {
      this.emitProviderExtension(
        {
          kind: 'extensionError',
          error: string(event.error, 'Prime Agent extension error'),
        },
        'debug'
      );
      return;
    }
    if (type === 'auto_retry_start' || type === 'auto_retry_end') {
      this.handleAutoRetry(event);
      return;
    }
    if (type === 'compaction_start' || type === 'compaction_end') {
      this.handleCompaction(event);
      return;
    }
    if (type === 'extension_ui_request') {
      this.handleExtensionUiRequest(event);
      return;
    }
    logger.debug('prime-agent event unmapped', { type });
  }

  private handleAgentEnd(): void {
    if (this.activeTurnId) {
      this.completeTurn(
        this.abortRequested
          ? 'interrupted'
          : this.turnFailure
            ? 'failed'
            : 'completed',
        this.turnFailure ?? undefined
      );
      this.advanceQueuedTurn();
    } else {
      this.emitLive({
        status: 'idle',
        activeTurnId: null,
        queueLength: this.queued.length,
      });
    }
  }

  private handleMessageEnd(event: PrimeAgentRpcMessage): void {
    const message = record(event.message);
    if (message.stopReason === 'aborted') this.abortRequested = true;
    if (message.stopReason === 'error')
      this.turnFailure = string(
        message.errorMessage,
        'Prime Agent generation failed'
      );
    this.finishMessageItems(
      this.abortRequested
        ? 'cancelled'
        : this.turnFailure
          ? 'failed'
          : 'completed'
    );
    this.captureUsage(message);
  }

  private handleAutoRetry(event: PrimeAgentRpcMessage): void {
    if (event.type === 'auto_retry_start') {
      if (this.activeTurnId) {
        this.emitProviderExtension(
          {
            kind: 'autoRetry',
            phase: 'start',
            ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
            ...(event.maxAttempts !== undefined
              ? { maxAttempts: event.maxAttempts }
              : {}),
            ...(event.error ? { error: string(event.error) } : {}),
          },
          'normal'
        );
      } else {
        logger.debug('prime-agent auto_retry_start outside active turn');
      }
      return;
    }
    if (event.success === false) {
      this.turnFailure = string(event.finalError, 'Prime Agent retry failed');
      this.emitError(this.turnFailure);
    } else if (this.activeTurnId) {
      this.emitProviderExtension(
        {
          kind: 'autoRetry',
          phase: 'end',
          success: true,
          ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
        },
        'normal'
      );
    } else {
      logger.debug('prime-agent auto_retry_end success outside active turn');
    }
  }

  private handleCompaction(event: PrimeAgentRpcMessage): void {
    if (this.activeTurnId) {
      this.emitProviderExtension(
        {
          kind: 'contextCompaction',
          phase: event.type === 'compaction_start' ? 'start' : 'end',
          ...(event.reason ? { reason: string(event.reason) } : {}),
          ...(event.result ? { result: record(event.result) } : {}),
        },
        'normal'
      );
    } else {
      logger.debug('prime-agent compaction outside active turn', {
        type: event.type,
      });
    }
  }

  private handleExtensionUiRequest(event: PrimeAgentRpcMessage): void {
    const method = string(event.method);
    if (
      method === 'select' ||
      method === 'confirm' ||
      method === 'input' ||
      method === 'editor'
    ) {
      const promptText = string(
        event.prompt,
        string(event.title, string(event.message, ''))
      );
      const promptDetail = promptText ? `: ${promptText.slice(0, 100)}` : '';
      this.emitError(
        `Prime asked a blocking UI question (${method}${promptDetail}) that channels cannot answer; interrupting`
      );
      void this.interrupt({}).catch(() => undefined);
    } else {
      this.emitProviderExtension(
        {
          kind: 'extensionUi',
          method,
          ...(event.id ? { id: string(event.id) } : {}),
          ...(event.title ? { title: string(event.title) } : {}),
          ...(event.message ? { message: string(event.message) } : {}),
        },
        'debug'
      );
    }
  }

  private handleMessageUpdate(delta: RpcRecord): void {
    if (!this.activeTurnId) {
      logger.debug('prime-agent out-of-turn message_update', {
        type: delta.type,
      });
      return;
    }
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
          string(delta.reason, 'Prime Agent generation error')
        );
        this.emitError(this.turnFailure);
      }
    }
  }

  private startTool(event: RpcRecord): void {
    if (!this.activeTurnId) {
      logger.debug('prime-agent out-of-turn tool event', {
        type: event.type,
        toolCallId: event.toolCallId ?? event.id,
      });
      return;
    }
    const id = this.toolIdForStart(event);
    this.ensureTool(
      id,
      string(event.toolName, 'tool'),
      toolArguments(event.args)
    );
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
        namespace: 'prime-agent',
        tool: name,
        arguments: args,
        status: 'running',
        startedAt: nowIso(),
      };
    this.ensureItem(id, item);
  }

  private updateTool(event: RpcRecord, result: unknown, done: boolean): void {
    if (!this.activeTurnId) {
      logger.debug('prime-agent out-of-turn tool event', {
        type: event.type,
        toolCallId: event.toolCallId ?? event.id,
      });
      return;
    }
    const id = this.toolIdForUpdate(event);
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
    client: PrimeAgentRpcClient,
    input: AgentSendMessageInputV2,
    payload: RpcRecord
  ): Promise<void> {
    await client.call('prompt', payload);
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
    if (this.resumeFallbackNotice) {
      const notice = this.resumeFallbackNotice;
      this.resumeFallbackNotice = null;
      this.emitProviderExtension(
        {
          kind: 'resumeFallback',
          reason: notice.kind,
          previousSessionId: notice.previousSessionId,
        },
        'normal'
      );
    }
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
    this.anonymousToolIds.clear();
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
      namespace: 'prime-agent',
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
    this.anonymousToolIds.clear();
  }

  private emitLive(live: Partial<AgentSessionLiveStateV2>): void {
    emitLiveStatePatch(this.patchSink, live);
  }

  private async refreshControlCommands(
    client: PrimeAgentRpcClient,
    generation: number
  ): Promise<void> {
    try {
      const response = await client.call('get_available_models');
      if (!this.isCurrentClient(client, generation)) return;
      const models = record(response.data).models;
      this.modelCatalog = Array.isArray(models)
        ? models.map(record).filter((model) => this.modelValue(model) !== '')
        : [];
      if (this.modelCatalog.length === 0) {
        this.commandCatalog = [];
        return;
      }
    } catch {
      // Older or malformed Prime Agent runtimes must not receive guessed
      // controls: an advertised command is an executable capability promise.
      if (this.isCurrentClient(client, generation))
        this.clearControlDiscovery();
      return;
    }
    this.recomputeControlCommands();
  }

  private modelValue(model: RpcRecord): string {
    const provider = string(model.provider);
    const id = string(model.id);
    return provider && id
      ? `${encodeURIComponent(provider)}/${encodeURIComponent(id)}`
      : '';
  }

  private availableThinkingLevels(model: RpcRecord | null): string[] {
    if (!model || model.reasoning !== true) return [];
    const levelMap = record(model.thinkingLevelMap);
    if (Object.keys(levelMap).length === 0) return [];
    const levels = ['off', 'minimal', 'low', 'medium', 'high'].filter(
      (level) => Object.hasOwn(levelMap, level) && levelMap[level] !== null
    );
    for (const level of ['xhigh', 'max']) {
      if (level in levelMap && levelMap[level] !== null) levels.push(level);
    }
    return levels;
  }

  private recomputeControlCommands(): void {
    const controls = primeAgentControlDefinitions();
    const selectedModel = this.modelCatalog.find(
      (model) =>
        this.modelValue(model) === this.modelValue(this.currentModel ?? {})
    );
    const thinkingLevels = this.availableThinkingLevels(selectedModel ?? null);
    this.commandCatalog = controls.flatMap((command) => {
      if (
        command.collisionKey &&
        this.unavailableControlKeys.has(command.collisionKey)
      )
        return [];
      if (command.collisionKey === 'model') {
        if (this.modelCatalog.length === 0) return [];
        return [
          {
            ...command,
            args: this.modelCatalog.flatMap((model) => {
              const value = this.modelValue(model);
              if (!value) return [];
              return [
                {
                  value,
                  label: string(model.name) || string(model.id),
                  description: string(model.provider),
                },
              ];
            }),
          },
        ];
      }
      if (command.collisionKey === 'thinking') {
        if (thinkingLevels.length === 0) return [];
        return [
          {
            ...command,
            args: thinkingLevels.map((value) => ({ value })),
          },
        ];
      }
      return [];
    });
  }

  private currentControlConfig(): Record<string, unknown> {
    const model = this.currentModel ? this.modelValue(this.currentModel) : '';
    return {
      ...(model ? { model } : {}),
      ...(this.thinkingLevel ? { effort: this.thinkingLevel } : {}),
      ...(this.currentModel
        ? { providerOptions: { provider: string(this.currentModel.provider) } }
        : {}),
    };
  }

  private emitSessionUpdate(): void {
    emitSessionUpdatePatch(this.patchSink, {
      providerSession: this.providerSession,
      config: this.currentControlConfig(),
      slashCommands: this.getSlashCommands(),
    });
  }

  private applyState(data: RpcRecord): void {
    this.providerSessionId = string(data.sessionId) || null;
    this.providerSessionFile = string(data.sessionFile) || null;
    const model = record(data.model);
    this.currentModel = string(model.id) ? model : null;
    this.thinkingLevel = string(data.thinkingLevel) || null;
  }
  private clearControlDiscovery(): void {
    this.commandCatalog = [];
    this.modelCatalog = [];
    this.currentModel = null;
    this.thinkingLevel = null;
    this.unavailableControlKeys.clear();
    this.controlInFlightId = null;
  }
  private isCurrentClient(
    client: PrimeAgentRpcClient,
    generation: number
  ): boolean {
    return this.client === client && this.clientGeneration === generation;
  }
  private async callNativeControl(
    client: PrimeAgentRpcClient,
    generation: number,
    control: string,
    method: string,
    fields?: RpcRecord
  ): Promise<PrimeAgentRpcMessage> {
    try {
      const response = fields
        ? await client.call(method, fields)
        : await client.call(method);
      if (!this.isCurrentClient(client, generation))
        throw new Error('Prime Agent control connection changed');
      return response;
    } catch (error) {
      if (this.isUnavailableNativeControlError(error, method)) {
        this.retractControl(control, client, generation);
        throw new AgentControlUnavailableError(
          control,
          `Prime Agent no longer supports /${control} on this runtime`
        );
      }
      throw error;
    }
  }
  private retractControl(
    control: string,
    client: PrimeAgentRpcClient,
    generation: number
  ): void {
    if (!this.isCurrentClient(client, generation)) return;
    this.unavailableControlKeys.add(control);
    this.recomputeControlCommands();
    this.emitSessionUpdate();
  }
  private isUnavailableNativeControlError(
    error: unknown,
    method: string
  ): boolean {
    if (
      !(error instanceof PrimeAgentRpcResponseError) ||
      error.command !== method
    )
      return false;
    const escapedMethod = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const message = error.message;
    return (
      new RegExp(
        `^(?:unknown|unsupported)\\s+(?:rpc\\s+)?(?:method|command)\\s*:?\\s*${escapedMethod}\\b`,
        'i'
      ).test(message) ||
      new RegExp(
        `^(?:(?:rpc\\s+)?(?:method|command)\\s+not\\s+found\\s*:?\\s*${escapedMethod}|${escapedMethod}\\s+(?:method|command)\\s+(?:is\\s+)?(?:unknown|unsupported|not found))\\b`,
        'i'
      ).test(message)
    );
  }
  private emitSnapshot(): void {
    if (!this.config) return;
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: this.sessionId,
        provider: 'prime-agent',
        cwd: this.config.cwd,
        capabilities: this.capabilities,
        providerSession: this.providerSession,
        config: this.currentControlConfig(),
      }),
    });
  }
  private get providerSession(): Record<string, string> {
    return {
      ...(this.providerSessionId
        ? { primeAgentSessionId: this.providerSessionId }
        : {}),
      ...(this.providerSessionFile
        ? { primeAgentSessionFile: this.providerSessionFile }
        : {}),
    };
  }
  private get sessionId(): string {
    return this.config?.sessionId ?? 'prime-agent';
  }
  private requireClient(): PrimeAgentRpcClient {
    if (this._status !== 'connected' || !this.client)
      throw new Error('Prime Agent adapter is not connected');
    return this.client;
  }
  private handleTransportClose(error: Error): void {
    if (this._status === 'disconnected') return;
    const tail = this.client?.diagnosticTail;
    const message =
      tail && !error.message.includes(tail)
        ? `${error.message}: ${tail}`
        : error.message;
    if (this.activeTurnId) this.completeTurn('failed', message);
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this._status = 'disconnected';
    const client = this.client;
    this.client = null;
    this.clientGeneration += 1;
    this.clearControlDiscovery();
    void client?.stop().catch(() => undefined);
    this.emitError(message);
    this.emitLive({
      status: 'disconnected',
      activeTurnId: null,
      queueLength: 0,
      error: message,
    });
  }
  private readImages(
    attachments: AgentSendMessageInputV2['attachments'] = []
  ): RpcRecord[] {
    return readValidatedImages(attachments, { providerLabel: 'Prime Agent' });
  }
}
