import type { IPty } from 'node-pty';
import type { OutputParser } from './output-parsers/index.js';

export type AgentState = 'initializing' | 'waiting-for-input' | 'processing' | 'permission-prompt' | 'error' | 'idle';
export type BackendDisplayState = 'initializing' | 'running' | 'idle' | 'permission';

export type SessionType = 'agent' | 'terminal';
export type AgentType = 'claude' | 'codex';
export type ContinuePolicy = 'always' | 'never';
export type SessionStatus = 'active' | 'disconnected';
export type SessionMode = 'pty';

// Agent command records
export const AGENT_COMMANDS: Record<AgentType, string> = {
  claude: 'claude',
  codex: 'codex',
};

export const AGENT_CONTINUE_ARGS: Record<AgentType, string[]> = {
  claude: ['--continue'],
  codex: ['resume', '--last'],
};

export const AGENT_YOLO_ARGS: Record<AgentType, string[]> = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--full-auto'],
};

// Session types — discriminated union on `mode`
interface BaseSession {
  id: string;
  type: SessionType;
  agent: AgentType;
  mode: SessionMode;
  workspacePath: string;
  worktreePath: string | null;
  cwd: string;
  repoName: string;
  branchName: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  idle: boolean;
  customCommand: string | null;
  status: SessionStatus;
  needsBranchRename: boolean;
  agentState: AgentState;
}

export interface PtySession extends BaseSession {
  mode: 'pty';
  pty: IPty;
  scrollback: string[];
  useTmux: boolean;
  tmuxSessionName: string;
  onPtyReplacedCallbacks: Array<(newPty: IPty) => void>;
  restored: boolean;
  branchRenamePrompt?: string;
  initialPrompt?: string | undefined;
  outputParser: OutputParser;
  hookToken: string;
  hooksActive: boolean;
  cleanedUp: boolean;
  _lastHookTime?: number | undefined;
  _lastEmittedBackendState?: BackendDisplayState | undefined;
  lastAttentionNotifiedAt?: number | undefined;
  currentActivity?: { tool: string; detail?: string } | undefined;
  yolo: boolean;
  claudeArgs: string[];
}

export type Session = PtySession;

// Summary type for REST API responses (no internal handles)
export interface SessionSummary {
  id: string;
  type: SessionType;
  agent: AgentType;
  mode: SessionMode;
  workspacePath: string;
  worktreePath: string | null;
  cwd: string;
  repoName: string;
  branchName: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  idle: boolean;
  customCommand: string | null;
  useTmux: boolean;
  tmuxSessionName: string;
  status: SessionStatus;
  needsBranchRename: boolean;
  agentState: AgentState;
  currentActivity?: { tool: string; detail?: string } | undefined;
}

export interface WorktreeMetadata {
  worktreePath: string;
  displayName: string;
  lastActivity: string;
  branchName?: string;
}

export interface WorkspaceSettings {
  // Session defaults
  defaultAgent?: AgentType;
  defaultContinue?: boolean;
  defaultContinuePolicy?: ContinuePolicy;
  defaultYolo?: boolean;
  launchInTmux?: boolean;
  claudeArgs?: string[];

  // Git settings
  defaultBranch?: string;
  remote?: string;
  branchPrefix?: string;

  // Custom prompts (Conductor-style)
  promptCodeReview?: string;
  promptCreatePr?: string;
  promptBranchRename?: string;
  promptGeneral?: string;
  promptFixConflicts?: string;
  promptStartWork?: string;

  // Worktree naming — mountains theme
  nextMountainIndex?: number;

  // Webhook tracking
  webhookId?: number;         // GitHub webhook ID for deletion tracking
  webhookEnabled?: boolean;   // Per-workspace webhook toggle
  webhookError?: string;      // 'not-admin' | 'not-found' | null
}

export const MOUNTAIN_NAMES = [
  'everest', 'kilimanjaro', 'denali', 'fuji', 'rainier', 'matterhorn',
  'elbrus', 'aconcagua', 'kangchenjunga', 'lhotse', 'makalu', 'cho-oyu',
  'dhaulagiri', 'manaslu', 'annapurna', 'nanga-parbat', 'olympus',
  'mont-blanc', 'k2', 'vinson', 'erebus', 'logan', 'puncak-jaya',
  'wilhelm', 'cook', 'ararat', 'etna', 'shasta', 'whitney', 'hood',
] as const;

export interface Config {
  host: string;
  port: number;
  cookieTTL: string;
  repos: string[];
  claudeCommand: string;
  claudeArgs: string[];
  defaultAgent: AgentType;
  defaultContinue: boolean;
  defaultYolo: boolean;
  launchInTmux: boolean;
  defaultNotifications: boolean;
  pinHash?: string | undefined;
  rootDirs?: string[] | undefined;
  workspaces?: string[] | undefined;
  workspaceSettings?: Record<string, WorkspaceSettings> | undefined;
  vapidPublicKey?: string | undefined;
  vapidPrivateKey?: string | undefined;
  debugLog?: boolean | undefined;
  forceOutputParser?: boolean | undefined;
  workspaceGroups?: Record<string, string[]> | undefined;
  integrations?: {
    jira?: { projectKey?: string; statusMappings?: Partial<Record<TransitionState, string>> };
  } | undefined;
  automations?: AutomationSettings | undefined;
  filterPresets?: FilterPreset[] | undefined;
  github?: {
    accessToken?: string;
    username?: string;
    webhookSecret?: string;
    smeeUrl?: string;
    autoProvision?: boolean;    // defaults to false
    backfillOffered?: boolean;  // tracks if backfill prompt was shown
  } | undefined;
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

export interface ServicePaths {
  servicePath: string;
  logDir: string | null;
  label: string;
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
  repoName?: string | undefined;
  repoPath?: string | undefined;
}

export interface PullRequestsResponse {
  prs: PullRequest[];
  error?: string | undefined;
}

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

export type TransitionState = 'none' | 'in-progress' | 'code-review' | 'ready-for-qa';

export interface ActivityEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  timeAgo: string;
  branches: string[];
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

export interface DashboardData {
  prs: PullRequest[];
  activity: ActivityEntry[];
  isGitRepo: boolean;
  defaultBranch: string | null;
  hasGhCli: boolean;
}

export interface Workspace {
  path: string;
  name: string;
  isGitRepo: boolean;
  defaultBranch: string | null;
}

export type Platform = 'macos' | 'linux';

export interface InstallOpts {
  configPath?: string | undefined;
  port?: string | undefined;
  host?: string | undefined;
}
