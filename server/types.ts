import type { IPty } from 'node-pty';
import type {
  GlobalSessionId,
  LocalSessionId,
  NodeId,
  RepoIdentity,
  RepoInstanceId,
  WorktreeInstanceId,
} from '../shared/identity.js';
import type {
  RepoIdentityWarning,
  ResolvedRemoteIdentity,
} from '../shared/repo-identity.js';
import type { OutputParser } from './output-parsers/index.js';
import type { ProtocolAdapter } from './protocol-adapter.js';
import type { ProtocolAdapterV2 } from './protocol-adapter-v2.js';
import type { ChatEvent } from '../shared/chat-events.js';
import type {
  AgentPatchV2,
  AgentSessionV2,
} from '../shared/agent-chat-protocol-v2.js';
import type {
  ControlActor,
  ControlFreshness,
  ControlMode,
  ControlStateSummary,
} from '../shared/control-state.js';
import type { SessionEnvelope } from '../shared/session-envelope.js';

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
export type BuiltinFrameworkId = 'claude' | 'codex' | 'opencode' | 'hermes';
export type EventSourceType = 'hooks' | 'plugin' | 'parser' | 'timer';
export type ContinuePolicy = 'always' | 'never';
export type BranchLifecycleState = 'active' | 'stale' | 'merged';
export type SessionStatus = 'active' | 'disconnected';
export type SessionMode = 'pty' | 'web';

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
    supportsAttachedRuntime: boolean;
    supportsWebSessions?: boolean;
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
      supportsAttachedRuntime: true,
      // De-advertised pending end-to-end verification of the Claude web
      // session protocol. See issue #300. The ClaudeProtocolAdapter exists
      // in server/protocol-adapters/claude-adapter.ts but has not been
      // verified for real assistant text streaming and round-trip behavior.
      // Re-enable only after: real protocol verification (no synthetic
      // event sources), assistant text streaming, and an end-to-end
      // round-trip test all pass.
      supportsWebSessions: false,
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
      supportsAttachedRuntime: false,
      // De-advertised pending full web-session implementation. See issue #301:
      // the Codex protocol adapter maps lifecycle/tool events but does not
      // stream assistant text deltas as `chat:text-delta`, so the web mode
      // appeared installed but produced no chat output. Flip back to true
      // only after (1) assistant text streaming is mapped end-to-end and
      // (2) an e2e round-trip test covers prompt → text-delta → completion.
      supportsWebSessions: false,
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
      supportsAttachedRuntime: true,
      supportsWebSessions: true,
    },
  },
  hermes: {
    id: 'hermes',
    displayName: 'Hermes',
    command: 'hermes',
    continueArgs: ['--continue'],
    yoloArgs: ['--yolo'],
    parserType: 'hermes',
    eventSource: 'parser',
    capabilities: {
      supportsHooks: false,
      supportsContinue: true,
      supportsYolo: true,
      supportsTelemetry: true,
      supportsAttachedRuntime: true,
      supportsWebSessions: true,
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
      typeof custom.capabilities.supportsTelemetry !== 'boolean' ||
      typeof custom.capabilities.supportsAttachedRuntime !== 'boolean'
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

// Lookup maps derived from BUILTIN_FRAMEWORKS — consumed by sessions, pty-handler,
// workspace-groups, and index.ts to resolve per-agent commands and args.
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
  /** Execution node that owns this live session. */
  nodeId?: NodeId;
  type: SessionType;
  agent: AgentType;
  mode: SessionMode;
  /**
   * Filesystem path of the repo this session is bound to. Omitted for
   * node-only/raw-shell sessions that are not associated with a checkout.
   */
  repoPath?: string;
  /**
   * Worktree path within the repo. `null` = repo-root session;
   * `undefined` = no repo binding at all.
   */
  worktreePath?: string | null;
  cwd: string;
  /** Human-readable repo name for repo-bound sessions. */
  repoName?: string;
  /** Branch name for repo-bound sessions. */
  branchName?: string;
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
  // Shared mutable state (used by both PTY and web sessions)
  currentActivity?: { tool: string; detail?: string } | undefined;
  /** Product control state; separate from transport `mode` (`pty` | `web`). */
  controlState?: ControlStateSummary | undefined;
  /** Typed intent/scope envelope for future revoke/expiry enforcement hooks. */
  sessionEnvelope?: SessionEnvelope | undefined;
  _lastEmittedBackendState?: BackendDisplayState | undefined;
  _lastEmittedPermissionType?: 'approval' | 'question' | undefined;
  lastAttentionNotifiedAt?: number | undefined;
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
  preserveRuntimeFilesOnExit?: boolean;
  _lastHookTime?: number | undefined;
  yolo: boolean;
  /** Framework-specific args (replaces deprecated claudeArgs) */
  sessionArgs?: string[];
  /** @deprecated Use sessionArgs instead */
  claudeArgs: string[];
  continuePolicy: ContinuePolicy;
  /** Actual event source quality (hooks/plugin/parser/timer) */
  dataQuality?: EventSourceType;
}

export interface WebSession extends BaseSession {
  mode: 'web';
  /** Active protocol adapter for this agent backend */
  adapter: ProtocolAdapter;
  /** Native v2 protocol adapter for web-chat sessions. */
  adapterV2: ProtocolAdapterV2;
  /** Canonical v2 web-chat state. */
  agentSessionV2: AgentSessionV2;
  /** Bounded v2 patch buffer for reconnect catch-up. */
  agentPatchesV2: AgentPatchV2[];
  /** Current web-chat protocol version. */
  protocolVersion: 2;
  /**
   * Agent type identifier (matches AgentFramework.id, e.g. 'codex' | 'opencode' | 'claude').
   * Mirrors adapter.agentType — kept as a plain field so session summaries and logs
   * can reference it without dereferencing the adapter object.
   */
  adapterType: string;
  /**
   * In-memory event buffer for replay on reconnect.
   * Cap: 1000 events, FIFO eviction (approval events never dropped).
   * TODO(PR#213): Enforce the cap when adapters start pushing events — use a bounded
   * buffer helper rather than raw array push to guarantee the eviction policy.
   */
  messages: ChatEvent[];
  /** Currently active turn ID, or null when idle */
  currentTurnId: string | null;
  /** Who owns the agent runtime process */
  runtimeOwnership: 'spawned' | 'attached';
  /** Token for authenticating inbound hook callbacks */
  hookToken: string;
  /** Whether hook infrastructure is currently active */
  hooksActive: boolean;
}

export type Session = PtySession | WebSession;

// Summary type for REST API responses (no internal handles)
export interface SessionSummary {
  id: string;
  type: SessionType;
  agent: AgentType;
  mode: SessionMode;
  /**
   * Filesystem path of the repo this session is bound to. Optional so
   * non-repo (node-only / raw-shell) routed sessions can flow through
   * the same envelope without a synthetic placeholder. Repo-bound
   * consumers must narrow before use. Local single-node session
   * creation paths continue to set this for repo-bound sessions.
   */
  repoPath?: string;
  /**
   * Worktree path within the repo. `null` = session runs at the repo
   * root (not in a worktree). `undefined` = session is not repo-bound at
   * all.
   */
  worktreePath?: string | null;
  cwd: string;
  /**
   * Human-readable repo name for repo-bound sessions. Omitted for non-repo
   * sessions that have no checkout binding.
   */
  repoName?: string;
  /**
   * Branch name for repo-bound sessions. Omitted for non-repo sessions.
   */
  branchName?: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  idle: boolean;
  customCommand: string | null;
  /** Execution node that owns this local session id. */
  nodeId?: NodeId;
  /** Node-scoped session id for hub/federated routing. */
  globalSessionId?: GlobalSessionId;
  /** Node-scoped checkout instance id for repoPath. */
  repoInstanceId?: RepoInstanceId;
  /** Node-scoped worktree/cwd instance id when this session runs in a worktree. */
  worktreeInstanceId?: WorktreeInstanceId;
  /** PTY sessions only */
  useTmux?: boolean;
  /** PTY sessions only */
  tmuxSessionName?: string;
  status: SessionStatus;
  needsBranchRename: boolean;
  agentState: AgentState;
  currentActivity?: { tool: string; detail?: string } | undefined;
  /** Product control state; separate from transport `mode` (`pty` | `web`). */
  controlMode?: ControlMode;
  activeActors?: ControlActor[];
  activeWorker?: ControlActor;
  lastInterventionAt?: string | null;
  lastInterventionBy?: ControlActor | null;
  lastInterventionEventId?: string | null;
  controlFreshness?: ControlFreshness;
  controlReason?: string;
  workspaceId?: string;
  additionalDirs?: string[];
  /** PTY sessions only — tracks data quality of telemetry source */
  dataQuality?: EventSourceType;
  /** Tracks whether permission-prompt is for approval or question — preserves needs-answer state across refresh */
  permissionType?: 'approval' | 'question';
  /** WorkContext linked to this session, when the create/list surface can resolve one. */
  workContextId?: string;
  /** Typed intent/scope envelope. Present on new responses; legacy callers should normalize when absent. */
  sessionEnvelope?: SessionEnvelope | undefined;
}

export interface TelemetryData {
  /** Node-local session id. Kept for legacy single-node consumers. */
  sessionId: string;
  /** Node-local session id when a scoped payload carries both local and global ids. */
  localSessionId?: LocalSessionId;
  /** Execution node that owns this telemetry sample. */
  nodeId?: NodeId;
  /** Node-scoped session id for collision-free telemetry keying. */
  globalSessionId?: GlobalSessionId;
  model: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  reasoningOutputTokens: number;
  contextPercent: number;
  contextWindowSize: number;
  costUsd: number | null;
  source: 'statusLine' | 'jsonl' | (string & {});
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
  webhookError?: string; // 'not-admin' | 'not-found' | other setup failure code

  /** Environment variable names that should receive per-worktree allocated ports. */
  portVariables?: string[];
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
  maxPtySessions: number;
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
  /**
   * Per-session scrollback cap in bytes. Default: 256 KB.
   * Config-file-only for this release; no settings UI surface yet.
   */
  maxScrollbackPerSessionBytes?: number | undefined;
  /**
   * Global scrollback cap across all sessions in bytes. Default: 4 MB.
   * When exceeded, oldest scrollback from non-active sessions is trimmed first.
   * Config-file-only for this release; no settings UI surface yet.
   */
  maxScrollbackGlobalBytes?: number | undefined;
  integrations?:
    | {
        jira?: {
          projectKey?: string;
          statusMappings?: Partial<Record<TransitionState, string>>;
        };
      }
    | undefined;
  automations?: AutomationSettings | undefined;
  control?: ControlSettings | undefined;
  credentialRotation?: CredentialRotationSettings | undefined;
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

export interface ControlSettings {
  interventionDebounceMs?: number;
  coDrivenAutoRevertMs?: number;
}

export interface CredentialRotationSettings {
  // Age threshold for the active credential before the scheduler rotates it.
  // Omitted or non-positive disables scheduled rotation entirely.
  intervalMs?: number;
  // Cadence at which the scheduler scans paired nodes. Defaults to 60_000.
  checkIntervalMs?: number;
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

export type RepoWebhookStatus = 'live' | 'manual' | 'limited' | 'error';
export type WebhookStatus = RepoWebhookStatus;

export interface Repo {
  path: string;
  name: string;
  isGitRepo: boolean;
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

// ── Session Analytics ──

export type SessionEventCategory = 'repo' | 'worktree' | 'free';

export interface SessionEvent {
  session_id: string;
  node_id?: string;
  repo_path?: string;
  worktree_path?: string | null;
  branch_name?: string;
  session_category?: SessionEventCategory;
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
  windows: RateLimitWindow[];
  timestamp: string;
  /** @deprecated Use `windows` instead. */
  fiveHourPercent?: number;
  /** @deprecated Use `windows` instead. */
  sevenDayPercent?: number;
  /** @deprecated Use `windows` instead. */
  fiveHourResetsAt?: string;
  /** @deprecated Use `windows` instead. */
  sevenDayResetsAt?: string;
}
