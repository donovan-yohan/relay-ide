import type {
  GlobalSessionId,
  NodeId,
  RepoIdentity,
  RepoInstanceId,
  WorktreeInstanceId,
} from '../../../shared/identity.js';
import type { SessionEnvelope } from '../../../shared/session-envelope.js';
import type { SessionDurabilityState } from '../../../shared/session-durability.js';
import type {
  RepoIdentityWarning,
  ResolvedRemoteIdentity,
} from '../../../shared/repo-identity.js';
import type {
  DisplayState,
  BackendDisplayState,
} from './state/display-state.js';
import type { ControlActor } from '../../../shared/control-state.js';
import type { HubNodeStatus } from '../../../shared/relay-node-protocol.js';
import type {
  WorkContext,
  WorkContextTabKind,
} from '../../../shared/work-context.js';
export type {
  AggregatedRepoInventoryGroup,
  AggregatedRepoInventoryResponse,
  RepoInventoryReport,
  RepoInventoryRepoInstance,
  RepoInventoryWorktreeInstance,
} from '../../../shared/repo-inventory.js';

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
export type TerminalActivityState =
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
  };
  eventSource: EventSourceType;
  availability?: {
    installed: boolean;
    path?: string;
    reason?: string;
  };
}

export interface CurrentActivity {
  tool: string;
  detail?: string;
}

export interface SessionTelemetry {
  /** Node-local session id. Kept for legacy single-node consumers. */
  sessionId: string;
  /** Node-local session id when a scoped event carries both local and global ids. */
  localSessionId?: string;
  /** Execution node that owns this telemetry sample. */
  nodeId?: NodeId;
  /** Node-scoped session id for collision-free telemetry keying. */
  globalSessionId?: GlobalSessionId;
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

export type RepoWebhookStatus = 'live' | 'manual' | 'limited' | 'error';

export interface Repo {
  path: string;
  name: string;
  isGitRepo: boolean;
  /** Derived from isGitRepo at projection time. 'repo' for git repos, 'directory' for non-git dirs. */
  kind?: 'repo' | 'directory';
  defaultBranch: string | null;
  currentBranch: string | null;
  /** Node-local checkout path. Kept beside path for backward-compatible local mode consumers. */
  localPath?: string;
  /** Execution node that owns this checkout path. Local mode uses DEFAULT_LOCAL_NODE_ID. */
  nodeId?: NodeId;
  /** Canonical logical repository identity, derived from remotes when possible. */
  repoIdentity?: RepoIdentity | null;
  /** Node-scoped checkout instance id. Do not use path alone for cross-node identity. */
  repoInstanceId?: RepoInstanceId;
  selectedRemote?: ResolvedRemoteIdentity | null;
  remotes?: ResolvedRemoteIdentity[];
  repoIdentityWarnings?: RepoIdentityWarning[];
  webhookStatus?: RepoWebhookStatus;
  webhookError?: string;
  lastWebhookEventAt?: string;
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
  type: 'terminal';
  mode?: 'pty' | undefined;
  repoName?: string;
  repoPath?: string;
  worktreePath?: string | null;
  cwd: string;
  branchName?: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  idle: boolean;
  /** Execution node that owns this local session id. */
  nodeId?: NodeId;
  /** Node-scoped session id for hub/federated routing. */
  globalSessionId?: GlobalSessionId;
  /** Node-scoped checkout instance id for repoPath. */
  repoInstanceId?: RepoInstanceId;
  /** Node-scoped worktree/cwd instance id when this session runs in a worktree. */
  worktreeInstanceId?: WorktreeInstanceId;
  status?: 'active' | 'disconnected' | undefined;
  /** #614: derived durability state. Optional for legacy summaries. */
  durability?: SessionDurabilityState | undefined;
  /** Derived terminal activity/attention state; never an agent identity. */
  activityState: TerminalActivityState;
  workspaceId?: string | undefined;
  additionalDirs?: string[] | undefined;
  currentActivity?: CurrentActivity | undefined;
  lastInterventionAt?: string | null;
  lastInterventionBy?: ControlActor | null;
  lastInterventionEventId?: string | null;
  dataQuality?: EventSourceType | undefined;
  /** Tracks whether permission-prompt is for approval or question — preserves needs-answer state across refresh */
  permissionType?: 'approval' | 'question';
  /** WorkContext linked to this session, when the backend can resolve one. */
  workContextId?: string;
  /** Typed intent/scope envelope. New server responses include this; old cached sessions may omit it. */
  sessionEnvelope?: SessionEnvelope | undefined;
}

export interface WorkContextSessionSummary {
  id: string;
  nodeId: NodeId;
  globalSessionId?: GlobalSessionId;
  tabKind: WorkContextTabKind;
  type?: SessionSummary['type'];
  mode?: SessionSummary['mode'];
  cwd: string;
  repoPath?: string;
  worktreePath?: string | null;
  repoName?: string;
  branchName?: string;
  displayName?: string;
  status?: SessionSummary['status'];
  durability?: SessionSummary['durability'];
  activityState?: SessionSummary['activityState'];
  currentActivity?: SessionSummary['currentActivity'];
  lastInterventionAt?: string | null;
  lastInterventionBy?: ControlActor | null;
  lastInterventionEventId?: string | null;
  lastActivity?: string;
  relationship: string;
  associatedAt: string;
  live: boolean;
}

export interface WorkContextNodeState {
  nodeId: NodeId;
  status: HubNodeStatus | 'unknown';
  displayName?: string;
  lastSeenAt?: string;
  kind?: 'local' | 'remote';
}

export interface WorkContextActiveGroup {
  id: string;
  context: WorkContext | null;
  node: WorkContextNodeState;
  sessions: WorkContextSessionSummary[];
  staleReadModel: boolean;
}

export interface WorktreeInfo {
  name: string;
  path: string;
  repoName: string;
  repoPath: string;
  displayName: string;
  lastActivity: string;
  branchName: string;
  nodeId?: NodeId;
  repoIdentity?: RepoIdentity | null;
  repoInstanceId?: RepoInstanceId;
  worktreeInstanceId?: WorktreeInstanceId;
}

export interface RepoInfo {
  name: string;
  path: string;
  root: string;
  defaultBranch?: string | null;
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
  terminalBackend?: 'relay-pty';
  defaultBranch?: string;
  remote?: string;
  branchPrefix?: string;
  promptFixConflicts?: string;
  nextMountainIndex?: number;
  /** Environment variable names that should receive per-worktree allocated ports. */
  portVariables?: string[];
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
  nodeId?: NodeId;
  repoIdentity?: RepoIdentity | null;
  repoInstanceId?: RepoInstanceId;
  worktreeInstanceId?: WorktreeInstanceId;
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

export type BranchDivergenceState =
  | 'ok'
  | 'not_git'
  | 'invalid_base'
  | 'missing_base'
  | 'detached'
  | 'unborn'
  | 'no_merge_base'
  | 'timeout'
  | 'git_error';

export type BranchBaseCandidateSource =
  | 'remoteDefault'
  | 'default'
  | 'upstream'
  | 'local'
  | 'remote';

export interface BranchBaseRef {
  ref: string;
  sha: string | null;
}

export interface BranchBaseCandidate extends BranchBaseRef {
  label: string;
  source: BranchBaseCandidateSource;
}

export interface BranchLineDelta {
  additions: number;
  deletions: number;
  fileCount: number;
}

export type DirtyFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface DirtyFileSummary {
  path: string;
  oldPath?: string;
  status: DirtyFileStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface DirtySummary {
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  files: DirtyFileSummary[];
  truncated: boolean;
}

export interface BranchDivergenceCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface BranchDivergenceSummary {
  repoPath: string;
  currentBranch: string | null;
  headSha: string | null;
  selectedBase: BranchBaseRef | null;
  baseCandidates: BranchBaseCandidate[];
  aheadCount: number;
  behindCount: number;
  lineDelta: BranchLineDelta;
  dirty: DirtySummary;
  commits: {
    ahead: BranchDivergenceCommit[];
    behind: BranchDivergenceCommit[];
  };
  state: BranchDivergenceState;
  error?: string;
  warnings: string[];
  generatedAt: string;
}

export interface FileContentResponse {
  content: string;
  binary?: boolean;
  truncated?: boolean;
  sizeBytes?: number;
  mtimeMs?: number;
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
