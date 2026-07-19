import type { PromptAttachment } from './prompt-attachment.js';

export type AgentProviderV2 =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'hermes'
  | 'mock'
  | (string & {});

export interface AgentCapabilitySetV2 {
  text?: boolean;
  reasoning?: boolean;
  tools?: boolean;
  commandExecution?: boolean;
  fileChanges?: boolean;
  approvals?: boolean;
  questions?: boolean;
  plans?: boolean;
  slashCommands?: boolean;
  queue?: boolean;
  interrupt?: boolean;
  cancelQueued?: boolean;
  resume?: boolean;
  fork?: boolean;
  rollback?: boolean;
  compact?: boolean;
  telemetry?: boolean;
  rateLimits?: boolean;
  /**
   * Adapter emits live `agent-item-delta-v2` patches token-by-token while
   * the model generates. False (or omitted) means items appear with full
   * content on completion (single `started` + `updated`). UI handles both
   * paths transparently — flag is informational.
   */
  streaming?: boolean;
}

export type AgentLiveStatusV2 =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'error'
  | 'disconnected';

export interface AgentSessionLiveStateV2 {
  status: AgentLiveStatusV2;
  activeTurnId: string | null;
  waitingOn: 'approval' | 'question' | 'plan' | 'tool' | 'network' | null;
  activeRequestIds: string[];
  proposedPlanItemId: string | null;
  queueLength: number;
  fastModeAvailable: boolean;
  error: string | null;
}

export interface AgentSessionConfigV2 {
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  additionalDirectories?: string[];
  providerOptions?: Record<string, unknown>;
}

export interface AgentSlashCommandV2 {
  id?: string;
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  source?:
    | 'sdk'
    | 'relay'
    | 'builtin'
    | 'project'
    | 'user'
    | 'skill'
    | 'plugin'
    | 'unknown';
  sourceLabel?: string;
  namespace?: string;
  path?: string;
  dispatch?: 'agent' | 'relay-control' | 'client';
  collisionKey?: string;
  /** Provider-native trigger prefix the wire expects when dispatch is 'agent'. Adapters set this; UI passes it through unchanged. */
  nativePrefix?: '/' | '$';
}

export interface AgentSessionV2 {
  id: string;
  provider: AgentProviderV2;
  providerSession?: Record<string, string>;
  capabilities: AgentCapabilitySetV2;
  config: AgentSessionConfigV2;
  live: AgentSessionLiveStateV2;
  turns: AgentTurnV2[];
  slashCommands?: AgentSlashCommandV2[];
}

export type AgentTurnStatusV2 =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed';

export interface AgentUsageV2 {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Codex: cached input tokens (maps to TokenUsageBreakdown.cachedInputTokens) */
  cachedInputTokens?: number;
  /** Codex: reasoning output tokens (maps to TokenUsageBreakdown.reasoningOutputTokens) */
  reasoningOutputTokens?: number;
  /** Codex: total tokens (maps to TokenUsageBreakdown.totalTokens) */
  totalTokens?: number;
  costUsd?: number | null;
  contextPercent?: number;
  contextWindowSize?: number;
}

export interface AgentTurnV2 {
  id: string;
  providerTurnId?: string;
  status: AgentTurnStatusV2;
  inputMessageId: string;
  items: AgentItemV2[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  usage?: AgentUsageV2;
}

/**
 * Framework-neutral presentation contract for an agent detail row (#1198).
 *
 * Adapters still retain their richer typed item payloads, while renderers read
 * this ACP-shaped projection exclusively. A stable item id is the durable card
 * entity: started/updated patches mutate that one entity in place rather than
 * appending status rows.
 */
export type AgentDetailCardKindV2 =
  | 'message'
  | 'thought'
  | 'tool_call'
  | 'output'
  | 'diff';

export type AgentDetailCardStatusV2 =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentDetailCardV2 {
  kind: AgentDetailCardKindV2;
  title: string;
  status: AgentDetailCardStatusV2;
  /** Expandable body. Diff cards carry unified-diff-shaped content here. */
  content?: string;
  /** Optional renderer hint; never a provider/framework identifier. */
  language?: string;
  command?: string;
  path?: string;
  additions?: number;
  deletions?: number;
  sizeBytes?: number;
}

interface AgentItemBaseV2 {
  id: string;
  providerItemId?: string;
  startedAt?: string;
  completedAt?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  metadata?: Record<string, unknown>;
  /** Normalized renderer input; adapter boundaries populate this additively. */
  card?: AgentDetailCardV2;
}

export interface AgentUserMessageItemV2 extends AgentItemBaseV2 {
  type: 'userMessage';
  text: string;
  expandedText?: string;
  /**
   * Legacy adapter-shaped attachments (local path + mime). New federated
   * attachments — `FileResourceRef`-backed bounded refs — flow via
   * `promptAttachments` below. Both fields may coexist during migration.
   */
  attachments?: Array<Record<string, unknown>>;
  /** Typed federated attachments. Bounded by default — no raw bytes. */
  promptAttachments?: PromptAttachment[];
  command?: { name: string; arguments?: string };
}

export interface AgentAssistantMessageItemV2 extends AgentItemBaseV2 {
  type: 'assistantMessage';
  text: string;
  phase?: 'thinking' | 'answer' | 'final' | (string & {}) | null;
  memoryCitations?: Array<Record<string, unknown>>;
  providerMessageId?: string;
}

export interface AgentReasoningItemV2 extends AgentItemBaseV2 {
  type: 'reasoning';
  summary: string;
  detail?: string;
  visibility?: 'hidden' | 'summary' | 'full';
}

export interface AgentPlanItemV2 extends AgentItemBaseV2 {
  type: 'plan';
  text: string;
  /** Codex app-server step list from turn/plan/updated */
  steps?: Array<{
    step: string;
    status: 'pending' | 'inProgress' | 'completed';
  }>;
  approvalState?: 'pending' | 'approved' | 'rejected' | 'revising';
}

export interface AgentCommandExecutionItemV2 extends AgentItemBaseV2 {
  type: 'commandExecution';
  command: string;
  cwd?: string;
  parsedActions?: string[];
  output: string;
  exitCode?: number | null;
  durationMs?: number;
  interactive?: boolean;
}

export interface AgentFileChangeItemV2 extends AgentItemBaseV2 {
  type: 'fileChange';
  paths: Array<{ path: string; oldPath?: string; status?: string }>;
  patch?: string;
  applyStatus?: 'pending' | 'applied' | 'rejected' | 'failed';
  approvalId?: string;
}

export interface AgentMcpToolCallItemV2 extends AgentItemBaseV2 {
  type: 'mcpToolCall';
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
  progress?: string;
  result?: unknown;
}

export interface AgentDynamicToolCallItemV2 extends AgentItemBaseV2 {
  type: 'dynamicToolCall';
  namespace: string;
  tool: string;
  arguments?: Record<string, unknown>;
  content?: string;
  result?: unknown;
}

export type AgentApprovalDecisionV2 =
  | {
      kind: 'accept';
      scope?: 'once' | 'session' | 'turn' | 'permanent';
      amendments?: ApprovalAmendmentV2[];
    }
  | { kind: 'decline' }
  | { kind: 'cancel' };

export type ApprovalAmendmentV2 =
  | { type: 'execpolicy'; payload: Record<string, unknown> }
  | { type: 'networkPolicy'; payload: Record<string, unknown> }
  | { type: 'permissionGrant'; permissions: string[] };

export type AgentApprovalKindV2 =
  | 'permission'
  | 'command'
  | 'patch'
  | 'permissionsGrant'
  | 'elicitation';

export type AgentApprovalDetailsV2 =
  | {
      kind: 'command';
      command: string;
      cwd: string;
      commandActions?: unknown[];
    }
  | {
      kind: 'patch';
      diff?: string;
      changes?: { path: string; kind: string; diff?: string }[];
    }
  | { kind: 'permissionsGrant'; permissions: string[] }
  | {
      kind: 'elicitation';
      serverName: string;
      mode: string;
      message: string;
      requestedSchema?: unknown;
    };

export interface AgentApprovalSupportV2 {
  scopes: ('once' | 'session' | 'turn' | 'permanent')[];
  amendmentTypes: ('execpolicy' | 'networkPolicy' | 'permissionGrant')[];
  canCancel: boolean;
}

export interface AgentApprovalItemV2 extends AgentItemBaseV2 {
  type: 'approval';
  requestId: string;
  kind: AgentApprovalKindV2 | (string & {});
  description: string;
  target: string;
  detail?: string;
  decision?: AgentApprovalDecisionV2;
  respondedBy?: 'user' | 'timeout';
  details?: AgentApprovalDetailsV2;
  supported?: AgentApprovalSupportV2;
}

export interface AgentQuestionItemV2 extends AgentItemBaseV2 {
  type: 'question';
  requestId: string;
  question: string;
  fields?: Array<Record<string, unknown>>;
  answers?: Record<string, string[]>;
}

export interface AgentCompactionItemV2 extends AgentItemBaseV2 {
  type: 'compaction';
  summary: string;
  tokensBefore?: number;
  tokensAfter?: number;
}

/**
 * Synthetic divider emitted at the recovery point when a user triggers
 * "Continue here" after a resume failure. Marks the boundary between
 * turns that had model-side context and turns that start with an empty
 * model context (fresh adapter session). All prior turns remain visible
 * in the Relay-owned transcript above this item.
 */
export interface AgentSessionBreakItemV2 extends AgentItemBaseV2 {
  type: 'sessionBreak';
  reason: 'continue-here';
}

export interface AgentWebSearchItemV2 extends AgentItemBaseV2 {
  type: 'webSearch';
  query: string;
  action?: string;
}

export interface AgentImageViewItemV2 extends AgentItemBaseV2 {
  type: 'imageView';
  source: string;
  description?: string;
}

export interface AgentImageGenerationItemV2 extends AgentItemBaseV2 {
  type: 'imageGeneration';
  prompt: string;
  imageUrl?: string;
}

export interface AgentHookPromptItemV2 extends AgentItemBaseV2 {
  type: 'hookPrompt';
  prompt: string;
  source?: string;
}

export interface AgentProviderExtensionItemV2 extends AgentItemBaseV2 {
  type: 'providerExtension';
  namespace: string;
  payload: Record<string, unknown>;
}

/**
 * Inline error rendered in the timeline. Source distinguishes between
 * agent/transport errors (`'agent'`) and frontend client validation
 * errors (`'client'`, e.g. unknown leading slash command).
 */
export interface AgentErrorMessageItemV2 extends AgentItemBaseV2 {
  type: 'errorMessage';
  message: string;
  source: 'agent' | 'client';
  context?: string;
}

export type AgentItemV2 =
  | AgentUserMessageItemV2
  | AgentAssistantMessageItemV2
  | AgentReasoningItemV2
  | AgentPlanItemV2
  | AgentCommandExecutionItemV2
  | AgentFileChangeItemV2
  | AgentMcpToolCallItemV2
  | AgentDynamicToolCallItemV2
  | AgentApprovalItemV2
  | AgentQuestionItemV2
  | AgentCompactionItemV2
  | AgentSessionBreakItemV2
  | AgentWebSearchItemV2
  | AgentImageViewItemV2
  | AgentImageGenerationItemV2
  | AgentHookPromptItemV2
  | AgentProviderExtensionItemV2
  | AgentErrorMessageItemV2;

function detailCardStatus(item: AgentItemV2): AgentDetailCardStatusV2 {
  return item.status ?? 'pending';
}

function detailCardText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function detailCardBytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function diffLineCounts(content: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of content.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

function isUnifiedDiff(content: string): boolean {
  return (
    /(^|\n)diff --git /.test(content) ||
    (/(^|\n)--- (?:a\/|\/dev\/null)/.test(content) &&
      /(^|\n)\+\+\+ (?:b\/|\/dev\/null)/.test(content))
  );
}

function toolCardContent(
  args: Record<string, unknown> | undefined,
  output: unknown
): string {
  const inputText = detailCardText(args);
  const outputText = detailCardText(output);
  if (inputText && outputText)
    return `input\n${inputText}\n\noutput\n${outputText}`;
  if (inputText) return `input\n${inputText}`;
  if (outputText) return `output\n${outputText}`;
  return '';
}

function detailCardTitle(content: string, fallback: string): string {
  const title = content.replace(/\s+/g, ' ').trim();
  if (!title) return fallback;
  return title.length <= 80 ? title : `${title.slice(0, 79).trimEnd()}…`;
}

function isTerminalDetailStatus(status: AgentDetailCardStatusV2): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

/**
 * Project a provider-rich item onto the one framework-neutral detail-card
 * shape. This is intentionally exhaustive by item type and contains no
 * framework/provider branch.
 */
export function agentDetailCardForItem(
  item: AgentItemV2
): AgentDetailCardV2 | undefined {
  const status = detailCardStatus(item);
  const includeDerivedFields = isTerminalDetailStatus(status);
  switch (item.type) {
    case 'assistantMessage':
    case 'userMessage': {
      const content = item.text;
      return {
        kind: 'message',
        title: item.type === 'userMessage' ? 'message' : 'response',
        status,
        ...(content
          ? {
              content,
              ...(includeDerivedFields
                ? { sizeBytes: detailCardBytes(content) }
                : {}),
            }
          : {}),
      };
    }
    case 'reasoning': {
      const content = item.detail || item.summary;
      return {
        kind: 'thought',
        title: includeDerivedFields
          ? detailCardTitle(item.summary, 'thinking')
          : 'thinking',
        status,
        ...(content
          ? {
              content,
              ...(includeDerivedFields
                ? { sizeBytes: detailCardBytes(content) }
                : {}),
            }
          : {}),
      };
    }
    case 'commandExecution': {
      const content = item.output;
      return {
        kind: 'output',
        title: item.command || 'command',
        status,
        command: item.command,
        language: 'bash',
        ...(content
          ? {
              content,
              ...(includeDerivedFields
                ? { sizeBytes: detailCardBytes(content) }
                : {}),
            }
          : {}),
      };
    }
    case 'fileChange': {
      const content = item.patch ?? '';
      const path = item.paths[0]?.path;
      return {
        kind: 'diff',
        title:
          path ??
          `${item.paths.length} file${item.paths.length === 1 ? '' : 's'}`,
        status,
        language: 'diff',
        ...(path ? { path } : {}),
        ...(content
          ? {
              content,
              ...(includeDerivedFields
                ? {
                    sizeBytes: detailCardBytes(content),
                    ...diffLineCounts(content),
                  }
                : {}),
            }
          : {}),
      };
    }
    case 'dynamicToolCall':
    case 'mcpToolCall': {
      const tool = item.tool;
      const output =
        item.type === 'dynamicToolCall'
          ? item.content || detailCardText(item.result)
          : item.progress || detailCardText(item.result);
      const content = toolCardContent(item.arguments, output);
      const isDiff =
        item.metadata?.contentKind === 'diff' || isUnifiedDiff(content);
      return {
        kind: isDiff ? 'diff' : 'tool_call',
        title: tool || 'tool',
        status,
        ...(isDiff ? { language: 'diff' } : {}),
        ...(content
          ? {
              content,
              ...(includeDerivedFields
                ? {
                    sizeBytes: detailCardBytes(content),
                    ...(isDiff ? diffLineCounts(content) : {}),
                  }
                : {}),
            }
          : {}),
      };
    }
    default:
      return undefined;
  }
}

/** Add or refresh the normalized card without mutating the provider item. */
export function withAgentDetailCard(item: AgentItemV2): AgentItemV2 {
  const card = agentDetailCardForItem(item);
  if (!card) return item;
  return { ...item, card } as AgentItemV2;
}

function withDetailCardsInTurn(turn: AgentTurnV2): AgentTurnV2 {
  return { ...turn, items: turn.items.map(withAgentDetailCard) };
}

/** Normalize every item-bearing patch at the adapter emission boundary. */
export function withAgentDetailCards(patch: AgentPatchV2): AgentPatchV2 {
  switch (patch.type) {
    case 'agent-session-snapshot-v2':
      return {
        ...patch,
        session: {
          ...patch.session,
          turns: patch.session.turns.map(withDetailCardsInTurn),
        },
      };
    case 'agent-turn-started-v2':
      return { ...patch, turn: withDetailCardsInTurn(patch.turn) };
    case 'agent-item-started-v2':
    case 'agent-item-updated-v2':
      return { ...patch, item: withAgentDetailCard(patch.item) };
    default:
      return patch;
  }
}

interface AgentPatchBaseV2 {
  type: AgentPatchV2['type'];
  sessionId: string;
  timestamp: string;
}

export interface AgentSessionSnapshotPatchV2 extends AgentPatchBaseV2 {
  type: 'agent-session-snapshot-v2';
  session: AgentSessionV2;
}

export interface AgentSessionUpdatedPatchV2 extends AgentPatchBaseV2 {
  type: 'agent-session-updated-v2';
  providerSession?: Record<string, string>;
  capabilities?: AgentCapabilitySetV2;
  config?: Partial<Omit<AgentSessionConfigV2, 'cwd'>>;
  slashCommands?: AgentSlashCommandV2[];
}

export interface AgentLiveStateUpdatedPatchV2 extends AgentPatchBaseV2 {
  type: 'agent-live-state-updated-v2';
  live: Partial<AgentSessionLiveStateV2>;
}

export interface AgentTurnStartedPatchV2 extends AgentPatchBaseV2 {
  type: 'agent-turn-started-v2';
  turn: AgentTurnV2;
}

export interface AgentItemStartedPatchV2 extends AgentPatchBaseV2 {
  type: 'agent-item-started-v2';
  turnId: string;
  item: AgentItemV2;
}

export interface AgentItemDeltaPatchV2 extends AgentPatchBaseV2 {
  type: 'agent-item-delta-v2';
  turnId: string;
  itemId: string;
  /** Append is the streaming default; replace is for authoritative snapshots. */
  mode?: 'append' | 'replace';
  delta: {
    text?: string;
    output?: string;
    summary?: string;
    detail?: string;
    patch?: string;
    content?: string;
    status?: AgentDetailCardStatusV2;
    error?: string;
    exitCode?: number | null;
    durationMs?: number;
    /** Cheap emitter-derived summary for live cards; terminal updates derive all fields. */
    card?: Pick<AgentDetailCardV2, 'additions' | 'deletions'>;
  };
}

export interface AgentItemUpdatedPatchV2 extends AgentPatchBaseV2 {
  type: 'agent-item-updated-v2';
  turnId: string;
  item: AgentItemV2;
}

export interface AgentTurnCompletedPatchV2 extends AgentPatchBaseV2 {
  type: 'agent-turn-completed-v2';
  turnId: string;
  status: Extract<AgentTurnStatusV2, 'completed' | 'interrupted' | 'failed'>;
  completedAt?: string;
  durationMs?: number;
  usage?: AgentUsageV2;
  error?: string;
}

export interface AgentErrorPatchV2 extends AgentPatchBaseV2 {
  type: 'agent-error-v2';
  message: string;
  turnId?: string;
}

export type AgentPatchV2 =
  | AgentSessionSnapshotPatchV2
  | AgentSessionUpdatedPatchV2
  | AgentLiveStateUpdatedPatchV2
  | AgentTurnStartedPatchV2
  | AgentItemStartedPatchV2
  | AgentItemDeltaPatchV2
  | AgentItemUpdatedPatchV2
  | AgentTurnCompletedPatchV2
  | AgentErrorPatchV2;

export type AgentCommandV2 =
  | {
      type: 'agent-send-message-v2';
      sessionId: string;
      text: string;
      clientMessageId?: string;
      attachments?: Array<Record<string, unknown>>;
      /** Typed federated attachments. Bounded by default — no raw bytes. */
      promptAttachments?: PromptAttachment[];
    }
  | { type: 'agent-interrupt-v2'; sessionId: string; turnId?: string }
  | {
      type: 'agent-approve-v2';
      sessionId: string;
      requestId: string;
      decision: AgentApprovalDecisionV2;
    }
  | {
      type: 'agent-answer-v2';
      sessionId: string;
      requestId: string;
      answers: Record<string, string[]>;
    }
  | {
      type: 'agent-plan-response-v2';
      sessionId: string;
      planItemId: string;
      decision: 'approve' | 'revise' | 'reject';
      response?: string;
    }
  | { type: 'agent-resume-v2'; sessionId: string; providerSessionId?: string }
  | { type: 'agent-continue-here-v2'; sessionId: string }
  | { type: 'agent-fork-v2'; sessionId: string; turnId?: string }
  | { type: 'agent-rollback-v2'; sessionId: string; turnId: string };

const PATCH_TYPES = new Set<string>([
  'agent-session-snapshot-v2',
  'agent-session-updated-v2',
  'agent-live-state-updated-v2',
  'agent-turn-started-v2',
  'agent-item-started-v2',
  'agent-item-delta-v2',
  'agent-item-updated-v2',
  'agent-turn-completed-v2',
  'agent-error-v2',
]);

const TURN_STATUSES = new Set<string>([
  'queued',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
]);

const TURN_COMPLETION_STATUSES = new Set<string>([
  'completed',
  'interrupted',
  'failed',
]);

const LIVE_STATUSES = new Set<string>([
  'idle',
  'working',
  'waiting',
  'error',
  'disconnected',
]);

const WAITING_ON_VALUES = new Set<string>([
  'approval',
  'question',
  'plan',
  'tool',
  'network',
]);

const DELTA_STRING_FIELDS = [
  'text',
  'output',
  'summary',
  'detail',
  'patch',
  'content',
] as const;

export function emptyAgentSessionV2(input: {
  id: string;
  provider: AgentProviderV2;
  cwd: string;
  capabilities?: AgentCapabilitySetV2;
  providerSession?: Record<string, string>;
  config?: Partial<Omit<AgentSessionConfigV2, 'cwd'>>;
}): AgentSessionV2 {
  const session: AgentSessionV2 = {
    id: input.id,
    provider: input.provider,
    capabilities: input.capabilities ?? {},
    config: {
      cwd: input.cwd,
      ...input.config,
    },
    live: {
      status: 'idle',
      activeTurnId: null,
      waitingOn: null,
      activeRequestIds: [],
      proposedPlanItemId: null,
      queueLength: 0,
      fastModeAvailable: false,
      error: null,
    },
    turns: [],
  };

  if (input.providerSession !== undefined) {
    session.providerSession = input.providerSession;
  }

  return session;
}

export function isAgentPatchV2(value: unknown): value is AgentPatchV2 {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.type !== 'string' ||
    !PATCH_TYPES.has(value.type) ||
    typeof value.sessionId !== 'string' ||
    typeof value.timestamp !== 'string'
  ) {
    return false;
  }

  switch (value.type) {
    case 'agent-session-snapshot-v2':
      return isSession(value.session);
    case 'agent-session-updated-v2':
      return (
        (value.providerSession === undefined ||
          isProviderSession(value.providerSession)) &&
        (value.capabilities === undefined || isRecord(value.capabilities)) &&
        (value.config === undefined || isPartialSessionConfig(value.config)) &&
        (value.slashCommands === undefined ||
          isSlashCommandArray(value.slashCommands))
      );
    case 'agent-live-state-updated-v2':
      return isPartialLiveState(value.live);
    case 'agent-turn-started-v2':
      return isTurn(value.turn);
    case 'agent-item-started-v2':
      return typeof value.turnId === 'string' && isItem(value.item);
    case 'agent-item-delta-v2':
      return (
        typeof value.turnId === 'string' &&
        typeof value.itemId === 'string' &&
        (value.mode === undefined ||
          value.mode === 'append' ||
          value.mode === 'replace') &&
        isDelta(value.delta)
      );
    case 'agent-item-updated-v2':
      return typeof value.turnId === 'string' && isItem(value.item);
    case 'agent-turn-completed-v2':
      return (
        typeof value.turnId === 'string' &&
        typeof value.status === 'string' &&
        TURN_COMPLETION_STATUSES.has(value.status)
      );
    case 'agent-error-v2':
      return typeof value.message === 'string';
  }

  return false;
}

export function applyAgentPatchV2(
  session: AgentSessionV2,
  patch: AgentPatchV2
): AgentSessionV2 {
  switch (patch.type) {
    case 'agent-session-snapshot-v2':
      return patch.session;
    case 'agent-session-updated-v2':
      return {
        ...session,
        ...(patch.capabilities !== undefined
          ? {
              capabilities: { ...session.capabilities, ...patch.capabilities },
            }
          : {}),
        ...(patch.providerSession !== undefined
          ? {
              providerSession: {
                ...(session.providerSession ?? {}),
                ...patch.providerSession,
              },
            }
          : {}),
        ...(patch.config !== undefined
          ? { config: { ...session.config, ...patch.config } }
          : {}),
        ...(patch.slashCommands !== undefined
          ? { slashCommands: patch.slashCommands }
          : {}),
      };
    case 'agent-live-state-updated-v2':
      return {
        ...session,
        live: {
          ...session.live,
          ...patch.live,
        },
      };
    case 'agent-turn-started-v2':
      return {
        ...session,
        live: {
          ...session.live,
          status: 'working',
          activeTurnId: patch.turn.id,
          error: null,
        },
        turns: upsertById(session.turns, patch.turn),
      };
    case 'agent-item-started-v2':
      return updateTurn(session, patch.turnId, (turn) => ({
        ...turn,
        items: upsertById(turn.items, patch.item),
      }));
    case 'agent-item-delta-v2':
      return updateTurn(session, patch.turnId, (turn) => ({
        ...turn,
        items: applyItemDelta(turn.items, patch),
      }));
    case 'agent-item-updated-v2':
      return updateTurn(session, patch.turnId, (turn) => ({
        ...turn,
        items: upsertById(turn.items, patch.item),
      }));
    case 'agent-turn-completed-v2':
      return updateTurn(
        completeLiveStateForActiveTurn(session, patch),
        patch.turnId,
        (turn) => completeTurn(turn, patch)
      );
    case 'agent-error-v2': {
      const errorItem: AgentErrorMessageItemV2 = {
        type: 'errorMessage',
        id: `error-${patch.timestamp}-${shortHash(`${patch.sessionId}|${patch.turnId ?? ''}|${patch.message}`)}`,
        message: patch.message,
        source: 'agent',
        status: 'completed',
        startedAt: patch.timestamp,
        completedAt: patch.timestamp,
      };

      const targetTurnId = patch.turnId ?? session.live.activeTurnId;
      const targetTurnExists =
        !!targetTurnId && session.turns.some((t) => t.id === targetTurnId);
      let nextTurns: AgentTurnV2[];
      if (targetTurnId && targetTurnExists) {
        nextTurns = updateTurn(session, targetTurnId, (turn) => ({
          ...turn,
          items: [...turn.items, errorItem],
        })).turns;
      } else {
        const lastTurn = session.turns[session.turns.length - 1];
        if (lastTurn) {
          nextTurns = upsertById(session.turns, {
            ...lastTurn,
            items: [...lastTurn.items, errorItem],
          });
        } else {
          nextTurns = [
            ...session.turns,
            {
              id: `synthetic-${patch.timestamp}`,
              status: 'failed',
              startedAt: patch.timestamp,
              completedAt: patch.timestamp,
              items: [errorItem],
              inputMessageId: '',
            },
          ];
        }
      }

      return {
        ...session,
        live: {
          ...session.live,
          status: 'error',
          error: patch.message,
        },
        turns: nextTurns,
      };
    }
  }
}

function completeLiveStateForActiveTurn(
  session: AgentSessionV2,
  patch: AgentTurnCompletedPatchV2
): AgentSessionV2 {
  if (session.live.activeTurnId !== patch.turnId) {
    return session;
  }

  return {
    ...session,
    live: {
      ...session.live,
      status: patch.status === 'failed' ? 'error' : 'idle',
      activeTurnId: null,
      error: patch.error ?? session.live.error,
    },
  };
}

function updateTurn(
  session: AgentSessionV2,
  turnId: string,
  update: (turn: AgentTurnV2) => AgentTurnV2
): AgentSessionV2 {
  return {
    ...session,
    turns: session.turns.map((turn) =>
      turn.id === turnId ? update(turn) : turn
    ),
  };
}

/**
 * Deterministic short hash (FNV-1a 32-bit) used for synthetic item ids so the
 * reducer is replay-safe: applying the same patch always produces the same id.
 */
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);

  if (index === -1) {
    return [...items, item];
  }

  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

function applyItemDelta(
  items: AgentItemV2[],
  patch: Extract<AgentPatchV2, { type: 'agent-item-delta-v2' }>
): AgentItemV2[] {
  const existing = items.find((item) => item.id === patch.itemId);

  if (existing) {
    return items.map((item) =>
      item.id === patch.itemId ? applyDeltaToItem(item, patch) : item
    );
  }

  if (patch.delta.text === undefined) {
    return items;
  }

  return [
    ...items,
    {
      type: 'assistantMessage',
      id: patch.itemId,
      text: patch.delta.text,
      phase: 'answer',
      status: 'running',
      startedAt: patch.timestamp,
    },
  ];
}

function applyDeltaToItem(
  item: AgentItemV2,
  patch: Extract<AgentPatchV2, { type: 'agent-item-delta-v2' }>
): AgentItemV2 {
  const next = appendItemDelta(item, patch.delta, patch.mode ?? 'append');
  const card = item.card;
  if (next.type === 'assistantMessage' || next.type === 'userMessage') {
    return next;
  }

  const status = patch.delta.status ?? card?.status ?? detailCardStatus(next);
  if (isTerminalDetailStatus(status)) return withAgentDetailCard(next);
  if (!card) return next;

  let content = card.content;
  switch (next.type) {
    case 'reasoning':
      content = next.detail || next.summary;
      break;
    case 'commandExecution':
      content = next.output;
      break;
    case 'fileChange':
      content = next.patch;
      break;
    case 'dynamicToolCall': {
      const fragment = patch.delta.content;
      if (typeof fragment === 'string') {
        const hadOutput =
          item.type === 'dynamicToolCall' &&
          typeof item.content === 'string' &&
          item.content;
        const separator = hadOutput
          ? ''
          : card.content
            ? '\n\noutput\n'
            : 'output\n';
        content =
          patch.mode === 'replace'
            ? `${card.content ? `${card.content}\n\n` : ''}output\n${fragment}`
            : `${card.content ?? ''}${separator}${fragment}`;
      }
      break;
    }
    default:
      break;
  }

  return {
    ...next,
    card: {
      ...card,
      status,
      ...(content !== undefined ? { content } : {}),
      ...(patch.delta.card ?? {}),
    },
  } as AgentItemV2;
}

function completeTurn(
  turn: AgentTurnV2,
  patch: AgentTurnCompletedPatchV2
): AgentTurnV2 {
  const next: AgentTurnV2 = {
    ...turn,
    status: patch.status,
  };

  if (patch.completedAt !== undefined) {
    next.completedAt = patch.completedAt;
  }
  if (patch.durationMs !== undefined) {
    next.durationMs = patch.durationMs;
  }
  if (patch.usage !== undefined) {
    next.usage = patch.usage;
  }
  if (patch.error !== undefined) {
    next.error = patch.error;
  }

  return next;
}

function appendItemDelta(
  item: AgentItemV2,
  delta: AgentItemDeltaPatchV2['delta'],
  mode: 'append' | 'replace'
): AgentItemV2 {
  let next: AgentItemV2 = item;

  next = appendStringField(next, delta, 'text', mode);
  next = appendStringField(next, delta, 'output', mode);
  next = appendStringField(next, delta, 'summary', mode);
  next = appendStringField(next, delta, 'detail', mode);
  next = appendStringField(next, delta, 'patch', mode);
  next = appendStringField(next, delta, 'content', mode);

  if (delta.status !== undefined) next = { ...next, status: delta.status };
  if (delta.error !== undefined) next = { ...next, error: delta.error };
  if (delta.exitCode !== undefined && next.type === 'commandExecution') {
    next = { ...next, exitCode: delta.exitCode };
  }
  if (delta.durationMs !== undefined && next.type === 'commandExecution') {
    next = { ...next, durationMs: delta.durationMs };
  }

  return next;
}

function appendStringField<K extends keyof AgentItemDeltaPatchV2['delta']>(
  item: AgentItemV2,
  delta: AgentItemDeltaPatchV2['delta'],
  key: K,
  mode: 'append' | 'replace'
): AgentItemV2 {
  const fragment = delta[key];
  const current = (item as unknown as Record<string, unknown>)[key];

  if (typeof fragment !== 'string') {
    return item;
  }
  if (mode === 'replace') {
    return { ...item, [key]: fragment } as AgentItemV2;
  }
  if (current === undefined) {
    return {
      ...item,
      [key]: fragment,
    } as AgentItemV2;
  }
  if (typeof current !== 'string') {
    return item;
  }

  return {
    ...item,
    [key]: current + fragment,
  } as AgentItemV2;
}

function isTurn(value: unknown): value is AgentTurnV2 {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.status === 'string' &&
    TURN_STATUSES.has(value.status) &&
    typeof value.inputMessageId === 'string' &&
    Array.isArray(value.items) &&
    value.items.every(isItem) &&
    typeof value.startedAt === 'string'
  );
}

type ItemValidator = (value: Record<string, unknown>) => boolean;

const ITEM_VALIDATORS: Record<string, ItemValidator> = {
  userMessage: (v) => typeof v.text === 'string',
  assistantMessage: (v) => typeof v.text === 'string',
  reasoning: (v) => typeof v.summary === 'string',
  plan: (v) => typeof v.text === 'string',
  commandExecution: (v) =>
    typeof v.command === 'string' && typeof v.output === 'string',
  fileChange: (v) =>
    Array.isArray(v.paths) &&
    v.paths.every((p) => isRecord(p) && typeof p.path === 'string'),
  mcpToolCall: (v) =>
    typeof v.server === 'string' && typeof v.tool === 'string',
  dynamicToolCall: (v) =>
    typeof v.namespace === 'string' && typeof v.tool === 'string',
  approval: (v) =>
    typeof v.requestId === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.description === 'string' &&
    typeof v.target === 'string',
  question: (v) =>
    typeof v.requestId === 'string' && typeof v.question === 'string',
  compaction: (v) => typeof v.summary === 'string',
  sessionBreak: (v) => v.reason === 'continue-here',
  webSearch: (v) => typeof v.query === 'string',
  imageView: (v) => typeof v.source === 'string',
  imageGeneration: (v) => typeof v.prompt === 'string',
  hookPrompt: (v) => typeof v.prompt === 'string',
  providerExtension: (v) =>
    typeof v.namespace === 'string' && isRecord(v.payload),
  errorMessage: (v) =>
    typeof v.message === 'string' &&
    (v.source === 'agent' || v.source === 'client'),
};

const DETAIL_CARD_KINDS = new Set<AgentDetailCardKindV2>([
  'message',
  'thought',
  'tool_call',
  'output',
  'diff',
]);

const DETAIL_CARD_STATUSES = new Set<AgentDetailCardStatusV2>([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

function isDetailCard(value: unknown): value is AgentDetailCardV2 {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    DETAIL_CARD_KINDS.has(value.kind as AgentDetailCardKindV2) &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    DETAIL_CARD_STATUSES.has(value.status as AgentDetailCardStatusV2) &&
    (value.content === undefined || typeof value.content === 'string') &&
    (value.language === undefined || typeof value.language === 'string') &&
    (value.command === undefined || typeof value.command === 'string') &&
    (value.path === undefined || typeof value.path === 'string') &&
    (value.additions === undefined || typeof value.additions === 'number') &&
    (value.deletions === undefined || typeof value.deletions === 'number') &&
    (value.sizeBytes === undefined || typeof value.sizeBytes === 'number')
  );
}

function isItem(value: unknown): value is AgentItemV2 {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  const validator = ITEM_VALIDATORS[value.type];
  return (
    !!validator &&
    validator(value) &&
    (value.card === undefined || isDetailCard(value.card))
  );
}

function isSession(value: unknown): value is AgentSessionV2 {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.provider === 'string' &&
    isRecord(value.capabilities) &&
    isRecord(value.config) &&
    typeof value.config.cwd === 'string' &&
    isLiveState(value.live) &&
    Array.isArray(value.turns) &&
    value.turns.every(isTurn) &&
    (value.providerSession === undefined ||
      isProviderSession(value.providerSession)) &&
    (value.slashCommands === undefined ||
      isSlashCommandArray(value.slashCommands))
  );
}

function isProviderSession(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') return false;
  }
  return true;
}

function isPartialSessionConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  // agent-session-updated-v2.config must not mutate cwd at runtime; reject any
  // payload that tries to set it (even to undefined explicitly).
  if (Object.hasOwn(value, 'cwd')) return false;
  if (value.model !== undefined && typeof value.model !== 'string')
    return false;
  if (value.effort !== undefined && typeof value.effort !== 'string')
    return false;
  if (
    value.permissionMode !== undefined &&
    typeof value.permissionMode !== 'string'
  ) {
    return false;
  }
  if (
    value.additionalDirectories !== undefined &&
    !(
      Array.isArray(value.additionalDirectories) &&
      value.additionalDirectories.every((d) => typeof d === 'string')
    )
  ) {
    return false;
  }
  if (value.providerOptions !== undefined && !isRecord(value.providerOptions)) {
    return false;
  }
  return true;
}

function isSlashCommandArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isSlashCommand);
}

function isSlashCommand(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.name !== 'string') return false;
  if (value.id !== undefined && typeof value.id !== 'string') return false;
  if (value.description !== undefined && typeof value.description !== 'string')
    return false;
  if (
    value.argumentHint !== undefined &&
    typeof value.argumentHint !== 'string'
  ) {
    return false;
  }
  if (
    value.aliases !== undefined &&
    !(
      Array.isArray(value.aliases) &&
      value.aliases.every((a) => typeof a === 'string')
    )
  ) {
    return false;
  }
  if (value.source !== undefined && typeof value.source !== 'string') {
    return false;
  }
  if (value.sourceLabel !== undefined && typeof value.sourceLabel !== 'string')
    return false;
  if (value.namespace !== undefined && typeof value.namespace !== 'string')
    return false;
  if (value.path !== undefined && typeof value.path !== 'string') return false;
  if (
    value.collisionKey !== undefined &&
    typeof value.collisionKey !== 'string'
  ) {
    return false;
  }
  if (
    value.dispatch !== undefined &&
    !(
      value.dispatch === 'agent' ||
      value.dispatch === 'relay-control' ||
      value.dispatch === 'client'
    )
  ) {
    return false;
  }
  if (
    value.nativePrefix !== undefined &&
    !(value.nativePrefix === '/' || value.nativePrefix === '$')
  ) {
    return false;
  }
  return true;
}

function isLiveState(value: unknown): value is AgentSessionLiveStateV2 {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    LIVE_STATUSES.has(value.status) &&
    (value.activeTurnId === null || typeof value.activeTurnId === 'string') &&
    (value.waitingOn === null ||
      (typeof value.waitingOn === 'string' &&
        WAITING_ON_VALUES.has(value.waitingOn))) &&
    Array.isArray(value.activeRequestIds) &&
    value.activeRequestIds.every(
      (requestId) => typeof requestId === 'string'
    ) &&
    (value.proposedPlanItemId === null ||
      typeof value.proposedPlanItemId === 'string') &&
    typeof value.queueLength === 'number' &&
    typeof value.fastModeAvailable === 'boolean' &&
    (value.error === null || typeof value.error === 'string')
  );
}

function isPartialLiveState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value.status !== undefined &&
    !(typeof value.status === 'string' && LIVE_STATUSES.has(value.status))
  ) {
    return false;
  }
  if (
    value.activeTurnId !== undefined &&
    value.activeTurnId !== null &&
    typeof value.activeTurnId !== 'string'
  ) {
    return false;
  }
  if (
    value.waitingOn !== undefined &&
    value.waitingOn !== null &&
    !(
      typeof value.waitingOn === 'string' &&
      WAITING_ON_VALUES.has(value.waitingOn)
    )
  ) {
    return false;
  }
  if (
    value.activeRequestIds !== undefined &&
    !(
      Array.isArray(value.activeRequestIds) &&
      value.activeRequestIds.every((r) => typeof r === 'string')
    )
  ) {
    return false;
  }
  if (
    value.proposedPlanItemId !== undefined &&
    value.proposedPlanItemId !== null &&
    typeof value.proposedPlanItemId !== 'string'
  ) {
    return false;
  }
  if (
    value.queueLength !== undefined &&
    typeof value.queueLength !== 'number'
  ) {
    return false;
  }
  if (
    value.fastModeAvailable !== undefined &&
    typeof value.fastModeAvailable !== 'boolean'
  ) {
    return false;
  }
  if (
    value.error !== undefined &&
    value.error !== null &&
    typeof value.error !== 'string'
  ) {
    return false;
  }
  return true;
}

function isDelta(value: unknown): value is AgentItemDeltaPatchV2['delta'] {
  if (!isRecord(value)) return false;
  if (
    !DELTA_STRING_FIELDS.every(
      (field) =>
        !Object.hasOwn(value, field) || typeof value[field] === 'string'
    )
  ) {
    return false;
  }
  if (
    value.status !== undefined &&
    !(
      typeof value.status === 'string' &&
      DETAIL_CARD_STATUSES.has(value.status as AgentDetailCardStatusV2)
    )
  ) {
    return false;
  }
  if (value.error !== undefined && typeof value.error !== 'string')
    return false;
  if (
    value.exitCode !== undefined &&
    value.exitCode !== null &&
    typeof value.exitCode !== 'number'
  ) {
    return false;
  }
  if (value.durationMs !== undefined && typeof value.durationMs !== 'number') {
    return false;
  }
  if (
    value.card !== undefined &&
    (!isRecord(value.card) ||
      (value.card.additions !== undefined &&
        typeof value.card.additions !== 'number') ||
      (value.card.deletions !== undefined &&
        typeof value.card.deletions !== 'number'))
  ) {
    return false;
  }
  return (
    DELTA_STRING_FIELDS.some((field) => typeof value[field] === 'string') ||
    value.status !== undefined ||
    value.error !== undefined ||
    value.exitCode !== undefined ||
    value.durationMs !== undefined ||
    value.card !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
