import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import express from 'express';
import cookieParser from 'cookie-parser';
import { createHealthMonitor } from './health.js';
import { restoreSessionsAfterListen } from './startup-restore.js';

import {
  loadConfig,
  saveConfig,
  DEFAULTS,
  writeMeta,
  deleteMeta,
  ensureMetaDir,
  getConfigDir,
  defaultTerminalBackend,
  normalizeTerminalBackend,
  resolveSessionSettings,
} from './config.js';
import { resolveSourceLaunchConfigPath } from './runtime-state-paths.js';
import * as auth from './auth.js';
import * as sessions from './sessions.js';
import {
  serializeAll,
  restoreFromDisk,
  populateMetaCache,
} from './sessions.js';
import type { CreateResult } from './sessions.js';

import { setupWebSocket } from './ws.js';
import { createLocalRelayNode } from './local-node.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  parseGlobalSessionId,
} from '../shared/identity.js';
import {
  buildWorkspaceTopicSessionCreateBody,
  workspaceTopicSessionLinkPatch,
  type WorkspaceTopic,
} from '../shared/workspace-topics.js';
import {
  WorktreeWatcher,
  BranchWatcher,
  RefWatcher,
  GitWatcher,
  parseAllWorktrees,
} from './watcher.js';
import {
  deleteLocalWorktreeBranch,
  removeWorktreeFromDisk,
  validateWorktreeForDelete,
} from './worktree-cleanup.js';
import { isInstalled as serviceIsInstalled } from './service.js';
import {
  ingressSessionImage,
  parseSessionImagePayload,
  SessionImageIngressError,
} from './session-image-ingress.js';
import { createGitRouter } from './git-routes.js';
import { createGhRouter } from './gh-routes.js';
import * as push from './push.js';
import {
  initAnalytics,
  closeAnalytics,
  createAnalyticsRouter,
  createSessionAnalyticsRouter,
  flushEventBuffer,
  computeEngagementMetrics,
  upsertSessionRollup,
  getSessionRollup,
  startEventBatching,
  stopEventBatching,
  runRetentionCleanup,
  recoverOrphanedSessions,
  recordRateLimitSnapshot,
} from './analytics.js';
import {
  createWorkContextRouter,
  createUnavailableWorkContextStore,
  initWorkContextStore,
  type WorkContextStore,
} from './work-contexts.js';
import { initIaStore, type IaStore } from './ia-store.js';
import { runBootWorkspaceMigration } from './ia-workspace-migration.js';
import {
  initContextPacketStore,
  type ContextPacketStore,
} from './context-packets.js';
import {
  initAgentProfileStore,
  type AgentProfileStore,
} from './agent-profile-store.js';
import {
  initInterventionLog,
  closeInterventionLog,
} from './intervention-log.js';
import {
  createWorkspaceRouter,
  clearPrCache,
  clearFilesListCache,
  clearDashboardPrCache,
} from './workspaces.js';
import { clearCiStatusCache } from './gh.js';
import { createWorkspaceGroupsRouter } from './workspace-groups.js';
import { createWorkbenchLayoutRouter } from './workbench-layout.js';
import { createWorkbenchCustomBlocksRouter } from './workbench-custom-blocks.js';
import { createWorkbenchProposeBlockRouter } from './workbench-prompt-hooks.js';
import { createOrgDashboardRouter } from './org-dashboard.js';
import { createIntegrationGitHubRouter } from './integration-github.js';
import {
  createBranchLinkerRouter,
  invalidateBranchLinkerCache,
} from './branch-linker.js';
import { createHooksRouter } from './hooks.js';
import { createTicketTransitionsRouter } from './ticket-transitions.js';
import { createIntegrationJiraRouter } from './integration-jira.js';
import { startPolling, stopPolling } from './review-poller.js';
import { createGitHubAppRouter } from './github-app.js';
import { createWebhookRouter } from './webhooks.js';
import { createWebhookManagerRouter, reloadSmee } from './webhook-manager.js';
import { fetchPrsGraphQL } from './github-graphql.js';
import {
  createTelemetryRouter,
  startTelemetry,
  stopTelemetry,
  getTelemetryForSession,
  getAccountTelemetry,
} from './telemetry.js';
import {
  getFrameworkClientInfoWithRuntime,
  getFrameworkChannelAvailability,
  listConfiguredFrameworks,
} from './frameworks.js';
import {
  createOpenAiCompatibleCommandCenterIntentProvider,
  readCommandCenterIntentResolverConfig,
  resolveCommandCenterIntent,
} from './command-center-intent-resolver.js';
import {
  executeCommandCenterCommand,
  commandCenterActorCredentialScopeFor,
  type CommandCenterActorScopeValidationInput,
  type CommandCenterExecutionRequest,
  type CommandCenterReadOnlyHandler,
} from './command-center-executor.js';
import {
  COMMAND_CENTER_RESOLVER_CATALOG,
  validateCommandCenterArgs,
} from '../shared/command-center-resolver.js';
import type { CommandCenterExecutionConfirmationInput } from '../shared/command-center-execution.js';
import { getNodeManifest } from './node-manifest.js';
import { createHubNodeRegistry } from './hub-node-registry.js';
import {
  createCredentialRotationScheduler,
  type CredentialRotationScheduler,
} from './credential-rotation-scheduler.js';
import {
  createHubNodeRouter,
  errorStatus as relayNodeErrorStatus,
} from './hub-node-router.js';
import {
  appendPolicyAudit,
  evaluateHubPolicy,
  policyDecisionToRelayError,
} from './hub-policy-evaluator.js';
import { createCliGatewayEventsRouter } from './cli-gateway-events.js';
import { createCliGatewayEventBus } from './cli-gateway-event-bus.js';
import {
  createCliGatewaySettingsRouter,
  safeSettingsFromConfig,
  webhookStatusFromConfig,
} from './cli-gateway-settings.js';
import { createConfirmationChallengeStore } from './confirmation-challenges.js';
import {
  createHandoffRouter,
  type HandoffCapabilityContext,
} from './handoffs.js';
import { createHubNodeLinkManager, HubNodeLinkError } from './hub-node-link.js';
import {
  aggregateRemoteSessions,
  createRemoteSessionReadModelCache,
  isLocallyOwnedSession,
} from './hub-session-aggregator.js';
import { createRepoInventoryFeature } from './features/repo-inventory.js';
import { createRepoFeatureRouter } from './features/repo-router.js';
import { createIaWorkspaceRouter } from './features/ia-workspace-router.js';
import { createWorkspaceEvidenceRouter } from './workspace-evidence.js';
import {
  createWorkspaceSurfacesRouter,
  initWorkspaceSurfaceStore,
  type WorkspaceSurfaceStore,
} from './workspace-surfaces.js';
import {
  createWorkspaceTopicsRouter,
  initWorkspaceTopicStore,
  type WorkspaceTopicStore,
} from './workspace-topics.js';
import {
  createContextInboxRouter,
  type ContextInboxStore,
} from './features/context-inbox-router.js';
import { createContextInboxStoreAdapter } from './features/context-inbox-store-adapter.js';
import {
  createWorkContextArtifactRouter,
  DEFAULT_WORK_CONTEXT_ARTIFACT_EXPORT_MAX_BYTES,
  DEFAULT_WORK_CONTEXT_ARTIFACT_PUBLISH_MAX_BYTES,
  readWorkContextArtifactQueryWorkContextId,
} from './features/work-context-artifact-router.js';
import { createWorkflowRunRouter } from './features/workflow-run-router.js';
import { createAutomationRunRouter } from './features/automation-run-router.js';
import { createPrOverseerRouter } from './features/pr-overseer-router.js';
import { createAgentProfileRouter } from './agent-profile-router.js';
import { createWorkContextMessageRouter } from './features/work-context-message-router.js';
import {
  initChannelMessageStore,
  type ChannelMessageStore,
} from './channel-message-store.js';
import {
  initChannelAttachmentStore,
  type ChannelAttachmentStore,
} from './channel-attachments.js';
import { createChannelHub, type ChannelHub } from './channel-hub.js';
import { createChannelChatRouter } from './channel-chat-router.js';
import {
  createChannelAgentBinder,
  type ChannelAgentBinder,
  type MentionTarget,
} from './channel-agent-binder.js';
import {
  channelAgentRuntimes,
  configureChannelAgentRuntimes,
} from './channel-agent-runtime.js';
import { v2Adapters } from './protocol-adapters/index.js';
import {
  initWorkContextArtifactStore,
  type WorkContextArtifactStore,
} from './work-context-artifacts.js';
import {
  initWorkContextMessageStore,
  type WorkContextMessageStore,
} from './work-context-messages.js';
import {
  initWorkflowRunStore,
  type WorkflowRunStore,
} from './workflow-runs.js';
import {
  initAutomationRunStore,
  type AutomationRunStore,
} from './automation-runs.js';
import {
  resolveAutomationRunTargetLiveness,
  type AutomationRunLivenessResolver,
} from '../shared/automation-run.js';
import { initPrOverseerStore, type PrOverseerStore } from './pr-overseer.js';
import { createGhPrObserver } from './pr-overseer-github.js';
import {
  createAnchorFileFetcher,
  createAnchorContentFetcher,
} from './anchor-file-fetcher.js';
import {
  registerAnchorFileFetcher,
  type AnchorFileFetcher,
} from './anchor-resolution.js';
import {
  registerFileRangeContentFetcher,
  type FileRangeContentFetcher,
} from './context-adapters/file-range.js';
import { collectLocalRepoInventory } from './repo-inventory.js';
import type {
  AutomationSettings,
  Config,
  SessionSummary,
  TerminalBackend,
  TicketContext,
} from './types.js';
import type { SessionLane } from '../shared/session-lane.js';
import {
  EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES,
  type EventsSubscribeTopic,
  type RelayCliGatewayCommand,
  type RelayCliGatewayError,
} from '../shared/cli-gateway-contract.js';
import { validateAndSanitizeLocalGatewayCreateInput } from '../shared/cli-gateway-runtime.js';
import { semverLessThan, clampDimension } from './utils.js';
import {
  buildPtyCapacityResponse,
  countActivePtySessions,
  sessionCreateErrorResponse,
} from './session-capacity.js';
import {
  createBrowserContentRouter,
  generateScopedToken,
  validateScopedToken,
  cleanExpiredTokens,
} from './browser-content.js';
import { sessionEnvelopeRegistry } from './session-envelope-registry.js';
import { createLogger, initFileLogging } from './logger.js';
import {
  initializePersistenceStores,
  isAllowDegradedPersistence,
  persistenceFailureInjectorFromTestEnvironment,
  PersistenceStartupError,
  type PersistenceStartupState,
} from './persistence-startup.js';
import { createSecurityAuditLog } from './security-audit-log.js';
import {
  getDefaultAllocator,
  initializeDefaultAllocator,
  normalizePortVariables,
  removePortsFromEnvFile,
  upsertPortsInEnvFile,
} from './port-allocator.js';
import {
  createPortReconciliationWarningLogger,
  filterPortReconciliationRepoPaths,
} from './port-reconciliation.js';
import {
  capabilityDecisionFromRequest,
  capabilitiesDecisionFromRequest,
  capabilityError,
  clampInterventionLimit,
  CONTROL_KILL_CAPABILITY,
  CONTROL_READ_CAPABILITY,
  CONTROL_RENAME_CAPABILITY,
  CONTROL_SESSION_CAPABILITY,
  errorStatus as sessionControlErrorStatus,
  INTERVENTION_READ_CAPABILITY,
  toInterventionReadResponse,
} from './session-control-api.js';
import {
  handleSupervisorActionRequest,
  handleSupervisorSessionsRequest,
} from './supervisor-route-handlers.js';
import {
  attachAuthenticatedCliGatewayActorCredential,
  authenticatedCliGatewayActorCredential,
  bearerActorToken,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
  classifyCliGatewayCredentialLane,
  cliGatewayActorFailure,
  cliGatewayCorrelationId,
  cliGatewayActorCommandCapabilities,
  createCliGatewayActorRegistry,
  createCliGatewayHandshakeGrantRegistry,
  isCliGatewayActorTokenRequest,
  issueCliGatewayActorCredential,
  issueCliGatewayActorCredentialWithGrant,
  issuePersistentOrchestratorCliGatewayActorCredential,
  listCliGatewayActorCredentialsWithGrant,
  revokeCliGatewayActorCredentialWithGrant,
  rotateCliGatewayActorCredentialWithGrant,
  sendCliGatewayActorFailure,
  validateCliGatewayActorCredential,
  type CliGatewayActorCommand,
  type CliGatewayActorIssueInput,
  type CliGatewayActorReadCommand,
} from './cli-gateway-actor-auth.js';
import {
  RELAY_CAPABILITY_BITS,
  type RelayCapabilityBit,
} from '../shared/security-policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);
const logger = createLogger('index');
const TERMINAL_BACKEND_RELAY_PTY: TerminalBackend = 'relay-pty';

const localRelayNode = createLocalRelayNode();
const cliGatewayActorRegistry = createCliGatewayActorRegistry();
const cliGatewayHandshakeGrantRegistry =
  createCliGatewayHandshakeGrantRegistry();

// When run via the CLI bin or the dev runner, RELAY_IDE_CONFIG is set
// explicitly. When run directly from source (e.g. `node dist/server/index.js`),
// default the config — and therefore every runtime SQLite store beside it — to
// a per-checkout app-data directory instead of the repo root, so runtime state
// never spills into the checkout (#961). See server/runtime-state-paths.ts.
const sourceLaunchConfig = resolveSourceLaunchConfigPath(
  path.join(__dirname, '..', '..'),
  { fileName: 'config.json', namespace: 'source' }
);
const CONFIG_PATH =
  process.env.RELAY_IDE_CONFIG || sourceLaunchConfig.configPath;
if (!process.env.RELAY_IDE_CONFIG && sourceLaunchConfig.legacyConfigPath) {
  logger.warn(
    'Ignoring legacy repo-root config %s; runtime state now lives at %s. Move the old file there or set RELAY_IDE_CONFIG to keep using it (#961).',
    sourceLaunchConfig.legacyConfigPath,
    CONFIG_PATH
  );
}

const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lilheF3LelYSo0bu';

const VERSION_CACHE_TTL = 5 * 60 * 1000;
const SELF_HOST_DEV_PORT_VARIABLES = new Set([
  'RELAY_IDE_DEV_BACKEND_PORT',
  'RELAY_IDE_DEV_FRONTEND_PORT',
]);
const versionCache: Map<string, { latest: string; fetchedAt: number }> =
  new Map();

function getCurrentVersion(): string {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
  ];
  const pkgPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!pkgPath) return '0.0.0';
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}

async function getLatestVersion(
  channel: 'stable' | 'nightly' = 'stable'
): Promise<string | null> {
  const now = Date.now();
  const cached = versionCache.get(channel);
  if (cached && now - cached.fetchedAt < VERSION_CACHE_TTL) {
    return cached.latest;
  }
  try {
    const tag = channel === 'nightly' ? 'nightly' : 'latest';
    const res = await fetch(`https://registry.npmjs.org/relay-ide/${tag}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    if (!data.version) return null;
    versionCache.set(channel, { latest: data.version, fetchedAt: now });
    return data.version;
  } catch (_) {
    return null;
  }
}

const GIT_WORKTREE_LIST_ARGS = ['worktree', 'list', '--porcelain'] as const;

type RepoEntry = { name: string; path: string; root: string };

function scanReposInRoot(rootDir: string): RepoEntry[] {
  const repos: RepoEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_) {
    return repos;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const fullPath = path.join(rootDir, entry.name);
    const dotGit = path.join(fullPath, '.git');
    try {
      if (fs.statSync(dotGit).isDirectory()) {
        repos.push({ name: entry.name, path: fullPath, root: rootDir });
      }
    } catch (_) {
      // .git doesn't exist — not a repo
    }
  }
  return repos;
}

async function listNonMainWorktrees(
  repoPath: string
): Promise<ReturnType<typeof parseAllWorktrees>> {
  const { stdout } = await execFileAsync('git', [...GIT_WORKTREE_LIST_ARGS], {
    cwd: repoPath,
  });
  return parseAllWorktrees(stdout, repoPath).filter((wt) => !wt.isMain);
}

function getRepoPortVariables(config: Config, repoPath: string): string[] {
  return normalizePortVariables(config.repoSettings?.[repoPath]?.portVariables);
}

function getAllocatorOrNull(): ReturnType<typeof getDefaultAllocator> | null {
  try {
    return getDefaultAllocator();
  } catch {
    return null;
  }
}

const logPortReconciliationOnce = createPortReconciliationWarningLogger(logger);

function logPortReconciliationFailure(err: unknown): void {
  logger.warn(
    'Port reconciliation failed:',
    err instanceof Error ? err.message : err
  );
}

function setupProcessSignalHandlers(): void {
  process.on('SIGPIPE', () => {});
  process.on('SIGHUP', () => {});
}

async function initializePortAllocatorAndReconcile(
  configPath: string,
  getConfig: () => Config,
  reconcilePortsForAllRepos: (repoPaths: string[]) => Promise<void>
): Promise<void> {
  try {
    await initializeDefaultAllocator(
      configPath,
      logger,
      process.env.RELAY_IDE_SELF_HOST === '1'
        ? Array.from(SELF_HOST_DEV_PORT_VARIABLES)
        : undefined
    );
  } catch (err) {
    logger.warn(
      'Port allocator disabled: failed to initialize:',
      err instanceof Error ? err.message : err
    );
  }

  if (getAllocatorOrNull()) {
    await reconcilePortsForAllRepos(getConfig().repos ?? []);
  }
}

function scanAllRepos(rootDirs: string[]): RepoEntry[] {
  const repos: RepoEntry[] = [];
  for (const rootDir of rootDirs) {
    repos.push(...scanReposInRoot(rootDir));
  }
  return repos;
}

function parseTTL(ttl: string): number {
  if (typeof ttl !== 'string') return 24 * 60 * 60 * 1000;
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = parseInt(match[1]!, 10);
  switch (match[2]!) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

function promptPin(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Module-level helpers extracted to reduce main() / route handler complexity
// ---------------------------------------------------------------------------

function runStartupRetentionCleanup(): void {
  try {
    const recovered = recoverOrphanedSessions();
    if (recovered > 0)
      logger.info(`[analytics] Recovered ${recovered} orphaned session(s).`);
    runRetentionCleanup();
  } catch (err) {
    logger.warn('[analytics] Retention/recovery error:', err);
  }
}

async function ensureFrontendBuilt(
  frontendDir: string,
  packageRoot: string
): Promise<void> {
  if (fs.existsSync(path.join(frontendDir, 'index.html'))) return;
  const viteConfig = path.join(packageRoot, 'frontend', 'vite.config.ts');
  if (!fs.existsSync(viteConfig)) {
    logger.warn(
      'Frontend assets missing and source not available — UI will not be served.'
    );
    return;
  }
  logger.info('Frontend not built — building now...');
  try {
    await execFileAsync(
      'npx',
      ['vite', 'build', '--config', 'frontend/vite.config.ts'],
      { cwd: packageRoot }
    );
    logger.info('Frontend build complete.');
  } catch (err) {
    logger.error(
      'Frontend build failed:',
      err instanceof Error ? err.message : err
    );
  }
}

/** Returns a validation error string, or null if the ticket context is valid. */
export function validateTicketContext(
  ticketContext: TicketContext,
  configuredWorkspaces: string[]
): string | null {
  if (
    typeof ticketContext.ticketId !== 'string' ||
    typeof ticketContext.title !== 'string' ||
    typeof ticketContext.url !== 'string'
  ) {
    return 'ticketContext requires string ticketId, title, and url';
  }
  if (ticketContext.source !== 'github' && ticketContext.source !== 'jira') {
    return "ticketContext.source must be 'github' or 'jira'";
  }
  if (!configuredWorkspaces.includes(ticketContext.repoPath)) {
    return 'ticketContext.repoPath is not a configured workspace';
  }
  if (
    ticketContext.source === 'github' &&
    !/^GH-\d+$/.test(ticketContext.ticketId)
  ) {
    return 'ticketContext.ticketId for github must match GH-<number>';
  }
  if (
    ticketContext.source === 'jira' &&
    !/^[A-Z][A-Z0-9]*-\d+$/.test(ticketContext.ticketId)
  ) {
    return 'ticketContext.ticketId must match <PROJECT>-<number>';
  }
  return null;
}

/**
 * Clamps a terminal dimension (cols or rows) to a valid range.
 * Returns the rounded value if valid, or undefined if invalid/unset.
 */

type TerminalSessionParams = {
  spawnedBySessionId?: string;
  repoName: string;
  repoPath?: string | undefined;
  worktreePath: string | null | undefined;
  cwd: string;
  displayName: string | undefined;
  safeCols: number | undefined;
  safeRows: number | undefined;
  resolvedTerminalBackend: TerminalBackend;
  sessionLane: SessionLane | undefined;
  workContextId?: string | undefined;
  portVariables?: string[] | undefined;
  /** #740: anchoring Bench's env overrides, applied additively to the PTY env. */
  envOverrides?: Record<string, string> | undefined;
};

function createTerminalSessionRecord(
  params: TerminalSessionParams
): CreateResult {
  const shell = process.env.SHELL || '/bin/sh';
  const displayName = resolveSessionDisplayName(
    params.displayName,
    sessions.nextTerminalName
  );
  return localRelayNode.sessions.create({
    type: 'terminal',
    ...(params.spawnedBySessionId !== undefined
      ? { spawnedBySessionId: params.spawnedBySessionId }
      : {}),
    repoName: params.repoName,
    ...(params.repoPath ? { repoPath: params.repoPath } : {}),
    worktreePath: params.worktreePath ?? null,
    cwd: params.cwd,
    displayName,
    branchName: '',
    command: shell,
    args: [],
    terminalBackend: params.resolvedTerminalBackend,
    ...(params.safeCols != null && { cols: params.safeCols }),
    ...(params.safeRows != null && { rows: params.safeRows }),
    ...(params.sessionLane ? { sessionLane: params.sessionLane } : {}),
    workContextId: params.workContextId,
    portVariables: params.portVariables,
    ...(params.envOverrides ? { envOverrides: params.envOverrides } : {}),
  });
}

function activePtySessionCount(): number {
  return countActivePtySessions(localRelayNode.sessions.list());
}

function parseRenderedScreenBooleanQuery(value: unknown): boolean {
  if (value === true || value === 'true' || value === '1') return true;
  return false;
}

export function parseRenderedScreenMaxLines(
  value: unknown
): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 ? value : undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

function compactRequestPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

type SessionLaunchPaths = {
  requestedRepoPath?: string | undefined;
  requestedWorktreePath?: string | undefined;
  cwd: string;
  settingsAnchorPath: string;
};

export function resolveSessionLaunchPaths(input: {
  repoPath?: unknown;
  worktreePath?: unknown;
  cwd?: unknown;
  config: Pick<Config, 'repos'>;
  devCwdFallback?: string | undefined;
}): SessionLaunchPaths {
  const requestedRepoPath = compactRequestPath(input.repoPath);
  const requestedWorktreePath = compactRequestPath(input.worktreePath);
  const requestedCwd = compactRequestPath(input.cwd);
  const defaultProjectPath =
    compactRequestPath(input.config.repos?.[0]) ?? input.devCwdFallback;
  const cwd =
    requestedWorktreePath ??
    requestedCwd ??
    requestedRepoPath ??
    defaultProjectPath ??
    '';
  return {
    requestedRepoPath,
    requestedWorktreePath,
    cwd,
    settingsAnchorPath: requestedRepoPath ?? cwd,
  };
}

export function resolveSessionDisplayName(
  requested: string | undefined,
  fallback: () => string
): string {
  const trimmed = requested?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback();
}

function devSessionCwdFallback(): string | undefined {
  if (
    process.env.RELAY_IDE_DEV_INSTANCE === '1' ||
    process.env.RELAY_IDE_SELF_HOST === '1'
  ) {
    return process.cwd();
  }
  return undefined;
}

function resolveLocalScreenSessionId(
  requestedId: string
):
  | { kind: 'local'; id: string }
  | { kind: 'remote'; nodeId: string; localSessionId: string }
  | { kind: 'missing' } {
  if (localRelayNode.sessions.get(requestedId)) {
    return { kind: 'local', id: requestedId };
  }
  const parsed = parseGlobalSessionId(requestedId);
  if (!parsed) return { kind: 'missing' };
  if (parsed.nodeId !== DEFAULT_LOCAL_NODE_ID) {
    return {
      kind: 'remote',
      nodeId: parsed.nodeId,
      localSessionId: parsed.localSessionId,
    };
  }
  if (localRelayNode.sessions.get(parsed.localSessionId)) {
    return { kind: 'local', id: parsed.localSessionId };
  }
  return { kind: 'missing' };
}

function renderedScreenErrorStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'SESSION_CONFLICT':
      return 409;
    case 'UNSUPPORTED':
      return 422;
    case 'UPSTREAM_ERROR':
      return 503;
    default:
      return 500;
  }
}

function sendPtyCapacityError(
  res: express.Response,
  response: ReturnType<typeof buildPtyCapacityResponse>
): boolean {
  if (!response) return false;
  res.status(503).json(response);
  return true;
}

function sendSessionCreateError(
  res: express.Response,
  err: unknown,
  maxPtySessions: unknown
): void {
  const response = sessionCreateErrorResponse(
    err,
    activePtySessionCount(),
    maxPtySessions
  );
  if (sendPtyCapacityError(res, response)) return;
  logger.error('[sessions] failed to create session:', err);
  res.status(500).json({
    error: 'session_create_failed',
    message: sessionCreateFailureMessage(err),
  });
}

/**
 * A launch anchor is valid when it IS a configured project path or lives
 * inside one (worktrees under `.worktrees/<slug>`, monorepo subdirs). The
 * boundary check uses path segments, so `/repo-evil` does not match `/repo`.
 */
function isConfiguredLaunchAnchor(
  anchor: string,
  configured: Set<string>
): boolean {
  if (configured.has(anchor)) return true;
  for (const root of configured) {
    const rel = path.relative(root, anchor);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

export function validateSessionCreateRequest(
  repoPath: string | undefined,
  cwd: string | undefined,
  type: 'terminal' | undefined,
  config: Config,
  workContextStore: WorkContextStore,
  workContextId: string | undefined,
  res: express.Response
): boolean {
  const configured = new Set(config.repos ?? []);
  const sessionType = type ?? 'terminal';
  if (repoPath && configured.size > 0 && !configured.has(repoPath)) {
    res.status(400).json({
      error: 'repoPath must be a configured project path when provided',
    });
    return false;
  }
  // Validate the actual launch directory. The session spawns in `cwd` (the
  // call site resolves it to worktreePath ?? requestCwd ?? repoPath), so `cwd`
  // is what has to be inside a configured project — it takes precedence here.
  // Checking `repoPath ?? cwd` let a request pair a configured repoPath with an
  // arbitrary cwd/worktreePath and launch outside the boundary; `cwd ?? repoPath`
  // still honors a repoPath-only anchor while closing that bypass.
  const anchor = cwd ?? repoPath ?? '';
  if (!anchor) {
    res.status(400).json({
      error: `${sessionType} sessions require a repoPath or cwd launch anchor`,
    });
    return false;
  }
  if (configured.size > 0 && !isConfiguredLaunchAnchor(anchor, configured)) {
    res.status(400).json({
      error: `${sessionType} sessions require a repoPath or cwd inside a configured project path`,
    });
    return false;
  }
  if (!workContextId) return true;
  if (workContextStore.get(workContextId)) return true;
  res.status(404).json({ error: 'work_context_not_found' });
  return false;
}

/**
 * Sanitize a caller-supplied `envOverrides` map for a session create (#740: a
 * Tab inherits its anchoring Bench's persisted env overrides). Keeps only
 * `string -> string` entries with a non-empty key. Non-records and non-string
 * values are dropped silently — the PTY layer additively applies what survives
 * and refuses reserved keys (`PATH`, `RELAY_*`) itself, so a malformed map can
 * never break session identity. Returns `undefined` when nothing usable
 * remains (no env added = unchanged behavior).
 */
function sanitizeSessionEnvOverrides(
  raw: unknown
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (typeof value !== 'string') continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sessionNameFromRepoPath(repoPath: string): string {
  return repoPath.split('/').filter(Boolean).pop() || 'session';
}

function associateSessionWithWorkContext(
  store: WorkContextStore,
  workContextId: string | undefined,
  session: SessionSummary
): string | null {
  if (!workContextId) return null;
  try {
    store.associateSession(workContextId, { session });
    return null;
  } catch (err) {
    const code =
      err instanceof Error ? err.message : 'work_context_association_failed';
    logger.warn(
      '[sessions] failed to associate session with work context %s: %s',
      workContextId,
      err
    );
    return code || 'work_context_association_failed';
  }
}

function withWorkContextMetadata(
  store: WorkContextStore,
  session: SessionSummary
): SessionSummary {
  const workContextId = store.findSessionWorkContextIds(session)[0];
  return workContextId ? { ...session, workContextId } : session;
}

function sendSessionCreateSuccess(
  res: express.Response,
  session: SessionSummary,
  associationError: string | null,
  workContextId?: string
): void {
  const responseSession = workContextId
    ? { ...session, workContextId }
    : session;
  res
    .status(201)
    .json(
      associationError
        ? { ...responseSession, workContextAssociationError: associationError }
        : responseSession
    );
}

function sessionCreateFailureMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'Failed to create session.';
  // Surface the underlying message so failures (codex spawn, app-server
  // handshake, thread/start, etc.) reach the UI instead of a generic banner.
  return err.message
    ? `Failed to create session: ${err.message}`
    : 'Failed to create session.';
}

/** Initializes the startup config PIN (migrates legacy hashes, prompts if needed). */
async function initializePinConfig(startupConfig: Config): Promise<void> {
  if (startupConfig.pinHash && !auth.isPinConfigured(startupConfig.pinHash)) {
    logger.info(
      'Migrating legacy PIN hash to scrypt. You will need to set a new PIN.'
    );
    delete startupConfig.pinHash;
    saveConfig(CONFIG_PATH, startupConfig);
  }

  if (!startupConfig.pinHash) {
    if (process.stdin.isTTY) {
      const pin = await promptPin('Set up a PIN for relay-ide:');
      startupConfig.pinHash = await auth.hashPin(pin);
      saveConfig(CONFIG_PATH, startupConfig);
      logger.info('PIN set successfully.');
    } else {
      logger.info(
        `No PIN configured. Open http://localhost:${startupConfig.port} to set one.`
      );
    }
  }
}

function logStartupWarning(message: string, err: unknown): void {
  logger.warn(message, err instanceof Error ? err.message : err);
}

function initializeRuntimeDirectories(configDir: string): void {
  try {
    initFileLogging(path.join(configDir, 'logs'));
  } catch (err) {
    logStartupWarning('File logging disabled: failed to initialize:', err);
  }

  try {
    fs.mkdirSync(path.join(configDir, 'telemetry'), { recursive: true });
  } catch (err) {
    logStartupWarning('Telemetry directory creation failed:', err);
  }
}

function startCredentialRotationScheduler(input: {
  config: Config;
  registry: ReturnType<typeof createHubNodeRegistry>;
  nodeLinks: ReturnType<typeof createHubNodeLinkManager>;
  auditSink: ReturnType<typeof createSecurityAuditLog> | undefined;
}): CredentialRotationScheduler | null {
  const cfg = input.config.credentialRotation;
  const intervalMs = cfg?.intervalMs ?? 0;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  try {
    const scheduler = createCredentialRotationScheduler({
      registry: input.registry,
      nodeLinks: input.nodeLinks,
      auditSink: input.auditSink,
      intervalMs,
      ...(cfg?.checkIntervalMs ? { checkIntervalMs: cfg.checkIntervalMs } : {}),
    });
    scheduler.start();
    return scheduler;
  } catch (err) {
    logger.warn(
      'Credential rotation scheduler disabled: failed to initialize:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function createAuditedHubNodeRegistry(
  configDir: string,
  auditSink: ReturnType<typeof createSecurityAuditLog> | undefined
): ReturnType<typeof createHubNodeRegistry> {
  const options: Parameters<typeof createHubNodeRegistry>[0] = {
    storagePath: path.join(configDir, 'hub-node-registry.json'),
    hubVersion: getCurrentVersion(),
  };
  if (auditSink) options.auditSink = auditSink;
  return createHubNodeRegistry(options);
}

async function ensureFrontendAvailableForStartup(
  frontendDir: string,
  packageRoot: string
): Promise<void> {
  // Services should use pre-built assets; background startup must not invoke build tooling.
  if (process.env['RELAY_IDE_BACKGROUND'] === '1') return;

  try {
    await ensureFrontendBuilt(frontendDir, packageRoot);
  } catch (err) {
    logStartupWarning('Frontend build check failed:', err);
  }
}

function shutdownAfterListenFailure(
  err: unknown,
  gracefulShutdown: () => Promise<void>
): void {
  logger.error(
    'Server failed to start:',
    err instanceof Error ? err.message : String(err)
  );
  void gracefulShutdown();
}

function buildSessionConfig(
  startupConfig: Config,
  configDir: string,
  securityAuditLog: { append(input: unknown): unknown } | undefined
): Parameters<typeof sessions.configure>[0] {
  return {
    port: startupConfig.port,
    configDir,
    ...(startupConfig.control?.interventionDebounceMs !== undefined
      ? { interventionDebounceMs: startupConfig.control.interventionDebounceMs }
      : {}),
    ...(startupConfig.control?.coDrivenAutoRevertMs !== undefined
      ? { coDrivenAutoRevertMs: startupConfig.control.coDrivenAutoRevertMs }
      : {}),
    ...(securityAuditLog ? { securityAuditSink: securityAuditLog } : {}),
    ...(startupConfig.maxScrollbackGlobalBytes !== undefined
      ? { maxScrollbackGlobalBytes: startupConfig.maxScrollbackGlobalBytes }
      : {}),
    ...(startupConfig.maxScrollbackPerSessionBytes !== undefined
      ? {
          maxScrollbackPerSessionBytes:
            startupConfig.maxScrollbackPerSessionBytes,
        }
      : {}),
  };
}

/**
 * Wrap the #758 `ContextPacketStore` in the #765 router's `ContextInboxStore`
 * adapter, or `null` when the store failed to init (routes then 503). Extracted
 * from `main()` to keep that boot function under the cognitive-complexity gate.
 */
function deriveContextInboxStore(
  store: ContextPacketStore | null
): ContextInboxStore | null {
  return store ? createContextInboxStoreAdapter(store) : null;
}

/**
 * Audit-attributed actor id for an explicit-presence (#964) write, sourced from
 * the authenticated CLI-gateway actor credential. Module-scoped so `main()`
 * stays under the complexity gate.
 */
/**
 * Initialize every SQLite-backed boot store through one collector. A hub may
 * use disabled stores only when the operator explicitly opts into degraded
 * mode; the collector otherwise throws before Express or server.listen exist.
 */
function initializeHubPersistence(
  configDir: string,
  config: Config
): PersistenceStartupState {
  const failureInjector = persistenceFailureInjectorFromTestEnvironment();
  return initializePersistenceStores(
    [
      {
        name: 'security-audit',
        criticality: 'core',
        initialize: () =>
          createSecurityAuditLog(path.join(configDir, 'security-audit.db')),
      },
      {
        name: 'work-contexts',
        criticality: 'core',
        initialize: () => initWorkContextStore(configDir),
        unavailable: (cause) => createUnavailableWorkContextStore(cause),
      },
      {
        name: 'ia',
        criticality: 'core',
        initialize: () => initIaStore(configDir),
      },
      {
        name: 'context-packets',
        criticality: 'core',
        initialize: () => initContextPacketStore(configDir),
      },
      {
        name: 'agent-profiles',
        criticality: 'core',
        initialize: () => {
          const store = initAgentProfileStore(configDir);
          store.seedBuiltIns(listConfiguredFrameworks(config.frameworks));
          return store;
        },
      },
      {
        name: 'work-context-artifacts',
        criticality: 'core',
        initialize: () => initWorkContextArtifactStore(configDir),
      },
      {
        name: 'workspace-topics',
        criticality: 'core',
        initialize: () => initWorkspaceTopicStore(configDir),
      },
      {
        name: 'work-context-messages',
        criticality: 'core',
        initialize: () => initWorkContextMessageStore(configDir),
      },
      {
        name: 'channel-attachments',
        criticality: 'core',
        initialize: () => initChannelAttachmentStore(configDir),
      },
      {
        name: 'channel-messages',
        criticality: 'core',
        initialize: () => initChannelMessageStore(configDir),
      },
      {
        name: 'intervention-log',
        criticality: 'core',
        initialize: () => initInterventionLog(configDir),
      },
      {
        name: 'analytics',
        criticality: 'optional',
        initialize: () => initAnalytics(configDir),
      },
      {
        name: 'workflow-runs',
        criticality: 'optional',
        initialize: () => initWorkflowRunStore(configDir),
      },
      {
        name: 'automation-runs',
        criticality: 'optional',
        initialize: () => initAutomationRunStore(configDir),
      },
      {
        name: 'workspace-surfaces',
        criticality: 'optional',
        initialize: () => initWorkspaceSurfaceStore(configDir),
      },
      {
        name: 'pr-overseer',
        criticality: 'optional',
        initialize: () => initPrOverseerStore(configDir),
      },
    ],
    {
      allowDegraded: isAllowDegradedPersistence(),
      logger,
      ...(failureInjector ? { failureInjector } : {}),
    }
  );
}

/**
 * Routable framework targets for @-mention routing (#1167): builtin/configured
 * frameworks gated on channel-runtime support and availability, plus `mock` when
 * `RELAY_MOCK_AGENT=1` (dev/tests). Unavailable frameworks are INCLUDED with
 * `available:false` so the palette can render them greyed with the reason.
 */
async function channelMentionTargets(config: Config): Promise<MentionTarget[]> {
  const targets: MentionTarget[] = [];
  for (const framework of listConfiguredFrameworks(config.frameworks)) {
    const channel = await getFrameworkChannelAvailability(framework);
    targets.push({
      id: framework.id,
      displayName: framework.displayName,
      kind: 'framework',
      available: channel.available,
      reason: channel.available ? null : (channel.reason ?? null),
    });
  }
  if (process.env['RELAY_MOCK_AGENT'] === '1') {
    targets.push({
      id: 'mock',
      displayName: 'Mock Agent',
      kind: 'framework',
      available: true,
      reason: null,
    });
  }
  return targets;
}

async function ensureStartupTerminalBackendAvailable(
  _startupConfig: Config
): Promise<void> {}

async function main(): Promise<void> {
  // Ignore SIGPIPE: node-pty can propagate pipe breaks causing unexpected session exits.
  // Ignore SIGHUP: keep server alive if controlling terminal disconnects.
  setupProcessSignalHandlers();

  ensureMetaDir(CONFIG_PATH);

  async function reconcilePortsForRepo(repoPath: string): Promise<void> {
    const allocator = getAllocatorOrNull();
    if (!allocator) return;

    const config = getConfig();
    const portVariables = normalizePortVariables(
      config.repoSettings?.[repoPath]?.portVariables
    );

    let worktrees: Awaited<ReturnType<typeof listNonMainWorktrees>>;
    try {
      worktrees = await listNonMainWorktrees(repoPath);
    } catch (err) {
      logPortReconciliationOnce(
        `list:${repoPath}`,
        'Failed to list worktrees for port reconciliation:',
        repoPath,
        err instanceof Error ? err.message : err
      );
      return;
    }

    const existingWorktrees = worktrees.filter((worktree) => {
      if (fs.existsSync(worktree.path)) return true;
      logPortReconciliationOnce(
        `missing-worktree:${repoPath}:${worktree.path}`,
        'Skipping port reconciliation for missing worktree:',
        worktree.path
      );
      return false;
    });
    const activeWorktreePaths = new Set(existingWorktrees.map((wt) => wt.path));
    for (const worktree of existingWorktrees) {
      try {
        const ports = await allocator.reconcilePortsForWorktree(
          repoPath,
          worktree.path,
          portVariables,
          process.env.RELAY_IDE_SELF_HOST === '1'
            ? Array.from(SELF_HOST_DEV_PORT_VARIABLES)
            : undefined
        );
        upsertPortsInEnvFile(worktree.path, ports);
      } catch (err) {
        logger.warn(
          'Port reconciliation failed for worktree:',
          worktree.path,
          err instanceof Error ? err.message : err
        );
      }
    }

    for (const assignment of allocator.getAllAssignments()) {
      if (assignment.repoId !== repoPath) continue;
      if (activeWorktreePaths.has(assignment.worktreeId)) continue;
      if (SELF_HOST_DEV_PORT_VARIABLES.has(assignment.variableName)) continue;
      try {
        allocator.releasePortForWorktreeVariable(
          repoPath,
          assignment.worktreeId,
          assignment.variableName
        );
        if (fs.existsSync(assignment.worktreeId)) {
          removePortsFromEnvFile(assignment.worktreeId, [
            assignment.variableName,
          ]);
        } else {
          logPortReconciliationOnce(
            `cleanup-missing:${repoPath}:${assignment.worktreeId}`,
            'Released stale port assignment for missing worktree:',
            assignment.worktreeId
          );
        }
      } catch (err) {
        logPortReconciliationOnce(
          `cleanup-failed:${repoPath}:${assignment.worktreeId}`,
          'Failed to clean up stale port assignment:',
          assignment.worktreeId,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  async function reconcilePortsForAllRepos(repoPaths: string[]): Promise<void> {
    for (const repoPath of filterPortReconciliationRepoPaths(repoPaths)) {
      await reconcilePortsForRepo(repoPath);
    }
  }

  function queuePortReconciliation(repoPaths: string[]): void {
    void reconcilePortsForAllRepos(repoPaths).catch(
      logPortReconciliationFailure
    );
  }

  // Runtime config — always reads fresh from disk.
  // Use this for ALL config access in route handlers, pollers, and event callbacks.
  let lastGoodConfig: Config | null = null;
  function getConfig(): Config {
    try {
      const fresh = loadConfig(CONFIG_PATH);
      lastGoodConfig = fresh;
      return structuredClone(fresh);
    } catch (err) {
      logger.warn(
        '[config] Failed to load config, using last good config:',
        err
      );
      const fallback = lastGoodConfig ?? ({ ...DEFAULTS } as Config);
      return structuredClone(fallback);
    }
  }

  // Startup-only config — captured once at boot.
  // Use ONLY for values wired into the listening socket or long-lived connections
  // (port, host, webhookSecret, smeeUrl, githubToken).
  let startupConfig: Config;
  try {
    startupConfig = loadConfig(CONFIG_PATH);
  } catch (_) {
    startupConfig = { ...DEFAULTS } as Config;
    saveConfig(CONFIG_PATH, startupConfig);
  }

  // CLI flag overrides
  if (process.env.RELAY_IDE_PORT)
    startupConfig.port = parseInt(process.env.RELAY_IDE_PORT, 10);
  if (process.env.RELAY_IDE_HOST)
    startupConfig.host = process.env.RELAY_IDE_HOST;

  push.ensureVapidKeys(startupConfig, CONFIG_PATH, saveConfig);

  const configDir = getConfigDir(CONFIG_PATH);
  initializeRuntimeDirectories(configDir);
  // Finalize all SQLite persistence before building long-lived services. A
  // failed store throws here by default, before a scheduler or listener can
  // leave an amnesiac hub running.
  const persistenceState = initializeHubPersistence(configDir, getConfig());
  const securityAuditLog =
    persistenceState.get<ReturnType<typeof createSecurityAuditLog>>(
      'security-audit'
    ) ?? undefined;
  const workContextStore =
    persistenceState.get<WorkContextStore>('work-contexts') ??
    createUnavailableWorkContextStore('work-contexts missing from startup');
  const iaStore = persistenceState.get<IaStore>('ia');
  const contextPacketStore =
    persistenceState.get<ContextPacketStore>('context-packets');
  const agentProfileStore =
    persistenceState.get<AgentProfileStore>('agent-profiles');
  const workContextArtifactStore =
    persistenceState.get<WorkContextArtifactStore>('work-context-artifacts');
  const workflowRunStore =
    persistenceState.get<WorkflowRunStore>('workflow-runs');
  const automationRunStore =
    persistenceState.get<AutomationRunStore>('automation-runs');
  const workspaceSurfaceStore =
    persistenceState.get<WorkspaceSurfaceStore>('workspace-surfaces');
  const workspaceTopicStore =
    persistenceState.get<WorkspaceTopicStore>('workspace-topics');
  const prOverseerStore = persistenceState.get<PrOverseerStore>('pr-overseer');
  const workContextMessageStore = persistenceState.get<WorkContextMessageStore>(
    'work-context-messages'
  );
  const channelAttachmentStore = persistenceState.get<ChannelAttachmentStore>(
    'channel-attachments'
  );
  const channelMessageStore =
    persistenceState.get<ChannelMessageStore>('channel-messages');
  const hubNodeRegistry = createAuditedHubNodeRegistry(
    configDir,
    securityAuditLog
  );
  const repoInventoryFeature = createRepoInventoryFeature(hubNodeRegistry);
  const hubNodeLinks = createHubNodeLinkManager({
    inventoryValidator: repoInventoryFeature.validateInventoryPayload,
    ptyInputRecorder: sessions.recordRoutedPtyInput,
    releaseRoutedPtyControlSession: sessions.releaseRoutedPtyControlSession,
  });
  const remoteSessionReadModelCache = createRemoteSessionReadModelCache();
  const credentialRotationScheduler = startCredentialRotationScheduler({
    config: startupConfig,
    registry: hubNodeRegistry,
    nodeLinks: hubNodeLinks,
    auditSink: securityAuditLog,
  });

  async function flushHubNodeHeartbeatsBestEffort(
    context: string
  ): Promise<void> {
    try {
      await hubNodeRegistry.flushPendingHeartbeatPersist();
    } catch (err) {
      logger.warn(
        'Failed to flush pending hub node heartbeat state during %s; continuing lifecycle sequence: %s',
        context,
        err instanceof Error ? err.message : err
      );
    }
  }

  await ensureStartupTerminalBackendAvailable(startupConfig);

  await initializePortAllocatorAndReconcile(
    CONFIG_PATH,
    getConfig,
    reconcilePortsForAllRepos
  );

  // #736: one-time, idempotent boot migration of legacy `config.workspaces`
  // groupings → persisted IA Workspaces (`ia.db`). NON-DESTRUCTIVE: reads
  // `config.workspaces` + the local repo inventory, writes ONLY to `ia.db`.
  // Idempotent via a `migration_state` marker + deterministic, upsert-if-absent
  // ids (see `ia-workspace-migration.ts`). Internally guarded so any failure
  // logs + skips and NEVER crashes boot; recovery now relies on the topic shell
  // and persisted IA/view-spine surfaces, not a duplicate repo-sidebar fallback.
  await runBootWorkspaceMigration({
    iaStore,
    getConfig,
    collectLocalRepoInventory: () =>
      collectLocalRepoInventory({
        config: getConfig(),
        configPath: CONFIG_PATH,
      }),
  });
  if (channelMessageStore) {
    try {
      channelMessageStore.sweepStaleStreaming();
      if (workspaceTopicStore) {
        // Enumerate ALL stored topic ids uncapped — NOT via `list()`, which caps
        // at 200 while the store retains up to 500. Feeding the capped list to
        // sweepOrphans would delete every channel whose topic ranks beyond the
        // top-200-by-updated_at (silent, unrecoverable data loss) once >200
        // topics exist.
        const persistedTopicIds = new Set(
          workspaceTopicStore.listAllTopicIds()
        );
        channelMessageStore.sweepOrphans(persistedTopicIds);
      }
    } catch (err) {
      logger.warn(
        'Channel store boot sweep failed:',
        err instanceof Error ? err.message : err
      );
    }
  }
  const channelHub: ChannelHub = createChannelHub({
    store: channelMessageStore,
    channelExists: (channelId) => Boolean(workspaceTopicStore?.get(channelId)),
  });
  // @-mention routing binder (#1167): owns private agent runtimes per
  // (channel, profile) and streams replies through the channel bridge.
  // Null when the channel store failed to init (routes degrade to 503).
  const channelAgentBinder: ChannelAgentBinder | null = channelMessageStore
    ? createChannelAgentBinder({
        store: channelMessageStore,
        attachmentStore: channelAttachmentStore,
        hub: channelHub,
        topicStore: workspaceTopicStore,
        agentProfileStore,
        runtimes: channelAgentRuntimes,
        knownProviderIds: Object.keys(v2Adapters),
        mentionTargets: () => channelMentionTargets(getConfig()),
        port: startupConfig.port,
        configDir,
        localNodeId: DEFAULT_LOCAL_NODE_ID,
      })
    : null;
  if (channelAgentBinder) {
    channelHub.onMessagePosted((message, mentions) =>
      channelAgentBinder.handleMessagePosted(message, mentions)
    );
  }

  const cliGatewayEventBus = createCliGatewayEventBus();

  await initializePinConfig(startupConfig);

  const authenticatedTokens = new Set<string>();

  // Build frontend if missing (e.g. fresh clone in development)
  const frontendDir = path.join(__dirname, '..', 'frontend');
  const packageRoot = path.join(__dirname, '..', '..');
  await ensureFrontendAvailableForStartup(frontendDir, packageRoot);

  const app = express();

  // Mount webhooks BEFORE global express.json() — unconditionally.
  // Secret is validated at request time (returns 401 if not configured).
  let broadcastEventDelegate:
    | ((type: string, data?: Record<string, unknown>) => void)
    | null = null;
  const webhookRouter = createWebhookRouter({
    secret: () => loadConfig(CONFIG_PATH).github?.webhookSecret,
    broadcastEvent: (type, data) => {
      broadcastEventDelegate?.(type, data);
    },
  });
  app.use('/webhooks', webhookRouter);

  app.use(express.json({ limit: '15mb' }));
  app.use(cookieParser());
  app.use(express.static(frontendDir));

  // Health check — no auth required (used by sandbox readiness probes and agent discovery)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  // Session resume starts after the listener is bound. Keep this separate from
  // health status: callers can observe readiness without making /healthz wait.
  const startupResume = {
    inProgress: false,
    complete: false,
    restored: 0,
    failed: false,
  };
  const healthMonitor = createHealthMonitor({
    disabledStores: persistenceState.disabledStores,
    getResumeReadiness: () => startupResume,
  });
  app.get('/healthz', healthMonitor.handler);

  function authenticatedBrowserSession(req: express.Request): boolean {
    const token = req.cookies && req.cookies.token;
    if (!token) return false;
    const config = getConfig();
    return (
      authenticatedTokens.has(token) ||
      auth.verifyCookieToken(token, config.pinHash)
    );
  }

  function bearerScopedToken(req: express.Request): string {
    const authHeader = req.header('authorization') ?? '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() ?? '';
  }

  function validatedHandoffCapabilities(
    _req: express.Request
  ): HandoffCapabilityContext | null {
    // Scoped CLI tokens currently prove only bearer possession, not capability grants.
    // Never promote caller-controlled x-relay-capabilities into a validated handoff
    // context; until token/policy grants are wired, handoff routes fail closed.
    return null;
  }

  function isCliGatewayV1Request(req: express.Request): boolean {
    return req.header('x-relay-cli-gateway') === 'v1';
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function sendGatewayCreateValidationError(
    res: express.Response,
    error: RelayCliGatewayError
  ): void {
    res.status(400).json({ error });
  }

  const retiredAgentSessionCreateFields = new Set([
    'agent',
    'role',
    'yolo',
    'claudeArgs',
    'continue',
    'continuePolicy',
    'initialPrompt',
    'ticketContext',
  ]);

  function rejectRetiredAgentSessionCreateFields(
    body: Record<string, unknown>,
    res: express.Response
  ): boolean {
    for (const field of retiredAgentSessionCreateFields) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      res.status(400).json({
        error: {
          code: 'RETIRED_AGENT_SESSION_FIELD',
          message: `Session field "${field}" belonged to retired agent sessions; start agent conversations in a channel or DM.`,
          field,
          replacement: 'channel-or-dm',
        },
      });
      return true;
    }
    return false;
  }

  function sessionCreateBodyFromRequest(
    req: express.Request,
    res: express.Response
  ): Record<string, unknown> | null {
    const body = req.body as unknown;
    if (!isCliGatewayV1Request(req)) {
      const directBody = isRecord(body) ? body : {};
      if (Object.prototype.hasOwnProperty.call(directBody, 'useTmux')) {
        res.status(400).json({
          error:
            'legacy useTmux request flag is no longer supported; use terminalBackend',
        });
        return null;
      }
      if (
        Object.prototype.hasOwnProperty.call(directBody, 'terminalBackend') &&
        normalizeTerminalBackend(directBody['terminalBackend']) === undefined
      ) {
        res.status(400).json({
          error: 'terminalBackend must be "relay-pty"',
        });
        return null;
      }
      if (rejectRetiredAgentSessionCreateFields(directBody, res)) return null;
      return directBody;
    }
    if (!isRecord(body)) {
      sendGatewayCreateValidationError(res, {
        code: 'INVALID_ARGUMENT',
        message: 'sessions.create input JSON must be an object',
        retryable: false,
      });
      return null;
    }
    const validated = validateAndSanitizeLocalGatewayCreateInput(body);
    if (validated.ok === false) {
      sendGatewayCreateValidationError(res, validated.error);
      return null;
    }
    return validated.input;
  }

  function resolveWorkspaceTopicSessionCreate(
    createBody: Record<string, unknown>,
    res: express.Response
  ): { body: Record<string, unknown>; topic?: WorkspaceTopic } | null {
    if (!Object.prototype.hasOwnProperty.call(createBody, 'workspaceTopicId')) {
      return { body: createBody };
    }
    const workspaceTopicId = createBody['workspaceTopicId'];
    if (
      typeof workspaceTopicId !== 'string' ||
      workspaceTopicId.trim() === ''
    ) {
      res.status(400).json({
        error: 'workspaceTopicId must be a non-empty string',
      });
      return null;
    }
    if (!workspaceTopicStore) {
      res.status(503).json({
        error: {
          code: 'WORKSPACE_TOPICS_UNAVAILABLE',
          message: 'WorkspaceTopic store is unavailable',
        },
      });
      return null;
    }
    const topic = workspaceTopicStore.get(workspaceTopicId.trim());
    if (!topic) {
      res.status(404).json({
        error: {
          code: 'WORKSPACE_TOPIC_NOT_FOUND',
          message: `WorkspaceTopic not found: ${workspaceTopicId}`,
        },
      });
      return null;
    }
    if (topic.status === 'archived') {
      res.status(400).json({
        error: {
          code: 'WORKSPACE_TOPIC_ARCHIVED',
          message: `WorkspaceTopic is archived: ${workspaceTopicId}`,
        },
      });
      return null;
    }
    return {
      body: {
        ...createBody,
        ...buildWorkspaceTopicSessionCreateBody({
          topic,
          overrides: createBody,
        }),
        workspaceTopicId: topic.id,
      },
      topic,
    };
  }

  function linkWorkspaceTopicSession(
    topic: WorkspaceTopic | undefined,
    session: { id: string },
    workContextId: string | undefined
  ): void {
    if (!topic || !workspaceTopicStore) return;
    const patch = workspaceTopicSessionLinkPatch({
      topic,
      sessionId: session.id,
      workContextId,
    });
    if (!patch) return;
    try {
      workspaceTopicStore.update(topic.id, patch);
    } catch (err) {
      logger.warn(
        '[index] failed to link session %s to WorkspaceTopic %s: %s',
        session.id,
        topic.id,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (!authenticatedBrowserSession(req)) {
      res.status(401).json(auth.browserSessionRequiredChallenge());
      return;
    }
    next();
  };

  const requireCliGatewayActorAuth = (
    capabilities: readonly RelayCapabilityBit[],
    scope?: {
      nodeIds?: string[];
      sessionIds?: string[];
      globalSessionIds?: string[];
      workContextIds?: string[];
      repoIds?: string[];
      pathPrefixes?: string[];
      taskRefs?: string[];
    },
    expectedCommand?: CliGatewayActorCommand,
    options: { deferWorkContextScope?: boolean } = {}
  ): express.RequestHandler => {
    return (req, res, next) => {
      if (!isCliGatewayV1Request(req)) {
        if (authenticatedBrowserSession(req)) {
          next();
          return;
        }
        res.status(401).json(auth.cliGatewayOrBrowserAuthRequiredChallenge());
        return;
      }
      const lane = classifyCliGatewayCredentialLane(req, expectedCommand);
      const correlationId = cliGatewayCorrelationId(req);
      if (lane !== 'scoped-actor-credential') {
        sendCliGatewayActorFailure(
          res,
          cliGatewayActorFailure({
            lane,
            ...(correlationId ? { correlationId } : {}),
          })
        );
        return;
      }
      const validation = validateCliGatewayActorCredential(
        cliGatewayActorRegistry,
        {
          token: bearerActorToken(req),
          capabilities,
          ...(scope ? { scope } : {}),
          ...(options.deferWorkContextScope
            ? { deferWorkContextScope: true }
            : {}),
          ...(correlationId ? { correlationId } : {}),
        }
      );
      if ('reason' in validation) {
        sendCliGatewayActorFailure(
          res,
          cliGatewayActorFailure({
            reason: validation.reason,
            ...(validation.credentialId
              ? { credentialId: validation.credentialId }
              : {}),
            deniedBits: validation.deniedBits,
            ...(correlationId ? { correlationId } : {}),
          })
        );
        return;
      }
      attachAuthenticatedCliGatewayActorCredential(req, validation.credential);
      next();
    };
  };

  const requireCliGatewayReadAuth = (
    expectedCommand?: CliGatewayActorReadCommand,
    options: { deferWorkContextScope?: boolean } = {}
  ): express.RequestHandler =>
    requireCliGatewayActorAuth(
      ['session:read'],
      undefined,
      expectedCommand,
      options
    );

  const requireCliGatewayAuthForActorCommand = (
    expectedCommand: CliGatewayActorCommand,
    options: {
      capabilities?: readonly RelayCapabilityBit[];
      scopeForRequest?: (req: express.Request) =>
        | {
            workContextIds?: string[];
            sessionIds?: string[];
            globalSessionIds?: string[];
            repoIds?: string[];
            pathPrefixes?: string[];
            taskRefs?: string[];
          }
        | undefined;
      deferWorkContextScope?: boolean;
    } = {}
  ): express.RequestHandler => {
    return (req, res, next) => {
      if (isCliGatewayActorTokenRequest(req)) {
        requireCliGatewayActorAuth(
          options.capabilities ??
            cliGatewayActorCommandCapabilities(expectedCommand),
          options.scopeForRequest?.(req),
          expectedCommand,
          {
            ...(options.deferWorkContextScope
              ? { deferWorkContextScope: true }
              : {}),
          }
        )(req, res, next);
        return;
      }
      requireCliGatewayAuth(req, res, next);
    };
  };

  const requireCliGatewayAuth: express.RequestHandler = (req, res, next) => {
    if (isCliGatewayActorTokenRequest(req)) {
      requireCliGatewayReadAuth()(req, res, next);
      return;
    }
    if (
      isCliGatewayV1Request(req) &&
      validateScopedToken(bearerScopedToken(req))
    ) {
      next();
      return;
    }
    if (authenticatedBrowserSession(req)) {
      next();
      return;
    }
    res.status(401).json(auth.cliGatewayOrBrowserAuthRequiredChallenge());
  };

  const requireCliGatewayEventsAuth: express.RequestHandler = (
    req,
    res,
    next
  ) => {
    if (!isCliGatewayActorTokenRequest(req)) {
      requireCliGatewayAuth(req, res, next);
      return;
    }
    const topic =
      typeof req.query['topic'] === 'string' ? req.query['topic'] : undefined;
    const capabilities =
      topic &&
      Object.prototype.hasOwnProperty.call(
        EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES,
        topic
      )
        ? EVENTS_SUBSCRIBE_TOPIC_CAPABILITIES[topic as EventsSubscribeTopic]
        : (['session:read'] as const);
    const workContextId =
      typeof req.query['workContextId'] === 'string'
        ? req.query['workContextId'].trim()
        : '';
    const sessionId =
      typeof req.query['sessionId'] === 'string'
        ? req.query['sessionId'].trim()
        : '';
    const globalSessionId =
      typeof req.query['globalSessionId'] === 'string'
        ? req.query['globalSessionId'].trim()
        : '';
    requireCliGatewayActorAuth(
      capabilities,
      {
        taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
        ...(workContextId ? { workContextIds: [workContextId] } : {}),
        ...(sessionId ? { sessionIds: [sessionId] } : {}),
        ...(globalSessionId ? { globalSessionIds: [globalSessionId] } : {}),
      },
      'events.subscribe'
    )(req, res, next);
  };

  const requireCliGatewayWriteAuth: express.RequestHandler = (
    req,
    res,
    next
  ) => {
    if (isCliGatewayActorTokenRequest(req)) {
      res.status(403).json({
        error: 'Forbidden',
        code: 'CLI_GATEWAY_ACTOR_WRITE_UNSUPPORTED',
        message:
          'CLI actor credentials are read-only in this slice; use browser or scoped gateway auth for lifecycle mutations.',
      });
      return;
    }
    requireCliGatewayAuth(req, res, next);
  };

  type ActorSessionCreateTarget =
    | {
        ok: true;
        path: string;
        repoId?: string;
        body: Record<string, unknown>;
        topic?: WorkspaceTopic;
      }
    | {
        ok: false;
        reason: 'missing_scope' | 'wrong_path_scope' | 'wrong_repo_scope';
      };

  const actorSessionCreateTargets = new WeakMap<
    express.Request,
    ActorSessionCreateTarget
  >();
  const invalidActorSessionCreatePath =
    '/.relay-invalid-actor-session-create-target';

  function actorSessionCreateTarget(
    req: express.Request
  ): ActorSessionCreateTarget {
    const cached = actorSessionCreateTargets.get(req);
    if (cached) return cached;
    const rawBody = isRecord(req.body) ? req.body : {};
    const validated = validateAndSanitizeLocalGatewayCreateInput(rawBody);
    if (!validated.ok) {
      const missing = { ok: false, reason: 'missing_scope' } as const;
      actorSessionCreateTargets.set(req, missing);
      return missing;
    }
    let body = validated.input;
    let topic: WorkspaceTopic | undefined;
    const workspaceTopicId = compactRequestPath(body['workspaceTopicId']);
    if (workspaceTopicId) {
      topic = workspaceTopicStore?.get(workspaceTopicId) ?? undefined;
      if (!topic || topic.status === 'archived') {
        const missing = { ok: false, reason: 'missing_scope' } as const;
        actorSessionCreateTargets.set(req, missing);
        return missing;
      }
      body = {
        ...body,
        ...buildWorkspaceTopicSessionCreateBody({
          topic,
          overrides: body,
        }),
        workspaceTopicId: topic.id,
      };
    }
    const requestedRepoPath = compactRequestPath(body['repoPath']);
    const requestedWorktreePath = compactRequestPath(body['worktreePath']);
    const requestedCwd = compactRequestPath(body['cwd']);
    const requestedTarget =
      requestedWorktreePath ?? requestedCwd ?? requestedRepoPath;
    if (!requestedTarget) {
      const missing = { ok: false, reason: 'missing_scope' } as const;
      actorSessionCreateTargets.set(req, missing);
      return missing;
    }
    let canonicalTarget: string;
    try {
      canonicalTarget = fs.realpathSync(requestedTarget);
    } catch {
      const wrongPath = { ok: false, reason: 'wrong_path_scope' } as const;
      actorSessionCreateTargets.set(req, wrongPath);
      return wrongPath;
    }
    if (!requestedRepoPath) {
      const canonicalBody = { ...body };
      if (requestedWorktreePath) {
        canonicalBody['worktreePath'] = canonicalTarget;
      } else if (requestedCwd) {
        canonicalBody['cwd'] = canonicalTarget;
      }
      const target = {
        ok: true,
        path: canonicalTarget,
        body: canonicalBody,
        ...(topic ? { topic } : {}),
      } as const;
      actorSessionCreateTargets.set(req, target);
      return target;
    }
    try {
      const canonicalRepoPath = fs.realpathSync(requestedRepoPath);
      const canonicalBody = {
        ...body,
        repoPath: canonicalRepoPath,
        ...(requestedWorktreePath
          ? { worktreePath: canonicalTarget }
          : requestedCwd
            ? { cwd: canonicalTarget }
            : {}),
      };
      const target = {
        ok: true,
        path: canonicalTarget,
        repoId: canonicalRepoPath,
        body: canonicalBody,
        ...(topic ? { topic } : {}),
      } as const;
      actorSessionCreateTargets.set(req, target);
      return target;
    } catch {
      const wrongRepo = { ok: false, reason: 'wrong_repo_scope' } as const;
      actorSessionCreateTargets.set(req, wrongRepo);
      return wrongRepo;
    }
  }

  function actorSessionCreateScopeForRequest(req: express.Request): {
    repoIds?: string[];
    pathPrefixes: string[];
  } {
    const target = actorSessionCreateTarget(req);
    if (!target.ok) {
      return { pathPrefixes: [invalidActorSessionCreatePath] };
    }
    return {
      ...(target.repoId ? { repoIds: [target.repoId] } : {}),
      pathPrefixes: [target.path],
    };
  }

  function pathIsWithin(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
  }

  const requireActorSessionCreatePolicy: express.RequestHandler = (
    req,
    res,
    next
  ) => {
    const credential = authenticatedCliGatewayActorCredential(req);
    if (!credential) {
      next();
      return;
    }
    const target = actorSessionCreateTarget(req);
    if (!target.ok) {
      sendCliGatewayActorFailure(
        res,
        cliGatewayActorFailure({ reason: target.reason })
      );
      return;
    }
    const hasAuthorizedPathScope =
      (credential.scope.pathPrefixes?.length ?? 0) > 0;
    const hasAuthorizedRepoScope =
      Boolean(target.repoId) &&
      (credential.scope.repoIds?.length ?? 0) > 0 &&
      pathIsWithin(target.repoId!, target.path);
    const scopedRuntimeId = credential.scope.sessionIds?.[0];
    const persistentOrchestratorRuntime =
      credential.metadata?.reason === 'persistent-orchestrator' &&
      scopedRuntimeId
        ? channelAgentRuntimes.get(scopedRuntimeId)
        : undefined;
    const isBoundPersistentOrchestrator =
      persistentOrchestratorRuntime?.role === 'orchestrator' &&
      persistentOrchestratorRuntime.status === 'active' &&
      persistentOrchestratorRuntime.profileActorId === credential.actor.id &&
      [
        persistentOrchestratorRuntime.cwd,
        persistentOrchestratorRuntime.repoPath,
      ]
        .filter((root): root is string => Boolean(root))
        .some((root) => pathIsWithin(root, target.path));
    if (
      !hasAuthorizedPathScope &&
      !hasAuthorizedRepoScope &&
      !isBoundPersistentOrchestrator
    ) {
      sendCliGatewayActorFailure(
        res,
        cliGatewayActorFailure({ reason: 'missing_scope' })
      );
      return;
    }
    if (
      Object.prototype.hasOwnProperty.call(target.body, 'spawnedBySessionId')
    ) {
      sendCliGatewayActorFailure(
        res,
        cliGatewayActorFailure({ reason: 'wrong_session_scope' })
      );
      return;
    }
    // A channel runtime/profile is not a public terminal session. Scoped actor
    // credentials authorize this explicit create but do not create lineage.
    delete target.body['spawnedBySessionId'];
    if (isRecord(req.body)) {
      delete req.body['spawnedBySessionId'];
    }
    next();
  };

  const requireScopedSessionAuth: express.RequestHandler = (req, res, next) => {
    if (isCliGatewayActorTokenRequest(req)) {
      const id = req.params['id'];
      requireCliGatewayActorAuth(['session:read'], {
        ...(id ? { sessionIds: [id], globalSessionIds: [id] } : {}),
      })(req, res, next);
      return;
    }
    if (authenticatedBrowserSession(req)) {
      next();
      return;
    }
    if (validateScopedToken(bearerScopedToken(req))) {
      next();
      return;
    }
    res.status(401).json(auth.scopedSessionOrBrowserAuthRequiredChallenge());
  };

  const requireScopedSessionAuthForActorCommand = (
    expectedCommand: CliGatewayActorReadCommand
  ): express.RequestHandler => {
    return (req, res, next) => {
      if (isCliGatewayActorTokenRequest(req)) {
        const id = req.params['id'];
        requireCliGatewayActorAuth(
          ['session:read'],
          {
            ...(id ? { sessionIds: [id], globalSessionIds: [id] } : {}),
          },
          expectedCommand
        )(req, res, next);
        return;
      }
      requireScopedSessionAuth(req, res, next);
    };
  };

  const actorLifecycleAuth: express.RequestHandler = (req, res, next) => {
    const body = isRecord(req.body) ? req.body : {};
    if (typeof body['grantHandle'] === 'string') {
      next();
      return;
    }
    requireAuth(req, res, next);
  };

  const actorLifecycleError = (res: express.Response, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      error instanceof Error &&
      'reason' in error &&
      typeof error.reason === 'string'
        ? error.reason
        : 'issue_failed';
    res.status(reason === 'credential_not_found' ? 404 : 400).json({
      error: {
        code: `CLI_ACTOR_CREDENTIAL_${reason.toUpperCase()}`,
        message,
        retryable: false,
      },
    });
  };

  app.post('/cli-gateway/actor-credentials', actorLifecycleAuth, (req, res) => {
    try {
      const body = isRecord(req.body)
        ? (req.body as CliGatewayActorIssueInput)
        : {};
      const issued =
        isRecord(req.body) && typeof req.body['grantHandle'] === 'string'
          ? issueCliGatewayActorCredentialWithGrant(
              cliGatewayActorRegistry,
              cliGatewayHandshakeGrantRegistry,
              req.body
            )
          : issueCliGatewayActorCredential(cliGatewayActorRegistry, body);
      res.status(201).json({
        token: issued.token,
        credential: issued.credential,
      });
    } catch (error) {
      actorLifecycleError(res, error);
    }
  });

  app.get('/cli-gateway/actor-credentials', requireAuth, (_req, res) => {
    res.json({ credentials: cliGatewayActorRegistry.listCredentials() });
  });

  app.post('/cli-gateway/actor-credentials/list', (req, res) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const listed = listCliGatewayActorCredentialsWithGrant(
        cliGatewayActorRegistry,
        cliGatewayHandshakeGrantRegistry,
        body
      );
      res.json(listed);
    } catch (error) {
      actorLifecycleError(res, error);
    }
  });

  app.delete('/cli-gateway/actor-credentials/:id', requireAuth, (req, res) => {
    const id = req.params['id'];
    if (!id) {
      res.status(400).json({
        error: {
          code: 'CLI_ACTOR_CREDENTIAL_ID_REQUIRED',
          message: 'credential id is required',
          retryable: false,
        },
      });
      return;
    }
    const body = isRecord(req.body) ? req.body : {};
    const credential = cliGatewayActorRegistry.revoke(id, {
      revokedBy:
        typeof body['revokedBy'] === 'string'
          ? body['revokedBy']
          : 'browser-operator',
      ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
      ...(typeof body['correlationId'] === 'string'
        ? { correlationId: body['correlationId'] }
        : {}),
    });
    if (!credential) {
      res.status(404).json({
        error: {
          code: 'CLI_ACTOR_CREDENTIAL_NOT_FOUND',
          message: 'credential not found',
          retryable: false,
        },
      });
      return;
    }
    res.json({ credential });
  });

  app.post('/cli-gateway/actor-credentials/:id/revoke', (req, res) => {
    const id = req.params['id'];
    if (!id) {
      res.status(400).json({
        error: {
          code: 'CLI_ACTOR_CREDENTIAL_ID_REQUIRED',
          message: 'credential id is required',
          retryable: false,
        },
      });
      return;
    }
    try {
      const body = isRecord(req.body) ? req.body : {};
      const credential = revokeCliGatewayActorCredentialWithGrant(
        cliGatewayActorRegistry,
        cliGatewayHandshakeGrantRegistry,
        id,
        body
      );
      res.json({ credential });
    } catch (error) {
      actorLifecycleError(res, error);
    }
  });

  app.post('/cli-gateway/actor-credentials/:id/rotate', (req, res) => {
    const id = req.params['id'];
    if (!id) {
      res.status(400).json({
        error: {
          code: 'CLI_ACTOR_CREDENTIAL_ID_REQUIRED',
          message: 'credential id is required',
          retryable: false,
        },
      });
      return;
    }
    try {
      const body = isRecord(req.body) ? req.body : {};
      const rotated = rotateCliGatewayActorCredentialWithGrant(
        cliGatewayActorRegistry,
        cliGatewayHandshakeGrantRegistry,
        id,
        body
      );
      res.status(201).json(rotated);
    } catch (error) {
      actorLifecycleError(res, error);
    }
  });

  const collectLocalInventory = () =>
    collectLocalRepoInventory({
      config: getConfig(),
      configPath: CONFIG_PATH,
    });
  const confirmationChallenges = createConfirmationChallengeStore();
  app.use(
    createHubNodeRouter({
      registry: hubNodeRegistry,
      nodeLinks: hubNodeLinks,
      requireAuth,
      cliGatewayAuth: requireCliGatewayAuth,
      cliGatewayAuthForActorCommand: requireCliGatewayAuthForActorCommand,
      operatorHandshakeGrants: cliGatewayHandshakeGrantRegistry,
      scopedSessionAuth: requireScopedSessionAuth,
      repoInventoryFeature,
      collectLocalRepoInventory: collectLocalInventory,
      confirmations: confirmationChallenges,
      sessionEnvelopes: sessionEnvelopeRegistry,
      renewLocalSession: localRelayNode.sessions.renew,
      releaseRoutedPtyControlSession: sessions.releaseRoutedPtyControlSession,
      releaseRoutedPtyControlSessionsForNode:
        sessions.releaseRoutedPtyControlSessionsForNode,
      workContextStore,
      readModelCache: remoteSessionReadModelCache,
      sourceDiagnostics: {
        strictDeny: process.env.RELAY_NODE_SOURCE_STRICT_DENY === '1',
      },
      ...(securityAuditLog ? { auditSink: securityAuditLog } : {}),
    })
  );
  app.use(
    createRepoFeatureRouter({
      registry: hubNodeRegistry,
      nodeLinks: hubNodeLinks,
      requireAuth,
      repoInventoryFeature,
      collectLocalRepoInventory: collectLocalInventory,
      confirmations: confirmationChallenges,
      sessionEnvelopes: sessionEnvelopeRegistry,
      // #734: legacy workspace groups feed the optional grouping in
      // GET /hub/ia/tree. Read-only projection of config.workspaces; the
      // builder tolerates malformed/missing `repos` arrays.
      listWorkspaceGroups: () =>
        (getConfig().workspaces ?? [])
          .filter((ws): ws is NonNullable<typeof ws> => ws != null)
          .map((ws) => ({
            id: ws.id,
            name: ws.name,
            order: typeof ws.order === 'number' ? ws.order : 0,
            ...(Array.isArray(ws.repos) ? { repos: ws.repos } : {}),
          })),
      // #735: Bench overlay CRUD (env/label + arbitrary-cwd benches) backed by
      // the #737 IA store. Null when the store failed to init → routes 503.
      iaStore,
      ...(securityAuditLog ? { auditSink: securityAuditLog } : {}),
    })
  );
  // #733: Workspace CRUD on the #737 IA store (own `ia.db`, new tables only,
  // non-destructive). Consumes the `iaStore` handle wired above; degrades to
  // 503 if the store failed to init.
  app.use(createIaWorkspaceRouter({ requireAuth, iaStore }));
  // AgentProfile CRUD (#1232): local browser/operator configuration only. The
  // router resolves provider ids through the live configured framework catalog;
  // it never receives or logs framework environment-variable values.
  app.use(
    createAgentProfileRouter({
      store: agentProfileStore,
      listConfiguredFrameworks: () =>
        listConfiguredFrameworks(getConfig().frameworks),
      requireAuth,
    })
  );
  app.use(
    createWorkspaceEvidenceRouter({
      requireAuth,
      getConfig,
      registry: hubNodeRegistry,
      nodeLinks: hubNodeLinks,
    })
  );
  // workspace-surfaces (#784): read-mostly catalogue of dev servers / previews /
  // docs / dashboards / logs / commands for a workspace evidence root. List
  // merges safe static discovery (package.json scripts, docker-compose ports)
  // with persisted agent-published surfaces; publish is an actor-auth write.
  app.use(
    createWorkspaceSurfacesRouter({
      store: workspaceSurfaceStore,
      getConfig,
      requireAuth: requireCliGatewayAuth,
      requireReadAuth: requireCliGatewayAuthForActorCommand(
        'workspace-surfaces.list'
      ),
      requireWriteActorAuth: requireCliGatewayAuthForActorCommand,
    })
  );
  // workspace-topics (#1022): typed topic/workspace ladder foundation. Topics
  // reference WorkspaceSurface ids instead of duplicating surface metadata.
  app.use(
    createWorkspaceTopicsRouter({
      store: workspaceTopicStore,
      surfaceStore: workspaceSurfaceStore,
      workContextStore,
      getConfig,
      requireAuth: requireCliGatewayAuth,
      requireReadActorAuth: requireCliGatewayAuthForActorCommand,
      requireWriteActorAuth: requireCliGatewayAuthForActorCommand,
    })
  );
  // channel conversation core (#1165): channels.* verbs over channel-chat.db.
  // Topic CRUD stays on the workspace-topics routes above; channels are a read/
  // write conversation surface keyed by workspace_topics id. Single write path.
  app.use(
    createChannelChatRouter({
      store: channelMessageStore,
      attachmentStore: channelAttachmentStore,
      hub: channelHub,
      topicStore: workspaceTopicStore,
      binder: channelAgentBinder,
      knownProviderIds: Object.keys(v2Adapters),
      getRuntime: (runtimeId) => {
        const runtime = channelAgentRuntimes.get(runtimeId);
        return runtime
          ? {
              profileActorId: runtime.profileActorId,
              providerId: runtime.providerId,
              ...(runtime.role !== undefined ? { role: runtime.role } : {}),
              status: runtime.status,
            }
          : undefined;
      },
      requireAuth: requireCliGatewayAuth,
      requireReadActorAuth: requireCliGatewayAuthForActorCommand,
      requireWriteActorAuth: requireCliGatewayAuthForActorCommand,
    })
  );
  // #765 / ADR-019: context.* / inbox.* gateway verbs. #759 wires the router
  // to the concrete #758 `ContextPacketStore` via the integration adapter
  // (method renames, throw→result-union remap, PULL-as-delivery flip). When the
  // #758 store failed to init (`contextPacketStore` is null) the routes degrade
  // to 503 SERVER_UNAVAILABLE rather than failing boot.
  const contextInboxStore = deriveContextInboxStore(contextPacketStore);
  app.use(
    createContextInboxRouter({
      requireAuth: requireCliGatewayAuth,
      requireReadActorAuth: requireCliGatewayAuthForActorCommand,
      requireWriteActorAuth: requireCliGatewayAuthForActorCommand,
      store: contextInboxStore,
      workContextStore,
      events: cliGatewayEventBus,
    })
  );
  const workContextScopeFromQuery = (
    req: express.Request
  ): { workContextIds?: string[] } | undefined => {
    const workContextId = readWorkContextArtifactQueryWorkContextId(req.query);
    return workContextId ? { workContextIds: [workContextId] } : undefined;
  };
  const workContextMessageScopeFromBody = (
    req: express.Request
  ): { workContextIds?: string[] } | undefined => {
    const body =
      typeof req.body === 'object' &&
      req.body !== null &&
      !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const filter =
      typeof body['filter'] === 'object' &&
      body['filter'] !== null &&
      !Array.isArray(body['filter'])
        ? (body['filter'] as Record<string, unknown>)
        : body;
    const workContextId =
      typeof filter['workContextId'] === 'string'
        ? filter['workContextId']
        : undefined;
    return workContextId ? { workContextIds: [workContextId] } : undefined;
  };
  const workflowRunScopeFromParams = (
    req: express.Request
  ): { workContextIds?: string[] } | undefined => {
    const workflowRunId =
      typeof req.params['id'] === 'string' ? req.params['id'] : '';
    const workflowRun =
      workflowRunId && workflowRunStore
        ? workflowRunStore.get(workflowRunId)
        : null;
    return workflowRun
      ? { workContextIds: [workflowRun.workContextId] }
      : undefined;
  };
  app.use(
    createWorkContextArtifactRouter({
      requireAuth: requireCliGatewayAuth,
      requireReadAuth: {
        list: requireCliGatewayAuthForActorCommand(
          'work-context-artifacts.list',
          {
            scopeForRequest: workContextScopeFromQuery,
          }
        ),
        show: requireCliGatewayAuthForActorCommand(
          'work-context-artifacts.show',
          {
            deferWorkContextScope: true,
          }
        ),
        export: requireCliGatewayAuthForActorCommand(
          'work-context-artifacts.export',
          {
            deferWorkContextScope: true,
          }
        ),
        handoffList: requireCliGatewayAuthForActorCommand(
          'handoff-artifacts.list',
          {
            scopeForRequest: workContextScopeFromQuery,
          }
        ),
        handoffShow: requireCliGatewayAuthForActorCommand(
          'handoff-artifacts.show',
          {
            deferWorkContextScope: true,
          }
        ),
        handoffCopy: requireCliGatewayAuthForActorCommand(
          'handoff-artifacts.copy',
          {
            deferWorkContextScope: true,
          }
        ),
        doctor: requireCliGatewayAuthForActorCommand(
          'work-context-artifacts.doctor'
        ),
      },
      requireWriteAuth: requireCliGatewayWriteAuth,
      requireWriteActorAuth: requireCliGatewayAuthForActorCommand,
      store: workContextArtifactStore,
      workContextStore,
      events: cliGatewayEventBus,
      diagnostics: {
        dbPath: path.join(configDir, 'work-context-artifacts.db'),
        payloadRoot: path.join(configDir, 'work-context-artifacts', 'payloads'),
        maxPublishBytes: DEFAULT_WORK_CONTEXT_ARTIFACT_PUBLISH_MAX_BYTES,
        maxExportBytes: DEFAULT_WORK_CONTEXT_ARTIFACT_EXPORT_MAX_BYTES,
      },
    })
  );
  app.use(
    createWorkflowRunRouter({
      requireAuth: requireCliGatewayAuth,
      requireReadAuth: {
        list: requireCliGatewayAuthForActorCommand('workflow-runs.list', {
          scopeForRequest: workContextScopeFromQuery,
        }),
        get: requireCliGatewayAuthForActorCommand('workflow-runs.get', {
          scopeForRequest: workflowRunScopeFromParams,
        }),
      },
      requireWriteActorAuth: requireCliGatewayAuthForActorCommand,
      store: workflowRunStore,
      workContextStore,
      events: cliGatewayEventBus,
    })
  );
  // automation-runs (#959): Relay-visible registry of operator crons / watchdogs
  // driving Relay sessions. The liveness resolver probes the live local session
  // registry so a watcher pointed at a session id that no longer exists derives
  // a `gone` target → `cleanup-needed` status, a finished session derives
  // `ended`, and a remote-node-scoped target derives `unknown` (cross-node
  // target liveness is a documented follow-up).
  const automationRunLivenessResolver: AutomationRunLivenessResolver = (
    target
  ) =>
    resolveAutomationRunTargetLiveness(
      target,
      localRelayNode.sessions.list(),
      DEFAULT_LOCAL_NODE_ID
    );
  const automationRunScopeFromParams = (
    req: express.Request
  ): { workContextIds?: string[] } | undefined => {
    const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
    const run = id && automationRunStore ? automationRunStore.get(id) : null;
    return run?.workContextId
      ? { workContextIds: [run.workContextId] }
      : undefined;
  };
  app.use(
    createAutomationRunRouter({
      requireAuth: requireCliGatewayAuth,
      requireReadAuth: {
        list: requireCliGatewayAuthForActorCommand('automation-runs.list', {
          scopeForRequest: workContextScopeFromQuery,
        }),
        get: requireCliGatewayAuthForActorCommand('automation-runs.get', {
          scopeForRequest: automationRunScopeFromParams,
        }),
      },
      requireWriteActorAuth: requireCliGatewayAuthForActorCommand,
      store: automationRunStore,
      resolveLiveness: automationRunLivenessResolver,
      workContextStore,
      events: cliGatewayEventBus,
    })
  );
  // pr-overseer (#960, refs #956): link a Relay terminal, issue, or WorkContext
  // to the GitHub PR it is shipping and observe checks/reviews/mergeability/issue
  // closeout. The gh-CLI-backed observer fetches a fresh snapshot only on
  // `observe` (reads stay GitHub-free); it never throws, so a missing/unauth `gh`
  // degrades to a failed-fetch snapshot rather than breaking the registry. No
  // merge/approve action exists here — the primitive observes and emits exact-head
  // evidence; the release decision stays with the authorized tester/release agent.
  const prObserver = createGhPrObserver();
  const prOverseerScopeFromParams = (
    req: express.Request
  ): { workContextIds?: string[] } | undefined => {
    const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
    const run = id && prOverseerStore ? prOverseerStore.get(id) : null;
    return run?.workContextId
      ? { workContextIds: [run.workContextId] }
      : undefined;
  };
  app.use(
    createPrOverseerRouter({
      requireAuth: requireCliGatewayAuth,
      requireReadAuth: {
        list: requireCliGatewayAuthForActorCommand('pr-overseer.list', {
          scopeForRequest: workContextScopeFromQuery,
        }),
        get: requireCliGatewayAuthForActorCommand('pr-overseer.get', {
          scopeForRequest: prOverseerScopeFromParams,
        }),
      },
      requireWriteActorAuth: requireCliGatewayAuthForActorCommand,
      store: prOverseerStore,
      observer: prObserver,
      workContextStore,
      events: cliGatewayEventBus,
    })
  );
  app.use(
    createWorkContextMessageRouter({
      requireAuth: requireCliGatewayAuth,
      requireReadAuth: {
        list: requireCliGatewayAuthForActorCommand(
          'work-context-messages.list',
          {
            scopeForRequest: workContextScopeFromQuery,
            deferWorkContextScope: true,
          }
        ),
        query: requireCliGatewayAuthForActorCommand(
          'work-context-messages.query',
          {
            scopeForRequest: workContextMessageScopeFromBody,
            deferWorkContextScope: true,
          }
        ),
        show: requireCliGatewayAuthForActorCommand(
          'work-context-messages.show',
          {
            deferWorkContextScope: true,
          }
        ),
        templateList: requireCliGatewayAuthForActorCommand(
          'work-context-messages.templates.list',
          {
            scopeForRequest: workContextScopeFromQuery,
            deferWorkContextScope: true,
          }
        ),
        templateShow: requireCliGatewayAuthForActorCommand(
          'work-context-messages.templates.show',
          {
            scopeForRequest: workContextScopeFromQuery,
            deferWorkContextScope: true,
          }
        ),
        templateRender: requireCliGatewayAuthForActorCommand(
          'work-context-messages.templates.render',
          {
            scopeForRequest: workContextMessageScopeFromBody,
            deferWorkContextScope: true,
          }
        ),
      },
      requireWriteActorAuth: requireCliGatewayAuthForActorCommand,
      store: workContextMessageStore,
      workContextStore,
      events: cliGatewayEventBus,
    })
  );
  // #766/#759: production `AnchorFileFetcher` wired to the session-scoped File
  // RPC path under `rpc:fs:read`. Resolves an anchor's `current` ref by routing
  // an `fs.read`/`fs.stat` through a live scoped session on the owning node
  // whose root contains the path; never local-stats (C1). The anchor
  // `stale`-derivation consumer (inbox decoration / #760) calls `resolveAnchor`
  // with this fetcher; built here so it shares the live registry/link/envelope
  // handles and is exposed for that follow-up wiring.
  const anchorFileFetcher: AnchorFileFetcher = createAnchorFileFetcher({
    registry: hubNodeRegistry,
    nodeLinks: hubNodeLinks,
    sessionEnvelopes: sessionEnvelopeRegistry,
  });
  // Anchor resolution (#766) decorates a packet's `AnchorState` at read time.
  // The #760 lane wires that decoration into `context.get`/`inbox.*` via the
  // context-inbox router (it calls `resolveAnchorWithRegisteredFetcher`).
  registerAnchorFileFetcher(anchorFileFetcher);
  // #760: production `FileRangeContentFetcher` for the file-range adapter's
  // CONTENT expansion. Reuses the same session-scoped File RPC `read` path under
  // `rpc:fs:read`; shares the live registry/link/envelope handles. Registered so
  // `expandFileRangePacket` can read a bounded slice without threading deps.
  const anchorContentFetcher: FileRangeContentFetcher =
    createAnchorContentFetcher({
      registry: hubNodeRegistry,
      nodeLinks: hubNodeLinks,
      sessionEnvelopes: sessionEnvelopeRegistry,
    });
  registerFileRangeContentFetcher(anchorContentFetcher);
  app.use(
    createCliGatewayEventsRouter(express, {
      cliGatewayAuth: requireCliGatewayEventsAuth,
      eventBus: cliGatewayEventBus,
      hooks: {
        onSessionCreate: (cb) => sessions.onSessionCreate(cb),
        onSessionEnd: (cb) => sessions.onSessionEnd(cb),
        onControlEvent: (cb) => sessions.onControlEvent(cb),
        onNodeStatus: (cb) => hubNodeRegistry.onNodeStatus(cb),
      },
    })
  );
  app.use(
    '/cli-gateway',
    createCliGatewaySettingsRouter({
      configPath: CONFIG_PATH,
      // Settings/webhook configuration remains browser-operator-only until
      // scoped actor credentials carry explicit settings/webhook grants.
      // Do not let CLI callers self-assert capability bits in headers.
      requireAuth,
    })
  );

  const webhookManagerRouter = createWebhookManagerRouter({
    configPath: CONFIG_PATH,
    broadcastEvent: (type, data) => {
      broadcastEventDelegate?.(type, data);
    },
    requireAuth,
  });
  app.use('/webhooks/manage', webhookManagerRouter);

  function boolConfigEndpoints(
    name: string,
    defaultValue: boolean,
    onEnable?: () => Promise<void>
  ) {
    app.get(
      `/config/${name}`,
      requireAuth,
      (_req: express.Request, res: express.Response) => {
        res.json({
          [name]:
            (getConfig() as unknown as Record<string, unknown>)[name] ??
            defaultValue,
        });
      }
    );
    app.patch(
      `/config/${name}`,
      requireAuth,
      async (req: express.Request, res: express.Response) => {
        const value = (req.body as Record<string, unknown>)[name];
        if (typeof value !== 'boolean') {
          res.status(400).json({ error: `${name} must be a boolean` });
          return;
        }
        if (value && onEnable) {
          try {
            await onEnable();
          } catch {
            res.status(400).json({ error: `Validation failed for ${name}` });
            return;
          }
        }
        const c = getConfig();
        (c as unknown as Record<string, unknown>)[name] = value;
        saveConfig(CONFIG_PATH, c);
        res.json({ [name]: value });
      }
    );
  }

  app.get('/config/terminalBackend', requireAuth, (_req, res) => {
    const c = getConfig();
    res.json({
      terminalBackend: defaultTerminalBackend(c),
      allowed: [TERMINAL_BACKEND_RELAY_PTY],
    });
  });
  app.patch('/config/terminalBackend', requireAuth, async (req, res) => {
    const value = normalizeTerminalBackend(
      (req.body as Record<string, unknown>).terminalBackend
    );
    if (!value) {
      res.status(400).json({
        error: 'terminalBackend must be relay-pty',
      });
      return;
    }
    const c = getConfig();
    c.terminalBackend = value;
    saveConfig(CONFIG_PATH, c);
    res.json({ terminalBackend: value, required: false });
  });

  const watcher = new WorktreeWatcher();
  watcher.rebuild(getConfig().repos || []);

  // GitWatcher owns one refcounted cwd watch per session id. Central session-end
  // cleanup is safe even though PTY explicit kill can fire session-end twice:
  // unwatchSession(id) consumes that session's ownership once and subsequent
  // notifications are no-ops, without decrementing another session at the cwd.
  const gitWatcher = new GitWatcher();
  sessions.onSessionEnd((sessionId) => gitWatcher.unwatchSession(sessionId));

  const server = http.createServer(app);
  const { broadcastEvent, broadcastBranchChanged } = setupWebSocket(
    server,
    authenticatedTokens,
    watcher,
    CONFIG_PATH,
    false,
    localRelayNode,
    hubNodeRegistry,
    hubNodeLinks,
    sessionEnvelopeRegistry,
    securityAuditLog,
    { strictDeny: process.env.RELAY_NODE_SOURCE_STRICT_DENY === '1' },
    channelHub
  );
  // Coarse per-agent status rides the existing /ws/events lane (#1167 §6),
  // mirroring the sidebar-badge broadcaster pattern.
  channelAgentBinder?.setStatusBroadcaster(broadcastEvent);

  const browserScopedToken = generateScopedToken();
  process.env['RELAY_IDE_BROWSER'] = '1';
  process.env['RELAY_IDE_BROWSER_CMD'] = 'relay-ide browser';
  process.env['RELAY_IDE_BROWSER_TOKEN'] = browserScopedToken;
  if (!process.env['RELAY_IDE_PORT']) {
    process.env['RELAY_IDE_PORT'] = String(startupConfig.port);
  }

  // Wire up the delegate used by the webhook router (mounted before broadcastEvent was available).
  // Webhook broadcasts may include workspace paths for targeted cache invalidation.
  broadcastEventDelegate = (type, data) => {
    if (type === 'pr-updated' || type === 'ci-updated') {
      const workspacePaths = data?.workspacePaths;
      if (Array.isArray(workspacePaths)) {
        for (const workspacePath of workspacePaths) {
          if (typeof workspacePath !== 'string') continue;
          clearDashboardPrCache(workspacePath);
          if (type === 'pr-updated') clearPrCache(workspacePath);
          if (type === 'ci-updated') clearCiStatusCache(workspacePath);
        }
      } else {
        clearDashboardPrCache();
        if (type === 'pr-updated') clearPrCache();
        if (type === 'ci-updated') clearCiStatusCache();
      }
    }
    broadcastEvent(type, data);
  };

  gitWatcher.on(
    'files-changed',
    (data: { workspacePath: string; changedFiles?: string[] }) => {
      broadcastEvent('files-changed', {
        workspacePath: data.workspacePath,
        changedFiles: data.changedFiles,
      });
      clearFilesListCache(data.workspacePath);
    }
  );

  // Watch .git/HEAD files for branch changes and update active sessions
  const branchWatcher = new BranchWatcher((cwdPath, newBranch) => {
    for (const session of localRelayNode.sessions.list()) {
      // Match by worktreePath or repoPath — session.cwd can drift to subdirectories
      const groupPath = session.worktreePath ?? session.repoPath;
      if (groupPath === cwdPath) {
        const raw = localRelayNode.sessions.get(session.id);
        if (raw) {
          raw.branchName = newBranch;
          broadcastEvent('session-renamed', {
            sessionId: session.id,
            branchName: newBranch,
            displayName: raw.displayName,
          });
        }
      }
    }
    broadcastBranchChanged(cwdPath, newBranch);
    // Rebuild ref watchers when branches change (new upstream to watch)
    rebuildRefWatcher();
  });
  branchWatcher.rebuild(getConfig().repos || []);
  watcher.on('worktrees-changed', () => {
    branchWatcher.rebuild(getConfig().repos || []);
    queuePortReconciliation(getConfig().repos || []);
  });

  // Watch upstream tracking refs for push/fetch and broadcast ref-changed events
  const refWatcher = new RefWatcher((cwdPath, branch) => {
    broadcastEvent('ref-changed', { cwdPath, branch });
    // Clear all PR cache — cwdPath may be a worktree path that doesn't match workspace cache keys
    clearPrCache();
  });

  let refWatcherRebuildPending = false;
  let refWatcherNeedsRebuild = false;
  function rebuildRefWatcher(): void {
    if (refWatcherRebuildPending) {
      refWatcherNeedsRebuild = true;
      return;
    }
    refWatcherRebuildPending = true;
    refWatcherNeedsRebuild = false;
    const entries = sessions
      .list()
      .flatMap((s) =>
        s.branchName ? [{ cwdPath: s.cwd, branch: s.branchName }] : []
      );
    refWatcher.rebuild(entries).finally(() => {
      refWatcherRebuildPending = false;
      if (refWatcherNeedsRebuild) rebuildRefWatcher();
    });
  }

  rebuildRefWatcher();
  sessions.onSessionCreate(() => rebuildRefWatcher());
  sessions.onSessionEnd(() => rebuildRefWatcher());

  // Wire session durability (#614) to hub-side node link health:
  //   resolver maps a session's owning nodeId to the hub's view of that
  //   node's connection state, so derivation can surface `stale-node`
  //   without bothering local-only sessions.
  sessions.setSessionNodeStatusResolver((nodeId) => {
    if (!nodeId || nodeId === 'local') return null;
    const node = hubNodeRegistry
      .listNodes()
      .find((candidate) => candidate.nodeId === nodeId);
    if (!node) return null;
    const status = node.status;
    if (
      status === 'online' ||
      status === 'stale' ||
      status === 'offline' ||
      status === 'revoked'
    ) {
      return status;
    }
    return null;
  });
  hubNodeRegistry.onNodeStatus(() => {
    // Node status changed — re-derive every session so attach-safety
    // consumers see `stale-node` transitions without waiting on `list()`.
    sessions.refreshDurability();
  });

  // Configure session defaults for hooks injection (startup-only — changing these requires restart)
  sessions.configure({
    ...buildSessionConfig(startupConfig, configDir, securityAuditLog),
  });
  configureChannelAgentRuntimes({
    orchestratorCredentials: {
      issueCredential: (input) =>
        issuePersistentOrchestratorCliGatewayActorCredential(
          cliGatewayActorRegistry,
          input
        ),
      revokeCredential: (credentialId, input) =>
        cliGatewayActorRegistry.revoke(credentialId, input),
    },
  });

  // Mount hooks router BEFORE auth middleware — hook callbacks come from localhost Claude Code
  const hooksRouter = createHooksRouter({
    getRuntime: (id) => channelAgentRuntimes.get(id),
  });
  app.use('/hooks', hooksRouter);

  // Mount workspace router — rebuild watchers when workspaces are added or removed
  const workspaceRouter = createWorkspaceRouter({
    configPath: CONFIG_PATH,
    onWorktreeCreated: () => broadcastEvent('worktrees-changed'),
    onWorkspacesChanged: () => {
      setImmediate(() => {
        try {
          const repoPaths = getConfig().repos || [];
          watcher.rebuild(repoPaths);
          branchWatcher.rebuild(repoPaths);
          queuePortReconciliation(repoPaths);
        } catch (err) {
          logger.error('Failed to rebuild workspace watchers:', err);
        }
      });
    },
  });
  app.use('/workspaces', requireCliGatewayWriteAuth, workspaceRouter);

  // Mount git (local/fast) and gh (network/slow) routers
  app.use(
    '/git',
    requireAuth,
    createGitRouter({
      configPath: CONFIG_PATH,
      getConfig,
      getSessions: () =>
        localRelayNode.sessions.list().flatMap((s) => {
          const worktreePath = s.worktreePath ?? s.repoPath;
          return worktreePath ? [{ id: s.id, worktreePath }] : [];
        }),
    })
  );
  app.use('/gh', requireAuth, createGhRouter());

  // Mount workspace-groups CRUD router
  app.use(
    '/workspace-groups',
    createWorkspaceGroupsRouter(CONFIG_PATH, requireCliGatewayWriteAuth, {
      sessions,
      gitWatcher,
      configPath: CONFIG_PATH,
    })
  );

  // Mount workbench layout persistence router
  // GET/PUT /workspace-groups/:id/workbench-layout
  app.use(
    '/workspace-groups',
    requireAuth,
    createWorkbenchLayoutRouter({ configPath: CONFIG_PATH })
  );

  // Mount workbench custom block proposal router (slice 4, #622)
  // POST/GET/POST /workbench/custom-blocks/proposals[/:id/(approve|reject|revoke)]
  app.use(
    '/workbench/custom-blocks',
    requireAuth,
    createWorkbenchCustomBlocksRouter({
      configPath: CONFIG_PATH,
      auditSink: securityAuditLog,
    })
  );

  // Mount workbench propose-block router (slice 5, #625)
  // POST /workbench/propose-block — agent proposes any block kind
  // GET  /workbench/propose-block/proposals — list first-party proposals
  // POST /workbench/propose-block/proposals/:id/(approve|reject)
  app.use(
    '/workbench',
    requireAuth,
    createWorkbenchProposeBlockRouter({
      configPath: CONFIG_PATH,
      auditSink: securityAuditLog,
    })
  );

  // Mount GitHub integration router
  const integrationGitHubRouter = createIntegrationGitHubRouter({
    configPath: CONFIG_PATH,
  });
  app.use('/integration-github', requireAuth, integrationGitHubRouter);

  // Mount Jira integration router
  const integrationJiraRouter = createIntegrationJiraRouter({
    configPath: CONFIG_PATH,
  });
  app.use('/integration-jira', requireAuth, integrationJiraRouter);

  // Mount branch linker router
  const branchLinkerRouter = createBranchLinkerRouter({
    configPath: CONFIG_PATH,
    getActiveBranchNames: () => {
      const map = new Map<string, Set<string>>();
      for (const s of localRelayNode.sessions.list()) {
        if (!s.branchName) continue;
        // Use repoPath so all sessions (main worktree and sub-worktrees) group correctly
        const wsRoot = s.repoPath || s.cwd;
        const existing = map.get(wsRoot);
        if (existing) {
          existing.add(s.branchName);
        } else {
          map.set(wsRoot, new Set([s.branchName]));
        }
      }
      return map;
    },
  });
  app.use('/branch-linker', requireAuth, branchLinkerRouter);

  // Mount ticket transitions router
  const { router: ticketTransitionsRouter, checkPrTransitions } =
    createTicketTransitionsRouter({ configPath: CONFIG_PATH });
  app.use('/ticket-transitions', requireAuth, ticketTransitionsRouter);

  // Mount GitHub device flow auth
  // onConnected is called after token save; reload smee so it picks up any new config.
  const githubAppRouter = createGitHubAppRouter({
    configPath: CONFIG_PATH,
    clientId: process.env.GITHUB_CLIENT_ID || DEFAULT_GITHUB_CLIENT_ID,
    onConnected: () => {
      reloadSmee(CONFIG_PATH, startupConfig.port);
    },
  });
  app.use('/auth/github', requireAuth, githubAppRouter);

  // Mount org dashboard router — use GraphQL when token available, fall back to gh CLI
  const orgDashboardRouter = createOrgDashboardRouter({
    configPath: CONFIG_PATH,
    checkPrTransitions,
    getBranchLinks: () => branchLinkerRouter.fetchLinks(),
    fetchGraphQL: fetchPrsGraphQL,
  });
  app.use('/org-dashboard', requireAuth, orgDashboardRouter);

  // Mount analytics router
  app.use('/analytics', requireAuth, createAnalyticsRouter(configDir));
  app.use('/api/analytics', requireAuth, createSessionAnalyticsRouter());
  app.use('/telemetry', requireAuth, createTelemetryRouter());
  app.use(
    '/handoffs',
    createHandoffRouter({
      requireAuth: requireCliGatewayAuth,
      getCapabilities: validatedHandoffCapabilities,
      workContextStore,
      getSession: (nodeId, sessionId) => {
        if (nodeId !== 'local') return undefined;
        return localRelayNode.sessions
          .list()
          .find((session) => session.id === sessionId);
      },
    })
  );
  app.use(
    '/work-contexts',
    createWorkContextRouter({
      store: workContextStore,
      artifactStore: workContextArtifactStore,
      requireAuth,
      requireReadAuth: {
        get: (req, res, next) => {
          if (isCliGatewayActorTokenRequest(req)) {
            const id = req.params['id'];
            requireCliGatewayActorAuth(
              ['session:read'],
              {
                ...(id ? { workContextIds: [id] } : {}),
              },
              'work-contexts.get'
            )(req, res, next);
            return;
          }
          if (isCliGatewayV1Request(req)) {
            requireCliGatewayAuth(req, res, next);
            return;
          }
          requireAuth(req, res, next);
        },
        resume: (req, res, next) => {
          if (isCliGatewayActorTokenRequest(req)) {
            const id = req.params['id'];
            requireCliGatewayActorAuth(
              ['session:read'],
              {
                ...(id ? { workContextIds: [id] } : {}),
              },
              'work-contexts.resume'
            )(req, res, next);
            return;
          }
          if (isCliGatewayV1Request(req)) {
            requireCliGatewayAuth(req, res, next);
            return;
          }
          requireAuth(req, res, next);
        },
      },
      getSessions: async () => {
        const [localSessions, remoteSessions] = await Promise.all([
          Promise.resolve(
            localRelayNode.sessions
              .list()
              .map((session) =>
                withWorkContextMetadata(workContextStore, session)
              )
          ),
          aggregateRemoteSessions({
            registry: hubNodeRegistry,
            nodeLinks: hubNodeLinks,
            logger,
            sessionEnvelopes: sessionEnvelopeRegistry,
            workContextStore,
            readModelCache: remoteSessionReadModelCache,
          }),
        ]);
        return [...localSessions, ...remoteSessions];
      },
      getNodes: () => hubNodeRegistry.listNodes(),
    })
  );

  // POST /api/frontend-log — relay frontend logs to the server log file
  app.post('/api/frontend-log', requireAuth, (req, res) => {
    const entries = req.body as Array<{
      ts?: string;
      level?: string;
      ns?: string;
      msg?: string;
    }>;
    if (!Array.isArray(entries)) {
      res.status(400).end();
      return;
    }
    const frontendLogger = createLogger('frontend');
    for (const e of entries.slice(0, 50)) {
      const level =
        e.level === 'warn' || e.level === 'error' ? e.level : 'info';
      const ns = typeof e.ns === 'string' ? e.ns : '?';
      const msg = typeof e.msg === 'string' ? e.msg : '';
      frontendLogger[level](`[${ns}] ${msg}`);
    }
    res.status(204).end();
  });

  // GET /api/frameworks — returns available agent frameworks with capabilities
  app.get('/api/frameworks', requireAuth, async (_req, res) => {
    const frameworks = await getFrameworkClientInfoWithRuntime(
      getConfig().frameworks
    );
    res.json({ frameworks });
  });

  // GET /api/node/manifest — reports local node platform, service, and capability probes.
  app.get('/api/node/manifest', requireAuth, async (_req, res) => {
    const manifest = await getNodeManifest({ config: getConfig() });
    res.json({ manifest });
  });

  // POST /api/command-center/resolve — natural-language Command Center resolver.
  // The response is the shared resolver contract plus redacted audit metadata;
  // raw prompts, provider payloads, and inferred args stay out of durable logs.
  app.post('/api/command-center/resolve', requireAuth, async (req, res) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (query.length === 0) {
        res.status(400).json({ error: 'query is required' });
        return;
      }
      if (query.length > 2_000) {
        res.status(400).json({ error: 'query is too long' });
        return;
      }

      const config = readCommandCenterIntentResolverConfig();
      const provider = config
        ? createOpenAiCompatibleCommandCenterIntentProvider(config, {
            fetch: globalThis.fetch,
          })
        : null;
      const result = await resolveCommandCenterIntent(
        { query },
        {
          provider,
          ...(config ? { minConfidence: config.minConfidence } : {}),
        }
      );
      res.json(result);
    } catch (error) {
      logger.error('Command Center resolver failed unexpectedly', error);
      res.status(500).json({ error: 'command-center-resolver-failed' });
    }
  });

  type CommandCenterActorValidationFailure = Extract<
    ReturnType<typeof validateCliGatewayActorCredential>,
    { reason: unknown }
  >;

  const sendCommandCenterActorValidationFailure = (
    res: express.Response,
    validation: CommandCenterActorValidationFailure,
    correlationId: string | undefined
  ) => {
    sendCliGatewayActorFailure(
      res,
      cliGatewayActorFailure({
        reason: validation.reason,
        ...(validation.credentialId
          ? { credentialId: validation.credentialId }
          : {}),
        deniedBits: validation.deniedBits,
        ...(correlationId ? { correlationId } : {}),
      })
    );
  };

  const sendCommandCenterInvalidRequest = (
    res: express.Response,
    reasonCode: string,
    message: string
  ) => {
    res.status(400).json({
      error: {
        code: 'INVALID_ARGUMENT',
        message,
        retryable: false,
        reasonCode,
      },
    });
  };

  const validateCommandCenterActorCredentialFor = (
    req: express.Request,
    commandId: string,
    args: unknown,
    correlationId: string | undefined
  ) => {
    const entry = COMMAND_CENTER_RESOLVER_CATALOG.byCommandId.get(
      commandId as RelayCliGatewayCommand
    );
    if (!entry || !isRecord(args)) return undefined;
    const argErrors = validateCommandCenterArgs(args, entry.inputSchema);
    if (argErrors.length > 0) return undefined;
    const requestedScope = commandCenterActorCredentialScopeFor(entry, args);
    return validateCliGatewayActorCredential(cliGatewayActorRegistry, {
      token: bearerActorToken(req),
      capabilities: entry.capabilityHints,
      ...(requestedScope ? { scope: requestedScope } : {}),
      ...(correlationId ? { correlationId } : {}),
    });
  };

  const authenticateCommandCenterExecutionRequest = (
    req: express.Request,
    res: express.Response,
    commandId: string,
    args: unknown
  ) => {
    const correlationId = cliGatewayCorrelationId(req);
    if (isCliGatewayActorTokenRequest(req)) {
      const validation = validateCommandCenterActorCredentialFor(
        req,
        commandId,
        args,
        correlationId
      );
      if (!validation) {
        sendCommandCenterInvalidRequest(
          res,
          'COMMAND_CENTER_ACTOR_SCOPE_UNRESOLVED',
          'Command Center actor requests require a known command and valid args before execution.'
        );
        return null;
      }
      if ('reason' in validation) {
        sendCommandCenterActorValidationFailure(res, validation, correlationId);
        return null;
      }
      attachAuthenticatedCliGatewayActorCredential(req, validation.credential);
      return { actorCredential: validation.credential, correlationId };
    }

    let authorized = false;
    requireCliGatewayAuth(req, res, () => {
      authorized = true;
    });
    if (!authorized) return null;
    return {
      actorCredential: authenticatedCliGatewayActorCredential(req),
      correlationId,
    };
  };

  const createCommandCenterActorScopeValidator =
    (req: express.Request, correlationId: string | undefined) =>
    ({
      requestedScope,
      requiredCapabilities,
    }: CommandCenterActorScopeValidationInput) => {
      const validation = validateCliGatewayActorCredential(
        cliGatewayActorRegistry,
        {
          token: bearerActorToken(req),
          capabilities: requiredCapabilities,
          ...(requestedScope ? { scope: requestedScope } : {}),
          ...(correlationId ? { correlationId } : {}),
        }
      );
      return 'reason' in validation
        ? {
            ok: false as const,
            reason: validation.reason,
            ...(validation.credentialId
              ? { credentialId: validation.credentialId }
              : {}),
            deniedBits: validation.deniedBits,
          }
        : { ok: true as const };
    };

  // POST /api/command-center/execute — execute one already-resolved typed
  // read-only Relay command through the same manifest/catalog policy boundary.
  // This route never accepts shell strings or prompt payloads; audit metadata
  // logs command/result/latency plus hashed args only.
  app.post('/api/command-center/execute', async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const commandId = typeof body.commandId === 'string' ? body.commandId : '';
    const args = Object.prototype.hasOwnProperty.call(body, 'args')
      ? body.args
      : {};
    let confirmation: CommandCenterExecutionConfirmationInput | undefined;
    if (Object.prototype.hasOwnProperty.call(body, 'confirmation')) {
      const confirmationBody = body.confirmation;
      if (
        !isRecord(confirmationBody) ||
        typeof confirmationBody['challengeId'] !== 'string' ||
        (confirmationBody['decision'] !== 'confirm' &&
          confirmationBody['decision'] !== 'deny')
      ) {
        sendCommandCenterInvalidRequest(
          res,
          'COMMAND_CENTER_CONFIRMATION_INVALID',
          'Command Center confirmation must include a challengeId and confirm/deny decision.'
        );
        return;
      }
      confirmation = {
        challengeId: confirmationBody['challengeId'],
        decision: confirmationBody['decision'],
      };
    }

    const authContext = authenticateCommandCenterExecutionRequest(
      req,
      res,
      commandId,
      args
    );
    if (!authContext) return;
    const { actorCredential, correlationId } = authContext;

    const trustedCapabilities = actorCredential
      ? {
          source: 'actor-grant' as const,
          capabilities: actorCredential.capabilities,
          actorId: actorCredential.actor.id,
        }
      : authenticatedBrowserSession(req)
        ? {
            source: 'browser-session' as const,
            capabilities: RELAY_CAPABILITY_BITS,
          }
        : undefined;

    const listSessions = async () => {
      const [localSessions, remoteSessions] = await Promise.all([
        Promise.resolve(
          localRelayNode.sessions
            .list()
            .map((session) =>
              withWorkContextMetadata(workContextStore, session)
            )
        ),
        aggregateRemoteSessions({
          registry: hubNodeRegistry,
          nodeLinks: hubNodeLinks,
          logger,
          sessionEnvelopes: sessionEnvelopeRegistry,
          workContextStore,
          readModelCache: remoteSessionReadModelCache,
        }),
      ]);
      return [...localSessions, ...remoteSessions];
    };

    const findSession = async (id: string) => {
      const local = localRelayNode.sessions
        .list()
        .map((session) => withWorkContextMetadata(workContextStore, session))
        .find((session) => session.id === id || session.globalSessionId === id);
      if (local) return local;
      const remoteSessions = await aggregateRemoteSessions({
        registry: hubNodeRegistry,
        nodeLinks: hubNodeLinks,
        logger,
        sessionEnvelopes: sessionEnvelopeRegistry,
        workContextStore,
        readModelCache: remoteSessionReadModelCache,
      });
      return remoteSessions.find(
        (session) => session.id === id || session.globalSessionId === id
      );
    };

    const handlers: Partial<
      Record<RelayCliGatewayCommand, CommandCenterReadOnlyHandler>
    > = {
      'nodes.list': () => ({
        ok: true,
        data: { nodes: hubNodeRegistry.listNodes() },
      }),
      'sessions.list': async () => ({
        ok: true,
        data: { sessions: await listSessions() },
      }),
      'sessions.get': async (commandArgs) => {
        const id = commandArgs['id'];
        if (typeof id !== 'string' || !id.trim()) {
          return {
            ok: false,
            kind: 'unavailable',
            reason: 'not-found',
            message: 'session id is required',
          };
        }
        const found = await findSession(id.trim());
        if (!found) {
          return {
            ok: false,
            kind: 'unavailable',
            reason: 'not-found',
            message: 'session was not found',
            details: { sessionId: id },
          };
        }
        return { ok: true, data: found };
      },
      'settings.get': () => ({
        ok: true,
        data: {
          settings: safeSettingsFromConfig(getConfig()),
          redaction: {
            rawConfigReturned: false,
            secretsReturned: false,
            tokenMaterialReturned: false,
          },
        },
      }),
      'webhooks.status': () => ({
        ok: true,
        data: webhookStatusFromConfig(getConfig()),
      }),
    };

    const executionRequest: CommandCenterExecutionRequest = {
      commandId,
      args,
      ...(confirmation ? { confirmation } : {}),
    };

    const result = await executeCommandCenterCommand(executionRequest, {
      handlers,
      trustedCapabilities,
      ...(actorCredential
        ? {
            validateActorScope: createCommandCenterActorScopeValidator(
              req,
              correlationId
            ),
          }
        : {}),
      auditSink: (audit) =>
        logger.info('Command Center execution audit', audit),
    });
    res.json(result);
  });

  startTelemetry({
    getActiveSessions: sessions.list,
    broadcastEvent,
    configDir,
  });
  startEventBatching();

  // Run retention cleanup and orphan recovery at startup
  runStartupRetentionCleanup();

  // Periodic rate limit snapshot recording (every 5 minutes)
  let lastRateLimitSnapshot = 0;
  const RATE_LIMIT_SNAPSHOT_INTERVAL = 5 * 60 * 1000;
  const rateLimitSnapshotTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastRateLimitSnapshot < RATE_LIMIT_SNAPSHOT_INTERVAL) return;
    const account = Object.values(getAccountTelemetry())
      .filter((entry) => entry.rateLimits.length > 0)
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )[0];
    if (!account) return;
    const fiveHour = account.rateLimits.find(
      (rl) => rl.name === 'five_hour' || rl.windowMinutes === 300
    );
    if (!fiveHour || fiveHour.usedPercent < 0) return;
    lastRateLimitSnapshot = now;
    recordRateLimitSnapshot({
      windows: account.rateLimits,
      timestamp: new Date().toISOString(),
    });
  }, 60_000);
  rateLimitSnapshotTimer.unref();

  // Schedule daily retention cleanup
  const retentionCleanupTimer = setInterval(
    () => {
      try {
        runRetentionCleanup();
      } catch {
        /* non-fatal */
      }
    },
    24 * 60 * 60 * 1000
  );
  retentionCleanupTimer.unref();

  // Populate session metadata cache in background (non-blocking)
  populateMetaCache().catch(() => {});

  // Build shared deps for review poller
  function buildPollerDeps() {
    return {
      configPath: CONFIG_PATH,
      getWorkspacePaths: () => getConfig().repos ?? [],
      broadcastEvent,
    };
  }

  // Start review request poller if enabled
  if (getConfig().automations?.autoCheckoutReviewRequests) {
    startPolling(buildPollerDeps());
  }

  // Start smee-client via webhook-manager
  reloadSmee(CONFIG_PATH, startupConfig.port);

  // Invalidate branch linker cache on session lifecycle changes
  sessions.onSessionCreate(() => {
    invalidateBranchLinkerCache();
  });
  sessions.onSessionEnd(() => {
    invalidateBranchLinkerCache();
  });

  sessions.onSessionEnd((sessionId) => {
    // 1-second grace period for in-flight hooks before computing final metrics
    setTimeout(() => {
      // Capture final telemetry snapshot
      const telemetry = getTelemetryForSession(sessionId);
      if (telemetry) {
        upsertSessionRollup({
          sessionId,
          ...(telemetry.model !== null ? { model: telemetry.model } : {}),
          totalInputTokens: telemetry.totalInputTokens,
          totalOutputTokens: telemetry.totalOutputTokens,
          totalCacheRead: telemetry.totalCacheRead,
          totalCacheWrite: telemetry.totalCacheWrite,
        });
      }

      flushEventBuffer(sessionId);
      const metrics = computeEngagementMetrics(sessionId);
      const endedAt = new Date().toISOString();
      const existingRollup = getSessionRollup(sessionId);
      const durationSeconds = existingRollup?.startedAt
        ? Math.round(
            (new Date(endedAt).getTime() -
              new Date(existingRollup.startedAt).getTime()) /
              1000
          )
        : undefined;
      upsertSessionRollup({
        sessionId,
        endedAt,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(metrics
          ? {
              ...(metrics.humanResponseLatencyAvgMs !== null
                ? {
                    humanResponseLatencyAvgMs:
                      metrics.humanResponseLatencyAvgMs,
                  }
                : {}),
              ...(metrics.humanResponseLatencyP50Ms !== null
                ? {
                    humanResponseLatencyP50Ms:
                      metrics.humanResponseLatencyP50Ms,
                  }
                : {}),
              ...(metrics.humanResponseLatencyP95Ms !== null
                ? {
                    humanResponseLatencyP95Ms:
                      metrics.humanResponseLatencyP95Ms,
                  }
                : {}),
              ...(metrics.agentIdlePercent !== null
                ? { agentIdlePercent: metrics.agentIdlePercent }
                : {}),
              rateLimitEncounters: metrics.rateLimitEncounters,
              toolUseCounts: metrics.toolUseCounts,
            }
          : {}),
      });
    }, 1000);
  });

  // GET /auth/check — lightweight auth probe (no side effects)
  app.get('/auth/check', requireAuth, (_req, res) => {
    res.json({ ok: true });
  });

  // GET /auth/status — no auth required, tells frontend if PIN is configured
  app.get('/auth/status', (_req, res) => {
    const config = getConfig();
    res.json({
      hasPIN: auth.isPinConfigured(config.pinHash),
      ...(persistenceState.isDegraded
        ? {
            status: 'degraded',
            disabledStores: persistenceState.disabledStores,
          }
        : {}),
    });
  });

  // POST /auth/setup — set initial PIN (only works when no PIN is configured)
  app.post('/auth/setup', async (req, res) => {
    try {
      const ip = (req.ip || req.connection.remoteAddress) as string;
      if (auth.isRateLimited(ip)) {
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return;
      }

      const { pin, confirm } = req.body as { pin?: string; confirm?: string };
      if (!pin || !confirm) {
        res.status(400).json({ error: 'PIN and confirmation required' });
        return;
      }
      if (pin !== confirm) {
        auth.recordFailedAttempt(ip);
        res.status(400).json({ error: 'PINs do not match' });
        return;
      }
      if (pin.length < 4) {
        res.status(400).json({ error: 'PIN must be at least 4 characters' });
        return;
      }

      // Single read — check + write atomically to avoid TOCTOU race
      const freshConfig = loadConfig(CONFIG_PATH);
      if (auth.isPinConfigured(freshConfig.pinHash)) {
        res
          .status(403)
          .json({ error: 'PIN is already configured. Use CLI to reset.' });
        return;
      }
      freshConfig.pinHash = await auth.hashPin(pin);
      saveConfig(CONFIG_PATH, freshConfig);

      // Auto-login: generate token and set cookie
      auth.clearRateLimit(ip);
      const ttlMs = parseTTL(freshConfig.cookieTTL);
      const token = auth.generateCookieToken({
        pinHash: freshConfig.pinHash,
        ttlMs,
      });
      authenticatedTokens.add(token);
      setTimeout(() => authenticatedTokens.delete(token), ttlMs);

      res.cookie('token', token, {
        httpOnly: true,
        sameSite: 'strict',
        maxAge: ttlMs,
      });

      res.json({ ok: true });
    } catch (err) {
      logger.error('[auth] Unhandled error in POST /auth/setup:', err);
      res.status(500).json({ error: 'Failed to set PIN' });
    }
  });

  // POST /auth
  app.post('/auth', async (req, res) => {
    try {
      const ip = (req.ip || req.connection.remoteAddress) as string;
      if (auth.isRateLimited(ip)) {
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return;
      }

      const { pin } = req.body as { pin?: string };
      if (!pin) {
        res.status(400).json({ error: 'PIN required' });
        return;
      }

      const authConfig = getConfig();
      if (!auth.isPinConfigured(authConfig.pinHash)) {
        res.status(412).json({ error: 'No PIN configured', needsSetup: true });
        return;
      }

      const valid = await auth.verifyPin(pin, authConfig.pinHash);
      if (!valid) {
        auth.recordFailedAttempt(ip);
        res.status(401).json({ error: 'Invalid PIN' });
        return;
      }

      auth.clearRateLimit(ip);
      const ttlMs = parseTTL(authConfig.cookieTTL);
      const token = auth.generateCookieToken({
        pinHash: authConfig.pinHash,
        ttlMs,
      });
      authenticatedTokens.add(token);
      setTimeout(() => authenticatedTokens.delete(token), ttlMs);

      res.cookie('token', token, {
        httpOnly: true,
        sameSite: 'strict',
        maxAge: ttlMs,
      });

      res.json({ ok: true });
    } catch (err) {
      logger.error('[auth] Unhandled error in POST /auth:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /sessions — enrich with live branch from git (rate-limited to avoid spawning git on every poll)
  const branchRefreshCache = new Map<string, number>(); // sessionId -> last refresh timestamp
  const BRANCH_REFRESH_INTERVAL_MS = 10_000;
  app.get(
    '/sessions',
    requireCliGatewayAuthForActorCommand('sessions.list'),
    async (_req, res) => {
      const [localSessions, remoteSessions] = await Promise.all([
        Promise.resolve(
          localRelayNode.sessions
            .list()
            .map((session) =>
              withWorkContextMetadata(workContextStore, session)
            )
        ),
        aggregateRemoteSessions({
          registry: hubNodeRegistry,
          nodeLinks: hubNodeLinks,
          logger,
          sessionEnvelopes: sessionEnvelopeRegistry,
          workContextStore,
          readModelCache: remoteSessionReadModelCache,
        }),
      ]);
      const allSessions = [...localSessions, ...remoteSessions];
      const now = Date.now();

      // Prune cache entries for sessions that no longer exist. Branch
      // refresh only runs against local sessions (they have a real cwd
      // on this host); the routed-session subset is skipped below via
      // the `nodeId === undefined` guard.
      const activeIds = new Set(allSessions.map((s) => s.id));
      for (const sessionId of branchRefreshCache.keys()) {
        if (!activeIds.has(sessionId)) branchRefreshCache.delete(sessionId);
      }

      await Promise.all(
        allSessions.map(async (s) => {
          // Skip remote (routed) sessions: their cwd lives on the owning
          // node and running `git` against it locally is meaningless.
          if (!isLocallyOwnedSession(s)) return;
          if (!s.cwd) return;
          const lastRefresh = branchRefreshCache.get(s.id) ?? 0;
          if (now - lastRefresh < BRANCH_REFRESH_INTERVAL_MS) return;
          const cwd = s.cwd;
          branchRefreshCache.set(s.id, now);
          try {
            const { stdout } = await execFileAsync(
              'git',
              ['rev-parse', '--abbrev-ref', 'HEAD'],
              { cwd }
            );
            const liveBranch = stdout.trim();
            if (liveBranch && liveBranch !== s.branchName) {
              s.branchName = liveBranch;
              const raw = localRelayNode.sessions.get(s.id);
              if (raw) raw.branchName = liveBranch;
            }
          } catch {
            /* non-fatal */
          }
        })
      );
      res.json(allSessions);
    }
  );

  app.get(
    '/sessions/:id',
    requireScopedSessionAuthForActorCommand('sessions.get'),
    async (req, res) => {
      const decision = capabilityDecisionFromRequest(
        req,
        CONTROL_READ_CAPABILITY
      );
      if (decision.decision !== 'allow') {
        const error = capabilityError(decision);
        res.status(sessionControlErrorStatus(error)).json({ error });
        return;
      }
      const id = req.params['id'] as string;
      const local = localRelayNode.sessions.get(id);
      if (local) {
        const session = localRelayNode.sessions
          .list()
          .find((candidate) => candidate.id === id);
        if (!session) {
          res.status(404).json({
            error: {
              code: 'NOT_FOUND',
              reasonCode: 'SESSION_NOT_FOUND',
              message: 'session summary was not found',
              retryable: false,
            },
          });
          return;
        }
        res.json(withWorkContextMetadata(workContextStore, session));
        return;
      }
      const remoteSessions = await aggregateRemoteSessions({
        registry: hubNodeRegistry,
        nodeLinks: hubNodeLinks,
        logger,
        sessionEnvelopes: sessionEnvelopeRegistry,
        workContextStore,
        readModelCache: remoteSessionReadModelCache,
      });
      const remote = remoteSessions.find(
        (candidate) => candidate.id === id || candidate.globalSessionId === id
      );
      if (!remote) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            reasonCode: 'SESSION_NOT_FOUND',
            message: 'session was not found',
            retryable: false,
          },
        });
        return;
      }
      res.json(remote);
    }
  );

  app.get(
    '/sessions/:id/screen',
    requireScopedSessionAuthForActorCommand('sessions.screen'),
    (req, res) => {
      const decision = capabilityDecisionFromRequest(
        req,
        CONTROL_READ_CAPABILITY
      );
      if (decision.decision !== 'allow') {
        const error = capabilityError(decision);
        res.status(sessionControlErrorStatus(error)).json({ error });
        return;
      }
      const requestedId = req.params['id'] as string;
      const resolved = resolveLocalScreenSessionId(requestedId);
      if (resolved.kind === 'remote') {
        res.status(503).json({
          error: {
            code: 'NODE_OFFLINE',
            reasonCode: 'SESSION_SCREEN_ROUTED_UNAVAILABLE',
            message:
              'rendered screen snapshots are only available for sessions owned by this node in this slice',
            retryable: true,
            details: {
              nodeId: resolved.nodeId,
              sessionId: resolved.localSessionId,
            },
          },
        });
        return;
      }
      if (resolved.kind === 'missing') {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            reasonCode: 'SESSION_NOT_FOUND',
            message: 'session was not found or is not locally readable',
            retryable: false,
            details: { sessionId: requestedId },
          },
        });
        return;
      }

      const maxScrollbackLines = parseRenderedScreenMaxLines(
        req.query.maxLines
      );
      const result = localRelayNode.sessions.getRenderedScreenSnapshot(
        resolved.id,
        {
          requestedId,
          includeScrollback: parseRenderedScreenBooleanQuery(
            req.query.scrollback
          ),
          ...(maxScrollbackLines === undefined ? {} : { maxScrollbackLines }),
        }
      );
      if (result.ok === false) {
        res.status(renderedScreenErrorStatus(result.error.code)).json({
          error: result.error,
        });
        return;
      }
      res.json(result.snapshot);
    }
  );

  app.get('/sessions/:id/replay', requireScopedSessionAuth, (req, res) => {
    const decision = capabilityDecisionFromRequest(
      req,
      CONTROL_READ_CAPABILITY
    );
    if (decision.decision !== 'allow') {
      const error = capabilityError(decision);
      res.status(sessionControlErrorStatus(error)).json({ error });
      return;
    }
    const id = req.params['id'] as string;
    const snapshot = localRelayNode.sessions.getReplaySnapshot(id);
    if (!snapshot) {
      // Routed/remote replay forwarding is out of scope for #656; the hub
      // currently only serves replay for sessions owned by the local node.
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          reasonCode: 'SESSION_REPLAY_UNAVAILABLE',
          message:
            'session replay is only available for local PTY sessions in this slice',
          retryable: false,
        },
      });
      return;
    }
    res.json(snapshot);
  });

  app.get(
    '/sessions/:id/interventions',
    requireScopedSessionAuth,
    (req, res) => {
      const decision = capabilitiesDecisionFromRequest(req, [
        CONTROL_READ_CAPABILITY,
        INTERVENTION_READ_CAPABILITY,
      ]);
      if (decision.decision !== 'allow') {
        const error = capabilityError(decision);
        res.status(sessionControlErrorStatus(error)).json({ error });
        return;
      }
      const id = req.params['id'] as string;
      if (!localRelayNode.sessions.get(id)) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            reasonCode: 'SESSION_NOT_FOUND',
            message: 'session was not found or is not locally readable',
            retryable: false,
          },
        });
        return;
      }
      const limit = clampInterventionLimit(
        typeof req.query.limit === 'string' ? req.query.limit : undefined
      );
      const records = localRelayNode.sessions.getInterventions(id, { limit });
      res.json(toInterventionReadResponse({ records, limit }));
    }
  );

  app.get('/supervisor/sessions', requireScopedSessionAuth, (req, res) => {
    handleSupervisorSessionsRequest(req, res, localRelayNode.sessions);
  });

  app.post(
    '/supervisor/actions/:action',
    requireScopedSessionAuth,
    (req, res) => {
      handleSupervisorActionRequest(req, res, localRelayNode.sessions);
    }
  );

  app.post('/sessions/:id/input', requireScopedSessionAuth, (req, res) => {
    const decision = capabilityDecisionFromRequest(
      req,
      CONTROL_SESSION_CAPABILITY
    );
    if (decision.decision !== 'allow') {
      const error = capabilityError(decision);
      res.status(sessionControlErrorStatus(error)).json({ error });
      return;
    }

    const id = req.params['id'] as string;
    const body =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const data = body['data'];
    if (typeof data !== 'string' || data.length === 0) {
      res.status(400).json({ error: 'data must be a non-empty string' });
      return;
    }
    if (data.length > 1000) {
      res
        .status(413)
        .json({ error: 'small input is limited to 1000 characters' });
      return;
    }

    const session = localRelayNode.sessions
      .list()
      .find((candidate) => candidate.id === id);
    if (!session) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          reasonCode: 'SESSION_NOT_FOUND',
          message: 'session was not found or is not locally writable',
          retryable: false,
        },
      });
      return;
    }
    if (session.status === 'disconnected') {
      res.status(409).json({
        error: {
          code: 'SESSION_CONFLICT',
          reasonCode: 'SESSION_DISCONNECTED',
          message: 'cannot send input to a disconnected session',
          retryable: false,
          details: { sessionId: id },
        },
      });
      return;
    }
    if (session.controlFreshness === 'stale') {
      res.status(409).json({
        error: {
          code: 'SESSION_CONFLICT',
          reasonCode: 'CONTROL_STATE_STALE',
          message: 'cannot send input from stale control state',
          retryable: false,
          details: { sessionId: id },
        },
      });
      return;
    }
    if (session.controlFreshness !== 'fresh') {
      res.status(409).json({
        error: {
          code: 'SESSION_CONFLICT',
          reasonCode: 'CONTROL_STATE_UNKNOWN',
          message: 'cannot send input from unknown control state',
          retryable: false,
          details: { sessionId: id },
        },
      });
      return;
    }
    try {
      localRelayNode.sessions.write(id, data);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          reasonCode: 'SESSION_NOT_FOUND',
          message: err instanceof Error ? err.message : 'session was not found',
          retryable: false,
        },
      });
    }
  });

  // GET /repos — scan root dirs for repos
  app.get('/repos', requireAuth, async (_req, res) => {
    const freshConfig = getConfig();
    const repos = scanAllRepos(freshConfig.rootDirs || []);
    // Also include legacy manually-added repos
    if (freshConfig.repos) {
      for (const repo of freshConfig.repos as unknown as RepoEntry[]) {
        if (!repos.some((r) => r.path === repo.path)) {
          repos.push(repo);
        }
      }
    }
    // Enrich with current branch (best-effort, parallel)
    const enriched = await Promise.all(
      repos.map(async (repo) => {
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['symbolic-ref', '--short', 'HEAD'],
            { cwd: repo.path }
          );
          return { ...repo, defaultBranch: stdout.trim() };
        } catch {
          return { ...repo, defaultBranch: null };
        }
      })
    );
    res.json(enriched);
  });

  // GET /worktrees/status — pre-cleanup checks for a worktree
  app.get('/worktrees/status', requireCliGatewayAuth, async (req, res) => {
    if (isCliGatewayActorTokenRequest(req)) {
      res.status(403).json({
        error: 'Forbidden',
        code: 'CLI_GATEWAY_ACTOR_WORKTREE_STATUS_UNSUPPORTED',
        message:
          'CLI actor credentials cannot read arbitrary worktree status until repo/worktree-scoped actor tokens are supported.',
      });
      return;
    }

    const worktreePath =
      typeof req.query.path === 'string' ? req.query.path : undefined;
    if (!worktreePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    const resolved = path.resolve(worktreePath);

    // Validate the path is a recognized git worktree via git worktree list (trust boundary first)
    const allRoots = getConfig().rootDirs || [];
    const allRepos: string[] = [...(getConfig().repos ?? [])];
    for (const rootDir of allRoots) {
      try {
        for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const fullPath = path.join(rootDir, entry.name);
          if (fs.existsSync(path.join(fullPath, '.git')))
            allRepos.push(fullPath);
        }
      } catch {
        /* skip unreadable rootDirs */
      }
    }
    let isKnownWorktree = false;
    for (const repoPath of [...new Set(allRepos)]) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['worktree', 'list', '--porcelain'],
          { cwd: repoPath, timeout: 5000 }
        );
        const allWt = parseAllWorktrees(stdout, repoPath);
        if (allWt.some((wt) => wt.path === resolved && !wt.isMain)) {
          isKnownWorktree = true;
          break;
        }
      } catch {
        /* skip repos where git fails */
      }
    }
    if (!isKnownWorktree) {
      res.status(400).json({ error: 'Path is not a recognized git worktree' });
      return;
    }

    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: 'Worktree not found' });
      return;
    }

    // Check for active sessions in this worktree
    const allSessions = localRelayNode.sessions.list();
    const activeSessions = allSessions
      .filter((s) => s.worktreePath === resolved || s.cwd === resolved)
      .map((s) => s.id);

    // Check for uncommitted changes — default to true (safe: assume changes exist if check fails)
    let hasUncommittedChanges = true;
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: resolved,
        timeout: 5000,
      });
      hasUncommittedChanges = stdout.trim().length > 0;
    } catch (err) {
      logger.warn(
        '[worktrees/status] git status failed for',
        resolved,
        err instanceof Error ? err.message : err
      );
    }

    res.json({ activeSessions, hasUncommittedChanges });
  });

  // GET /config/defaultAgent — get default coding agent (reads defaultFramework)
  app.get('/config/defaultAgent', requireAuth, (_req, res) => {
    res.json({ defaultAgent: getConfig().defaultFramework || 'claude' });
  });

  // PATCH /config/defaultAgent — set default coding agent (writes defaultFramework)
  app.patch('/config/defaultAgent', requireAuth, (req, res) => {
    const { defaultAgent } = req.body as { defaultAgent?: string };
    if (!defaultAgent) {
      res.status(400).json({ error: 'defaultAgent is required' });
      return;
    }
    const c = getConfig();
    c.defaultFramework = defaultAgent;
    saveConfig(CONFIG_PATH, c);
    res.json({ defaultAgent: c.defaultFramework });
  });

  boolConfigEndpoints('defaultNotifications', true);
  boolConfigEndpoints('autoProvision', false);

  // GET /config/renamerTool — get the active renamer tool setting
  app.get('/config/renamerTool', requireAuth, (_req, res) => {
    const c = getConfig();
    res.json({
      renamerTool: c.renamerTool ?? 'claude',
      ...(c.renamerCustomScript !== undefined
        ? { renamerCustomScript: c.renamerCustomScript }
        : {}),
    });
  });

  // PATCH /config/renamerTool — set the renamer tool (and optional custom script path)
  app.patch('/config/renamerTool', requireAuth, (req, res) => {
    const { renamerTool, renamerCustomScript } = req.body as {
      renamerTool?: string;
      renamerCustomScript?: string;
    };
    const validTools = ['claude', 'codex', 'none', 'custom-script'];
    if (!renamerTool || !validTools.includes(renamerTool)) {
      res.status(400).json({
        error: 'renamerTool must be one of: claude, codex, none, custom-script',
      });
      return;
    }
    if (renamerTool === 'custom-script') {
      if (
        !renamerCustomScript ||
        typeof renamerCustomScript !== 'string' ||
        !renamerCustomScript.trim()
      ) {
        res.status(400).json({
          error:
            'renamerCustomScript is required when renamerTool is custom-script',
        });
        return;
      }
      if (!path.isAbsolute(renamerCustomScript)) {
        res
          .status(400)
          .json({ error: 'renamerCustomScript must be an absolute path' });
        return;
      }
      const scriptPath = renamerCustomScript.trim();
      if (!fs.existsSync(scriptPath)) {
        res
          .status(400)
          .json({ error: 'renamerCustomScript path does not exist' });
        return;
      }
      try {
        fs.accessSync(scriptPath, fs.constants.X_OK);
      } catch {
        res
          .status(400)
          .json({ error: 'renamerCustomScript is not executable' });
        return;
      }
    }
    const c = getConfig();
    c.renamerTool = renamerTool as import('./types.js').RenamerTool;
    if (renamerTool === 'custom-script' && renamerCustomScript) {
      // Only update renamerCustomScript when explicitly provided for custom-script tool.
      c.renamerCustomScript = renamerCustomScript.trim();
    }
    // Do NOT clear renamerCustomScript when switching away from custom-script —
    // keep it so switching back does not lose the configured path.
    // Users clear it by setting it to empty string via a dedicated param.
    saveConfig(CONFIG_PATH, c);
    res.json({
      renamerTool: c.renamerTool,
      ...(c.renamerCustomScript !== undefined
        ? { renamerCustomScript: c.renamerCustomScript }
        : {}),
    });
  });

  // GET /config/automations — get automation settings
  app.get(
    '/config/automations',
    requireAuth,
    (_req: express.Request, res: express.Response) => {
      res.json(getConfig().automations ?? {});
    }
  );

  // PATCH /config/automations — update automation settings and start/stop poller
  app.patch(
    '/config/automations',
    requireAuth,
    (req: express.Request, res: express.Response) => {
      const body = req.body as Partial<AutomationSettings>;
      const c = getConfig();
      const prev = c.automations ?? {};
      const next: AutomationSettings = {
        ...(prev.autoCheckoutReviewRequests !== undefined
          ? {
              autoCheckoutReviewRequests: prev.autoCheckoutReviewRequests,
            }
          : {}),
        ...(prev.pollIntervalMs !== undefined
          ? { pollIntervalMs: prev.pollIntervalMs }
          : {}),
        ...(prev.lastPollTimestamp !== undefined
          ? { lastPollTimestamp: prev.lastPollTimestamp }
          : {}),
      };

      if (typeof body.autoCheckoutReviewRequests === 'boolean') {
        next.autoCheckoutReviewRequests = body.autoCheckoutReviewRequests;
      }
      if (
        typeof body.pollIntervalMs === 'number' &&
        body.pollIntervalMs >= 60000
      ) {
        next.pollIntervalMs = body.pollIntervalMs;
      }

      c.automations = next;
      try {
        saveConfig(CONFIG_PATH, c);
      } catch (err) {
        logger.error('[config] Failed to save automation settings:', err);
        res.status(500).json({ error: 'Failed to save settings' });
        return;
      }

      // Start or stop poller based on new setting
      void stopPolling().then(() => {
        if (next.autoCheckoutReviewRequests) {
          startPolling(buildPollerDeps());
        }
      });

      res.json(next);
    }
  );

  // GET /presets — return all filter presets (built-in merged with user presets)
  app.get(
    '/presets',
    requireAuth,
    (_req: express.Request, res: express.Response) => {
      res.json(getConfig().filterPresets ?? []);
    }
  );

  // POST /presets — add a new user filter preset
  app.post(
    '/presets',
    requireAuth,
    (req: express.Request, res: express.Response) => {
      const { name, filters, sort } = req.body as {
        name?: string;
        filters?: unknown;
        sort?: unknown;
      };
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      if (sort && typeof sort === 'object') {
        const sortObj = sort as Record<string, unknown>;
        const dir = sortObj['direction'];
        if (dir !== 'asc' && dir !== 'desc') {
          res
            .status(400)
            .json({ error: 'sort.direction must be "asc" or "desc"' });
          return;
        }
        const col = sortObj['column'];
        if (!col || typeof col !== 'string' || !col.trim()) {
          res
            .status(400)
            .json({ error: 'sort.column must be a non-empty string' });
          return;
        }
      }
      const trimmedName = name.trim();
      const c = getConfig();
      const existingPresets = c.filterPresets ?? [];
      const duplicate = existingPresets.some(
        (p) => p.name.toLowerCase() === trimmedName.toLowerCase()
      );
      if (duplicate) {
        res
          .status(409)
          .json({ error: `A preset named "${trimmedName}" already exists` });
        return;
      }
      const preset = {
        name: trimmedName,
        filters:
          (filters as {
            status?: string[];
            repo?: string[];
            role?: string[];
          }) ?? {},
        sort: (sort as { column: string; direction: 'asc' | 'desc' }) ?? {
          column: 'role',
          direction: 'asc' as const,
        },
      };
      if (!c.filterPresets) c.filterPresets = [];
      c.filterPresets.push(preset);
      saveConfig(CONFIG_PATH, c);
      res.json(preset);
    }
  );

  // DELETE /presets/:name — remove a user preset (built-in presets cannot be deleted)
  app.delete(
    '/presets/:name',
    requireAuth,
    (req: express.Request, res: express.Response) => {
      const name = decodeURIComponent(req.params['name'] ?? '');
      const c = getConfig();
      const presets = c.filterPresets ?? [];
      const target = presets.find((p) => p.name === name);
      if (!target) {
        res.status(404).json({ error: 'Preset not found' });
        return;
      }
      if (target.builtIn) {
        res.status(400).json({ error: 'Cannot delete a built-in preset' });
        return;
      }
      c.filterPresets = presets.filter((p) => p.name !== name);
      saveConfig(CONFIG_PATH, c);
      res.json({ ok: true });
    }
  );

  // GET /push/vapid-key
  app.get('/push/vapid-key', requireAuth, (_req, res) => {
    const key = push.getVapidPublicKey();
    if (!key) {
      res.status(501).json({ error: 'Push not available' });
      return;
    }
    res.json({ vapidPublicKey: key });
  });

  // POST /push/subscribe
  app.post('/push/subscribe', requireAuth, (req, res) => {
    const { subscription, sessionIds } = req.body as {
      subscription?: {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };
      sessionIds?: string[];
    };
    if (!subscription?.endpoint) {
      res.status(400).json({ error: 'subscription required' });
      return;
    }
    push.subscribe(subscription, sessionIds || []);
    res.json({ ok: true });
  });

  // POST /push/unsubscribe
  app.post('/push/unsubscribe', requireAuth, (req, res) => {
    const { endpoint } = req.body as { endpoint?: string };
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint required' });
      return;
    }
    push.unsubscribe(endpoint);
    res.json({ ok: true });
  });

  // DELETE /worktrees — remove a worktree, prune, and delete its branch
  app.delete('/worktrees', requireCliGatewayWriteAuth, async (req, res) => {
    const { worktreePath, repoPath, force, deleteBranch } = req.body as {
      worktreePath?: string;
      repoPath?: string;
      force?: boolean;
      deleteBranch?: boolean;
    };
    if (!worktreePath || !repoPath) {
      res.status(400).json({ error: 'worktreePath and repoPath are required' });
      return;
    }

    const resolvedPath = path.resolve(worktreePath);
    const worktreeSessions = sessions
      .list()
      .filter((s) => s.worktreePath === resolvedPath || s.cwd === resolvedPath)
      .map((s) => s.id);

    const validation = await validateWorktreeForDelete(
      worktreePath,
      repoPath,
      force ?? false,
      worktreeSessions
    );
    if (!validation.ok) {
      const validationErr = validation.error;
      res.status(validationErr.status).json({
        error: validationErr.error,
        ...(validationErr.sessionIds && {
          sessionIds: validationErr.sessionIds,
        }),
        ...(validationErr.hasUncommittedChanges !== undefined && {
          hasUncommittedChanges: validationErr.hasUncommittedChanges,
        }),
      });
      return;
    }

    // Force: kill active sessions in this worktree first
    if (force) {
      for (const sessionId of worktreeSessions) {
        try {
          localRelayNode.sessions.kill(sessionId);
        } catch (err) {
          logger.warn(
            `[worktrees] failed to kill session ${sessionId}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }

    const branchName = validation.branchName;

    const removeErr = await removeWorktreeFromDisk(
      worktreePath,
      repoPath,
      force ?? false,
      validation.deleteProof
    );
    if (removeErr) {
      res.status(500).json({ error: removeErr });
      return;
    }

    try {
      // Prune stale worktree refs
      await execFileAsync('git', ['worktree', 'prune'], { cwd: repoPath });
    } catch (_) {
      // Non-fatal: prune failure doesn't block success
    }

    const shouldDeleteBranch = deleteBranch !== false;
    const branchDeleted = shouldDeleteBranch
      ? await deleteLocalWorktreeBranch(repoPath, branchName)
      : false;

    try {
      getDefaultAllocator().releasePortsForWorktree(repoPath, resolvedPath);
      removePortsFromEnvFile(resolvedPath);
    } catch (err) {
      logger.warn(
        '[worktrees] failed to release ports:',
        err instanceof Error ? err.message : err
      );
    }

    // Clean up metadata file
    deleteMeta(CONFIG_PATH, worktreePath);

    // Broadcast worktrees-changed so all clients refresh
    broadcastEvent('worktrees-changed');

    res.json({ ok: true, branchDeleted });
  });

  // POST /sessions — public relay-pty terminal creation only
  const requireCliGatewaySessionCreateAuth =
    requireCliGatewayAuthForActorCommand('sessions.create', {
      scopeForRequest: actorSessionCreateScopeForRequest,
    });
  app.post(
    '/sessions',
    requireCliGatewaySessionCreateAuth,
    requireActorSessionCreatePolicy,
    async (req, res) => {
      const actorTarget = authenticatedCliGatewayActorCredential(req)
        ? actorSessionCreateTarget(req)
        : undefined;
      const requestedCreateBody =
        actorTarget?.ok === true
          ? actorTarget.body
          : sessionCreateBodyFromRequest(req, res);
      if (!requestedCreateBody) return;
      const topicCreate =
        actorTarget?.ok === true
          ? {
              body: actorTarget.body,
              ...(actorTarget.topic ? { topic: actorTarget.topic } : {}),
            }
          : resolveWorkspaceTopicSessionCreate(requestedCreateBody, res);
      if (!topicCreate) return;
      const createBody = topicCreate.body;
      const workspaceTopic = topicCreate.topic;
      const {
        repoPath,
        worktreePath,
        cwd: requestCwd,
        type = 'terminal',
        terminalBackend,
        cols,
        rows,
        displayName: requestedDisplayName,
        spawnedBySessionId: requestedSpawnedBySessionId,
        sessionLane,
        workContextId,
        envOverrides: rawEnvOverrides,
      } = createBody as {
        repoPath?: string;
        worktreePath?: string | null;
        cwd?: string;
        type?: string;
        mode?: string;
        terminalBackend?: TerminalBackend;
        cols?: number;
        rows?: number;
        branchName?: string;
        displayName?: string;
        spawnedBySessionId?: string;
        needsBranchRename?: boolean;
        newWorktree?: boolean;
        branchRenamePrompt?: string;
        sessionLane?: SessionLane;
        workContextId?: string;
        envOverrides?: unknown;
      };
      const spawnedBySessionId = authenticatedCliGatewayActorCredential(req)
        ? undefined
        : requestedSpawnedBySessionId;

      if (type !== 'terminal') {
        res.status(400).json({
          error: {
            code: 'UNSUPPORTED_SESSION_TYPE',
            message:
              'Agent conversations run in channels; public session creation only supports terminals.',
          },
        });
        return;
      }
      if ((req.body as Record<string, unknown>)['mode'] === 'web') {
        res.status(400).json({
          error: {
            code: 'UNSUPPORTED_SESSION_MODE',
            message:
              'Agent conversations run in channels; mode "web" is no longer supported.',
          },
        });
        return;
      }
      // Read config once for the lifetime of this request
      const freshConfig = getConfig();
      const requestedTerminalBackend =
        normalizeTerminalBackend(terminalBackend);

      // #740: Bench-inherited env overrides (sanitized to string->string). The
      // PTY layer applies these additively and refuses reserved keys.
      const sessionEnvOverrides = sanitizeSessionEnvOverrides(rawEnvOverrides);

      const {
        requestedRepoPath,
        requestedWorktreePath,
        cwd,
        settingsAnchorPath,
      } = resolveSessionLaunchPaths({
        repoPath,
        worktreePath,
        cwd: requestCwd,
        config: freshConfig,
        devCwdFallback: devSessionCwdFallback(),
      });

      if (
        !validateSessionCreateRequest(
          requestedRepoPath,
          cwd,
          type,
          freshConfig,
          workContextStore,
          workContextId,
          res
        )
      ) {
        return;
      }

      // Validate cwd directory exists
      if (!fs.existsSync(cwd)) {
        res.status(400).json({ error: `Directory does not exist: ${cwd}` });
        return;
      }

      const safeCols = clampDimension(cols, 1, 500);
      const safeRows = clampDimension(rows, 1, 200);

      const name = sessionNameFromRepoPath(settingsAnchorPath);
      const portVariables = getRepoPortVariables(
        freshConfig,
        settingsAnchorPath
      );
      const capacityResponse = buildPtyCapacityResponse(
        activePtySessionCount(),
        freshConfig.maxPtySessions
      );
      if (sendPtyCapacityError(res, capacityResponse)) return;

      const terminalSettings = resolveSessionSettings(
        freshConfig,
        settingsAnchorPath,
        {
          terminalBackend: requestedTerminalBackend,
        }
      );
      let session: CreateResult;
      try {
        session = createTerminalSessionRecord({
          ...(spawnedBySessionId !== undefined ? { spawnedBySessionId } : {}),
          repoName: name,
          repoPath: requestedRepoPath,
          worktreePath: requestedWorktreePath ?? null,
          cwd,
          displayName: requestedDisplayName,
          safeCols,
          safeRows,
          resolvedTerminalBackend: terminalSettings.terminalBackend,
          sessionLane,
          workContextId,
          portVariables,
          envOverrides: sessionEnvOverrides,
        });
      } catch (err) {
        sendSessionCreateError(res, err, freshConfig.maxPtySessions);
        return;
      }

      gitWatcher.watchSession(session.id, session.cwd);

      const associationError = associateSessionWithWorkContext(
        workContextStore,
        workContextId,
        session
      );

      linkWorkspaceTopicSession(workspaceTopic, session, workContextId);

      sendSessionCreateSuccess(res, session, associationError, workContextId);
    }
  );

  // DELETE /sessions/:id
  app.delete('/sessions/:id', requireAuth, (req, res) => {
    const decision = capabilityDecisionFromRequest(
      req,
      CONTROL_KILL_CAPABILITY
    );
    if (decision.decision !== 'allow') {
      const error = capabilityError(decision);
      res.status(sessionControlErrorStatus(error)).json({ error });
      return;
    }
    const id = req.params['id'] as string;
    try {
      localRelayNode.sessions.kill(id);
      push.removeSession(id);
      res.json({ ok: true, id, sessionId: id, killed: true });
    } catch (_) {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // PATCH /sessions/:id — update displayName and persist to metadata
  app.patch('/sessions/:id', requireAuth, (req, res) => {
    const decision = capabilityDecisionFromRequest(
      req,
      CONTROL_RENAME_CAPABILITY
    );
    if (decision.decision !== 'allow') {
      const error = capabilityError(decision);
      res.status(sessionControlErrorStatus(error)).json({ error });
      return;
    }
    const body = isRecord(req.body) ? req.body : {};
    const displayName = body['displayName'];
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      res.status(400).json({ error: 'displayName is required' });
      return;
    }
    try {
      const id = req.params['id'] as string;
      const updated = localRelayNode.sessions.updateDisplayName(
        id,
        displayName
      );
      const session = localRelayNode.sessions.get(id);
      if (session) {
        writeMeta(CONFIG_PATH, {
          worktreePath: session.cwd,
          displayName,
          lastActivity: session.lastActivity,
        });
      }
      res.json({ ...updated, id, sessionId: id, displayName });
    } catch (_) {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // POST /sessions/:id/image — upload clipboard image and inject on the node
  // that owns the target terminal session. Local sessions run in-process;
  // scoped remote sessions route hub→node over the reverse node-link RPC.
  app.post('/sessions/:id/image', requireAuth, async (req, res) => {
    let payload: ReturnType<typeof parseSessionImagePayload>;
    try {
      payload = parseSessionImagePayload(req.body);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Image upload failed';
      res
        .status(err instanceof SessionImageIngressError ? err.status : 400)
        .json({ error: message });
      return;
    }

    const targetId = req.params['id'] as string;
    try {
      if (localRelayNode.sessions.get(targetId)) {
        const result = await ingressSessionImage({
          sessions: localRelayNode.sessions,
          sessionId: targetId,
          payload,
        });
        res.json(result);
        return;
      }

      const parsedGlobal = parseGlobalSessionId(targetId);
      const firstValidation = parsedGlobal
        ? sessionEnvelopeRegistry.validate({
            nodeId: parsedGlobal.nodeId,
            sessionId: parsedGlobal.localSessionId,
            globalSessionId: targetId,
            now: new Date(),
          })
        : sessionEnvelopeRegistry.validate({
            sessionId: targetId,
            now: new Date(),
          });
      if (!firstValidation.ok) {
        res
          .status(relayNodeErrorStatus(firstValidation.error))
          .json({ error: firstValidation.error });
        return;
      }

      const scoped = firstValidation.summary;
      const nodeId = scoped.nodeId;
      const sessionId = scoped.sessionId;
      if (nodeId === DEFAULT_LOCAL_NODE_ID) {
        const result = await ingressSessionImage({
          sessions: localRelayNode.sessions,
          sessionId,
          payload,
        });
        res.json(result);
        return;
      }

      const node = hubNodeRegistry
        .listNodes()
        .find((candidate) => candidate.nodeId === nodeId);
      const policyDecision = evaluateHubPolicy({
        peer: { kind: 'hub' },
        node,
        nodeId,
        intent: { action: 'sessions.attach', target: nodeId },
        scope: {
          kind: scoped.scope.kind,
          nodeId,
          cwd: scoped.scope.cwd,
          ...(scoped.scope.repoPath ? { repoPath: scoped.scope.repoPath } : {}),
          ...(scoped.scope.worktreePath !== undefined
            ? { worktreePath: scoped.scope.worktreePath }
            : {}),
        },
        requiredCapabilities: ['session:attach'],
        sessionId,
        expiresAt: scoped.expiresAt,
        ...(scoped.revokedAt ? { revokedAt: scoped.revokedAt } : {}),
        ...(scoped.correlationId
          ? { correlationId: scoped.correlationId }
          : {}),
        params: {
          mimeType: payload.mimeType,
          bytesBase64: payload.data.length,
        },
        now: new Date(),
      });
      const auditedDecision = appendPolicyAudit(
        securityAuditLog,
        policyDecision
      );
      if (auditedDecision.decision !== 'allow') {
        const error = policyDecisionToRelayError(auditedDecision);
        res.status(relayNodeErrorStatus(error)).json({ error });
        return;
      }
      if (
        !node ||
        node.status !== 'online' ||
        !hubNodeLinks.hasActiveNode(nodeId)
      ) {
        res.status(404).json({
          error: {
            code: 'NODE_OFFLINE',
            message: `node ${nodeId} has no live reverse link`,
            retryable: true,
          },
        });
        return;
      }

      const result = await hubNodeLinks.request(nodeId, 'sessions.image', {
        id: sessionId,
        ...payload,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof HubNodeLinkError) {
        res.status(relayNodeErrorStatus(err.relayNodeError)).json({
          error: err.relayNodeError,
        });
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Image upload failed';
      res
        .status(err instanceof SessionImageIngressError ? err.status : 500)
        .json({ error: message });
    }
  });

  // GET /version — check current vs latest
  app.get('/version', requireAuth, async (_req, res) => {
    const current = getCurrentVersion();
    const channel = startupConfig.updateChannel ?? 'stable';
    const latest = await getLatestVersion(channel);
    const updateAvailable =
      latest !== null &&
      current !== latest &&
      (semverLessThan(current, latest) ||
        (channel === 'nightly' &&
          !current.includes('-') &&
          latest.includes('nightly') &&
          latest.startsWith(current + '-')));
    res.json({ current, latest, updateAvailable, channel });
  });

  // POST /update — install latest version from npm
  let updateInFlight = false;
  app.post('/update', requireAuth, async (_req, res) => {
    if (updateInFlight) {
      res.status(409).json({ ok: false, error: 'Update already in progress' });
      return;
    }
    updateInFlight = true;
    try {
      const channel = startupConfig.updateChannel ?? 'stable';
      const tag = channel === 'nightly' ? 'nightly' : 'latest';
      await execFileAsync('npm', ['install', '-g', `relay-ide@${tag}`], {
        env: { ...process.env, RELAY_IDE_SKIP_SERVICE_RESTART: '1' },
      });
      const restarting = serviceIsInstalled();
      if (restarting) {
        stopEventBatching();
        stopTelemetry();
        await flushHubNodeHeartbeatsBestEffort('update restart');
        serializeAll(configDir, { reason: 'update' });
        workContextStore.close();
        iaStore?.close();
        contextPacketStore?.close();
        agentProfileStore?.close();
        workContextArtifactStore?.close();
        workflowRunStore?.close();
        automationRunStore?.close();
        workspaceSurfaceStore?.close();
        workspaceTopicStore?.close();
        prOverseerStore?.close();
        workContextMessageStore?.close();
        channelAgentBinder?.close();
        await channelAgentRuntimes.close();
        channelHub.close();
        channelMessageStore?.close();
        channelAttachmentStore?.close();
        closeInterventionLog();
        broadcastEvent('server-restarting');
      }
      res.json({ ok: true, restarting });
      if (restarting) {
        // Brief delay to let the broadcast reach clients
        setTimeout(() => {
          server.close(() => process.exit(0));
          // Fallback if close hangs
          setTimeout(() => process.exit(0), 3000);
        }, 500);
      } else {
        updateInFlight = false;
      }
    } catch (err) {
      updateInFlight = false;
      const message = err instanceof Error ? err.message : 'Update failed';
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/update-channel', requireAuth, (_req, res) => {
    res.json({ channel: startupConfig.updateChannel ?? 'stable' });
  });

  app.put('/update-channel', requireAuth, (req, res) => {
    const { channel } = req.body as { channel?: string };
    if (channel !== 'stable' && channel !== 'nightly') {
      res
        .status(400)
        .json({ error: 'Invalid channel. Must be "stable" or "nightly".' });
      return;
    }
    startupConfig.updateChannel = channel;
    saveConfig(CONFIG_PATH, startupConfig);
    versionCache.clear();
    res.json({ channel });
  });

  // Browser content viewer (token-based auth, separate from browser-session cookies)
  const browserContentRouter = createBrowserContentRouter(broadcastEvent);
  app.use(browserContentRouter);

  // SPA catch-all — serve index.html for client-side routes (must be after all API routes)
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });

  // Clean expired browser content tokens every hour
  const BROWSER_TOKEN_TTL = 24 * 60 * 60 * 1000;
  const browserTokenCleanupTimer = setInterval(
    () => cleanExpiredTokens(BROWSER_TOKEN_TTL),
    60 * 60 * 1000
  );
  browserTokenCleanupTimer.unref();

  const devInstance =
    process.env.RELAY_IDE_DEV_INSTANCE === '1' ||
    process.env.RELAY_IDE_SELF_HOST === '1';
  let cancelStartupRestore = (): void => {};
  async function gracefulShutdown() {
    cancelStartupRestore();
    const restartReason = devInstance ? 'dev-restart' : 'signal-shutdown';
    broadcastEvent('server-restarting', { reason: restartReason });
    await stopPolling();
    stopEventBatching();
    stopTelemetry();
    closeAnalytics();
    healthMonitor.stop();
    branchWatcher.close();
    refWatcher.close();
    gitWatcher.close();
    clearInterval(rateLimitSnapshotTimer);
    clearInterval(retentionCleanupTimer);
    clearInterval(browserTokenCleanupTimer);
    server.close();
    credentialRotationScheduler?.stop();
    await flushHubNodeHeartbeatsBestEffort('graceful shutdown');
    // Serialize relay-pty session metadata only. relay-pty/libghostty-vt is not
    // a process supervisor, so server restart is cold/resume until a future daemon.
    serializeAll(configDir, { reason: restartReason });
    workContextStore.close();
    iaStore?.close();
    contextPacketStore?.close();
    agentProfileStore?.close();
    workContextArtifactStore?.close();
    workflowRunStore?.close();
    automationRunStore?.close();
    workspaceSurfaceStore?.close();
    workspaceTopicStore?.close();
    prOverseerStore?.close();
    workContextMessageStore?.close();
    channelAgentBinder?.close();
    await channelAgentRuntimes.close();
    channelHub.close();
    channelMessageStore?.close();
    channelAttachmentStore?.close();
    closeInterventionLog();
    for (const s of localRelayNode.sessions.list()) {
      try {
        sessions.detachForRestart(s.id);
      } catch {
        /* already exiting */
      }
    }
    setTimeout(() => process.exit(0), 200);
  }
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  // Retry listen with backoff — handles EADDRINUSE during updates when the
  // previous process hasn't released the port yet (launchd KeepAlive restarts).
  const MAX_RETRIES = 5;
  let attempt = 0;

  // Integration-test-only ordering seam. Normal startup never sleeps: the
  // hold is accepted only under NODE_ENV=test and defaults to zero. Keeping it
  // inside the exact function handed to restoreSessionsAfterListen means the
  // real-process regression fails if this function is moved/awaited before
  // server.listen().
  const testStartupRestoreHoldMs =
    process.env['NODE_ENV'] === 'test'
      ? (positiveIntegerEnv('RELAY_IDE_TEST_STARTUP_RESTORE_HOLD_MS') ?? 0)
      : 0;
  async function restoreStartupSessions(): Promise<number> {
    startupResume.inProgress = true;
    if (testStartupRestoreHoldMs > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, testStartupRestoreHoldMs)
      );
    }
    return restoreFromDisk(configDir, getConfig().repos ?? []);
  }
  cancelStartupRestore = restoreSessionsAfterListen(
    server,
    restoreStartupSessions,
    {
      restored: (restoredCount) => {
        startupResume.inProgress = false;
        startupResume.complete = true;
        startupResume.restored = restoredCount;
        if (restoredCount === 0) return;
        logger.info(
          `Restored ${restoredCount} session(s) from previous update.`
        );
        for (const session of localRelayNode.sessions.list()) {
          gitWatcher.watchSession(session.id, session.cwd);
        }
      },
      failed: (err) => {
        startupResume.inProgress = false;
        startupResume.complete = true;
        startupResume.failed = true;
        logger.error(
          'Background session restore failed:',
          err instanceof Error ? err.message : String(err)
        );
      },
    }
  );
  function tryListen() {
    server.listen(startupConfig.port, startupConfig.host, () => {
      const addr = server.address() as import('node:net').AddressInfo;
      logger.info(`relay-ide listening on ${startupConfig.host}:${addr.port}`);
    });
  }
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempt < MAX_RETRIES) {
      attempt++;
      const delay = Math.min(1000 * attempt, 5000);
      logger.warn(
        `Port ${startupConfig.port} in use, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})...`
      );
      setTimeout(tryListen, delay);
    } else {
      shutdownAfterListenFailure(err, gracefulShutdown);
    }
  });
  tryListen();
}

function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    logger.warn(`Ignoring ${name}: expected a positive integer number of ms.`);
    return undefined;
  }
  return parsed;
}

main().catch((err) => {
  if (err instanceof PersistenceStartupError) {
    logger.error(err.message);
  } else {
    logger.error('Unhandled fatal error:', err);
  }
  process.exitCode = 1;
});
