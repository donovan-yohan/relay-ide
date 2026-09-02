import { spawn as nodeSpawn } from 'node:child_process';
import { ANTIGRAVITY_CHANNEL_COMMAND } from './launch-commands.js';
import { ANTIGRAVITY_ENV_DENYLIST } from './provider-env.js';
import {
  adapterProcessRegistry,
  AdapterProcessRegistry,
  buildChildEnv,
  createPatchSink,
  createTurnQueue,
  emitErrorPatch,
  emitLiveStatePatch,
  emitProviderExtensionPatch,
  emitTurnCompletedPatch,
  emitTurnStartedPatch,
  reconnectWithStoredConfig,
  TurnGuardrails,
  type AdapterProcessRegistryEntry,
} from './adapter-utils.js';
import { nowIso, numberOr, objectField, stringField } from './wire-values.js';
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
  AntigravityStreamClient,
  type AntigravitySpawnFn,
  type AntigravityStreamClientOptions,
  type AntigravityStreamCloseEvent,
} from '../antigravity-stream-client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('antigravity-adapter');

const COMMAND_TOOLS = new Set(['run_command']);
const FILE_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
]);

const CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  reasoning: false,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: false,
  questions: false,
  plans: false,
  slashCommands: false,
  queue: true,
  steer: false,
  interrupt: true,
  cancelQueued: false,
  resume: true,
  fork: false,
  rollback: false,
  compact: false,
  telemetry: true,
  rateLimits: false,
  streaming: true,
} satisfies Required<AgentCapabilitySetV2>;

const QUEUE_ABANDONED_MESSAGE =
  'Antigravity session ended before this queued message was sent.';

const DEFAULT_CRASH_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RESPAWNS = 3;
const CONNECT_TIMEOUT_MS = 15_000;

export class AntigravityProtocolAdapter
  extends BaseProtocolAdapterV2
  implements AdapterProcessRegistryEntry
{
  private readonly patchSink = createPatchSink(
    () => this.sessionId,
    (patch) => this.emitPatch(patch)
  );

  readonly agentType = 'antigravity';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = CAPABILITIES;
  readonly resumesProviderSessionDuringConnect = true;

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private client: AntigravityStreamClient | null = null;
  private clientGeneration = 0;
  private exitedProcessRootPid: number | null = null;
  private antigravityConversationId: string | null = null;
  private isFreshSession = false;
  private firstTurnOfFreshSessionStarted = false;

  private activeTurnId: string | null = null;
  private activeStartedMs = 0;
  private interruptRequested = false;
  private turnUsage: AgentUsageV2 | undefined;
  private lastJetskiStderrLine: string | null = null;
  private assistantEmittedThisTurn = false;
  private providerExtensionSequence = 0;
  private queueAdvanceInFlight = false;
  private readonly items = new Map<string, AgentItemV2>();

  private interruptWaitResolver: (() => void) | null = null;

  private readonly guardrails = new TurnGuardrails({
    turnTimeoutMs: () => 24 * 60 * 60 * 1000,
    idleTtlMs: () => 24 * 60 * 60 * 1000,
    crashWindowMs: DEFAULT_CRASH_WINDOW_MS,
    maxRespawns: DEFAULT_MAX_RESPAWNS,
  });

  private readonly queued = createTurnQueue<AgentSendMessageInputV2>({
    canDrain: () =>
      !this.queueAdvanceInFlight &&
      this.activeTurnId === null &&
      this._status === 'connected',
    startTurn: (input) => this.runQueuedTurn(input),
    onLengthChange: (queueLength, reason) => {
      if (reason === 'enqueued') {
        this.emitLive({
          status: 'working',
          activeTurnId: this.activeTurnId,
          queueLength,
        });
      }
    },
  });

  constructor(
    private readonly spawnFn: AntigravitySpawnFn = nodeSpawn as unknown as AntigravitySpawnFn,
    private readonly registry: AdapterProcessRegistry = adapterProcessRegistry
  ) {
    super();
  }

  get status(): AdapterStatus {
    return this._status;
  }

  get registrySessionId(): string {
    return this.sessionId;
  }

  ownedProcessRootPids(): number[] {
    const pid = this.client?.pid ?? this.exitedProcessRootPid;
    return typeof pid === 'number' && pid > 1 ? [pid] : [];
  }

  gcSweep(_now: number): void {
    // No-op for v1.
  }

  async forceStop(): Promise<void> {
    await this.teardownClient();
  }

  toJSON(): Record<string, unknown> {
    return {
      agentType: this.agentType,
      runtimeOwnership: this.runtimeOwnership,
      status: this._status,
    };
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this._status = 'connecting';
    this.isFreshSession = !config.resumeSessionId;
    this.firstTurnOfFreshSessionStarted = false;
    this.antigravityConversationId = config.resumeSessionId ?? null;

    try {
      await this.spawnClientAndAwaitInit();
      this._status = 'connected';
      this.emitSnapshot();
      this.emitLive({
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        proposedPlanItemId: null,
        queueLength: 0,
        fastModeAvailable: false,
        error: null,
      });
      this.registry.register(this);
    } catch (error) {
      this._status = 'disconnected';
      await this.teardownClient().catch(() => undefined);
      throw error;
    }
  }

  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
    this.registry.unregister(this.sessionId);
    await this.teardownClient();
    this.activeTurnId = null;
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this.items.clear();
  }

  private async teardownClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientGeneration += 1;
    await client?.stop().catch(() => undefined);
  }

  async reconnect(): Promise<void> {
    await reconnectWithStoredConfig({
      config: this.config,
      transformConfig: (config) => ({
        ...config,
        ...(this.antigravityConversationId
          ? { resumeSessionId: this.antigravityConversationId }
          : {}),
      }),
      disconnect: async () => {
        this.resetForTransportSwitch('Antigravity transport reconnected');
        this._status = 'disconnected';
        await this.teardownClient();
      },
      connect: (config) => this.connect(config),
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (!this.config) throw new Error('Cannot resumeSession before connect');
    const config = { ...this.config, resumeSessionId: sessionId };
    this.resetForTransportSwitch('Antigravity session switched');
    this._status = 'disconnected';
    await this.teardownClient();
    await this.connect(config);
  }

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    if (this._status !== 'connected') {
      throw new Error('Antigravity adapter is not connected');
    }
    if (this.activeTurnId) {
      return this.queued.enqueue(input);
    }
    return this.startTurn(input);
  }

  private async startTurn(input: AgentSendMessageInputV2): Promise<void> {
    this.ensureClient();
    this.activeTurnId = input.turnId;
    this.activeStartedMs = Date.now();
    this.interruptRequested = false;
    this.turnUsage = undefined;
    this.items.clear();
    this.lastJetskiStderrLine = null;
    this.assistantEmittedThisTurn = false;
    this.guardrails.noteTurnStart();

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

    if (input.attachments && input.attachments.length > 0) {
      this.emitError(
        'Image attachments are not delivered to Antigravity (deliversImages: false).'
      );
    }

    let content = input.content;
    if (this.isFreshSession && !this.firstTurnOfFreshSessionStarted) {
      this.firstTurnOfFreshSessionStarted = true;
      if (this.config?.systemPromptAppendix?.trim()) {
        content = `<relay_context>\n${this.config.systemPromptAppendix.trim()}\n</relay_context>\n\n${input.content}`;
      }
    }

    try {
      await this.client!.writeAccepted({
        event: 'user',
        message: { role: 'user', content },
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleTransportClose(error);
      throw error;
    }
  }

  private terminalizeRunningItems(
    status: 'completed' | 'failed' | 'cancelled',
    error?: string
  ): void {
    for (const [id, item] of this.items) {
      if (item.status !== 'running') continue;
      let updated: AgentItemV2;
      if (item.type === 'fileChange') {
        updated = {
          ...item,
          status,
          applyStatus: status === 'completed' ? 'applied' : 'failed',
          completedAt: nowIso(),
          ...(error ? { error } : {}),
        };
      } else {
        updated = {
          ...item,
          status,
          completedAt: nowIso(),
          ...(error ? { error } : {}),
        };
      }
      this.items.set(id, updated);
      this.emitItemUpdated(updated);
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
      error: error || undefined,
    });

    this.activeTurnId = null;
    this.items.clear();
    this.interruptRequested = false;
    this.turnUsage = undefined;
    this.lastJetskiStderrLine = null;
    this.assistantEmittedThisTurn = false;
    this.guardrails.noteTurnEnd();

    this.emitLive({
      status: this.queued.length ? 'working' : 'idle',
      activeTurnId: null,
      queueLength: this.queued.length,
      error: error ?? null,
    });

    this.advanceQueuedTurn();
  }

  private advanceQueuedTurn(): void {
    this.queued.drain();
  }

  private async runQueuedTurn(next: AgentSendMessageInputV2): Promise<void> {
    this.queueAdvanceInFlight = true;
    try {
      await this.startTurn(next);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.handleTransportClose(failure);
      throw failure;
    } finally {
      this.queueAdvanceInFlight = false;
      if (!this.activeTurnId) this.advanceQueuedTurn();
    }
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    if (
      !this.activeTurnId ||
      (input.turnId && input.turnId !== this.activeTurnId)
    ) {
      return;
    }

    this.interruptRequested = true;
    this.client?.signal('SIGINT');

    await this.raceInterruptResultOrClose(5000);
    await this.teardownClient();

    if (this.activeTurnId) {
      this.completeTurn('interrupted');
    }
    this.advanceQueuedTurn();
  }

  private raceInterruptResultOrClose(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const onDone = (): void => {
        if (settled) return;
        settled = true;
        this.interruptWaitResolver = null;
        resolve();
      };
      this.interruptWaitResolver = onDone;
      const timer = setTimeout(onDone, ms);
      timer.unref?.();
    });
  }

  private signalInterruptSettled(): void {
    if (this.interruptWaitResolver) {
      const fn = this.interruptWaitResolver;
      this.interruptWaitResolver = null;
      fn();
    }
  }

  async respondToApproval(_input: AgentApprovalResponseInputV2): Promise<void> {
    throw new Error(
      'Antigravity stream-json approvals/questions are not mapped'
    );
  }

  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {
    throw new Error(
      'Antigravity stream-json approvals/questions are not mapped'
    );
  }

  // ── Subprocess management ──────────────────────────────────────────────────

  private ensureClient(): void {
    if (this.client && this.client.running) return;

    if (this.guardrails.isCrashLooping()) {
      throw new Error(
        'Antigravity subprocess is crash-looping (3 respawns within 5 minutes); not respawning. Use "Continue here" to start a fresh session.'
      );
    }
    this.spawnClient();
  }

  private composeArgs(): string[] {
    const config = this.config!;
    const args: string[] = [
      '--add-dir',
      config.cwd,
      '--disable-slash-commands',
      '--mode',
      'accept-edits',
      '--print-timeout',
      '24h',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ];

    if (config.model) {
      args.push('--model', config.model);
    }

    const extra =
      config.extra && typeof config.extra === 'object'
        ? (config.extra as Record<string, unknown>)
        : {};
    const effort = typeof extra.effort === 'string' ? extra.effort : undefined;
    if (
      effort &&
      (effort === 'low' || effort === 'medium' || effort === 'high')
    ) {
      args.push('--effort', effort);
    }

    if (this.antigravityConversationId) {
      args.push('--conversation', this.antigravityConversationId);
    } else if (config.resumeSessionId) {
      args.push('--conversation', config.resumeSessionId);
    }

    if (this.isYolo()) {
      args.push('--dangerously-skip-permissions');
    }

    args.push('-p', '');
    return args;
  }

  private isYolo(): boolean {
    if (!this.config) return false;
    if (
      this.config.permissionMode === 'always-proceed' ||
      this.config.permissionMode === 'bypassPermissions'
    ) {
      return true;
    }
    const extra =
      this.config.extra && typeof this.config.extra === 'object'
        ? (this.config.extra as Record<string, unknown>)
        : {};
    return extra.yolo === true;
  }

  private buildEnv(): Record<string, string> {
    return buildChildEnv({
      processEnv: this.config?.processEnv,
      denylist: ANTIGRAVITY_ENV_DENYLIST,
    });
  }

  private spawnClient(): AntigravityStreamClient {
    if (!this.config) {
      throw new Error('Cannot spawn Antigravity before connect');
    }
    const args = this.composeArgs();
    const options: AntigravityStreamClientOptions = {
      command: ANTIGRAVITY_CHANNEL_COMMAND,
      args,
      cwd: this.config.cwd,
      env: this.buildEnv(),
      spawn: this.spawnFn,
    };
    const client = new AntigravityStreamClient(options);
    this.client = client;
    this.exitedProcessRootPid = null;

    const generation = ++this.clientGeneration;
    const current = (): boolean =>
      this.client === client && this.clientGeneration === generation;

    client.on('event', (event: Record<string, unknown>) => {
      if (current()) this.handleWireEvent(event);
    });
    client.on('stderr', (line: string) => {
      if (current()) this.handleStderr(line);
    });
    client.on('close', (evt: AntigravityStreamCloseEvent) => {
      if (current()) this.handleClientClose(evt, client);
    });
    client.on('spawn-error', (err: Error) => {
      if (current()) this.handleSpawnError(err);
    });
    client.on('oversized-line', (dropped: number) => {
      logger.warn(
        'antigravity stdout line exceeded cap and was skipped (%d bytes)',
        dropped
      );
    });

    client.start();
    return client;
  }

  private async spawnClientAndAwaitInit(): Promise<void> {
    if (!this.config) {
      throw new Error('Cannot connect before config is set');
    }

    const client = this.spawnClient();
    const generation = this.clientGeneration;
    const requestedResumeId = this.config.resumeSessionId;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        client.removeListener('event', onEvent);
        client.removeListener('close', onClose);
        client.removeListener('spawn-error', onSpawnError);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Timeout waiting for Antigravity initialization.'));
      }, CONNECT_TIMEOUT_MS);
      timer.unref?.();

      const onEvent = (event: Record<string, unknown>): void => {
        if (settled || this.clientGeneration !== generation) return;
        const eventName = stringField(event.event);

        if (eventName === 'init') {
          settled = true;
          cleanup();
          const convId = stringField(event.conversation_id);
          this.antigravityConversationId = convId ?? null;
          const initData = objectField(event.init);
          logger.debug('Antigravity init received', {
            conversationId: this.antigravityConversationId,
            permissionMode: initData
              ? stringField(initData.permission_mode)
              : undefined,
          });

          if (requestedResumeId && convId && convId !== requestedResumeId) {
            logger.warn(
              'Antigravity could not resume conversation %s; started a fresh one %s',
              requestedResumeId,
              convId
            );
            this.emitPatch({
              type: 'agent-error-v2',
              sessionId: this.sessionId,
              timestamp: nowIso(),
              message: `Antigravity could not resume conversation ${requestedResumeId}; started a fresh one.`,
            });
          }
          resolve();
          return;
        }

        if (eventName === 'result') {
          settled = true;
          cleanup();
          const resultObj = objectField(event.result);
          const errorMsg =
            (resultObj ? stringField(resultObj.error) : undefined) ||
            'Startup failed';
          reject(new Error(errorMsg));
          return;
        }
      };

      const onClose = (): void => {
        if (settled || this.clientGeneration !== generation) return;
        settled = true;
        cleanup();
        reject(
          new Error('Antigravity subprocess closed before initialization.')
        );
      };

      const onSpawnError = (err: Error): void => {
        if (settled || this.clientGeneration !== generation) return;
        settled = true;
        cleanup();
        const enoent =
          /ENOENT/.test(err.message) ||
          (err as NodeJS.ErrnoException).code === 'ENOENT';
        const message = enoent
          ? 'agy CLI not found on PATH — install Antigravity CLI and log in.'
          : `Failed to spawn agy: ${err.message}`;
        reject(new Error(message));
      };

      client.on('event', onEvent);
      client.on('close', onClose);
      client.on('spawn-error', onSpawnError);
    });
  }

  // ── Close / crash handling ─────────────────────────────────────────────────

  private handleClientClose(
    evt: AntigravityStreamCloseEvent,
    client: AntigravityStreamClient
  ): void {
    const stderrTail = client.stderrTail;
    this.exitedProcessRootPid = client.pid ?? null;
    this.client = null;
    this.guardrails.recordCrash();
    this.signalInterruptSettled();

    const exit = evt.signal
      ? `signal ${evt.signal}`
      : `code ${evt.code ?? 'unknown'}`;
    const tail = stderrTail ? `\n${stderrTail}` : '';
    const message = `Antigravity subprocess exited (${exit}) before completing the turn.${tail}`;

    this._status = 'disconnected';
    if (this.activeTurnId !== null) {
      const turnId = this.activeTurnId;
      this.emitPatch({
        type: 'agent-error-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        message,
      });
      this.completeTurn('failed', message);
    }
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));

    this.emitLive({
      status: 'disconnected',
      activeTurnId: null,
      queueLength: 0,
    });
  }

  private handleSpawnError(err: Error): void {
    this.client = null;
    this.guardrails.recordCrash();
    this.signalInterruptSettled();
    const enoent =
      /ENOENT/.test(err.message) ||
      (err as NodeJS.ErrnoException).code === 'ENOENT';
    const message = enoent
      ? 'agy CLI not found on PATH — install Antigravity CLI and log in.'
      : `Failed to spawn agy: ${err.message}`;

    if (this.activeTurnId !== null) {
      this.emitError(message);
      this.completeTurn('failed', message);
    } else {
      this.emitError(message);
    }
  }

  private handleTransportClose(error: Error): void {
    if (this._status === 'disconnected') return;
    if (this.activeTurnId) {
      this.completeTurn('failed', error.message);
    }
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this._status = 'disconnected';
    const client = this.client;
    this.client = null;
    this.clientGeneration += 1;
    void client?.stop().catch(() => undefined);
    this.signalInterruptSettled();
    this.emitError(error.message);
    this.emitLive({
      status: 'disconnected',
      activeTurnId: null,
      queueLength: 0,
      error: error.message,
    });
  }

  private resetForTransportSwitch(reason: string): void {
    if (this.activeTurnId) this.completeTurn('failed', reason);
    this.queued.rejectAll(new Error(QUEUE_ABANDONED_MESSAGE));
    this.queueAdvanceInFlight = false;
    this.items.clear();
  }

  private handleStderr(line: string): void {
    if (line.startsWith('jetski:')) {
      this.lastJetskiStderrLine = line;
    }
  }

  // ── Wire event dispatch ───────────────────────────────────────────────────

  private handleWireEvent(event: Record<string, unknown>): void {
    this.guardrails.noteActivity();
    const eventName = stringField(event.event);

    if (eventName === 'init') {
      const convId = stringField(event.conversation_id);
      if (
        this._status === 'connecting' ||
        (convId && convId === this.antigravityConversationId)
      ) {
        // Handled by connect barrier or expected init from respawned client
        return;
      }
      logger.warn('Antigravity unexpected init event received');
      this.emitProviderExtension({ kind: 'unexpectedInit' }, 'debug');
      return;
    }

    if (eventName === 'step_update') {
      const step = objectField(event.step_update);
      if (!step) {
        logger.warn('Antigravity step_update missing step_update object');
        return;
      }
      this.handleStepUpdate(step);
      return;
    }

    if (eventName === 'result') {
      const resultObj = objectField(event.result);
      this.handleResult(resultObj ?? {});
      return;
    }

    logger.warn(
      'Antigravity unmapped event received: %s',
      eventName ?? 'unknown'
    );
    this.emitProviderExtension({ kind: 'unmappedEvent', event }, 'debug');
  }

  private handleStepUpdate(step: Record<string, unknown>): void {
    const stepType = stringField(step.step_type);
    const state = stringField(step.state);
    const stepIndex = numberOr(step.step_index, 0);
    const turnId = this.activeTurnId;

    if (!turnId) {
      logger.warn('Antigravity step_update received without active turn');
      return;
    }

    if (stepType === 'user_input' && state === 'DONE') {
      return;
    }

    if (stepType === 'agent_response') {
      this.handleAgentResponseStep(step, state, stepIndex, turnId);
      return;
    }

    if (stepType === 'tool') {
      this.handleToolStep(step, state, stepIndex, turnId);
      return;
    }

    if (stepType === 'subagent') {
      this.handleSubagentStep(step, state, stepIndex, turnId);
      return;
    }

    if (stepType === 'system_message' && state === 'DONE') {
      this.emitProviderExtension(
        {
          kind: 'systemMessage',
          stepIndex,
          durationSeconds: step.duration_seconds,
        },
        'debug'
      );
      return;
    }

    if (stepType === 'unknown' && state === 'DONE') {
      this.emitProviderExtension(
        {
          kind: 'unknownStep',
          stepIndex,
          note: 'agy auto-skipped a structured question; questions are unmapped',
        },
        'normal'
      );
      return;
    }

    logger.warn(
      'Antigravity unmapped step_update: %s state=%s',
      stepType,
      state
    );
    this.emitProviderExtension(
      { kind: 'unmappedStep', stepType, state, stepIndex },
      'debug'
    );
  }

  private handleAgentResponseStep(
    step: Record<string, unknown>,
    state: string | undefined,
    stepIndex: number,
    turnId: string
  ): void {
    const textDelta = stringField(step.text_delta);
    const itemId = `${turnId}-assistant-${stepIndex}`;

    if (state === 'ACTIVE' && textDelta !== undefined) {
      this.ensureItem(itemId, {
        type: 'assistantMessage',
        id: itemId,
        text: '',
        phase: 'answer',
        status: 'running',
      });
      this.emitDelta(itemId, { text: textDelta });
      this.assistantEmittedThisTurn = true;
      return;
    }

    if (state === 'DONE') {
      if (textDelta !== undefined) {
        this.ensureItem(itemId, {
          type: 'assistantMessage',
          id: itemId,
          text: '',
          phase: 'answer',
          status: 'running',
        });
        this.emitDelta(itemId, { text: textDelta });
        const item = this.items.get(itemId);
        this.emitItemUpdated({
          ...(item ?? {
            type: 'assistantMessage',
            id: itemId,
            text: textDelta,
            phase: 'answer',
          }),
          status: 'completed',
          completedAt: nowIso(),
        });
        this.assistantEmittedThisTurn = true;
      }
      const usage = objectField(step.usage);
      if (usage) {
        this.accumulateUsage(usage);
      }
      return;
    }

    this.emitProviderExtension(
      { kind: 'unmappedStep', stepType: 'agent_response', state, stepIndex },
      'debug'
    );
  }

  private handleToolStep(
    step: Record<string, unknown>,
    state: string | undefined,
    stepIndex: number,
    turnId: string
  ): void {
    const toolInfo = objectField(step.tool_info) ?? {};
    const toolName =
      stringField(step.tool_name) || stringField(toolInfo.name) || '';
    const params = objectField(toolInfo.parameters) ?? {};
    const itemId = `${turnId}-tool-${stepIndex}`;
    const durationSeconds =
      typeof step.duration_seconds === 'number'
        ? step.duration_seconds
        : undefined;
    const durationMs =
      durationSeconds !== undefined
        ? Math.round(durationSeconds * 1000)
        : undefined;
    const errObj = objectField(toolInfo.error);
    const errorMessage = errObj ? stringField(errObj.message) : undefined;

    if (COMMAND_TOOLS.has(toolName)) {
      this.handleCommandTool(
        state,
        itemId,
        params,
        toolInfo,
        durationMs,
        errorMessage
      );
      return;
    }

    if (FILE_TOOLS.has(toolName)) {
      this.handleFileTool(state, itemId, params, durationMs, errorMessage);
      return;
    }

    this.handleDynamicTool(
      state,
      itemId,
      toolName,
      params,
      toolInfo,
      errorMessage
    );
  }

  private handleCommandTool(
    state: string | undefined,
    itemId: string,
    params: Record<string, unknown>,
    toolInfo: Record<string, unknown>,
    durationMs: number | undefined,
    errorMessage: string | undefined
  ): void {
    const command = stringField(params.CommandLine) ?? '';
    const output = stringField(toolInfo.output) ?? '';

    if (state === 'ACTIVE') {
      this.ensureItem(itemId, {
        type: 'commandExecution',
        id: itemId,
        command,
        output: '',
        status: 'running',
      });
      return;
    }
    if (state === 'DONE') {
      this.ensureItem(itemId, {
        type: 'commandExecution',
        id: itemId,
        command,
        output: '',
        status: 'running',
      });
      this.emitItemUpdated({
        type: 'commandExecution',
        id: itemId,
        command,
        output,
        ...(durationMs !== undefined ? { durationMs } : {}),
        status: 'completed',
        completedAt: nowIso(),
      });
      return;
    }
    if (state === 'ERROR') {
      this.ensureItem(itemId, {
        type: 'commandExecution',
        id: itemId,
        command,
        output: '',
        status: 'running',
      });
      this.emitItemUpdated({
        type: 'commandExecution',
        id: itemId,
        command,
        output,
        error: errorMessage ?? 'Tool error',
        ...(durationMs !== undefined ? { durationMs } : {}),
        status: 'failed',
        completedAt: nowIso(),
      });
    }
  }

  private handleFileTool(
    state: string | undefined,
    itemId: string,
    params: Record<string, unknown>,
    _durationMs: number | undefined,
    errorMessage: string | undefined
  ): void {
    const targetPath =
      stringField(params.TargetFile) ?? stringField(params.AbsolutePath) ?? '';

    if (state === 'ACTIVE') {
      this.ensureItem(itemId, {
        type: 'fileChange',
        id: itemId,
        paths: [{ path: targetPath, status: 'edited' }],
        applyStatus: 'pending',
        status: 'running',
      });
      return;
    }
    if (state === 'DONE') {
      this.ensureItem(itemId, {
        type: 'fileChange',
        id: itemId,
        paths: [{ path: targetPath, status: 'edited' }],
        applyStatus: 'pending',
        status: 'running',
      });
      this.emitItemUpdated({
        type: 'fileChange',
        id: itemId,
        paths: [{ path: targetPath, status: 'edited' }],
        applyStatus: 'applied',
        status: 'completed',
        completedAt: nowIso(),
      });
      return;
    }
    if (state === 'ERROR') {
      this.ensureItem(itemId, {
        type: 'fileChange',
        id: itemId,
        paths: [{ path: targetPath, status: 'edited' }],
        applyStatus: 'pending',
        status: 'running',
      });
      this.emitItemUpdated({
        type: 'fileChange',
        id: itemId,
        paths: [{ path: targetPath, status: 'edited' }],
        applyStatus: 'failed',
        error: errorMessage ?? 'Tool error',
        status: 'failed',
        completedAt: nowIso(),
      });
    }
  }

  private handleDynamicTool(
    state: string | undefined,
    itemId: string,
    toolName: string,
    params: Record<string, unknown>,
    toolInfo: Record<string, unknown>,
    errorMessage: string | undefined
  ): void {
    const output = stringField(toolInfo.output);

    if (state === 'ACTIVE') {
      this.ensureItem(itemId, {
        type: 'dynamicToolCall',
        id: itemId,
        namespace: 'antigravity',
        tool: toolName,
        arguments: params,
        status: 'running',
      });
      return;
    }
    if (state === 'DONE') {
      this.ensureItem(itemId, {
        type: 'dynamicToolCall',
        id: itemId,
        namespace: 'antigravity',
        tool: toolName,
        arguments: params,
        status: 'running',
      });
      this.emitItemUpdated({
        type: 'dynamicToolCall',
        id: itemId,
        namespace: 'antigravity',
        tool: toolName,
        arguments: params,
        ...(output !== undefined ? { result: output } : {}),
        status: 'completed',
        completedAt: nowIso(),
      });
      return;
    }
    if (state === 'ERROR') {
      this.ensureItem(itemId, {
        type: 'dynamicToolCall',
        id: itemId,
        namespace: 'antigravity',
        tool: toolName,
        arguments: params,
        status: 'running',
      });
      this.emitItemUpdated({
        type: 'dynamicToolCall',
        id: itemId,
        namespace: 'antigravity',
        tool: toolName,
        arguments: params,
        error: errorMessage ?? 'Tool error',
        status: 'failed',
        completedAt: nowIso(),
      });
    }
  }

  private handleSubagentStep(
    step: Record<string, unknown>,
    state: string | undefined,
    stepIndex: number,
    turnId: string
  ): void {
    const subagentInfo = objectField(step.subagent_info) ?? {};
    const subagents = Array.isArray(subagentInfo.subagents)
      ? subagentInfo.subagents
      : [];
    const itemId = `${turnId}-tool-${stepIndex}`;
    const toolName = stringField(step.tool_name) || 'invoke_subagent';

    if (state === 'ACTIVE') {
      this.ensureItem(itemId, {
        type: 'dynamicToolCall',
        id: itemId,
        namespace: 'antigravity',
        tool: toolName,
        arguments: { subagents },
        status: 'running',
      });
      return;
    }
    if (state === 'DONE') {
      this.ensureItem(itemId, {
        type: 'dynamicToolCall',
        id: itemId,
        namespace: 'antigravity',
        tool: toolName,
        arguments: { subagents },
        status: 'running',
      });
      this.emitItemUpdated({
        type: 'dynamicToolCall',
        id: itemId,
        namespace: 'antigravity',
        tool: toolName,
        arguments: { subagents },
        status: 'completed',
        completedAt: nowIso(),
      });
      return;
    }
    if (state === 'ERROR') {
      this.ensureItem(itemId, {
        type: 'dynamicToolCall',
        id: itemId,
        namespace: 'antigravity',
        tool: toolName,
        arguments: { subagents },
        status: 'running',
      });
      this.emitItemUpdated({
        type: 'dynamicToolCall',
        id: itemId,
        namespace: 'antigravity',
        tool: toolName,
        arguments: { subagents },
        status: 'failed',
        completedAt: nowIso(),
      });
    }
  }

  private handleResult(resultObj: Record<string, unknown>): void {
    const turnId = this.activeTurnId;
    if (!turnId) {
      logger.warn('Antigravity result received without active turn');
      this.emitProviderExtension(
        { kind: 'unattachedResult', result: resultObj },
        'debug'
      );
      return;
    }

    const status = stringField(resultObj.status);
    const response = stringField(resultObj.response);
    const error = stringField(resultObj.error);

    if (status === 'SUCCESS') {
      if (
        !this.assistantEmittedThisTurn &&
        response &&
        response.trim().length > 0
      ) {
        const fallbackId = `${turnId}-assistant-final`;
        this.ensureItem(fallbackId, {
          type: 'assistantMessage',
          id: fallbackId,
          text: response,
          phase: 'answer',
          status: 'completed',
          completedAt: nowIso(),
        });
      }
      this.completeTurn('completed');
      this.signalInterruptSettled();
      return;
    }

    if (status === 'CANCELED') {
      const reason =
        this.lastJetskiStderrLine ??
        'Antigravity auto-denied a tool permission in headless mode (enable yolo on this profile or add a permissions.allow rule in ~/.gemini/antigravity-cli/settings.json).';
      this.emitError(reason);
      this.completeTurn('failed', reason);
      this.signalInterruptSettled();
      return;
    }

    if (status === 'ERROR') {
      if (this.interruptRequested) {
        this.completeTurn('interrupted');
      } else {
        const reason = error || 'Antigravity error';
        this.emitError(reason);
        this.completeTurn('failed', reason);
        this.guardrails.recordCrash();
      }
      const client = this.client;
      this.client = null;
      this.clientGeneration += 1;
      void client?.stop().catch(() => undefined);
      this.signalInterruptSettled();
      return;
    }

    this.completeTurn(
      'failed',
      `Unknown Antigravity result status: ${status ?? 'none'}`
    );
    this.signalInterruptSettled();
  }

  private accumulateUsage(raw: Record<string, unknown>): void {
    const inputTokens = numberOr(raw.input_tokens, 0);
    const outputTokens = numberOr(raw.output_tokens, 0);
    const cacheReadTokens = numberOr(raw.cache_read_tokens, 0);
    const reasoningTokens = numberOr(raw.thinking_tokens, 0);
    const totalTokens = numberOr(raw.total_tokens, 0);

    if (!this.turnUsage) {
      this.turnUsage = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        reasoningOutputTokens: reasoningTokens,
        totalTokens,
      };
    } else {
      this.turnUsage.inputTokens =
        (this.turnUsage.inputTokens ?? 0) + inputTokens;
      this.turnUsage.outputTokens =
        (this.turnUsage.outputTokens ?? 0) + outputTokens;
      this.turnUsage.cacheReadTokens =
        (this.turnUsage.cacheReadTokens ?? 0) + cacheReadTokens;
      this.turnUsage.reasoningOutputTokens =
        (this.turnUsage.reasoningOutputTokens ?? 0) + reasoningTokens;
      this.turnUsage.totalTokens =
        (this.turnUsage.totalTokens ?? 0) + totalTokens;
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

  private emitDelta(id: string, delta: { text?: string }): void {
    if (!this.activeTurnId) return;
    const item = this.items.get(id);
    if (item && item.type === 'assistantMessage' && delta.text) {
      item.text += delta.text;
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
    if (this.activeTurnId) {
      this.items.set(item.id, item);
      this.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId: this.activeTurnId,
        item,
      });
    }
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
      namespace: 'antigravity',
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
        provider: 'antigravity',
        cwd: this.config.cwd,
        capabilities: this.capabilities,
        providerSession: this.providerSession,
      }),
    });
  }

  private get providerSession(): Record<string, string> {
    return {
      ...(this.antigravityConversationId
        ? { antigravityConversationId: this.antigravityConversationId }
        : {}),
    };
  }

  private get sessionId(): string {
    return this.config?.sessionId ?? 'antigravity';
  }
}
