import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
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
  AgentApprovalSupportV2,
  AgentCapabilitySetV2,
  AgentSessionLiveStateV2,
  AgentSessionUpdatedPatchV2,
  AgentSlashCommandV2,
  AgentUsageV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../../shared/agent-chat-protocol-v2.js';
import { createLogger } from '../logger.js';

const logger = createLogger('claude-adapter');

type QueryParams = {
  prompt: string | AsyncIterable<SDKUserMessage>;
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
    /** SDK session ID to resume. Mutually exclusive with fresh connects. */
    resume?: string;
  };
};

export type ClaudeQueryFunction = (params: QueryParams) => Query;

interface QueuedClaudeMessage {
  input: AgentSendMessageInputV2;
  resolve: () => void;
  reject: (err: unknown) => void;
}

type ClaudeEventVisibility = 'normal' | 'debug' | 'trace';

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
  streaming: true,
};

const RELAY_CLAUDE_COMMANDS: AgentSlashCommandV2[] = [
  {
    id: 'relay:clear',
    name: 'clear',
    description: 'Start a new session with empty context',
    aliases: ['reset', 'new'],
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'clear',
  },
  {
    id: 'relay:resume',
    name: 'resume',
    description: 'Resume a saved Claude session',
    aliases: ['continue'],
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'resume',
  },
  {
    id: 'relay:model',
    name: 'model',
    description: 'Switch model for subsequent Claude responses',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'model',
  },
];

/** Claude supports only once/permanent accept and deny — no cancel, no amendments. */
const CLAUDE_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once', 'permanent'],
  amendmentTypes: [],
  canCancel: false,
};

/**
 * Translate a normalized V2 approval decision into the Claude SDK permission result.
 * Throws for decisions that Claude does not support so the UI can gate them using
 * `supported` and the adapter never receives them in practice.
 */
function claudeDecisionFromV2(
  decision: AgentApprovalDecisionV2,
  requestId: string,
  suggestions: PermissionUpdate[] | undefined
): PermissionResult {
  if (decision.kind === 'decline') {
    return {
      behavior: 'deny',
      message: 'Denied by user',
      toolUseID: requestId,
      decisionClassification: 'user_reject',
    };
  }

  if (decision.kind === 'cancel') {
    throw new Error(
      'Claude does not support cancel decisions. UI must gate cancel using supported.canCancel.'
    );
  }

  // kind === 'accept'
  const scope = decision.scope ?? 'once';

  if (scope === 'session' || scope === 'turn') {
    throw new Error(
      `Claude does not support scope '${scope}'. UI must gate this using supported.scopes.`
    );
  }

  if (decision.amendments && decision.amendments.length > 0) {
    throw new Error(
      'Claude does not support amendments. UI must gate amendments using supported.amendmentTypes.'
    );
  }

  return {
    behavior: 'allow',
    toolUseID: requestId,
    ...(scope === 'permanent' && suggestions
      ? { updatedPermissions: suggestions }
      : {}),
    decisionClassification:
      scope === 'permanent' ? 'user_permanent' : 'user_temporary',
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function objectField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeCommandName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

function uniqueStrings(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => normalizeCommandName(value)).filter(Boolean)
    ),
  ];
}

function normalizeSlashCommand(cmd: SlashCommand): AgentSlashCommandV2 {
  const name = normalizeCommandName(cmd.name);
  const argumentHint = Array.isArray(cmd.argumentHint)
    ? cmd.argumentHint.filter((part) => typeof part === 'string').join(' ')
    : cmd.argumentHint;

  return {
    id: `sdk:${name}`,
    name,
    ...(typeof cmd.description === 'string' && cmd.description.length > 0
      ? { description: cmd.description }
      : {}),
    ...(typeof argumentHint === 'string' && argumentHint.length > 0
      ? { argumentHint }
      : {}),
    ...(Array.isArray(cmd.aliases) && cmd.aliases.length > 0
      ? {
          aliases: uniqueStrings(
            cmd.aliases.filter((a): a is string => typeof a === 'string')
          ),
        }
      : {}),
    source: 'sdk',
    sourceLabel: 'Claude',
    dispatch: 'agent',
    collisionKey: name.toLowerCase(),
  };
}

function mergeAliases(
  base: AgentSlashCommandV2,
  extraAliases?: string[]
): AgentSlashCommandV2 {
  if (!extraAliases || extraAliases.length === 0) return base;
  const aliases = uniqueStrings([
    ...(base.aliases ?? []),
    ...extraAliases,
  ]).filter((alias) => alias.toLowerCase() !== base.name.toLowerCase());
  return aliases.length > 0 ? { ...base, aliases } : base;
}

function mergeClaudeCommandCatalog(
  sdkCommands: AgentSlashCommandV2[]
): AgentSlashCommandV2[] {
  const byName = new Map<string, AgentSlashCommandV2>();

  for (const command of sdkCommands) {
    const key = normalizeCommandName(command.name).toLowerCase();
    if (!key || byName.has(key)) continue;
    const relayOverride = RELAY_CLAUDE_COMMANDS.find(
      (entry) => entry.name === key
    );
    byName.set(key, mergeAliases(command, relayOverride?.aliases));
  }

  for (const relayCommand of RELAY_CLAUDE_COMMANDS) {
    const key = relayCommand.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, relayCommand);
  }

  return [...byName.values()];
}

function claudeEventVisibility(
  message: Record<string, unknown>
): ClaudeEventVisibility {
  if (message.type === 'stream_event') return 'trace';
  if (message.type === 'rate_limit_event') {
    const info = objectField(message.rate_limit_info);
    return info.status === 'allowed' ? 'trace' : 'debug';
  }
  if (message.type === 'system') {
    const subtype = stringField(message.subtype);
    if (subtype === 'hook_started') return 'trace';
    if (subtype === 'hook_response') {
      const outcome = stringField(message.outcome);
      const stdout = stringField(message.stdout);
      const stderr = stringField(message.stderr);
      return outcome === 'success' && stdout.length === 0 && stderr.length === 0
        ? 'trace'
        : 'debug';
    }
    if (subtype.startsWith('hook_')) return 'debug';
  }
  return 'debug';
}

function contentBlocks(
  message: Record<string, unknown>
): Record<string, unknown>[] {
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

function targetFromToolInput(
  toolName: string,
  input: Record<string, unknown>
): string {
  if (toolName === 'Bash')
    return stringField(input.command, JSON.stringify(input));
  return stringField(input.file_path ?? input.path, JSON.stringify(input));
}

function filePathsFromToolInput(
  input: Record<string, unknown>
): Array<{ path: string; status?: string }> {
  const paths: Array<{ path: string; status?: string }> = [];
  const filePath = input.file_path ?? input.path;
  if (typeof filePath === 'string')
    paths.push({ path: filePath, status: 'edited' });
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

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (stringField(block.type) === 'text') {
      const text = stringField(block.text);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

function patchFromFileResult(result: Record<string, unknown>): string {
  const gitDiff = objectField(result.gitDiff);
  const gitPatch = stringField(gitDiff.patch);
  if (gitPatch) return gitPatch;

  const hunks = result.structuredPatch;
  if (!Array.isArray(hunks)) return '';
  const out: string[] = [];
  for (const hunk of hunks) {
    if (!isRecord(hunk)) continue;
    const oldStart = Number(hunk.oldStart) || 0;
    const oldLines = Number(hunk.oldLines) || 0;
    const newStart = Number(hunk.newStart) || 0;
    const newLines = Number(hunk.newLines) || 0;
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    const lines = hunk.lines;
    if (Array.isArray(lines)) {
      for (const line of lines) {
        if (typeof line === 'string') out.push(line);
      }
    }
  }
  return out.join('\n');
}

function pathsFromFileResult(
  result: Record<string, unknown>,
  fallback: Array<{ path: string; status?: string }>
): Array<{ path: string; status?: string }> {
  const filePath = stringField(result.filePath);
  if (!filePath) return fallback;
  const gitDiff = objectField(result.gitDiff);
  const status = stringField(gitDiff.status);
  return [{ path: filePath, ...(status ? { status } : { status: 'edited' }) }];
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

class StreamInputController {
  private queue: SDKUserMessage[] = [];
  private waiter: ((msg: SDKUserMessage | null) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(msg);
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const w = this.waiter;
    this.waiter = null;
    w?.(null);
  }

  iterator(): AsyncGenerator<SDKUserMessage, void, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- async generator function expression cannot bind class `this`
    const self = this;
    return (async function* () {
      while (true) {
        if (self.queue.length > 0) {
          yield self.queue.shift() as SDKUserMessage;
          continue;
        }
        if (self.closed) return;
        const next = await new Promise<SDKUserMessage | null>((resolve) => {
          self.waiter = resolve;
        });
        if (next === null) return;
        yield next;
      }
    })();
  }
}

export class ClaudeProtocolAdapter extends BaseProtocolAdapterV2 {
  readonly agentType = 'claude';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private _status: AdapterStatus = 'disconnected';
  private config: AdapterConfig | null = null;
  private input: StreamInputController | null = null;
  private activeQuery: Query | null = null;
  private consumeTask: Promise<void> | null = null;
  private sessionAbort: AbortController | null = null;
  private activeTurnId: string | null = null;
  private activeStartedAt: string | null = null;
  private completedActiveTurn = false;
  private readonly queue: QueuedClaudeMessage[] = [];
  private readonly pendingApprovals = new Map<
    string,
    (decision: AgentApprovalDecisionV2) => void
  >();
  private readonly queryFn: ClaudeQueryFunction;
  private claudeSessionId: string | null = null;
  private slashCommandsLoaded = false;
  private slashCommandsLoadTask: Promise<void> | null = null;
  private readonly streamedTextItems = new Set<string>();
  private readonly streamedReasoningItems = new Set<string>();
  private readonly streamTextBuffers = new Map<string, string>();
  private readonly streamReasoningBuffers = new Map<string, string>();
  private streamProviderMessageId: string | null = null;
  private providerExtensionSeq = 0;
  private readonly activeToolUses = new Map<
    string,
    {
      kind: 'file' | 'exec' | 'dynamic';
      toolName: string;
      input: Record<string, unknown>;
      command?: string;
      paths?: Array<{ path: string; status?: string }>;
    }
  >();

  constructor(
    queryFn: ClaudeQueryFunction = sdkQuery as unknown as ClaudeQueryFunction
  ) {
    super();
    this.queryFn = queryFn;
  }

  get status(): AdapterStatus {
    return this._status;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.input = new StreamInputController();
    this.sessionAbort = new AbortController();
    const mode = permissionMode(config.permissionMode);
    const additionalDirs = isRecord(config.extra)
      ? config.extra.additionalDirectories
      : undefined;

    const query = this.queryFn({
      prompt: this.input.iterator(),
      options: {
        abortController: this.sessionAbort,
        cwd: config.cwd,
        ...(config.model ? { model: config.model } : {}),
        ...(mode ? { permissionMode: mode } : {}),
        ...(Array.isArray(additionalDirs)
          ? { additionalDirectories: additionalDirs as string[] }
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
    this._status = 'connected';
    this.consumeTask = this.consumeMessages();
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
    void this.refreshSlashCommands();
  }

  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
    this.input?.close();
    try {
      this.activeQuery?.close?.();
    } catch (err) {
      logger.warn('Claude query close failed:', err);
    }
    this.sessionAbort?.abort();
    this.rejectQueued(new Error('Claude adapter disconnected'));
    this.pendingApprovals.clear();
    if (this.consumeTask) {
      await this.consumeTask.catch(() => undefined);
    }
    this.activeTurnId = null;
    this.activeStartedAt = null;
    this.completedActiveTurn = false;
    this.activeQuery = null;
    this.consumeTask = null;
    this.input = null;
    this.sessionAbort = null;
    this.claudeSessionId = null;
    this.slashCommandsLoaded = false;
    this.slashCommandsLoadTask = null;
  }

  async reconnect(): Promise<void> {
    if (!this.config) throw new Error('Cannot reconnect before connect');
    const config = this.config;
    await this.disconnect();
    await this.connect(config);
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (!this.config) throw new Error('Cannot resumeSession before connect');
    const config = this.config;

    // Tear down existing session state without clearing the stored claudeSessionId
    // so that emitSnapshot below can include it in providerSession.
    this._status = 'disconnected';
    this.input?.close();
    try {
      this.activeQuery?.close?.();
    } catch (err) {
      logger.warn('Claude query close failed during resumeSession:', err);
    }
    this.sessionAbort?.abort();
    this.rejectQueued(new Error('Claude adapter resuming'));
    this.pendingApprovals.clear();
    if (this.consumeTask) {
      await this.consumeTask.catch(() => undefined);
    }
    this.activeTurnId = null;
    this.activeStartedAt = null;
    this.completedActiveTurn = false;
    this.activeQuery = null;
    this.consumeTask = null;
    this.sessionAbort = null;
    this.slashCommandsLoaded = false;
    this.slashCommandsLoadTask = null;

    // Store the provider session id so the snapshot carries it.
    this.claudeSessionId = sessionId;

    // Re-open the stream with the resume option so the SDK reattaches.
    this.input = new StreamInputController();
    this.sessionAbort = new AbortController();
    const mode = permissionMode(config.permissionMode);
    const additionalDirs = isRecord(config.extra)
      ? config.extra.additionalDirectories
      : undefined;

    const query = this.queryFn({
      prompt: this.input.iterator(),
      options: {
        abortController: this.sessionAbort,
        cwd: config.cwd,
        ...(config.model ? { model: config.model } : {}),
        ...(mode ? { permissionMode: mode } : {}),
        ...(Array.isArray(additionalDirs)
          ? { additionalDirectories: additionalDirs as string[] }
          : {}),
        env: {
          ...process.env,
          CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        },
        includePartialMessages: true,
        includeHookEvents: true,
        canUseTool: this.handleCanUseTool,
        resume: sessionId,
      },
    });
    this.activeQuery = query;
    this._status = 'connected';
    this.consumeTask = this.consumeMessages();

    // Emit a snapshot reflecting the resumed session. The SDK does not replay
    // history automatically for Claude — the UI's locally-persisted timeline
    // already carries the conversation. An empty timeline snapshot with the
    // known providerSession is sufficient to signal resume readiness.
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: config.sessionId,
      timestamp: nowIso(),
      session: emptyAgentSessionV2({
        id: config.sessionId,
        provider: 'claude',
        cwd: config.cwd,
        capabilities: { ...this.capabilities, resume: true },
        providerSession: { claudeSessionId: sessionId },
        config: {
          ...(config.model ? { model: config.model } : {}),
          ...(config.permissionMode
            ? { permissionMode: config.permissionMode }
            : {}),
        },
      }),
    });

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
    void this.refreshSlashCommands();
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

    this.startTurn(input);
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    if (
      this.activeTurnId !== null &&
      (input.turnId === undefined || input.turnId === this.activeTurnId)
    ) {
      await this.activeQuery?.interrupt?.().catch((err: unknown) => {
        logger.warn('Claude interrupt request failed:', err);
      });
      this.completeActiveTurn('interrupted');
      this.drainQueue();
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

  private startTurn(input: AgentSendMessageInputV2): void {
    if (!this.config || !this.input) {
      throw new Error('Cannot start Claude turn before connect');
    }

    const startedAt = nowIso();
    this.activeTurnId = input.turnId;
    this.activeStartedAt = startedAt;
    this.completedActiveTurn = false;

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

    this.input.push({
      type: 'user',
      message: { role: 'user', content: input.content },
      parent_tool_use_id: null,
    });
  }

  private async consumeMessages(): Promise<void> {
    if (!this.activeQuery) return;
    try {
      for await (const message of this.activeQuery) {
        this.handleSdkMessage(message);
      }
    } catch (err) {
      if (this._status === 'connected') {
        logger.warn('Claude stream consume error:', err);
        if (this.activeTurnId !== null && !this.completedActiveTurn) {
          const message = err instanceof Error ? err.message : String(err);
          this.emitPatch({
            type: 'agent-error-v2',
            sessionId: this.sessionId,
            timestamp: nowIso(),
            turnId: this.activeTurnId,
            message,
          });
          this.completeActiveTurn('failed', undefined, message);
        }
      }
    }
  }

  private readonly handleCanUseTool: CanUseTool = async (
    toolName,
    input,
    options
  ) => {
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
        description:
          options.title ??
          options.displayName ??
          `Claude wants to use ${toolName}`,
        target,
        ...(options.description ? { detail: options.description } : {}),
        supported: CLAUDE_APPROVAL_SUPPORT,
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

    const decision = await new Promise<AgentApprovalDecisionV2>(
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
        description:
          options.title ??
          options.displayName ??
          `Claude wants to use ${toolName}`,
        target,
        ...(options.description ? { detail: options.description } : {}),
        supported: CLAUDE_APPROVAL_SUPPORT,
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

    return claudeDecisionFromV2(decision, requestId, options.suggestions);
  };

  private handleSdkMessage(message: unknown): void {
    if (!isRecord(message)) return;

    logger.trace('sdk message %s', safeJson(message));

    if (message.type === 'system' && message.subtype === 'init') {
      const sessionId = stringField(message.session_id);
      const update: Partial<
        Pick<AgentSessionUpdatedPatchV2, 'providerSession'>
      > = {};
      if (sessionId && sessionId !== this.claudeSessionId) {
        this.claudeSessionId = sessionId;
        update.providerSession = { claudeSessionId: sessionId };
      }
      if (Object.keys(update).length > 0) {
        this.emitSessionUpdate(update);
      }
      void this.refreshSlashCommands();
      return;
    }

    if (message.type === 'assistant') {
      if (this.activeTurnId === null) return;
      this.handleAssistantMessage(this.activeTurnId, message);
      return;
    }

    if (message.type === 'user') {
      if (this.activeTurnId === null) return;
      this.handleUserToolResults(this.activeTurnId, message);
      return;
    }

    if (message.type === 'result') {
      if (this.activeTurnId === null) return;
      const turnId = this.activeTurnId;
      if (message.subtype !== 'success') {
        const errors = Array.isArray(message.errors)
          ? message.errors.join('\n')
          : 'Claude turn failed';
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
      this.drainQueue();
      return;
    }

    if (message.type === 'stream_event') {
      if (this.activeTurnId !== null) {
        this.handleStreamEvent(this.activeTurnId, message);
      }
      return;
    }

    if (this.activeTurnId !== null) {
      this.emitProviderExtension(
        this.activeTurnId,
        message,
        claudeEventVisibility(message)
      );
    }
  }

  private handleStreamEvent(
    turnId: string,
    message: Record<string, unknown>
  ): void {
    const event = objectField(message.event);
    const eventType = stringField(event.type);

    logger.trace('stream_event %s %s', eventType, safeJson(event));

    if (eventType === 'message_start') {
      const innerMessage = objectField(event.message);
      const id = stringField(innerMessage.id);
      this.streamProviderMessageId = id || null;
      return;
    }

    if (eventType === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : 0;
      const block = objectField(event.content_block);
      const blockType = stringField(block.type);
      if (blockType === 'text') {
        const itemId = `msg-${turnId}-${index}`;
        this.streamedTextItems.add(itemId);
        this.streamTextBuffers.set(itemId, '');
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'assistantMessage',
            id: itemId,
            text: '',
            phase: 'answer',
            status: 'running',
            startedAt: nowIso(),
            ...(this.streamProviderMessageId
              ? { providerMessageId: this.streamProviderMessageId }
              : {}),
          },
        });
      } else if (blockType === 'thinking') {
        const itemId = `thinking-${turnId}-${index}`;
        this.streamedReasoningItems.add(itemId);
        this.streamReasoningBuffers.set(itemId, '');
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'reasoning',
            id: itemId,
            summary: '',
            visibility: 'summary',
            status: 'running',
            startedAt: nowIso(),
          },
        });
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const index = typeof event.index === 'number' ? event.index : 0;
      const delta = objectField(event.delta);
      const deltaType = stringField(delta.type);
      if (deltaType === 'text_delta') {
        const itemId = `msg-${turnId}-${index}`;
        if (!this.streamedTextItems.has(itemId)) return;
        const text = stringField(delta.text);
        const current = this.streamTextBuffers.get(itemId) ?? '';
        this.streamTextBuffers.set(itemId, current + text);
        this.emitPatch({
          type: 'agent-item-delta-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          itemId,
          delta: { text },
        });
      } else if (deltaType === 'thinking_delta') {
        const itemId = `thinking-${turnId}-${index}`;
        if (!this.streamedReasoningItems.has(itemId)) return;
        const text = stringField(delta.thinking);
        const current = this.streamReasoningBuffers.get(itemId) ?? '';
        this.streamReasoningBuffers.set(itemId, current + text);
        this.emitPatch({
          type: 'agent-item-delta-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          itemId,
          delta: { summary: text },
        });
      }
      return;
    }

    if (eventType === 'content_block_stop') {
      const index = typeof event.index === 'number' ? event.index : 0;
      const textItemId = `msg-${turnId}-${index}`;
      const reasoningItemId = `thinking-${turnId}-${index}`;
      if (this.streamedTextItems.has(textItemId)) {
        const text = this.streamTextBuffers.get(textItemId) ?? '';
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'assistantMessage',
            id: textItemId,
            text,
            phase: 'answer',
            status: 'completed',
            completedAt: nowIso(),
            ...(this.streamProviderMessageId
              ? { providerMessageId: this.streamProviderMessageId }
              : {}),
          },
        });
      } else if (this.streamedReasoningItems.has(reasoningItemId)) {
        const text = this.streamReasoningBuffers.get(reasoningItemId) ?? '';
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'reasoning',
            id: reasoningItemId,
            summary: text,
            visibility: 'summary',
            status: 'completed',
            completedAt: nowIso(),
          },
        });
      }
      return;
    }
  }

  private handleAssistantMessage(
    turnId: string,
    message: Record<string, unknown>
  ): void {
    let blockIndex = 0;
    for (const block of contentBlocks(message)) {
      const type = block.type;
      const itemIndex = blockIndex++;
      if (type === 'text') {
        const text = stringField(block.text);
        const id = `msg-${turnId}-${itemIndex}`;
        if (this.streamedTextItems.has(id)) {
          // Stream already emitted start/deltas/stop. Final text matches; skip.
          continue;
        }
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
        const id = `thinking-${turnId}-${itemIndex}`;
        if (this.streamedReasoningItems.has(id)) {
          continue;
        }
        this.emitPatch({
          type: 'agent-item-started-v2',
          sessionId: this.sessionId,
          timestamp: nowIso(),
          turnId,
          item: {
            type: 'reasoning',
            id,
            summary: stringField(block.thinking ?? block.text ?? block.summary),
            visibility: 'summary',
            status: 'completed',
            completedAt: nowIso(),
          },
        });
      } else if (type === 'tool_use') {
        this.emitToolUse(turnId, block);
      } else {
        this.emitProviderExtension(turnId, block, 'debug');
      }
    }
  }

  private handleUserToolResults(
    turnId: string,
    message: Record<string, unknown>
  ): void {
    const toolUseResult = message.tool_use_result;
    for (const block of contentBlocks(message)) {
      if (stringField(block.type) !== 'tool_result') continue;
      const toolUseId = stringField(block.tool_use_id);
      if (!toolUseId) continue;
      const tracked = this.activeToolUses.get(toolUseId);
      if (!tracked) {
        this.emitProviderExtension(turnId, block, 'debug');
        continue;
      }
      this.activeToolUses.delete(toolUseId);
      const isError = block.is_error === true;
      const completedAt = nowIso();
      const resultText = toolResultText(block.content);

      if (tracked.kind === 'file') {
        const result = isRecord(toolUseResult) ? toolUseResult : {};
        const patch = patchFromFileResult(result);
        const paths = pathsFromFileResult(result, tracked.paths ?? []);
        const applyStatus = isError ? 'failed' : 'applied';
        const status = isError ? 'failed' : 'completed';
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: completedAt,
          turnId,
          item: {
            type: 'fileChange',
            id: `file-${toolUseId}`,
            providerItemId: toolUseId,
            paths,
            ...(patch ? { patch } : {}),
            applyStatus,
            status,
            completedAt,
          },
        });
        continue;
      }

      if (tracked.kind === 'exec') {
        const result = isRecord(toolUseResult) ? toolUseResult : {};
        const stdout = stringField(result.stdout);
        const stderr = stringField(result.stderr);
        const output = stdout || stderr || resultText;
        const status = isError ? 'failed' : 'completed';
        this.emitPatch({
          type: 'agent-item-updated-v2',
          sessionId: this.sessionId,
          timestamp: completedAt,
          turnId,
          item: {
            type: 'commandExecution',
            id: `exec-${toolUseId}`,
            providerItemId: toolUseId,
            command: tracked.command ?? '',
            output,
            ...(typeof result.interrupted === 'boolean'
              ? { interactive: result.interrupted }
              : {}),
            status,
            completedAt,
          },
        });
        continue;
      }

      const status = isError ? 'failed' : 'completed';
      this.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: this.sessionId,
        timestamp: completedAt,
        turnId,
        item: {
          type: 'dynamicToolCall',
          id: `tool-${toolUseId}`,
          providerItemId: toolUseId,
          namespace: 'claude',
          tool: tracked.toolName,
          arguments: tracked.input,
          ...(toolUseResult !== undefined ? { result: toolUseResult } : {}),
          ...(resultText ? { content: resultText } : {}),
          status,
          completedAt,
        },
      });
    }
  }

  private emitToolUse(turnId: string, block: Record<string, unknown>): void {
    const toolUseId = stringField(block.id, `unknown-${Date.now()}`);
    const name = stringField(block.name, 'unknown');
    const input = objectField(block.input);

    if (name === 'Bash') {
      const command = stringField(input.command, JSON.stringify(input));
      this.activeToolUses.set(toolUseId, {
        kind: 'exec',
        toolName: name,
        input,
        command,
      });
      this.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        item: {
          type: 'commandExecution',
          id: `exec-${toolUseId}`,
          providerItemId: toolUseId,
          command,
          output: '',
          status: 'running',
          startedAt: nowIso(),
        },
      });
      return;
    }

    if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
      const paths = filePathsFromToolInput(input);
      this.activeToolUses.set(toolUseId, {
        kind: 'file',
        toolName: name,
        input,
        paths,
      });
      this.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: this.sessionId,
        timestamp: nowIso(),
        turnId,
        item: {
          type: 'fileChange',
          id: `file-${toolUseId}`,
          providerItemId: toolUseId,
          paths,
          applyStatus: 'pending',
          status: 'pending',
          startedAt: nowIso(),
        },
      });
      return;
    }

    this.activeToolUses.set(toolUseId, {
      kind: 'dynamic',
      toolName: name,
      input,
    });
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
    const turnId = this.activeTurnId;
    const completedAt = nowIso();
    const durationMs = this.activeStartedAt
      ? Date.now() - Date.parse(this.activeStartedAt)
      : undefined;

    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sessionId,
      timestamp: completedAt,
      turnId,
      status,
      completedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    this.activeTurnId = null;
    this.activeStartedAt = null;
    this.streamedTextItems.clear();
    this.streamedReasoningItems.clear();
    this.streamTextBuffers.clear();
    this.streamReasoningBuffers.clear();
    this.streamProviderMessageId = null;
    this.activeToolUses.clear();
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
    try {
      this.startTurn(queued.input);
      queued.resolve();
    } catch (err) {
      queued.reject(err);
    }
  }

  private rejectQueued(err: unknown): void {
    const queued = this.queue.splice(0);
    for (const message of queued) message.reject(err);
    if (queued.length > 0) this.emitLiveState({ queueLength: 0 });
  }

  private emitSnapshot(): void {
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
        config: {
          ...(this.config.model ? { model: this.config.model } : {}),
          ...(this.config.permissionMode
            ? { permissionMode: this.config.permissionMode }
            : {}),
        },
      }),
    });
  }

  private emitSessionUpdate(update: {
    providerSession?: Record<string, string>;
    capabilities?: AgentCapabilitySetV2;
    config?: AgentSessionUpdatedPatchV2['config'];
    slashCommands?: AgentSlashCommandV2[];
  }): void {
    this.emitPatch({
      type: 'agent-session-updated-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      ...(update.providerSession !== undefined
        ? { providerSession: update.providerSession }
        : {}),
      ...(update.capabilities !== undefined
        ? { capabilities: update.capabilities }
        : {}),
      ...(update.config !== undefined ? { config: update.config } : {}),
      ...(update.slashCommands !== undefined
        ? { slashCommands: update.slashCommands }
        : {}),
    });
  }

  private async refreshSlashCommands(): Promise<void> {
    if (this.slashCommandsLoaded) return;
    if (this.slashCommandsLoadTask) {
      await this.slashCommandsLoadTask;
      return;
    }
    const query = this.activeQuery;
    const fetchCommands = query?.supportedCommands;
    if (typeof fetchCommands !== 'function') return;

    let task: Promise<void> | null = null;
    task = (async () => {
      try {
        let commands: unknown[] | undefined;
        const fetchInitialization = query?.initializationResult;
        if (typeof fetchInitialization === 'function') {
          const initialization = await fetchInitialization.call(query);
          if (
            isRecord(initialization) &&
            Array.isArray(initialization.commands)
          ) {
            commands = initialization.commands;
          }
        }
        if (commands === undefined) {
          commands = await fetchCommands.call(query);
        }
        if (!Array.isArray(commands)) return;
        if (this._status !== 'connected' || this.activeQuery !== query) return;

        const sdkCommands: AgentSlashCommandV2[] = commands
          .filter(
            (cmd): cmd is SlashCommand =>
              isRecord(cmd) &&
              typeof cmd.name === 'string' &&
              cmd.name.length > 0
          )
          .map(normalizeSlashCommand);
        const normalized = mergeClaudeCommandCatalog(sdkCommands);
        this.slashCommandsLoaded = true;
        this.emitSessionUpdate({ slashCommands: normalized });
      } catch (err) {
        logger.warn('Claude supportedCommands fetch failed:', err);
      } finally {
        if (task !== null && this.slashCommandsLoadTask === task) {
          this.slashCommandsLoadTask = null;
        }
      }
    })();

    this.slashCommandsLoadTask = task;
    await task;
  }

  private emitProviderExtension(
    turnId: string,
    payload: Record<string, unknown>,
    visibility: ClaudeEventVisibility = 'normal'
  ): void {
    const seq = ++this.providerExtensionSeq;
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sessionId,
      timestamp: nowIso(),
      turnId,
      item: {
        type: 'providerExtension',
        id: `ext-claude-${turnId}-${seq}`,
        namespace: 'claude',
        payload,
        ...(visibility === 'normal'
          ? {}
          : { metadata: { eventVisibility: visibility } }),
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
