import { spawn as nodeSpawn } from 'node:child_process';
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
  AgentQuestionItemV2,
  AgentSessionLiveStateV2,
  AgentUsageV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';
import {
  AcpClient,
  type AcpClientOptions,
  type AcpInitializeResult,
  type AcpNotification,
  type AcpPeerRequest,
} from '../acp-client.js';

const logger = createLogger('acp-adapter');

/** The ACP major version this adapter speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * Deterministic native-event -> AgentPatchV2 mapping table for ACP:
 *
 * Native Event / Method               | Direction | Relay AgentPatchV2 / Item
 * -----------------------------------|-----------|------------------------------------------
 * initialize                         | -> Server | (readiness barrier; protocolVersion pin)
 * authenticate (optional)            | -> Server | (auth handshake per profile.authMethodId)
 * session/resume | session/load | new| -> Server | agent-session-snapshot-v2 (providerSession.[providerSessionKey])
 * session/prompt                     | -> Server | response stopReason settles turn outcome
 * session/cancel                     | -> Server | cancels active prompt; completes turn interrupted
 * session/update (agent_message_chunk)| <- Server | agent-item-started-v2 + agent-item-delta-v2 (assistantMessage)
 * session/update (agent_thought_chunk)| <- Server | agent-item-started-v2 + agent-item-delta-v2 (reasoning)
 * session/update (tool_call)         | <- Server | agent-item-started-v2 (commandExecution/fileChange/dynamicToolCall)
 * session/update (tool_call_update)  | <- Server | agent-item-updated-v2 (completed/failed output)
 * session/update (usage_update)      | <- Server | folded into turnUsage (totalTokens/contextPercent)
 * session/update (plan)              | <- Server | passthrough / ignored (no drop logged as error)
 * session/request_permission (peer)  | <- Server | agent-item-started-v2 (approval card); -> respond allow_once/reject_once/cancelled
 * vendor extension request (peer)    | <- Server | routed to profile.onPeerRequest hook
 * vendor extension notif (notif)     | <- Server | routed to profile.onNotification hook
 * unknown peer request               | <- Server | -> respondError -32601 (Relay does not implement ${method})
 * unknown notification               | <- Server | ignored / debug logged
 */

export const DEFAULT_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once'],
  amendmentTypes: [],
  canCancel: true,
};

export const DEFAULT_COMMAND_TOOL_NAMES = new Set([
  'bash',
  'pwsh',
  'terminal_bash',
  'shell',
  'command',
  'exec',
]);

export const DEFAULT_FILE_TOOL_NAMES = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'file_edit',
  'create_file',
  'delete_file',
]);

const DEV_NULL = '/dev/null';
const OLD_DEV_NULL = '-- /dev/null';
const NEW_DEV_NULL = '++ /dev/null';
const DIFF_OLD_DEV_NULL = '--- /dev/null';
const DIFF_NEW_DEV_NULL = '+++ /dev/null';

export type ClientFactory = (options: AcpClientOptions) => AcpClient;

export interface PendingApproval {
  turnId: string;
  peerRequestId: string | number;
  card: AgentApprovalItemV2;
  options: Array<{ optionId: string; kind?: string; name?: string }>;
}

export interface PendingInputRequest {
  turnId: string;
  peerRequestId: string | number;
  card: AgentQuestionItemV2;
}

export interface AcpToolCallContext {
  turnId: string;
  sessionId: string;
  agentType: string;
}

export interface AcpNotificationContext {
  turnId: string | null;
  sessionId: string;
  agentType: string;
  ensureItem: (id: string, item: AgentItemV2) => void;
  emitItemUpdated: (item: AgentItemV2) => void;
  emitLiveStateUpdate: () => void;
  emitProviderExtension: (
    payload: Record<string, unknown>,
    visibility?: 'normal' | 'debug'
  ) => void;
}

export interface AcpPeerRequestContext {
  client: AcpClient;
  turnId: string | null;
  sessionId: string;
  agentType: string;
  items: Map<string, AgentItemV2>;
  ensureItem: (id: string, item: AgentItemV2) => void;
  emitItemUpdated: (item: AgentItemV2) => void;
  emitLiveStateUpdate: () => void;
  emitProviderExtension: (
    payload: Record<string, unknown>,
    visibility?: 'normal' | 'debug'
  ) => void;
  registerPendingInput: (
    requestId: string,
    pending: PendingInputRequest
  ) => void;
}

export interface AcpHarnessProfile {
  agentType: string;
  displayName?: string;
  capabilities: AgentCapabilitySetV2;
  approvalSupport?: AgentApprovalSupportV2;
  providerSessionKey?: string;
  providerNamespace?: string;
  command: string | ((config: AdapterConfig) => string);
  args?: string[] | ((config: AdapterConfig) => string[]);
  authMethodId?: string | null;
  envDenylist?: readonly string[];
  buildEnv?: (config: AdapterConfig) => Record<string, string>;
  readinessTimeoutMs?: number;
  promptTimeoutMs?: number;
  requestTimeoutMs?: number;
  clientInfo?: { name: string; version: string };
  clientCapabilities?: Record<string, unknown>;
  resumeStrategy?: 'resume' | 'load' | 'none' | 'auto';
  modelArgs?: (model: string) => string[];
  permissionPolicy?: (permissionMode: string | undefined) => {
    yoloStrategy?: 'root-flag' | 'auto-allow' | 'none';
    yoloFlag?: boolean;
    yoloAutoApprove?: boolean;
  };
  /**
   * QUIRK hook: map an approval decision to an ACP optionId.
   *
   * - Returning an optionId selects it on the wire.
   * - Returning null fails closed with an ACP cancelled outcome.
   *
   * Cursor uses option-kind matching with fail-closed once-scope; dsh hard-codes
   * its two option ids and does not consult the options array.
   */
  selectPermissionOptionId?: (input: {
    decision: AgentApprovalResponseInputV2['decision'];
    options: Array<{ optionId: string; kind?: string; name?: string }>;
  }) => string | null;
  mapToolCall?: (
    update: Record<string, unknown>,
    context: AcpToolCallContext
  ) => AgentItemV2 | undefined;
  onNotification?: (
    notification: AcpNotification,
    context: AcpNotificationContext
  ) => Promise<boolean | void> | boolean | void;
  onPeerRequest?: (
    request: AcpPeerRequest,
    context: AcpPeerRequestContext
  ) => Promise<boolean | void> | boolean | void;
}

export class AcpProtocolAdapter extends BaseProtocolAdapterV2 {
  private readonly patchSink = createPatchSink(
    () => this.sessionId,
    (patch) => this.emitPatch(patch)
  );

  readonly agentType: string;
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2;
  readonly resumesProviderSessionDuringConnect = true;

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private client: AcpClient | null = null;
  private clientGeneration = 0;
  private providerSessionId: string | null = null;
  private activeTurnId: string | null = null;
  private activeStartedMs = 0;
  private abortRequested = false;
  private turnUsage: AgentUsageV2 | undefined;
  private providerExtensionSequence = 0;
  private queueAdvanceInFlight = false;
  private readonly items = new Map<string, AgentItemV2>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingInputRequests = new Map<
    string,
    PendingInputRequest
  >();
  private resumeFallbackReason: string | null = null;
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
    protected readonly profile: AcpHarnessProfile,
    protected readonly clientFactory: ClientFactory = (options) =>
      new AcpClient({ ...options, spawn: nodeSpawn })
  ) {
    super();
    this.agentType = profile.agentType;
    this.capabilities = profile.capabilities;
  }

  get status(): AdapterStatus {
    return this._status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this._status = 'connecting';
    const command =
      typeof this.profile.command === 'function'
        ? this.profile.command(config)
        : this.profile.command;
    const args = this.buildLaunchArgs(config);
    const client = this.clientFactory({
      command,
      args,
      cwd: config.cwd,
      env: this.buildEnv(config),
      ...(this.profile.readinessTimeoutMs !== undefined
        ? { readinessTimeoutMs: this.profile.readinessTimeoutMs }
        : {}),
      ...(this.profile.promptTimeoutMs !== undefined
        ? { promptTimeoutMs: this.profile.promptTimeoutMs }
        : {}),
      ...(this.profile.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.profile.requestTimeoutMs }
        : {}),
    });
    this.client = client;
    const generation = ++this.clientGeneration;
    const current = (): boolean =>
      this.client === client && this.clientGeneration === generation;

    client.on('notification', (notification: AcpNotification) => {
      if (current()) void this.handleNotification(notification);
    });
    client.on('peerRequest', (request: AcpPeerRequest) => {
      if (current()) void this.handlePeerRequest(request);
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
            `${this.agentType} ACP transport closed${client.stderrTailText ? `: ${client.stderrTailText}` : ''}`
          )
        );
    });

    try {
      const initResult = await client.start({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: this.profile.clientCapabilities ?? {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        ...(this.profile.clientInfo
          ? { clientInfo: this.profile.clientInfo }
          : {}),
      });

      if (initResult.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(
          `Unsupported ACP protocol version: ${initResult.protocolVersion} (expected ${ACP_PROTOCOL_VERSION})`
        );
      }

      if (this.profile.authMethodId) {
        try {
          await client.request('authenticate', {
            methodId: this.profile.authMethodId,
          });
        } catch (authError) {
          logger.debug(`[${this.agentType}] authenticate step notice`, {
            error:
              authError instanceof Error
                ? authError.message
                : String(authError),
          });
        }
      }

      const opened = await this.openSession(client, config, initResult);
      const providerSessionId =
        string(opened.sessionId) || config.resumeSessionId || null;
      if (!providerSessionId)
        throw new Error(
          `${this.agentType} ACP handshake returned no sessionId; refusing to report connected`
        );
      this.providerSessionId = providerSessionId;
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

  private buildLaunchArgs(config: AdapterConfig): string[] {
    if (typeof this.profile.args === 'function') {
      return this.profile.args(config);
    }
    const args: string[] = [];
    if (config.model && this.profile.modelArgs) {
      args.push(...this.profile.modelArgs(config.model));
    }
    if (config.permissionMode === 'yolo') {
      const policy = this.profile.permissionPolicy?.(config.permissionMode);
      if (
        policy &&
        ('yoloFlag' in policy
          ? policy.yoloFlag
          : policy.yoloStrategy === 'root-flag' ||
            policy.yoloStrategy === 'auto-allow')
      ) {
        args.push('--yolo');
      }
    }
    if (Array.isArray(this.profile.args)) {
      args.push(...this.profile.args);
    } else if (!this.profile.args) {
      args.push('acp');
    }
    return args;
  }

  private async openSession(
    client: AcpClient,
    config: AdapterConfig,
    initResult: AcpInitializeResult
  ): Promise<Record<string, unknown>> {
    const params = { cwd: config.cwd, mcpServers: [] };
    if (!config.resumeSessionId)
      return record(await client.request('session/new', params));

    const strategy = this.profile.resumeStrategy ?? 'auto';
    let resumeMethod: 'session/resume' | 'session/load' | null;
    if (strategy === 'resume') {
      resumeMethod = hasResumeCapability(initResult) ? 'session/resume' : null;
    } else if (strategy === 'load') {
      resumeMethod = hasLoadCapability(initResult) ? 'session/load' : null;
    } else if (strategy === 'none') {
      resumeMethod = null;
    } else {
      if (hasResumeCapability(initResult)) {
        resumeMethod = 'session/resume';
      } else if (hasLoadCapability(initResult)) {
        resumeMethod = 'session/load';
      } else resumeMethod = null;
    }

    if (!resumeMethod) {
      return record(await client.request('session/new', params));
    }

    try {
      return record(
        await client.request(resumeMethod, {
          sessionId: config.resumeSessionId,
          ...params,
        })
      );
    } catch (error) {
      this.resumeFallbackReason =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        `[${this.agentType}] ${resumeMethod} failed; starting a fresh session`,
        { message: this.resumeFallbackReason }
      );
      return record(await client.request('session/new', params));
    }
  }

  private buildEnv(config: AdapterConfig): Record<string, string> {
    if (this.profile.buildEnv) {
      return this.profile.buildEnv(config);
    }
    return buildChildEnv({
      processEnv: config.processEnv,
      ...(this.profile.envDenylist
        ? { denylist: this.profile.envDenylist }
        : {}),
    });
  }

  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
    this.releasePendingRequests(ABANDONED_APPROVAL_REASON);
    await this.teardownClient();
    this.activeTurnId = null;
    this.providerSessionId = null;
    this.queued.rejectAll(
      new Error(
        `${this.agentType} session ended before this queued message was sent.`
      )
    );
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
        ...(this.providerSessionId
          ? { resumeSessionId: this.providerSessionId }
          : {}),
      }),
      disconnect: async () => {
        this.resetForTransportSwitch(`${this.agentType} transport reconnected`);
        this._status = 'disconnected';
        await this.teardownClient();
      },
      connect: (config) => this.connect(config),
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (!this.config) throw new Error('Cannot resumeSession before connect');
    const config = { ...this.config, resumeSessionId: sessionId };
    this.resetForTransportSwitch(`${this.agentType} session switched`);
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
        sessionId: this.providerSessionId,
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
      const message = stopReasonMessage(this.agentType, stopReason);
      this.emitError(message);
      this.completeTurn('failed', message);
    }
    this.queued.drain();
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    if (!this.activeTurnId) return;
    if (input.turnId && input.turnId !== this.activeTurnId) return;
    const client = this.client;
    if (!client || !this.providerSessionId) return;
    this.abortRequested = true;
    this.releasePendingRequests(TURN_ENDED_APPROVAL_REASON);
    client.notify('session/cancel', { sessionId: this.providerSessionId });
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    const pending = this.pendingApprovals.get(input.requestId);
    if (!pending)
      throw new Error(`Unknown ${this.agentType} approval: ${input.requestId}`);
    const client = this.requireClient();
    this.pendingApprovals.delete(input.requestId);

    let outcome: Record<string, unknown>;
    if (input.decision.kind === 'cancel') outcome = { outcome: 'cancelled' };
    else {
      const optionId =
        this.profile.selectPermissionOptionId?.({
          decision: input.decision,
          options: pending.options,
        }) ??
        defaultSelectPermissionOptionId({
          decision: input.decision,
          options: pending.options,
        });

      if (!optionId) {
        logger.warn(
          `[${this.agentType}] approval kind missing from options; failing closed`,
          {
            decisionKind: input.decision.kind,
            availableOptions: pending.options,
          }
        );
        client.respond(pending.peerRequestId, {
          outcome: { outcome: 'cancelled' },
        });
        const resolved: AgentApprovalItemV2 = {
          ...pending.card,
          decision: input.decision,
          respondedBy: 'user',
          status: 'cancelled',
          completedAt: nowIso(),
        };
        this.items.set(resolved.id, resolved);
        this.emitItemUpdated(resolved);
        this.emitLiveStateUpdate();
        emitErrorPatch(
          this.patchSink,
          `${this.profile.displayName ?? this.agentType} permission request did not provide a matching option for ${input.decision.kind}.`,
          this.activeTurnId
        );
        return;
      }

      outcome = { outcome: 'selected', optionId };
    }

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
    if (!pending) {
      if (!this.capabilities.questions) {
        throw new Error(`${this.agentType} ACP questions are not mapped`);
      }
      throw new Error(`Unknown ${this.agentType} question: ${input.requestId}`);
    }
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

  private async handleNotification(
    notification: AcpNotification
  ): Promise<void> {
    const { method, params } = notification;

    if (this.profile.onNotification) {
      const context: AcpNotificationContext = {
        turnId: this.activeTurnId,
        sessionId: this.sessionId,
        agentType: this.agentType,
        ensureItem: (id, item) => this.ensureItem(id, item),
        emitItemUpdated: (item) => this.emitItemUpdated(item),
        emitLiveStateUpdate: () => this.emitLiveStateUpdate(),
        emitProviderExtension: (payload, visibility) =>
          this.emitProviderExtension(payload, visibility),
      };
      const handled = this.profile.onNotification(notification, context);
      if (handled === true) return;
      if (isPromiseLike(handled)) {
        const awaited = await handled;
        if (awaited === true) return;
      }
    }

    if (method !== 'session/update') {
      logger.debug(`[${this.agentType}] unmapped native notification`, {
        method,
      });
      return;
    }
    const sessionId = string(params.sessionId);
    if (
      this.providerSessionId &&
      sessionId &&
      sessionId !== this.providerSessionId
    ) {
      logger.debug(`[${this.agentType}] ignoring update for another session`, {
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
      case 'config_option_update':
        this.sessionConfigOptions = Array.isArray(update.configOptions)
          ? update.configOptions
          : this.sessionConfigOptions;
        this.emitProviderExtension(
          { kind: 'configOptions', options: this.sessionConfigOptions ?? [] },
          'debug'
        );
        return;
      case 'plan':
        // Ignored here for slice 2 passthrough, no drop logged as error
        return;
      default:
        logger.debug(`[${this.agentType}] unmapped native session update`, {
          kind,
        });
    }
  }

  private async handlePeerRequest(request: AcpPeerRequest): Promise<void> {
    const client = this.client;
    if (!client) return;

    if (request.method === 'session/request_permission') {
      this.handlePermissionRequest(request);
      return;
    }

    if (this.profile.onPeerRequest) {
      const context: AcpPeerRequestContext = {
        client,
        turnId: this.activeTurnId,
        sessionId: this.sessionId,
        agentType: this.agentType,
        items: this.items,
        ensureItem: (id, item) => this.ensureItem(id, item),
        emitItemUpdated: (item) => this.emitItemUpdated(item),
        emitLiveStateUpdate: () => this.emitLiveStateUpdate(),
        emitProviderExtension: (payload, visibility) =>
          this.emitProviderExtension(payload, visibility),
        registerPendingInput: (requestId, pending) =>
          this.pendingInputRequests.set(requestId, pending),
      };
      const handled = this.profile.onPeerRequest(request, context);
      if (handled === true) return;
      if (isPromiseLike(handled)) {
        const awaited = await handled;
        if (awaited === true) return;
      }
    }

    logger.debug(`[${this.agentType}] unmapped native peer request`, {
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
    const rawOptions = Array.isArray(request.params.options)
      ? (request.params.options as Array<Record<string, unknown>>)
      : [];
    const options = rawOptions.map((o) => ({
      optionId: string(o.optionId),
      kind: string(o.kind),
      name: string(o.name),
    }));

    const toolCall = record(request.params.toolCall);
    const toolCallId = string(toolCall.toolCallId);

    if (this.config?.permissionMode === 'yolo') {
      const policy = this.profile.permissionPolicy?.(
        this.config.permissionMode
      );
      const shouldAutoApprove =
        policy &&
        ('yoloAutoApprove' in policy
          ? policy.yoloAutoApprove
          : policy.yoloStrategy === 'auto-allow');
      if (shouldAutoApprove) {
        const allowOnce = options.find(
          (o) =>
            o.kind === 'allow_once' ||
            o.kind === 'allow-once' ||
            (!o.kind &&
              (o.optionId === 'allow_once' || o.optionId === 'allow-once'))
        );
        if (allowOnce) {
          client.respond(request.id, {
            outcome: { outcome: 'selected', optionId: allowOnce.optionId },
          });
          const grant = {
            toolCallId,
            title: string(toolCall.title),
            kind: string(toolCall.kind),
            optionId: allowOnce.optionId,
          };
          logger.info(
            `[${this.agentType}] yolo auto-approved permission request`,
            grant
          );
          this.emitProviderExtension(
            { kind: 'permission_auto_approved', grant },
            'debug'
          );
          return;
        }
        logger.warn(
          `[${this.agentType}] yolo permission request offered no allow_once option; asking the operator`,
          {
            toolCallId,
            availableOptions: options,
          }
        );
      }
    }

    const requestId = `${this.agentType}-approval-${String(request.id)}`;
    const target = this.approvalTarget(toolCallId);
    const startedAt = nowIso();
    const card: AgentApprovalItemV2 = {
      type: 'approval',
      id: `approval-${requestId}`,
      requestId,
      kind: 'permission',
      description: `${this.profile.displayName ?? this.agentType} wants to run ${target}`,
      target,
      supported: this.profile.approvalSupport ?? DEFAULT_APPROVAL_SUPPORT,
      status: 'pending',
      startedAt,
    };
    this.pendingApprovals.set(requestId, {
      turnId,
      peerRequestId: request.id,
      card,
      options,
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
    const turnId = this.activeTurnId;
    if (!turnId) return;
    const id = string(update.toolCallId);
    if (!id || this.items.has(id)) return;

    if (this.profile.mapToolCall) {
      const customItem = this.profile.mapToolCall(update, {
        turnId,
        sessionId: this.sessionId,
        agentType: this.agentType,
      });
      if (customItem) {
        this.ensureItem(id, customItem);
        return;
      }
    }

    const kind = string(update.kind);
    const title = string(update.title, 'tool');
    const args = isRecord(update.rawInput) ? update.rawInput : {};
    const locations = Array.isArray(update.locations) ? update.locations : [];
    const hasDiffContent =
      Array.isArray(update.content) &&
      update.content.some((c) => isRecord(c) && c.type === 'diff');

    let item: AgentItemV2;
    if (
      kind === 'execute' ||
      ((!kind || kind === 'other') &&
        (DEFAULT_COMMAND_TOOL_NAMES.has(title) ||
          typeof args.command === 'string'))
    ) {
      const command = string(args.command) || stripBackticks(title);
      item = {
        type: 'commandExecution',
        id,
        command,
        ...(string(args.cwd) ? { cwd: string(args.cwd) } : {}),
        output: '',
        status: 'running',
        startedAt: nowIso(),
      };
    } else if (
      kind === 'edit' ||
      kind === 'delete' ||
      kind === 'move' ||
      ((!kind || kind === 'other') &&
        (hasDiffContent ||
          typeof args.path === 'string' ||
          typeof args.file_path === 'string' ||
          locations.length > 0 ||
          DEFAULT_FILE_TOOL_NAMES.has(title)))
    ) {
      const targetPath =
        string(args.path ?? args.file_path) ||
        (isRecord(locations[0]) ? string(locations[0].path) : '') ||
        extractFilePathFromTitle(title);
      const isAdd =
        title.toLowerCase().startsWith('create') ||
        title.toLowerCase() === 'write' ||
        args.is_creation === true ||
        (Array.isArray(update.content) &&
          update.content.some(
            (c) =>
              isRecord(c) &&
              c.type === 'diff' &&
              (c.oldText === null ||
                c.oldText === '' ||
                c.oldText === DEV_NULL ||
                String(c.oldText).startsWith(OLD_DEV_NULL))
          ));
      item = {
        type: 'fileChange',
        id,
        paths: [
          {
            path: targetPath,
            status:
              kind === 'delete' ? 'deleted' : isAdd ? 'added' : 'modified',
          },
        ],
        applyStatus: 'pending',
        status: 'running',
        startedAt: nowIso(),
      };
    } else {
      item = {
        type: 'dynamicToolCall',
        id,
        namespace: this.profile.providerNamespace ?? this.agentType,
        tool: title,
        arguments: args,
        status: 'running',
        startedAt: nowIso(),
      };
    }
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

    let rawOutputText = '';
    let realExitCode: number | null | undefined;
    if (isRecord(update.rawOutput)) {
      if (typeof update.rawOutput.exitCode === 'number') {
        realExitCode = update.rawOutput.exitCode;
      }
      const stdout = string(update.rawOutput.stdout);
      const stderr = string(update.rawOutput.stderr);
      rawOutputText = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '');
    }

    const textContent = toolContentText(update.content);
    const diffContent = renderDiffContent(update.content);

    let updated: AgentItemV2;
    if (item.type === 'commandExecution') {
      const output = rawOutputText || textContent;
      const exitCode = realExitCode ?? (failed ? 1 : 0);
      updated = {
        ...item,
        output,
        exitCode,
        status: failed ? 'failed' : 'completed',
        completedAt: nowIso(),
      };
    } else if (item.type === 'fileChange') {
      const patch = diffContent || (textContent ? textContent : undefined);
      const isCreation =
        Array.isArray(update.content) &&
        update.content.some(
          (c) =>
            isRecord(c) &&
            c.type === 'diff' &&
            (!c.oldText ||
              c.oldText === DEV_NULL ||
              c.oldText === OLD_DEV_NULL ||
              String(c.oldText).startsWith(OLD_DEV_NULL))
        );
      const paths = item.paths.map((p) => {
        const nextStatus =
          isCreation && p.status !== 'deleted' ? 'added' : p.status;
        return {
          path: p.path,
          ...(p.oldPath ? { oldPath: p.oldPath } : {}),
          ...(nextStatus ? { status: nextStatus } : {}),
        };
      });
      updated = {
        ...item,
        paths,
        ...(patch ? { patch } : {}),
        applyStatus: failed ? 'failed' : 'applied',
        status: failed ? 'failed' : 'completed',
        completedAt: nowIso(),
      };
    } else if (item.type === 'dynamicToolCall') {
      let result: string | undefined;
      if (rawOutputText) {
        result = rawOutputText;
      } else if (textContent) {
        result = textContent;
      } else if (update.rawOutput !== undefined) {
        result =
          typeof update.rawOutput === 'string'
            ? update.rawOutput
            : JSON.stringify(update.rawOutput, null, 2);
      }
      updated = {
        ...item,
        ...(result !== undefined ? { result } : {}),
        status: failed ? 'failed' : 'completed',
        completedAt: nowIso(),
      };
    } else return;
    this.items.set(id, updated);
    this.emitItemUpdated(updated);
  }

  private applyUsage(update: Record<string, unknown>): void {
    if (!this.activeTurnId) return;
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
        `${this.agentType} channel runtime does not accept attachments on this lane`
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

    if (this.pendingInputRequests.size > 0) {
      for (const [, pending] of this.pendingInputRequests) {
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
        this.items.set(pending.card.id, updated);
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

  protected emitProviderExtension(
    payload: Record<string, unknown>,
    visibility: 'normal' | 'debug' = 'normal'
  ): void {
    if (!this.activeTurnId) return;
    emitProviderExtensionPatch(this.patchSink, {
      turnId: this.activeTurnId,
      namespace: this.profile.providerNamespace ?? this.agentType,
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
    const sessionKey =
      this.profile.providerSessionKey ?? `${this.agentType}SessionId`;
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: this.sessionId,
        provider: this.agentType,
        cwd: this.config.cwd,
        capabilities: this.capabilities,
        providerSession: this.providerSessionId
          ? { [sessionKey]: this.providerSessionId }
          : {},
      }),
    });
    if (this.resumeFallbackReason) {
      emitErrorPatch(
        this.patchSink,
        `${this.agentType} could not resume the previous session (${this.resumeFallbackReason}); started a new one.`
      );
      this.resumeFallbackReason = null;
    }
  }

  private resetForTransportSwitch(reason: string): void {
    this.releasePendingRequests(ABANDONED_APPROVAL_REASON);
    if (this.activeTurnId) this.completeTurn('failed', reason);
    this.queued.rejectAll(
      new Error(
        `${this.agentType} session ended before this queued message was sent.`
      )
    );
    this.queueAdvanceInFlight = false;
    this.items.clear();
  }

  private get sessionId(): string {
    return this.config?.sessionId ?? this.agentType;
  }

  private requireClient(): AcpClient {
    if (this._status !== 'connected' || !this.client)
      throw new Error(`${this.agentType} adapter is not connected`);
    return this.client;
  }

  private handleTransportClose(error: Error): void {
    if (this._status === 'disconnected') return;
    this.releasePendingRequests(ABANDONED_APPROVAL_REASON);
    if (this.activeTurnId) this.completeTurn('failed', error.message);
    this.queued.rejectAll(
      new Error(
        `${this.agentType} session ended before this queued message was sent.`
      )
    );
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

export function stopReasonMessage(
  agentType: string,
  stopReason: string
): string {
  if (stopReason === 'max_tokens')
    return `${agentType} hit its output-token limit`;
  if (stopReason === 'max_turn_requests')
    return `${agentType} hit its per-turn request limit`;
  if (stopReason === 'refusal') return `${agentType} refused this request`;
  return `${agentType} ended the turn: ${stopReason}`;
}

export function stripBackticks(str: string): string {
  const trimmed = str.trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function extractFilePathFromTitle(title: string): string {
  const backtickMatch = title.match(/`([^`]+)`/);
  if (backtickMatch && backtickMatch[1]) return backtickMatch[1];
  return title;
}

export function formatUnifiedDiff(
  filePath: string,
  oldTextRaw: string | null | undefined,
  newTextRaw: string | null | undefined
): string {
  const p = filePath.startsWith('/') ? filePath : `/${filePath}`;
  const oldText = oldTextRaw ?? '';
  const newText = newTextRaw ?? '';
  const isCreation =
    !oldText ||
    oldText === DEV_NULL ||
    oldText === OLD_DEV_NULL ||
    oldText.startsWith(OLD_DEV_NULL);
  const isDeletion =
    !newText ||
    newText === DEV_NULL ||
    newText === NEW_DEV_NULL ||
    newText.startsWith(NEW_DEV_NULL);

  const oldHeader = isCreation ? DIFF_OLD_DEV_NULL : `--- a${p}`;
  const newHeader = isDeletion ? DIFF_NEW_DEV_NULL : `+++ b${p}`;

  let oldBody = oldText;
  if (oldBody.startsWith('-- ')) {
    const newline = oldBody.indexOf('\n');
    oldBody = newline >= 0 ? oldBody.slice(newline + 1) : '';
  }
  let newBody = newText;
  if (newBody.startsWith('++ ')) {
    const newline = newBody.indexOf('\n');
    newBody = newline >= 0 ? newBody.slice(newline + 1) : '';
  }

  const oldLines = oldBody ? oldBody.split('\n') : [];
  const newLines = newBody ? newBody.split('\n') : [];

  const hunk = `@@ -${isCreation ? 0 : 1},${oldLines.length} +${isDeletion ? 0 : 1},${newLines.length} @@`;
  const diffLines: string[] = [oldHeader, newHeader, hunk];

  for (const line of oldLines) {
    diffLines.push(`-${line}`);
  }
  for (const line of newLines) {
    diffLines.push(`+${line}`);
  }

  return diffLines.join('\n');
}

export function renderDiffContent(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const diffs: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (entry.type === 'diff') {
      const p = string(entry.path);
      const oldT =
        entry.oldText === null || entry.oldText === undefined
          ? null
          : string(entry.oldText);
      const newT =
        entry.newText === null || entry.newText === undefined
          ? null
          : string(entry.newText);
      diffs.push(formatUnifiedDiff(p, oldT, newT));
    }
  }
  return diffs.join('\n\n');
}

export function toolContentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => {
      if (!isRecord(entry)) return '';
      if (entry.type === 'text' && typeof entry.text === 'string')
        return entry.text;
      const content = entry.content;
      if (typeof content === 'string') return content;
      if (isRecord(content) && typeof content.text === 'string')
        return content.text;
      return '';
    })
    .join('');
}

export function hasResumeCapability(init: AcpInitializeResult): boolean {
  const caps = init.agentCapabilities as Record<string, unknown> | undefined;
  if (
    caps &&
    isRecord(caps.sessionCapabilities) &&
    caps.sessionCapabilities.resume !== undefined
  ) {
    return true;
  }
  const topSessionCaps = (init as unknown as Record<string, unknown>)
    .sessionCapabilities;
  if (isRecord(topSessionCaps) && topSessionCaps.resume !== undefined) {
    return true;
  }
  return false;
}

export function hasLoadCapability(init: AcpInitializeResult): boolean {
  const caps = init.agentCapabilities as Record<string, unknown> | undefined;
  if (caps && (caps.loadSession === true || isRecord(caps.loadSession))) {
    return true;
  }
  const topLoad = (init as unknown as Record<string, unknown>).loadSession;
  if (topLoad === true || isRecord(topLoad)) {
    return true;
  }
  return false;
}

function defaultSelectPermissionOptionId(input: {
  decision: AgentApprovalResponseInputV2['decision'];
  options: Array<{ optionId: string; kind?: string; name?: string }>;
}): string | null {
  const { decision, options } = input;
  if (decision.kind === 'cancel') return null;

  const scope =
    decision.kind === 'accept'
      ? decision.scope
      : 'scope' in decision
        ? decision.scope
        : undefined;

  const wantsSessionGrant =
    decision.kind === 'accept' &&
    (scope === 'session' || scope === 'permanent');
  const wantsSessionDeny =
    decision.kind === 'decline' &&
    (scope === 'session' || scope === 'permanent');

  const targetKinds =
    decision.kind === 'accept'
      ? wantsSessionGrant
        ? ['allow_always', 'allow-always']
        : ['allow_once', 'allow-once']
      : wantsSessionDeny
        ? ['reject_always', 'reject-always']
        : ['reject_once', 'reject-once'];

  for (const targetKind of targetKinds) {
    const matched = options.find((o) =>
      o.kind ? o.kind === targetKind : o.optionId === targetKind
    );
    if (matched) return matched.optionId;
  }
  return null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
