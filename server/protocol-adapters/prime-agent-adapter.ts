import * as fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { BaseProtocolAdapterV2 } from '../protocol-adapter-v2.js';
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
import { relayControlCatalogForProvider } from '../../shared/agent-command-catalog.js';
import { cleanEnv } from '../utils.js';
import {
  PrimeAgentRpcClient,
  type PrimeAgentRpcClientOptions,
  type PrimeAgentRpcMessage,
} from '../prime-agent-rpc-client.js';

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
  cancelQueued: false,
  interrupt: true,
  resume: true,
  fork: false,
  rollback: false,
  compact: true,
  telemetry: true,
  rateLimits: false,
  streaming: true,
};

type ClientFactory = (
  options: PrimeAgentRpcClientOptions
) => PrimeAgentRpcClient;
type RpcRecord = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}
function record(value: unknown): RpcRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RpcRecord)
    : {};
}
function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function queueCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
function resultText(value: unknown): string {
  const content = record(value).content;
  if (!Array.isArray(content)) return typeof value === 'string' ? value : '';
  return content
    .map((part) => string(record(part).text))
    .filter(Boolean)
    .join('\n');
}
function toolArguments(value: unknown): RpcRecord {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as RpcRecord;
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return { raw: value };
    }
  }
  return {};
}
function isCommandTool(name: string): boolean {
  return /^(bash|shell|exec|terminal)$/i.test(name);
}
function isFileTool(name: string): boolean {
  return /^(edit|write|patch|apply_patch|create|delete|move)/i.test(name);
}

const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = MAX_IMAGE_COUNT * MAX_IMAGE_BYTES;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

function matchesImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png')
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg')
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/gif') {
    const signature = bytes.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return (
    mimeType === 'image/webp' &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

export class PrimeAgentProtocolAdapter extends BaseProtocolAdapterV2 {
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
  private readonly queued: AgentSendMessageInputV2[] = [];
  private toolFallbackSequence = 0;
  private readonly anonymousToolIds = new Map<string, string[]>();
  private readonly pendingAnonymousToolIds = new Map<string, string[]>();
  private queueAdvanceInFlight = false;
  private providerExtensionSequence = 0;
  private readonly items = new Map<string, AgentItemV2>();
  private commandCatalog = relayControlCatalogForProvider('prime-agent');
  private modelCatalog: RpcRecord[] = [];
  private currentModel: RpcRecord | null = null;
  private thinkingLevel: string | null = null;
  private controlInFlight = false;

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
    if (config.resumeSessionId) args.push('--resume', config.resumeSessionId);
    const env = { ...cleanEnv(), ...(config.processEnv ?? {}) };
    delete env['CLAUDECODE'];
    const client = this.clientFactory({
      command: 'prime-agent',
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
      this.applyState(record(response.data));
      this._status = 'connected';
      await this.refreshControlCommands();
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
      this._status = 'disconnected';
      await client.stop().catch(() => undefined);
      throw error;
    }
  }

  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
    await this.teardownClient();
    this.activeTurnId = null;
    this.queued.length = 0;
    this.queueAdvanceInFlight = false;
    this.items.clear();
    this.anonymousToolIds.clear();
    this.pendingAnonymousToolIds.clear();
  }

  private async teardownClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientGeneration += 1;
    await client?.stop();
  }

  async reconnect(): Promise<void> {
    if (!this.config) throw new Error('Cannot reconnect before connect');
    const config = {
      ...this.config,
      ...(this.providerSessionId
        ? { resumeSessionId: this.providerSessionId }
        : {}),
    };
    this.resetForTransportSwitch('Prime Agent transport reconnected');
    this._status = 'disconnected';
    await this.teardownClient();
    await this.connect(config);
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
    if (this.controlInFlight) {
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
      this.queued.push(input);
      this.emitLive({
        status: 'working',
        activeTurnId: this.activeTurnId,
        queueLength: this.queued.length,
      });
      return;
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
    if (this.activeTurnId || this.queued.length > 0) {
      throw new Error(
        'Prime Agent controls are unavailable while a turn is active'
      );
    }
    if (this.controlInFlight) {
      throw new Error('another Prime Agent control command is in progress');
    }
    this.controlInFlight = true;
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
        case 'clear': {
          const response = await client.call('new_session');
          if (record(response.data).cancelled === true) {
            throw new Error('Prime Agent cancelled the new session request');
          }
          this.providerSessionId = null;
          this.providerSessionFile = null;
          this.items.clear();
          break;
        }
        case 'model': {
          const selected = this.modelCatalog.find(
            (model) => this.modelValue(model) === args
          );
          if (!selected) {
            throw new Error(
              'model must be selected from the live Prime Agent catalog'
            );
          }
          await client.call('set_model', {
            provider: string(selected.provider),
            modelId: string(selected.id),
          });
          break;
        }
        case 'thinking': {
          const allowed = this.availableThinkingLevels(this.currentModel);
          if (!allowed.includes(args)) {
            throw new Error(
              `thinking must be one of: ${allowed.join(', ') || 'none available'}`
            );
          }
          await client.call('set_thinking_level', { level: args });
          break;
        }
        case 'compact':
          await client.call('compact');
          break;
        default:
          throw new Error('unsupported Prime Agent control command');
      }

      const state = await client.call('get_state');
      this.applyState(record(state.data));
      this.recomputeControlCommands();
      this.emitSessionUpdate();
      return { config: this.currentControlConfig() };
    } finally {
      this.controlInFlight = false;
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
    if (type === 'turn_start' || type === 'turn_end') return;
    if (type === 'message_start') {
      if (record(event.message).role === 'assistant')
        this.assistantMessageSequence += 1;
      return;
    }
    if (type === 'agent_end') {
      this.completeTurn(
        this.abortRequested
          ? 'interrupted'
          : this.turnFailure
            ? 'failed'
            : 'completed',
        this.turnFailure ?? undefined
      );
      void this.advanceQueuedTurn();
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
    if (type === 'auto_retry_end' && event.success === false) {
      this.turnFailure = string(event.finalError, 'Prime Agent retry failed');
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
          string(delta.reason, 'Prime Agent generation error')
        );
        this.emitError(this.turnFailure);
      }
    }
  }

  private startTool(event: RpcRecord): void {
    if (!this.activeTurnId) return;
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
    if (!this.activeTurnId) return;
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
    if (message.role !== 'assistant') return;
    const usage = record(message.usage);
    const cost = record(usage.cost);
    const number = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const inputTokens = number(usage.input);
    const outputTokens = number(usage.output);
    const cacheReadTokens = number(usage.cacheRead);
    const cacheWriteTokens = number(usage.cacheWrite);
    const costUsd = number(cost.total);
    const previous = this.turnUsage ?? {};
    const add = (
      prior: number | undefined,
      next: number | undefined
    ): number | undefined => (next === undefined ? prior : (prior ?? 0) + next);
    const accumulatedInput = add(previous.inputTokens, inputTokens);
    const accumulatedOutput = add(previous.outputTokens, outputTokens);
    const accumulatedCacheRead = add(previous.cacheReadTokens, cacheReadTokens);
    const accumulatedCacheWrite = add(
      previous.cacheWriteTokens,
      cacheWriteTokens
    );
    const accumulatedCost = add(previous.costUsd ?? undefined, costUsd);
    this.turnUsage = {
      ...(accumulatedInput !== undefined
        ? { inputTokens: accumulatedInput }
        : {}),
      ...(accumulatedOutput !== undefined
        ? { outputTokens: accumulatedOutput }
        : {}),
      ...(accumulatedCacheRead !== undefined
        ? { cacheReadTokens: accumulatedCacheRead }
        : {}),
      ...(accumulatedCacheWrite !== undefined
        ? { cacheWriteTokens: accumulatedCacheWrite }
        : {}),
      ...(accumulatedCost !== undefined ? { costUsd: accumulatedCost } : {}),
    };
  }

  private async submitNativeInput(
    client: PrimeAgentRpcClient,
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
    void this.advanceQueuedTurn();
  }

  private async advanceQueuedTurn(): Promise<void> {
    if (
      this.queueAdvanceInFlight ||
      this.activeTurnId ||
      this.queued.length === 0 ||
      this._status !== 'connected'
    ) {
      return;
    }
    const next = this.queued.shift();
    if (!next) return;
    this.queueAdvanceInFlight = true;
    this.startTurn(next);
    try {
      const payload: RpcRecord = { message: next.content };
      const images = this.readImages(next.attachments);
      if (images.length) payload.images = images;
      try {
        await this.submitNativeInput(this.requireClient(), next, payload);
      } catch (error) {
        this.handleTransportClose(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // Attachment files are Relay-local input. A file can be removed or
      // invalidated after enqueue, which must fail only this attributed turn;
      // the provider transport remains usable for later queued messages.
      this.emitError(failure.message);
      this.completeTurn('failed', failure.message);
    } finally {
      this.queueAdvanceInFlight = false;
      if (!this.activeTurnId) void this.advanceQueuedTurn();
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
    this.toolFallbackSequence = 0;
    this.anonymousToolIds.clear();
    this.pendingAnonymousToolIds.clear();
    const timestamp = nowIso();
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sessionId,
      timestamp,
      turn: {
        id: input.turnId,
        status: 'running',
        inputMessageId: `user-${input.turnId}`,
        items: [],
        startedAt: timestamp,
      },
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
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      status,
      completedAt: nowIso(),
      durationMs: Date.now() - this.activeStartedMs,
      ...(this.turnUsage ? { usage: this.turnUsage } : {}),
      ...(error ? { error } : {}),
    });
    this.activeTurnId = null;
    this.items.clear();
    this.abortRequested = false;
    this.turnFailure = null;
    this.turnUsage = undefined;
    this.anonymousToolIds.clear();
    this.pendingAnonymousToolIds.clear();
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
    return `${this.activeTurnId}-tool-fallback-${this.assistantMessageSequence}-${index ?? 'none'}-${++this.toolFallbackSequence}`;
  }
  private toolIdForStart(event: RpcRecord): string {
    const providerId = string(event.toolCallId).trim();
    if (providerId) return providerId;
    const name = string(event.toolName, 'tool');
    const pending = this.pendingAnonymousToolIds.get(name);
    const id = pending?.shift() ?? this.fallbackToolId();
    if (pending?.length === 0) this.pendingAnonymousToolIds.delete(name);
    this.anonymousToolIds.set(name, [
      ...(this.anonymousToolIds.get(name) ?? []),
      id,
    ]);
    return id;
  }
  private toolIdForUpdate(event: RpcRecord): string {
    const providerId = string(event.toolCallId).trim();
    if (providerId) return providerId;
    const name = string(event.toolName, 'tool');
    return this.anonymousToolIds.get(name)?.[0] ?? this.toolIdForStart(event);
  }
  private toolIdForPreview(toolCall: RpcRecord, index: number): string {
    const providerId = string(toolCall.id).trim();
    if (providerId) return providerId;
    const name = string(toolCall.name, 'tool');
    const id = this.fallbackToolId(index);
    this.pendingAnonymousToolIds.set(name, [
      ...(this.pendingAnonymousToolIds.get(name) ?? []),
      id,
    ]);
    return id;
  }
  private forgetAnonymousToolId(event: RpcRecord, id: string): void {
    if (string(event.toolCallId).trim()) return;
    const name = string(event.toolName, 'tool');
    const ids = this.anonymousToolIds.get(name);
    if (!ids) return;
    const remaining = ids.filter((candidate) => candidate !== id);
    if (remaining.length) this.anonymousToolIds.set(name, remaining);
    else this.anonymousToolIds.delete(name);
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
    this.emitPatch({
      type: 'agent-error-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      message,
      ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
    });
  }
  private emitProviderExtension(
    payload: Record<string, unknown>,
    visibility: 'normal' | 'debug' = 'normal'
  ): void {
    if (!this.activeTurnId) return;
    const sequence = ++this.providerExtensionSequence;
    const timestamp = nowIso();
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp,
      turnId: this.activeTurnId,
      item: {
        type: 'providerExtension',
        id: `ext-prime-agent-${this.activeTurnId}-${sequence}`,
        namespace: 'prime-agent',
        payload,
        ...(visibility === 'debug'
          ? { metadata: { eventVisibility: 'debug' } }
          : {}),
        status: 'completed',
        startedAt: timestamp,
        completedAt: timestamp,
      },
    });
  }

  private resetForTransportSwitch(reason: string): void {
    if (this.activeTurnId) this.completeTurn('failed', reason);
    this.queued.length = 0;
    this.queueAdvanceInFlight = false;
    this.items.clear();
    this.anonymousToolIds.clear();
    this.pendingAnonymousToolIds.clear();
  }

  private emitLive(live: Partial<AgentSessionLiveStateV2>): void {
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      live,
    });
  }

  private async refreshControlCommands(): Promise<void> {
    const client = this.requireClient();
    try {
      const response = await client.call('get_available_models');
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
      this.modelCatalog = [];
      this.commandCatalog = [];
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
    if (!model) return [];
    if (model.reasoning !== true) return ['off'];
    const levelMap = record(model.thinkingLevelMap);
    const levels = ['off', 'minimal', 'low', 'medium', 'high'].filter(
      (level) => levelMap[level] !== null
    );
    for (const level of ['xhigh', 'max']) {
      if (level in levelMap && levelMap[level] !== null) levels.push(level);
    }
    return levels;
  }

  private recomputeControlCommands(): void {
    const controls = relayControlCatalogForProvider('prime-agent');
    const thinkingLevels = this.availableThinkingLevels(this.currentModel);
    this.commandCatalog = controls.flatMap((command) => {
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
      return [command];
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
    this.emitPatch({
      type: 'agent-session-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
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
    if (this.activeTurnId) this.completeTurn('failed', error.message);
    this.queued.length = 0;
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
    const imageAttachments = attachments.filter(
      (attachment) => attachment.type === 'image'
    );
    if (imageAttachments.length > MAX_IMAGE_COUNT) {
      throw new Error(`Prime Agent accepts at most ${MAX_IMAGE_COUNT} images`);
    }
    const images: RpcRecord[] = [];
    let totalBytes = 0;
    for (const attachment of imageAttachments) {
      const mimeType = attachment.mimeType ?? '';
      if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
        throw new Error(
          `Unsupported Prime Agent image MIME type: ${mimeType || 'missing'}`
        );
      }
      try {
        const stat = fs.lstatSync(attachment.path);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('attachment must be a regular non-symlink file');
        if (stat.size > MAX_IMAGE_BYTES)
          throw new Error(`attachment exceeds ${MAX_IMAGE_BYTES} bytes`);
        totalBytes += stat.size;
        if (totalBytes > MAX_IMAGE_TOTAL_BYTES)
          throw new Error(
            `attachments exceed ${MAX_IMAGE_TOTAL_BYTES} aggregate bytes`
          );
        const bytes = fs.readFileSync(attachment.path);
        if (
          bytes.length > MAX_IMAGE_BYTES ||
          !matchesImageSignature(bytes, mimeType)
        ) {
          throw new Error('attachment bytes do not match the declared image');
        }
        images.push({
          type: 'image',
          data: bytes.toString('base64'),
          mimeType,
        });
      } catch (error) {
        throw new Error(
          `Cannot read Prime Agent image attachment ${attachment.path}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
    return images;
  }
}
