export type AgentDetailCardKindV2 =
  | 'thought'
  | 'tool_call'
  | 'output'
  | 'diff'
  | 'message';

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
  content?: string;
  language?: string;
  path?: string;
  additions?: number;
  deletions?: number;
  sizeBytes?: number;
}

export type ChannelAsyncRunId = `chrun:${string}`;
export type ChannelMessageId = `chm:${string}`;

export type ChannelAsyncRunState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type ChannelAsyncRunTargetState =
  | Exclude<ChannelAsyncRunState, 'submitted'>
  | 'queued';

export type ChannelAsyncRunApprovalState = 'requested' | 'resolved' | 'expired';

export interface ChannelAsyncRunTarget {
  targetId: string;
  state: ChannelAsyncRunTargetState;
  reason?: string;
  approvalState?: ChannelAsyncRunApprovalState;
  updatedAt: string;
  completedAt?: string;
}

export interface ChannelAsyncRun {
  id: ChannelAsyncRunId;
  channelId: string;
  threadId: ChannelMessageId | null;
  requestMessageId: ChannelMessageId;
  requesterId: string;
  state: ChannelAsyncRunState;
  reason?: string;
  targets: ChannelAsyncRunTarget[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ChannelAgentDetail {
  itemId: string;
  card: AgentDetailCardV2;
}

export interface ChannelMessageSource {
  runtimeId: string;
  turnId?: string;
  itemId?: string;
}

export interface ChannelMessage {
  schemaVersion?: number;
  id: string;
  channelId: string;
  seq?: number;
  kind: 'message' | 'system';
  status: 'streaming' | 'complete' | 'truncated' | 'interrupted' | 'failed';
  sender: {
    kind: 'human' | 'agent' | 'system';
    id: string;
    displayName?: string;
    providerId?: string;
    runtimeId?: string;
  };
  body: {
    text: string;
    format?: 'markdown' | 'text';
  };
  threadId?: string | null;
  parentMessageId?: string | null;
  source?: ChannelMessageSource;
  agentDetail?: ChannelAgentDetail;
  asyncRun?: {
    runId: ChannelAsyncRunId;
    targetId: string;
  };
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface AgentRunMetrics {
  durationMs: number;
  durationLabel: string;
  toolCallCount: number;
  filesTouchedCount: number;
  filesTouched: string[];
  pendingApproval: boolean;
  status: ChannelAsyncRunState | 'completed' | 'working' | 'failed';
}

export interface AgentRunSummary {
  runId: string;
  channelId: string;
  agentId: string;
  agentPubkey: string;
  agentName: string;
  createdAt: string;
  completedAt?: string;
  status: string;
  metrics: AgentRunMetrics;
  requestSnippet?: string;
  responseSnippet?: string;
}

export interface AgentRunRecord {
  runId: string;
  channelId: string;
  agentId: string;
  agentPubkey: string;
  agentName: string;
  createdAt: string;
  completedAt?: string;
  status: string;
  run?: ChannelAsyncRun;
  requestMessage?: ChannelMessage;
  principalMessage?: ChannelMessage;
  messages: ChannelMessage[];
  metrics: AgentRunMetrics;
}

export type ReasoningTerminalState =
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'truncated';
