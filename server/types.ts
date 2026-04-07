import type { IPty } from 'node-pty';
import type { OutputParser } from './output-parsers/index.js';

export type AgentState =
  | 'initializing'
  | 'waiting-for-input'
  | 'processing'
  | 'permission-prompt'
  | 'error'
  | 'idle';
export type BackendDisplayState =
  | 'initializing'
  | 'running'
  | 'idle'
  | 'permission'
  | 'error';

export type SessionType = 'agent' | 'terminal';
export type AgentType = string;
export type BuiltinFrameworkId = 'claude' | 'codex' | 'opencode';
export type EventSourceType = 'hooks' | 'plugin' | 'parser' | 'timer';
export type ContinuePolicy = 'always' | 'never';
export type BranchLifecycleState = 'active' | 'stale' | 'merged';
export type SessionStatus = 'active' | 'disconnected';
export type SessionMode = 'pty';

// ── Agent Framework Registry ──

export interface AgentFramework {
  id: string;
  displayName: string;
  command: string;
  commandOverride?: string;
  continueArgs: string[];
  yoloArgs: string[];
  yoloEnv?: Record<string, string>;
  extraArgs?: string[];
  parserType: string;
  eventSource: EventSourceType;
  capabilities: {
    supportsHooks: boolean;
    supportsContinue: boolean;
    supportsYolo: boolean;
    supportsTelemetry: boolean;
  };
}

export const BUILTIN_FRAMEWORKS: Record<BuiltinFrameworkId, AgentFramework> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    continueArgs: ['--continue'],
    yoloArgs: ['--dangerously-skip-permissions'],
    parserType: 'claude',
    eventSource: 'hooks',
    capabilities: {
      supportsHooks: true,
      supportsContinue: true,
      supportsYolo: true,
      supportsTelemetry: true,
    },
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    command: 'codex',
    continueArgs: ['resume', '--last'],
    yoloArgs: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'],
    parserType: 'codex',
    eventSource: 'hooks',
    capabilities: {
      supportsHooks: true,
      supportsContinue: true,
      supportsYolo: true,
      supportsTelemetry: false,
    },
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    continueArgs: ['--continue'],
    yoloArgs: [],
    yoloEnv: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: {
          read: 'allow',
          edit: 'allow',
          bash: 'allow',
          glob: 'allow',
          grep: 'allow',
          list: 'allow',
          task: 'allow',
          webfetch: 'allow',
          websearch: 'allow',
          codesearch: 'allow',
          lsp: 'allow',
          skill: 'allow',
        },
      }),
    },
    parserType: 'opencode',
    eventSource: 'plugin',
    capabilities: {
      supportsHooks: false,
      supportsContinue: true,
      supportsYolo: true,
      supportsTelemetry: true,
    },
  },
};

export function resolveFramework(
  config: { frameworks?: Record<string, Partial<AgentFramework>> },
  frameworkId: string
): AgentFramework {
  const builtin = BUILTIN_FRAMEWORKS[frameworkId as BuiltinFrameworkId] as
    | AgentFramework
    | undefined;
  const override = config.frameworks?.[frameworkId];

  if (!builtin && !override) {
    throw new Error(
      `Unknown framework: "${frameworkId}". Register it in config.frameworks.`
    );
  }

  if (!builtin) {
    // fully custom framework from config — validate all required fields before returning
    const custom = override!;
    const validEventSources: EventSourceType[] = [
      'hooks',
      'plugin',
      'parser',
      'timer',
    ];
    if (
      !custom.id ||
      !custom.displayName ||
      !custom.command ||
      !Array.isArray(custom.continueArgs) ||
      !Array.isArray(custom.yoloArgs) ||
      !custom.parserType ||
      !custom.eventSource ||
      !validEventSources.includes(custom.eventSource) ||
      !custom.capabilities ||
      typeof custom.capabilities.supportsHooks !== 'boolean' ||
      typeof custom.capabilities.supportsContinue !== 'boolean' ||
      typeof custom.capabilities.supportsYolo !== 'boolean' ||
      typeof custom.capabilities.supportsTelemetry !== 'boolean'
    ) {
      throw new Error(
        `Custom framework "${frameworkId}" must define id, displayName, command, continueArgs, yoloArgs, parserType, eventSource, and complete capabilities.`
      );
    }
    return { ...custom } as AgentFramework;
  }

  if (!override) {
    return builtin;
  }

  // shallow merge at top level, deep merge for capabilities
  const { capabilities: overrideCaps, ...overrideRest } = override;
  return {
    ...builtin,
    ...overrideRest,
    capabilities: overrideCaps
      ? { ...builtin.capabilities, ...overrideCaps }
      : builtin.capabilities,
  };
}

// Deprecated aliases derived from BUILTIN_FRAMEWORKS for backward compatibility
export const AGENT_COMMANDS: Record<string, string> = Object.fromEntries(
  Object.values(BUILTIN_FRAMEWORKS).map((f) => [f.id, f.command])
);

export const AGENT_CONTINUE_ARGS: Record<string, string[]> = Object.fromEntries(
  Object.values(BUILTIN_FRAMEWORKS).map((f) => [f.id, f.continueArgs])
);

export const AGENT_YOLO_ARGS: Record<string, string[]> = Object.fromEntries(
  Object.values(BUILTIN_FRAMEWORKS).map((f) => [f.id, f.yoloArgs])
);

// Session types — discriminated union on `mode`
interface BaseSession {
  id: string;
  type: SessionType;
  agent: AgentType;
  mode: SessionMode;
  repoPath: string;
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
  workspaceId?: string;
  additionalDirs?: string[];
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
  _lastEmittedPermissionType?: 'approval' | 'question' | undefined;
  lastAttentionNotifiedAt?: number | undefined;
  currentActivity?: { tool: string; detail?: string } | undefined;
  yolo: boolean;
  /** Framework-specific args (replaces deprecated claudeArgs) */
  sessionArgs?: string[];
  /** @deprecated Use sessionArgs instead */
  claudeArgs: string[];
  continuePolicy: ContinuePolicy;
  /** Actual event source quality (hooks/plugin/parser/timer) */
  dataQuality?: EventSourceType;
}

export type Session = PtySession;

// Summary type for REST API responses (no internal handles)
export interface SessionSummary {
  id: string;
  type: SessionType;
  agent: AgentType;
  mode: SessionMode;
  repoPath: string;
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
  workspaceId?: string;
  additionalDirs?: string[];
  dataQuality?: EventSourceType;
}

export interface TelemetryData {
  sessionId: string;
  model: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  reasoningOutputTokens: number;
  contextPercent: number;
  contextWindowSize: number;
  costUsd: number | null;
  source: string;
  updatedAt: string;
}

export interface RateLimitWindow {
  name: string;
  usedPercent: number;
  resetsAt: string;
  windowMinutes?: number;
}

export interface AccountTelemetry {
  framework: string;
  rateLimits: RateLimitWindow[];
  planType?: string;
  updatedAt: string;
}

export interface WorktreeMetadata {
  worktreePath: string;
  displayName: string;
  lastActivity: string;
  branchName?: string;
}

export interface WorkspaceSettings {
  // Session defaults
  defaultFramework?: string; // canonical agent framework (v5+)
  frameworkOverrides?: Partial<AgentFramework>; // per-repo framework customization
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
  webhookId?: number; // GitHub webhook ID for deletion tracking
  webhookEnabled?: boolean; // Per-workspace webhook toggle
  webhookError?: string; // 'not-admin' | 'not-found' | null
}

export const MOUNTAIN_NAMES = [
  'everest',
  'kilimanjaro',
  'denali',
  'fuji',
  'rainier',
  'matterhorn',
  'elbrus',
  'aconcagua',
  'kangchenjunga',
  'lhotse',
  'makalu',
  'cho-oyu',
  'dhaulagiri',
  'manaslu',
  'annapurna',
  'nanga-parbat',
  'olympus',
  'mont-blanc',
  'k2',
  'vinson',
  'erebus',
  'logan',
  'puncak-jaya',
  'wilhelm',
  'cook',
  'ararat',
  'etna',
  'shasta',
  'whitney',
  'hood',
] as const;

export interface Config {
  host: string;
  port: number;
  cookieTTL: string;
  repos: string[];
  claudeArgs: string[];
  defaultFramework: string; // canonical agent framework, defaults to 'claude'
  frameworks?: Record<string, Partial<AgentFramework>>; // user-customized frameworks
  defaultContinue: boolean;
  defaultYolo: boolean;
  launchInTmux: boolean;
  defaultNotifications: boolean;
  claudeFullscreen: boolean;
  pinHash?: string | undefined;
  rootDirs?: string[] | undefined;
  workspaces?: Workspace[] | undefined;
  repoSettings?: Record<string, WorkspaceSettings> | undefined;
  vapidPublicKey?: string | undefined;
  vapidPrivateKey?: string | undefined;
  debugLog?: boolean | undefined;
  forceOutputParser?: boolean | undefined;
  integrations?:
    | {
        jira?: {
          projectKey?: string;
          statusMappings?: Partial<Record<TransitionState, string>>;
        };
      }
    | undefined;
  automations?: AutomationSettings | undefined;
  filterPresets?: FilterPreset[] | undefined;
  github?:
    | {
        accessToken?: string;
        username?: string;
        webhookSecret?: string;
        smeeUrl?: string;
        autoProvision?: boolean; // defaults to false
        backfillOffered?: boolean; // tracks if backfill prompt was shown
      }
    | undefined;
  updateChannel?: 'stable' | 'nightly' | undefined;
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

export type TransitionState =
  | 'none'
  | 'in-progress'
  | 'code-review'
  | 'ready-for-qa';

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

export interface Repo {
  path: string;
  name: string;
  isGitRepo: boolean;
  defaultBranch: string | null;
  currentBranch: string | null;
}

export type RepoRole =
  | 'frontend'
  | 'backend'
  | 'lib'
  | 'infra'
  | 'docs'
  | 'other';

export interface WorkspaceTemplate {
  repoRoles?: Record<string, RepoRole>;
  defaultAgent?: string;
  customPrompt?: string;
  claudeArgs?: string[];
}

export interface WorkspaceLevelSettings {
  defaultFramework?: string; // canonical agent framework (v5+)
  defaultContinue?: boolean;
  defaultYolo?: boolean;
  launchInTmux?: boolean;
  claudeArgs?: string[];
  promptCodeReview?: string;
  promptCreatePr?: string;
  promptBranchRename?: string;
  promptGeneral?: string;
  promptFixConflicts?: string;
  promptStartWork?: string;
}

export interface Workspace {
  id: string;
  name: string;
  repos: string[];
  themeColor?: string;
  order: number;
  template?: WorkspaceTemplate;
  settings?: WorkspaceLevelSettings;
}

export type Platform = 'macos' | 'linux';

export interface InstallOpts {
  configPath?: string | undefined;
  port?: string | undefined;
  host?: string | undefined;
}

// Changed file status from git status/diff
export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export interface ChangedFile {
  path: string;
  oldPath?: string; // only for renames
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  directory: string; // parent directory for DataTable groupBy
  summary?: string; // rule-based summary (v1)
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

// ── Session Analytics ──

export interface SessionEvent {
  session_id: string;
  repo_path?: string;
  event_type: string;
  event_data?: Record<string, unknown>;
  timestamp: string;
}

export interface SessionRollup {
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
}

export interface RateLimitSnapshot {
  fiveHourPercent: number;
  fiveHourResetsAt: string;
  sevenDayPercent: number;
  sevenDayResetsAt: string;
  timestamp: string;
}
