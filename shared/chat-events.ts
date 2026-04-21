// Canonical ChatEvent type system for the unified web chat interface.
// ChatEvent is a SIBLING to AgentEvent — not a subtype. AgentEvent handles
// session lifecycle; ChatEvent handles streaming content, tool calls, approvals,
// and protocol-specific semantics.
//
// All agent backends (Codex, OpenCode, Claude Code) map their native protocol
// messages into this canonical type system via ProtocolAdapters.

export type ChatEventSource = 'codex' | 'opencode' | 'claude' | 'mock';

export interface ChatEventBase {
  sessionId: string;
  timestamp: string;
  source: ChatEventSource;
}

// ── Content Events ────────────────────────────────────────────────────────────

/** Streaming text chunk from the agent (before message is complete) */
export interface TextDeltaEvent extends ChatEventBase {
  type: 'chat:text-delta';
  turnId: string;
  messageId: string;
  delta: string;
}

/** Full message completed streaming */
export interface MessageCompleteEvent extends ChatEventBase {
  type: 'chat:message-complete';
  turnId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
}

/** Thinking/reasoning trace from the agent */
export interface ReasoningEvent extends ChatEventBase {
  type: 'chat:reasoning';
  turnId: string;
  messageId: string;
  content: string;
  /** Whether this is a delta or the complete reasoning block */
  isDelta: boolean;
}

/** Context was compacted / summarized by the agent */
export interface CompactionEvent extends ChatEventBase {
  type: 'chat:compaction';
  /** Turn during which compaction occurred, if mid-turn */
  turnId?: string;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
}

// ── Tool Events ───────────────────────────────────────────────────────────────

export type ToolCallStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'declined';

/** A tool call started */
export interface ToolCallEvent extends ChatEventBase {
  type: 'chat:tool-call';
  turnId: string;
  toolCallId: string;
  toolName: string;
  /** Human-readable description of what the tool is doing (Conductor-style) */
  description: string;
  input: Record<string, unknown>;
  status: ToolCallStatus;
}

/** Streaming output from a running tool (e.g. bash stdout) */
export interface ToolOutputDeltaEvent extends ChatEventBase {
  type: 'chat:tool-output-delta';
  turnId: string;
  toolCallId: string;
  delta: string;
}

/** Tool call completed (success or error) */
export interface ToolResultEvent extends ChatEventBase {
  type: 'chat:tool-result';
  turnId: string;
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  output?: string;
  exitCode?: number;
  durationMs: number;
  error?: string;
}

// Subset of FileChangeStatus from types.ts — omits 'untracked' (agents don't emit untracked-file events)
export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** File was created, modified, or deleted by the agent */
export interface FileChangeEvent extends ChatEventBase {
  type: 'chat:file-change';
  turnId: string;
  toolCallId: string;
  path: string;
  oldPath?: string;
  kind: FileChangeKind;
  additions: number;
  deletions: number;
  /** Unified diff content */
  diff?: string;
}

// ── Approval Events ───────────────────────────────────────────────────────────

export type ApprovalKind = 'command' | 'file' | 'permission' | 'mcp';

/** Agent is requesting permission to perform an action */
export interface ApprovalRequestEvent extends ChatEventBase {
  type: 'chat:approval-request';
  turnId: string;
  requestId: string;
  kind: ApprovalKind;
  toolName: string;
  description: string;
  /** The command, file path, or resource being requested */
  target: string;
  /** Additional context (e.g. file contents, command arguments) */
  detail?: string;
  /** Auto-deny timeout in milliseconds (default: 300000 / 5min) */
  timeoutMs?: number;
}

/** User's decision on an approval request */
export interface ApprovalResponseEvent extends ChatEventBase {
  type: 'chat:approval-response';
  turnId: string;
  requestId: string;
  decision: 'allow' | 'allow-always' | 'deny';
  respondedBy: 'user' | 'timeout';
}

export interface InputField {
  id: string;
  label: string;
  type: 'text' | 'select' | 'multiselect' | 'confirm';
  options?: string[];
  defaultValue?: string | string[];
}

/** Agent is asking the user a question (structured form) */
export interface InputRequestEvent extends ChatEventBase {
  type: 'chat:input-request';
  turnId: string;
  requestId: string;
  question: string;
  fields: InputField[];
}

/** User's answers to an agent question */
export interface InputResponseEvent extends ChatEventBase {
  type: 'chat:input-response';
  turnId: string;
  requestId: string;
  answers: Record<string, string[]>;
}

// ── Lifecycle Events ──────────────────────────────────────────────────────────

/** Web session was created and agent is ready */
export interface SessionStartedEvent extends ChatEventBase {
  type: 'chat:session-started';
  sessionId: string;
  agentType: string;
  model?: string;
  /** Available slash commands from the agent */
  availableCommands?: Array<{ name: string; description: string }>;
}

export type SessionStatusKind =
  | 'idle'
  | 'active'
  | 'error'
  | 'retry'
  | 'disconnected';
export type WaitingOn = 'user-input' | 'approval' | 'tool' | 'network';

/** Agent session status changed */
export interface SessionStatusEvent extends ChatEventBase {
  type: 'chat:session-status';
  status: SessionStatusKind;
  waitingOn?: WaitingOn;
  error?: string;
}

/** A new turn started (user sent a message) */
export interface TurnStartedEvent extends ChatEventBase {
  type: 'chat:turn-started';
  turnId: string;
  /** Index of this turn in the conversation (0-based) */
  turnIndex: number;
}

export type TurnCompletionReason =
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'error';

/** A turn finished */
export interface TurnCompletedEvent extends ChatEventBase {
  type: 'chat:turn-completed';
  turnId: string;
  reason: TurnCompletionReason;
  durationMs: number;
  toolCallCount: number;
  messageCount: number;
}

export type ErrorKind =
  | 'network'
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'protocol'
  | 'unknown';

/** An error occurred in the session */
export interface ErrorEvent extends ChatEventBase {
  type: 'chat:error';
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  turnId?: string;
}

// ── Telemetry Events ──────────────────────────────────────────────────────────

/** Token usage and cost information */
export interface TelemetryEvent extends ChatEventBase {
  type: 'chat:telemetry';
  turnId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  contextPercent: number;
  contextWindowSize: number;
}

/** Rate limit status */
export interface RateLimitEvent extends ChatEventBase {
  type: 'chat:rate-limit';
  utilizationPercent: number;
  resetsAt: string;
  windowName: string;
}

// ── Union Type ────────────────────────────────────────────────────────────────

export type ChatEvent =
  | TextDeltaEvent
  | MessageCompleteEvent
  | ReasoningEvent
  | CompactionEvent
  | ToolCallEvent
  | ToolOutputDeltaEvent
  | ToolResultEvent
  | FileChangeEvent
  | ApprovalRequestEvent
  | ApprovalResponseEvent
  | InputRequestEvent
  | InputResponseEvent
  | SessionStartedEvent
  | SessionStatusEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | ErrorEvent
  | TelemetryEvent
  | RateLimitEvent;

export type ChatEventType = ChatEvent['type'];

// ── Type Guards ───────────────────────────────────────────────────────────────

const VALID_SOURCES: ReadonlySet<string> = new Set([
  'codex',
  'opencode',
  'claude',
  'mock',
]);

const VALID_TYPES: ReadonlySet<string> = new Set([
  'chat:text-delta',
  'chat:message-complete',
  'chat:reasoning',
  'chat:compaction',
  'chat:tool-call',
  'chat:tool-output-delta',
  'chat:tool-result',
  'chat:file-change',
  'chat:approval-request',
  'chat:approval-response',
  'chat:input-request',
  'chat:input-response',
  'chat:session-started',
  'chat:session-status',
  'chat:turn-started',
  'chat:turn-completed',
  'chat:error',
  'chat:telemetry',
  'chat:rate-limit',
]);

export function isChatEvent(event: unknown): event is ChatEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    typeof (event as ChatEventBase).sessionId === 'string' &&
    typeof (event as ChatEventBase).timestamp === 'string' &&
    typeof (event as { type?: unknown }).type === 'string' &&
    VALID_TYPES.has((event as { type: string }).type) &&
    VALID_SOURCES.has((event as ChatEventBase).source)
  );
}

export function isApprovalRequestEvent(
  e: ChatEvent
): e is ApprovalRequestEvent {
  return e.type === 'chat:approval-request';
}

export function isToolCallEvent(e: ChatEvent): e is ToolCallEvent {
  return e.type === 'chat:tool-call';
}

export function isFileChangeEvent(e: ChatEvent): e is FileChangeEvent {
  return e.type === 'chat:file-change';
}

export function isTelemetryEvent(e: ChatEvent): e is TelemetryEvent {
  return e.type === 'chat:telemetry';
}

export function isLifecycleEvent(
  e: ChatEvent
): e is
  | SessionStartedEvent
  | SessionStatusEvent
  | TurnStartedEvent
  | TurnCompletedEvent {
  return (
    e.type === 'chat:session-started' ||
    e.type === 'chat:session-status' ||
    e.type === 'chat:turn-started' ||
    e.type === 'chat:turn-completed'
  );
}
