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

export interface AgentSessionV2 {
  id: string;
  provider: AgentProviderV2;
  providerSession?: Record<string, string>;
  capabilities: AgentCapabilitySetV2;
  config: AgentSessionConfigV2;
  live: AgentSessionLiveStateV2;
  turns: AgentTurnV2[];
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

interface AgentItemBaseV2 {
  id: string;
  providerItemId?: string;
  startedAt?: string;
  completedAt?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentUserMessageItemV2 extends AgentItemBaseV2 {
  type: 'userMessage';
  text: string;
  expandedText?: string;
  attachments?: Array<Record<string, unknown>>;
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
  steps?: Array<{ id: string; text: string; status?: string }>;
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

export interface AgentApprovalItemV2 extends AgentItemBaseV2 {
  type: 'approval';
  requestId: string;
  kind: 'command' | 'file' | 'permission' | 'mcp' | (string & {});
  description: string;
  target: string;
  detail?: string;
  decision?: 'allow' | 'allow-always' | 'deny';
  respondedBy?: 'user' | 'timeout';
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
  | AgentWebSearchItemV2
  | AgentImageViewItemV2
  | AgentImageGenerationItemV2
  | AgentHookPromptItemV2
  | AgentProviderExtensionItemV2;

interface AgentPatchBaseV2 {
  type: AgentPatchV2['type'];
  sessionId: string;
  timestamp: string;
}

export interface AgentSessionSnapshotPatchV2 extends AgentPatchBaseV2 {
  type: 'agent-session-snapshot-v2';
  session: AgentSessionV2;
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
  delta: {
    text?: string;
    output?: string;
    summary?: string;
    detail?: string;
    patch?: string;
    content?: string;
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
    }
  | { type: 'agent-interrupt-v2'; sessionId: string; turnId?: string }
  | {
      type: 'agent-approve-v2';
      sessionId: string;
      requestId: string;
      decision: 'allow' | 'allow-always' | 'deny';
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
  | { type: 'agent-fork-v2'; sessionId: string; turnId?: string }
  | { type: 'agent-rollback-v2'; sessionId: string; turnId: string };

const PATCH_TYPES = new Set<string>([
  'agent-session-snapshot-v2',
  'agent-live-state-updated-v2',
  'agent-turn-started-v2',
  'agent-item-started-v2',
  'agent-item-delta-v2',
  'agent-item-updated-v2',
  'agent-turn-completed-v2',
  'agent-error-v2',
]);

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
      return isRecord(value.session);
    case 'agent-live-state-updated-v2':
      return isRecord(value.live);
    case 'agent-turn-started-v2':
      return isTurn(value.turn);
    case 'agent-item-started-v2':
      return typeof value.turnId === 'string' && isItem(value.item);
    case 'agent-item-delta-v2':
      return (
        typeof value.turnId === 'string' &&
        typeof value.itemId === 'string' &&
        isRecord(value.delta)
      );
    case 'agent-item-updated-v2':
      return typeof value.turnId === 'string' && isItem(value.item);
    case 'agent-turn-completed-v2':
      return (
        typeof value.turnId === 'string' && typeof value.status === 'string'
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
        items: turn.items.map((item) =>
          item.id === patch.itemId ? appendItemDelta(item, patch.delta) : item
        ),
      }));
    case 'agent-item-updated-v2':
      return updateTurn(session, patch.turnId, (turn) => ({
        ...turn,
        items: turn.items.map(
          (item): AgentItemV2 =>
            item.id === patch.item.id
              ? ({ ...item, ...patch.item } as AgentItemV2)
              : item
        ),
      }));
    case 'agent-turn-completed-v2':
      return updateTurn(
        {
          ...session,
          live: {
            ...session.live,
            status: patch.status === 'failed' ? 'error' : 'idle',
            activeTurnId:
              session.live.activeTurnId === patch.turnId
                ? null
                : session.live.activeTurnId,
            error: patch.error ?? session.live.error,
          },
        },
        patch.turnId,
        (turn) => completeTurn(turn, patch)
      );
    case 'agent-error-v2':
      return {
        ...session,
        live: {
          ...session.live,
          status: 'error',
          error: patch.message,
        },
      };
  }
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

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);

  if (index === -1) {
    return [...items, item];
  }

  return [...items.slice(0, index), item, ...items.slice(index + 1)];
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
  delta: AgentItemDeltaPatchV2['delta']
): AgentItemV2 {
  let next: AgentItemV2 = item;

  next = appendStringField(next, delta, 'text');
  next = appendStringField(next, delta, 'output');
  next = appendStringField(next, delta, 'summary');
  next = appendStringField(next, delta, 'detail');
  next = appendStringField(next, delta, 'patch');
  next = appendStringField(next, delta, 'content');

  return next;
}

function appendStringField<K extends keyof AgentItemDeltaPatchV2['delta']>(
  item: AgentItemV2,
  delta: AgentItemDeltaPatchV2['delta'],
  key: K
): AgentItemV2 {
  const fragment = delta[key];
  const current = (item as unknown as Record<string, unknown>)[key];

  if (typeof fragment !== 'string' || typeof current !== 'string') {
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
    typeof value.inputMessageId === 'string' &&
    Array.isArray(value.items) &&
    typeof value.startedAt === 'string'
  );
}

function isItem(value: unknown): value is AgentItemV2 {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
