import type {
  DisplayState,
  BackendDisplayState,
} from './state/display-state.js';

export type PrDotStatus =
  | 'draft'
  | 'open'
  | 'approved'
  | 'changes-requested'
  | 'review-requested'
  | 'merged'
  | 'closed'
  | 'unknown';

export type AgentType = string;
export type AgentState =
  | 'initializing'
  | 'waiting-for-input'
  | 'processing'
  | 'permission-prompt'
  | 'error'
  | 'idle';

export type EventSourceType = 'hooks' | 'plugin' | 'parser' | 'timer';

export interface FrameworkInfo {
  id: string;
  displayName: string;
  command: string;
  capabilities: {
    supportsContinue: boolean;
    supportsYolo: boolean;
    supportsHooks: boolean;
    supportsTelemetry: boolean;
    supportsWebSessions?: boolean;
  };
  eventSource: EventSourceType;
}

export interface CurrentActivity {
  tool: string;
  detail?: string;
}

export interface SessionTelemetry {
  sessionId: string;
  model: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  contextPercent: number;
  contextWindowSize: number;
  costUsd: number | null;
  turnCount: number;
  subagentCount: number;
  source: 'statusLine' | 'jsonl' | (string & {});
  updatedAt: string;
}

export type TelemetryData = SessionTelemetry;

export interface RateLimitWindow {
  name: string;
  usedPercent: number;
  resetsAt: string;
  windowMinutes?: number;
}

export interface AccountTelemetry {
  framework: string;
  rateLimits: RateLimitWindow[];
  planType?: string | undefined;
  updatedAt: string;
}

export interface Repo {
  path: string;
  name: string;
  isGitRepo: boolean;
  defaultBranch: string | null;
  currentBranch: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  repos: string[];
  themeColor?: string;
  order: number;
}

export interface SessionSummary {
  id: string;
  type: 'agent' | 'terminal';
  agent: AgentType;
  mode?: 'pty' | 'web' | undefined;
  repoName: string;
  repoPath: string;
  worktreePath: string | null;
  cwd: string;
  branchName: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  idle: boolean;
  useTmux?: boolean | undefined;
  status?: 'active' | 'disconnected' | undefined;
  agentState?: AgentState | undefined;
  workspaceId?: string | undefined;
  additionalDirs?: string[] | undefined;
  currentActivity?: CurrentActivity | undefined;
  dataQuality?: EventSourceType | undefined;
  /** Tracks whether permission-prompt is for approval or question — preserves needs-answer state across refresh */
  permissionType?: 'approval' | 'question';
}

export interface WorktreeInfo {
  name: string;
  path: string;
  repoName: string;
  repoPath: string;
  displayName: string;
  lastActivity: string;
  branchName: string;
}

export interface RepoInfo {
  name: string;
  path: string;
  root: string;
  defaultBranch?: string | null;
}

export interface OpenSessionOptions {
  yolo?: boolean;
  branchName?: string;
  agent?: AgentType;
  claudeArgs?: string;
  useTmux?: boolean;
}

export interface SessionMeta {
  prNumber: number | null;
  additions: number;
  deletions: number;
  fetchedAt: string;
}

export interface GitStatus {
  prState: 'open' | 'merged' | 'closed' | null;
  additions: number;
  deletions: number;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  author: string;
  role: 'author' | 'reviewer';
  updatedAt: string;
  additions: number;
  deletions: number;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  ciStatus: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | null;
  isDraft: boolean;
  repoName?: string;
  repoPath?: string;
}

export interface PullRequestsResponse {
  prs: PullRequest[];
  error?: string | undefined;
}

/** Alias for PullRequestsResponse — used by OrgDashboard API responses. */
export type OrgPrsResponse = PullRequestsResponse;

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  createdAt: string;
  updatedAt: string;
  repoName: string;
  repoPath: string;
}

export interface GitHubIssuesResponse {
  issues: GitHubIssue[];
  error?: string | undefined;
}

export interface JiraIssue {
  key: string;
  title: string;
  url: string;
  status: string;
  priority: string | null;
  sprint: string | null;
  storyPoints: number | null;
  assignee: string | null;
  updatedAt: string;
  projectKey: string;
}

export interface JiraIssuesResponse {
  issues: JiraIssue[];
  error?: string | undefined;
}

export interface JiraStatus {
  id: string;
  name: string;
}

export type AnyIssue = GitHubIssue | JiraIssue;

export interface BranchInfo {
  name: string;
  isLocal: boolean;
  isRemote: boolean;
  checkedOutIn?: {
    worktreePath: string;
    worktreeName: string;
    sessionId?: string;
  };
}

export interface BranchLink {
  repoPath: string;
  repoName: string;
  branchName: string;
  hasActiveSession: boolean;
  source?: 'github' | 'jira' | undefined;
}

export type BranchLinksResponse = Record<string, BranchLink[]>;

export interface TicketContext {
  ticketId: string;
  title: string;
  description?: string;
  url: string;
  source: 'github' | 'jira';
  repoPath: string;
  repoName: string;
}

export interface ActivityEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  timeAgo: string;
  branches: string[];
}

export interface DashboardData {
  prs: PullRequest[];
  activity: ActivityEntry[];
  isGitRepo: boolean;
  defaultBranch: string | null;
  hasGhCli: boolean;
}

export interface CiStatus {
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision: string | null;
  additions: number;
  deletions: number;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  unresolvedCommentCount: number;
  updatedAt: string;
}

export interface WorkspaceSettings {
  defaultAgent?: AgentType;
  defaultContinue?: boolean;
  defaultYolo?: boolean;
  launchInTmux?: boolean;
  claudeArgs?: string[];
  defaultBranch?: string;
  remote?: string;
  branchPrefix?: string;
  promptCodeReview?: string;
  promptCreatePr?: string;
  promptBranchRename?: string;
  promptGeneral?: string;
  promptFixConflicts?: string;
  promptStartWork?: string;
  nextMountainIndex?: number;
  /** Environment variable names that should receive per-worktree allocated ports. */
  portVariables?: string[];
}

export interface AutomationSettings {
  autoCheckoutReviewRequests?: boolean;
  autoReviewOnCheckout?: boolean;
  pollIntervalMs?: number;
  lastPollTimestamp?: string;
}

export interface FilterPreset {
  name: string;
  builtIn?: boolean;
  filters: { status?: string[]; repo?: string[]; role?: string[] };
  sort: { column: string; direction: 'asc' | 'desc' };
}

export interface SidebarItem {
  id: string;
  kind: 'repo' | 'worktree';
  path: string;
  repoPath: string;
  displayName: string;
  branchName: string;
  lastActivity: string;
  displayState: DisplayState;
  lastKnownBackendState: BackendDisplayState | null;
  sessions: SessionSummary[];
  isUnread?: boolean;
  prStatus?: PrDotStatus;
}

// Changed files panel types
export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  directory: string;
  summary?: string;
}

export interface ChangedFilesResponse {
  files: ChangedFile[];
  aggregate: { additions: number; deletions: number; fileCount: number };
  error?: string;
}

export interface FileDiffResponse {
  diff: string;
  summary?: string;
  error?: string;
}

export type DiffSource = 'working' | 'staged' | 'branch';

// ── Session Analytics ──

export interface AnalyticsOverview {
  timeWindow: { start: string; end: string };
  totalSessions: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheRead: number;
  avgSessionDuration: number;
  avgHumanResponseLatency: number;
  avgAgentIdlePercent: number;
  totalRateLimitEncounters: number;
  byRepo: Array<{
    repoName: string;
    sessions: number;
    tokensIn: number;
    tokensOut: number;
    pctOfTotal: number;
  }>;
}

export interface AnalyticsSessionSummary {
  sessionId: string;
  repoName: string | null;
  repoPath: string | null;
  agentType: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  humanResponseLatencyAvg: number | null;
  agentIdlePercent: number | null;
  rateLimitEncounters: number;
  topTools: string[];
  recovered: boolean;
}

export interface AnalyticsSessionsResponse {
  sessions: AnalyticsSessionSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface AnalyticsSessionDetail {
  session: {
    sessionId: string;
    repoPath: string | null;
    repoName: string | null;
    agentType: string | null;
    model: string | null;
    startedAt: string;
    endedAt: string | null;
    durationSeconds: number | null;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheRead: number;
    totalCacheWrite: number;
    turnCount: number;
    subagentCount: number;
    humanResponseLatencyAvgMs: number | null;
    humanResponseLatencyP50Ms: number | null;
    humanResponseLatencyP95Ms: number | null;
    agentIdlePercent: number | null;
    rateLimitEncounters: number;
    toolUseCounts: Record<string, number> | null;
    recovered: boolean;
  };
  toolBreakdown: Record<string, { count: number }>;
  events: Array<{
    type: string;
    timestamp: string;
    data: Record<string, unknown>;
  }>;
  engagementBreakdown: {
    agentActiveTime: number;
    waitingForHumanTime: number;
    rateLimitTime: number;
    otherTime: number;
  };
}

export interface AnalyticsTrend {
  date: string;
  sessions: number;
  tokensIn: number;
  tokensOut: number;
  avgHumanLatency: number;
  avgAgentIdle: number;
  rateLimitEncounters: number;
}

export interface AnalyticsToolBreakdown {
  tools: Array<{
    name: string;
    totalUses: number;
    pctOfUses: number;
  }>;
}

export interface AnalyticsRateLimitHistory {
  snapshots: Array<{
    timestamp: string;
    fiveHourPercent: number;
    sevenDayPercent: number;
  }>;
}
