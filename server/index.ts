import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import express from 'express';
import cookieParser from 'cookie-parser';

import {
  loadConfig,
  saveConfig,
  DEFAULTS,
  readMeta,
  writeMeta,
  deleteMeta,
  ensureMetaDir,
  getConfigDir,
  resolveSessionSettings,
} from './config.js';
import * as auth from './auth.js';
import * as sessions from './sessions.js';
import {
  serializeAll,
  restoreFromDisk,
  activeTmuxSessionNames,
  populateMetaCache,
} from './sessions.js';
import type { CreateResult } from './sessions.js';
import { AGENT_CONTINUE_ARGS, AGENT_YOLO_ARGS } from './types.js';
import { getTmuxPrefix } from './pty-handler.js';
import { setupWebSocket } from './ws.js';
import {
  WorktreeWatcher,
  BranchWatcher,
  RefWatcher,
  GitWatcher,
  parseAllWorktrees,
} from './watcher.js';
import { isInstalled as serviceIsInstalled } from './service.js';
import { extensionForMime, setClipboardImage } from './clipboard.js';
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
  createWorkspaceRouter,
  clearPrCache,
  clearFilesListCache,
} from './workspaces.js';
import { createWorkspaceGroupsRouter } from './workspace-groups.js';
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
import {
  createWebhookManagerRouter,
  reloadSmee,
  startSmartPolling,
} from './webhook-manager.js';
import { fetchPrsGraphQL } from './github-graphql.js';
import {
  createTelemetryRouter,
  startTelemetry,
  stopTelemetry,
  getTelemetryForSession,
  getAccountTelemetry,
} from './telemetry.js';
import type {
  AgentType,
  AutomationSettings,
  Config,
  ContinuePolicy,
  TicketContext,
  WorkspaceSettings,
} from './types.js';
import { BUILTIN_FRAMEWORKS } from './types.js';
import { semverLessThan, clampDimension } from './utils.js';
import {
  createBrowserContentRouter,
  generateScopedToken,
  cleanExpiredTokens,
} from './browser-content.js';
import { createLogger, initFileLogging } from './logger.js';
import {
  initializeDefaultAllocator,
  getDefaultAllocator,
  normalizePortVariables,
  removePortsFromEnvFile,
  upsertPortsInEnvFile,
} from './port-allocator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);
const logger = createLogger('index');

// When run via CLI bin, config lives in ~/.config/relay-ide/
// When run directly (development), fall back to local config.json
const CONFIG_PATH =
  process.env.RELAY_IDE_CONFIG ||
  path.join(__dirname, '..', '..', 'config.json');

const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lilheF3LelYSo0bu';

const VERSION_CACHE_TTL = 5 * 60 * 1000;
const versionCache: Map<string, { latest: string; fetchedAt: number }> =
  new Map();

function getCurrentVersion(): string {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
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

function execErrorMessage(err: unknown, fallback: string): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || fallback).trim();
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
    await initializeDefaultAllocator(configPath, logger);
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

async function cleanupOrphanedTmuxSessions(
  adoptedNames: Set<string>
): Promise<void> {
  try {
    const { stdout } = await execFileAsync('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}',
    ]);
    const tmuxPrefix = getTmuxPrefix();
    const orphanedSessions = stdout
      .trim()
      .split('\n')
      .filter((name) => name.startsWith(tmuxPrefix) && !adoptedNames.has(name));
    for (const name of orphanedSessions) {
      execFileAsync('tmux', ['kill-session', '-t', name]).catch(() => {});
    }
    if (orphanedSessions.length > 0) {
      logger.info(
        `Cleaned up ${orphanedSessions.length} orphaned tmux session(s).`
      );
    }
  } catch {
    // tmux not installed or no sessions — ignore
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
function validateTicketContext(
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

/** Builds the initial prompt string from a ticket context and repo settings. */
function buildTicketInitialPrompt(
  ticketContext: TicketContext,
  repoSettings: WorkspaceSettings | undefined
): string {
  const template =
    repoSettings?.promptStartWork ??
    'You are working on ticket {ticketId}: {title}\n\nTicket URL: {ticketUrl}\n\nPlease start by understanding the issue and proposing an approach.';
  return template
    .replace(/\{ticketId\}/g, ticketContext.ticketId)
    .replace(/\{title\}/g, ticketContext.title)
    .replace(/\{ticketUrl\}/g, ticketContext.url)
    .replace(/\{description\}/g, ticketContext.description ?? '');
}

type WorktreeValidationError = {
  status: number;
  error: string;
  sessionIds?: string[];
};

/** Validates that a worktree can be deleted. Returns an error descriptor or null. */
async function validateWorktreeForDelete(
  worktreePath: string,
  repoPath: string,
  force: boolean,
  activeSessions: string[]
): Promise<WorktreeValidationError | null> {
  try {
    const { stdout: wtListOut } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: repoPath }
    );
    const allWorktrees = parseAllWorktrees(wtListOut, repoPath);
    const isKnownWorktree = allWorktrees.some(
      (wt) => wt.path === path.resolve(worktreePath) && !wt.isMain
    );
    if (!isKnownWorktree) {
      if (!fs.existsSync(worktreePath)) {
        return {
          status: 404,
          error: 'Worktree not found — may have been already cleaned up',
        };
      }
      return { status: 400, error: 'Path is not a recognized git worktree' };
    }
  } catch (err) {
    logger.warn(
      '[worktrees/delete] git worktree list failed for',
      repoPath,
      err instanceof Error ? err.message : err
    );
    if (!force) {
      return {
        status: 500,
        error:
          'Cannot verify worktree — git worktree list failed. Use force: true to delete anyway.',
      };
    }
  }

  if (activeSessions.length > 0 && !force) {
    return {
      status: 409,
      error: 'active_sessions',
      sessionIds: activeSessions,
    };
  }

  return null;
}

/**
 * Clamps a terminal dimension (cols or rows) to a valid range.
 * Returns the rounded value if valid, or undefined if invalid/unset.
 */

/**
 * Builds the CLI args array for an agent session based on resolved settings.
 */
function buildAgentArgs(
  resolvedAgent: AgentType,
  claudeArgs: string[],
  yolo: boolean,
  continuePolicy: ContinuePolicy | undefined
): string[] {
  const baseArgs = [
    ...claudeArgs,
    ...(yolo ? (AGENT_YOLO_ARGS[resolvedAgent] ?? []) : []),
  ];
  const useContinue = continuePolicy === 'always';
  return useContinue
    ? [...(AGENT_CONTINUE_ARGS[resolvedAgent] ?? []), ...baseArgs]
    : [...baseArgs];
}

/**
 * Resolves the effective continue policy for an agent session.
 * For new worktrees (needsBranchRename), always returns 'never'.
 */
function resolveContinuePolicy(
  explicitContinuePolicy: ContinuePolicy | undefined,
  explicitContinue: boolean | undefined,
  needsBranchRename: boolean | undefined
): ContinuePolicy | undefined {
  if (needsBranchRename) return 'never';
  if (explicitContinuePolicy !== undefined) return explicitContinuePolicy;
  if (explicitContinue === undefined) return undefined;
  return explicitContinue ? 'always' : 'never';
}

/** Removes a worktree from disk, falling back to rmSync if git fails. Returns error string or null. */
async function removeWorktreeFromDisk(
  worktreePath: string,
  repoPath: string,
  force: boolean
): Promise<string | null> {
  try {
    const removeArgs = force
      ? ['worktree', 'remove', '--force', worktreePath]
      : ['worktree', 'remove', worktreePath];
    await execFileAsync('git', removeArgs, { cwd: repoPath });
  } catch {
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true });
      } catch (rmErr: unknown) {
        return execErrorMessage(rmErr, 'Failed to remove worktree directory');
      }
    }
    // directory already gone — that's fine, continue to cleanup
  }
  return null;
}

type AgentSessionParams = {
  repoName: string;
  repoPath: string;
  worktreePath: string | null | undefined;
  cwd: string;
  requestBranchName: string | undefined;
  displayName: string;
  tmuxDisplayName: string;
  args: string[];
  resolvedAgent: AgentType;
  resolvedUseTmux: boolean;
  resolvedYolo: boolean;
  resolvedClaudeArgs: string[];
  resolvedContinuePolicy: ContinuePolicy | undefined;
  safeCols: number | undefined;
  safeRows: number | undefined;
  needsBranchRename: boolean;
  branchRenamePrompt: string;
  computedInitialPrompt: string | undefined;
  claudeFullscreen: boolean;
  /** Port env var names to inject for this worktree (from repo settings) */
  portVariables?: string[] | undefined;
};

/** Creates an agent session record and writes worktree metadata if applicable. */
function createAgentSessionRecord(params: AgentSessionParams): CreateResult {
  const session = sessions.create({
    type: 'agent',
    agent: params.resolvedAgent,
    repoName: params.repoName,
    repoPath: params.repoPath,
    worktreePath: params.worktreePath ?? null,
    cwd: params.cwd,
    branchName: params.requestBranchName ?? '',
    displayName: params.displayName,
    tmuxDisplayName: params.tmuxDisplayName,
    args: params.args,
    configPath: CONFIG_PATH,
    useTmux: params.resolvedUseTmux,
    yolo: params.resolvedYolo,
    claudeArgs: params.resolvedClaudeArgs,
    continuePolicy: params.resolvedContinuePolicy,
    claudeFullscreen: params.claudeFullscreen,
    ...(params.safeCols != null && { cols: params.safeCols }),
    ...(params.safeRows != null && { rows: params.safeRows }),
    needsBranchRename: params.needsBranchRename,
    branchRenamePrompt: params.branchRenamePrompt,
    ...(params.computedInitialPrompt != null && {
      initialPrompt: params.computedInitialPrompt,
    }),
    // Pass port env var names for per-worktree port injection
    portVariables: params.portVariables,
  });

  if (params.worktreePath) {
    writeMeta(CONFIG_PATH, {
      worktreePath: params.cwd,
      displayName: params.displayName,
      lastActivity: new Date().toISOString(),
      branchName: params.requestBranchName ?? '',
    });
  }

  return session;
}

/** Initializes the startup config PIN (migrates legacy hashes, prompts if needed). */
async function initializePinConfig(startupConfig: Config): Promise<void> {
  if (startupConfig.pinHash && auth.isLegacyHash(startupConfig.pinHash)) {
    logger.info(
      'Migrating legacy PIN hash to scrypt. You will need to set a new PIN.'
    );
    delete startupConfig.pinHash;
    saveConfig(CONFIG_PATH, startupConfig);
  }

  if (process.env.NO_PIN === '1') {
    logger.info('PIN disabled (NO_PIN=1).');
    startupConfig.pinHash = startupConfig.pinHash || 'disabled';
  } else if (!startupConfig.pinHash) {
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
      logger.debug(
        'Failed to list worktrees for port reconciliation:',
        repoPath,
        err instanceof Error ? err.message : err
      );
      return;
    }

    const activeWorktreePaths = new Set(worktrees.map((wt) => wt.path));
    for (const worktree of worktrees) {
      try {
        const ports = await allocator.reconcilePortsForWorktree(
          repoPath,
          worktree.path,
          portVariables
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
      try {
        allocator.releasePortsForWorktree(repoPath, assignment.worktreeId);
        removePortsFromEnvFile(assignment.worktreeId);
      } catch (err) {
        logger.warn(
          'Failed to clean up stale port assignment:',
          assignment.worktreeId,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  async function reconcilePortsForAllRepos(repoPaths: string[]): Promise<void> {
    for (const repoPath of repoPaths) {
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
  // (port, host, webhookSecret, smeeUrl, githubToken, forceOutputParser).
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
  initFileLogging(path.join(configDir, 'logs'));
  fs.mkdirSync(path.join(configDir, 'telemetry'), { recursive: true });

  await initializePortAllocatorAndReconcile(
    CONFIG_PATH,
    getConfig,
    reconcilePortsForAllRepos
  );

  try {
    initAnalytics(configDir);
  } catch (err) {
    logger.warn(
      'Analytics disabled: failed to initialize:',
      err instanceof Error ? err.message : err
    );
  }

  await initializePinConfig(startupConfig);

  const authenticatedTokens = new Set<string>();

  // Build frontend if missing (e.g. fresh clone in development)
  const frontendDir = path.join(__dirname, '..', 'frontend');
  const packageRoot = path.join(__dirname, '..', '..');
  await ensureFrontendBuilt(frontendDir, packageRoot);

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

  const requireAuth: express.RequestHandler = (req, res, next) => {
    const token = req.cookies && req.cookies.token;
    if (!token || !authenticatedTokens.has(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

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

  const watcher = new WorktreeWatcher();
  watcher.rebuild(getConfig().repos || []);

  const gitWatcher = new GitWatcher();

  const server = http.createServer(app);
  const { broadcastEvent, broadcastBranchChanged } = setupWebSocket(
    server,
    authenticatedTokens,
    watcher,
    CONFIG_PATH
  );

  const browserScopedToken = generateScopedToken();
  process.env['RELAY_IDE_BROWSER'] = '1';
  process.env['RELAY_IDE_BROWSER_CMD'] = 'relay-ide browser';
  process.env['RELAY_IDE_BROWSER_TOKEN'] = browserScopedToken;
  if (!process.env['RELAY_IDE_PORT']) {
    process.env['RELAY_IDE_PORT'] = String(startupConfig.port);
  }

  // Wire up the delegate used by the webhook router (mounted before broadcastEvent was available)
  // Also clear the PR cache on real webhook events — these indicate actual PR state changes
  broadcastEventDelegate = (type, data) => {
    if (type === 'pr-updated') clearPrCache();
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
    for (const session of sessions.list()) {
      // Match by worktreePath or repoPath — session.cwd can drift to subdirectories
      const groupPath = session.worktreePath ?? session.repoPath;
      if (groupPath === cwdPath) {
        const raw = sessions.get(session.id);
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
      .filter((s) => s.branchName)
      .map((s) => ({ cwdPath: s.cwd, branch: s.branchName }));
    refWatcher.rebuild(entries).finally(() => {
      refWatcherRebuildPending = false;
      if (refWatcherNeedsRebuild) rebuildRefWatcher();
    });
  }

  rebuildRefWatcher();
  sessions.onSessionCreate(() => rebuildRefWatcher());
  sessions.onSessionEnd(() => rebuildRefWatcher());

  // Configure session defaults for hooks injection (startup-only — changing these requires restart)
  sessions.configure({
    port: startupConfig.port,
    forceOutputParser: startupConfig.forceOutputParser ?? false,
    configDir,
  });

  // Mount hooks router BEFORE auth middleware — hook callbacks come from localhost Claude Code
  const hooksRouter = createHooksRouter({
    getSession: sessions.get,
    broadcastEvent,
    fireBackendStateIfChanged: sessions.fireBackendStateIfChanged,
    notifySessionAttention: push.notifySessionAttention,
    configPath: CONFIG_PATH,
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
  app.use('/workspaces', requireAuth, workspaceRouter);

  // Mount git (local/fast) and gh (network/slow) routers
  app.use(
    '/git',
    requireAuth,
    createGitRouter({
      configPath: CONFIG_PATH,
      getConfig,
      getSessions: () =>
        sessions.list().map((s) => ({
          id: s.id,
          worktreePath: s.worktreePath ?? s.repoPath,
        })),
    })
  );
  app.use('/gh', requireAuth, createGhRouter());

  // Mount workspace-groups CRUD router
  app.use(
    '/workspace-groups',
    createWorkspaceGroupsRouter(CONFIG_PATH, requireAuth, {
      sessions,
      gitWatcher,
      configPath: CONFIG_PATH,
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
      for (const s of sessions.list()) {
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
  const {
    router: ticketTransitionsRouter,
    transitionOnSessionCreate,
    checkPrTransitions,
  } = createTicketTransitionsRouter({ configPath: CONFIG_PATH });
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
  app.get('/api/frameworks', requireAuth, (_req, res) => {
    const frameworks = Object.values(BUILTIN_FRAMEWORKS).map((f) => ({
      id: f.id,
      displayName: f.displayName,
      command: f.command,
      capabilities: f.capabilities,
      eventSource: f.eventSource,
    }));
    res.json({ frameworks });
  });

  // Restore sessions from a previous update restart
  const restoredCount = await restoreFromDisk(
    configDir,
    getConfig().repos ?? [],
    getConfig().frameworks
  );
  if (restoredCount > 0) {
    logger.info(`Restored ${restoredCount} session(s) from previous update.`);
    // Start git watching for restored sessions
    for (const session of sessions.list()) {
      gitWatcher.watch(session.cwd);
    }
  }

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
  setInterval(() => {
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

  // Schedule daily retention cleanup
  setInterval(
    () => {
      try {
        runRetentionCleanup();
      } catch {
        /* non-fatal */
      }
    },
    24 * 60 * 60 * 1000
  );

  // Populate session metadata cache in background (non-blocking)
  populateMetaCache().catch(() => {});

  // Build shared deps for review poller
  function buildPollerDeps() {
    return {
      configPath: CONFIG_PATH,
      getWorkspacePaths: () => getConfig().repos ?? [],
      getRepoSettings: (wsPath: string) => getConfig().repoSettings?.[wsPath],
      createSession: async (opts: {
        repoPath: string;
        worktreePath: string;
        branchName: string;
        initialPrompt?: string;
      }) => {
        const freshCfg = getConfig();
        const resolved = resolveSessionSettings(freshCfg, opts.repoPath, {});
        const repoName =
          opts.repoPath.split('/').filter(Boolean).pop() || 'session';
        const displayName = sessions.nextAgentName();
        // Get port env var names from repo settings for port injection
        const portVariables = getRepoPortVariables(freshCfg, opts.repoPath);
        sessions.create({
          type: 'agent',
          agent: resolved.agent,
          repoName,
          repoPath: opts.repoPath,
          worktreePath: opts.worktreePath,
          cwd: opts.worktreePath,
          branchName: opts.branchName,
          displayName,
          args: [
            ...resolved.claudeArgs,
            ...(resolved.yolo ? (AGENT_YOLO_ARGS[resolved.agent] ?? []) : []),
          ],
          configPath: CONFIG_PATH,
          useTmux: resolved.useTmux,
          yolo: resolved.yolo,
          claudeArgs: resolved.claudeArgs,
          claudeFullscreen: freshCfg.claudeFullscreen,
          ...(opts.initialPrompt != null && {
            initialPrompt: opts.initialPrompt,
          }),
          // Pass port env var names for per-worktree port injection
          portVariables,
        });
      },
      broadcastEvent,
    };
  }

  // Start review request poller if enabled
  if (getConfig().automations?.autoCheckoutReviewRequests) {
    startPolling(buildPollerDeps());
  }

  // Start smee-client via webhook-manager
  reloadSmee(CONFIG_PATH, startupConfig.port);

  // Start smart polling — broadcasts pr-updated/ci-updated only for repos without webhooks
  startSmartPolling(CONFIG_PATH, broadcastEvent);

  // Invalidate branch linker cache on session lifecycle changes
  sessions.onSessionCreate(() => {
    invalidateBranchLinkerCache();
  });
  sessions.onSessionEnd((sessionId) => {
    invalidateBranchLinkerCache();
    lastPushState.delete(sessionId);
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

  // Push notifications on meaningful state transitions (skip when hooks already sent attention notification)
  const lastPushState = new Map<string, string>();
  sessions.onBackendStateChange((sessionId, state) => {
    const prevState = lastPushState.get(sessionId);
    lastPushState.set(sessionId, state);

    // Only notify on meaningful transitions: running → idle or running → permission
    if (
      prevState === 'running' &&
      (state === 'idle' || state === 'permission')
    ) {
      const session = sessions.get(sessionId);
      if (session && session.type !== 'terminal') {
        // Dedup: if hooks fired an attention notification within last 10s, skip
        if (
          session.mode === 'pty' &&
          session.hooksActive &&
          session.lastAttentionNotifiedAt &&
          Date.now() - session.lastAttentionNotifiedAt < 10000
        ) {
          return;
        }
        push.notifySessionAttention(sessionId, session);
      }
    }
  });

  // GET /auth/check — lightweight auth probe (no side effects)
  app.get('/auth/check', requireAuth, (_req, res) => {
    res.json({ ok: true });
  });

  // GET /auth/status — no auth required, tells frontend if PIN is configured
  app.get('/auth/status', (_req, res) => {
    const config = getConfig();
    res.json({ hasPIN: !!config.pinHash });
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
      if (freshConfig.pinHash) {
        res
          .status(403)
          .json({ error: 'PIN is already configured. Use CLI to reset.' });
        return;
      }
      freshConfig.pinHash = await auth.hashPin(pin);
      saveConfig(CONFIG_PATH, freshConfig);

      // Auto-login: generate token and set cookie
      auth.clearRateLimit(ip);
      const token = auth.generateCookieToken();
      authenticatedTokens.add(token);
      const ttlMs = parseTTL(freshConfig.cookieTTL);
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
      if (!authConfig.pinHash) {
        res.status(412).json({ error: 'No PIN configured', needsSetup: true });
        return;
      }
      const valid =
        process.env.NO_PIN === '1' ||
        (await auth.verifyPin(pin, authConfig.pinHash));
      if (!valid) {
        auth.recordFailedAttempt(ip);
        res.status(401).json({ error: 'Invalid PIN' });
        return;
      }

      auth.clearRateLimit(ip);
      const token = auth.generateCookieToken();
      authenticatedTokens.add(token);

      const ttlMs = parseTTL(authConfig.cookieTTL);
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
  app.get('/sessions', requireAuth, async (_req, res) => {
    const allSessions = sessions.list();
    const now = Date.now();

    // Prune cache entries for sessions that no longer exist
    const activeIds = new Set(allSessions.map((s) => s.id));
    for (const sessionId of branchRefreshCache.keys()) {
      if (!activeIds.has(sessionId)) branchRefreshCache.delete(sessionId);
    }

    await Promise.all(
      allSessions.map(async (s) => {
        if (s.type !== 'agent') return;
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
            const raw = sessions.get(s.id);
            if (raw) raw.branchName = liveBranch;
          }
        } catch {
          /* non-fatal */
        }
      })
    );
    res.json(allSessions);
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
  app.get('/worktrees/status', requireAuth, async (req, res) => {
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
    const allSessions = sessions.list();
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

  boolConfigEndpoints('defaultContinue', true);
  boolConfigEndpoints('defaultYolo', false);
  boolConfigEndpoints('launchInTmux', false, async () => {
    await execFileAsync('tmux', ['-V']);
  });
  boolConfigEndpoints('defaultNotifications', true);
  boolConfigEndpoints('claudeFullscreen', true);
  boolConfigEndpoints('autoProvision', false);

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
      const next: AutomationSettings = { ...prev };

      if (typeof body.autoCheckoutReviewRequests === 'boolean') {
        next.autoCheckoutReviewRequests = body.autoCheckoutReviewRequests;
      }
      if (typeof body.autoReviewOnCheckout === 'boolean') {
        next.autoReviewOnCheckout = body.autoReviewOnCheckout;
      }
      if (
        typeof body.pollIntervalMs === 'number' &&
        body.pollIntervalMs >= 60000
      ) {
        next.pollIntervalMs = body.pollIntervalMs;
      }

      // Enforce: auto-review requires auto-checkout
      if (!next.autoCheckoutReviewRequests) {
        next.autoReviewOnCheckout = false;
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
  app.delete('/worktrees', requireAuth, async (req, res) => {
    const { worktreePath, repoPath, force } = req.body as {
      worktreePath?: string;
      repoPath?: string;
      force?: boolean;
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

    const validationErr = await validateWorktreeForDelete(
      worktreePath,
      repoPath,
      force ?? false,
      worktreeSessions
    );
    if (validationErr) {
      res.status(validationErr.status).json({
        error: validationErr.error,
        ...(validationErr.sessionIds && {
          sessionIds: validationErr.sessionIds,
        }),
      });
      return;
    }

    // Force: kill active sessions in this worktree first
    if (force) {
      for (const sessionId of worktreeSessions) {
        try {
          sessions.kill(sessionId);
        } catch (err) {
          logger.warn(
            `[worktrees] failed to kill session ${sessionId}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }

    // Derive branch name from metadata or worktree directory name
    const meta = readMeta(CONFIG_PATH, worktreePath);
    const branchName =
      (meta && meta.branchName) || worktreePath.split('/').pop() || '';

    const removeErr = await removeWorktreeFromDisk(
      worktreePath,
      repoPath,
      force ?? false
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

    if (branchName) {
      try {
        // Delete the branch
        await execFileAsync('git', ['branch', '-D', branchName], {
          cwd: repoPath,
        });
      } catch (_) {
        // Non-fatal: branch may not exist or may be checked out elsewhere
      }
    }

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

    res.json({ ok: true });
  });

  // POST /sessions — unified endpoint for agent and terminal sessions
  app.post('/sessions', requireAuth, async (req, res) => {
    const {
      repoPath,
      worktreePath,
      type = 'agent',
      agent,
      yolo,
      useTmux,
      claudeArgs,
      cols,
      rows,
      branchName: requestBranchName,
      needsBranchRename,
      branchRenamePrompt,
      initialPrompt,
      continue: explicitContinue,
      continuePolicy: explicitContinuePolicy,
      ticketContext,
    } = req.body as {
      repoPath?: string;
      worktreePath?: string | null;
      type?: 'agent' | 'terminal';
      agent?: AgentType;
      yolo?: boolean;
      useTmux?: boolean;
      claudeArgs?: string[];
      cols?: number;
      rows?: number;
      branchName?: string;
      needsBranchRename?: boolean;
      branchRenamePrompt?: string;
      initialPrompt?: string;
      continue?: boolean;
      continuePolicy?: ContinuePolicy;
      ticketContext?: {
        ticketId: string;
        title: string;
        description?: string;
        url: string;
        source: 'github' | 'jira';
        repoPath: string;
        repoName: string;
      };
    };

    if (!repoPath) {
      res.status(400).json({ error: 'repoPath is required' });
      return;
    }

    // Read config once for the lifetime of this request
    const freshConfig = getConfig();

    // Validate repoPath is a configured workspace
    const configuredWorkspaces = freshConfig.repos ?? [];
    if (!configuredWorkspaces.includes(repoPath)) {
      res.status(400).json({ error: 'repoPath is not a configured workspace' });
      return;
    }

    const cwd = worktreePath ?? repoPath;

    // Validate cwd directory exists
    if (!fs.existsSync(cwd)) {
      res.status(400).json({ error: `Directory does not exist: ${cwd}` });
      return;
    }

    const safeCols = clampDimension(cols, 1, 500);
    const safeRows = clampDimension(rows, 1, 200);

    const name = repoPath.split('/').filter(Boolean).pop() || 'session';
    const portVariables = getRepoPortVariables(freshConfig, repoPath);

    if (type === 'terminal') {
      // Terminal session — bare shell
      const shell = process.env.SHELL || '/bin/sh';
      const displayName = sessions.nextTerminalName();
      const session = sessions.create({
        type: 'terminal',
        agent: 'claude' as AgentType,
        repoName: name,
        repoPath,
        worktreePath: worktreePath ?? null,
        cwd,
        displayName,
        branchName: '',
        command: shell,
        args: [],
        ...(safeCols != null && { cols: safeCols }),
        ...(safeRows != null && { rows: safeRows }),
        // Pass port env var names for per-worktree port injection
        portVariables,
      });
      gitWatcher.watch(session.cwd);
      res.status(201).json(session);
      return;
    }

    // Agent session
    // Resolve continue policy (handles legacy boolean continue + new worktree override)
    const effectivePolicy = resolveContinuePolicy(
      explicitContinuePolicy,
      explicitContinue,
      needsBranchRename
    );

    const resolved = resolveSessionSettings(freshConfig, repoPath, {
      agent,
      yolo,
      useTmux,
      claudeArgs,
      continuePolicy: effectivePolicy,
    });
    const resolvedAgent = resolved.agent;
    const args = buildAgentArgs(
      resolvedAgent,
      resolved.claudeArgs,
      resolved.yolo,
      resolved.continuePolicy
    );

    // Ticket context validation and initial prompt
    let computedInitialPrompt: string | undefined = initialPrompt;
    if (ticketContext) {
      const ticketErr = validateTicketContext(
        ticketContext,
        configuredWorkspaces
      );
      if (ticketErr) {
        res.status(400).json({ error: ticketErr });
        return;
      }
      const repoSettings = freshConfig.repoSettings?.[ticketContext.repoPath];
      computedInitialPrompt = buildTicketInitialPrompt(
        ticketContext,
        repoSettings
      );
    }

    const displayName = sessions.nextAgentName();
    // Compute tmux-specific display name from repo + branch for identifiable tmux ls output
    // UI displayName stays as "Agent N" — tmux name and UI name are independent
    const tmuxDisplayName = requestBranchName
      ? `${name}-${requestBranchName}`
      : name;

    const session = createAgentSessionRecord({
      repoName: name,
      repoPath,
      worktreePath,
      cwd,
      requestBranchName,
      displayName,
      tmuxDisplayName,
      args,
      resolvedAgent,
      resolvedUseTmux: resolved.useTmux,
      resolvedYolo: resolved.yolo,
      resolvedClaudeArgs: resolved.claudeArgs,
      resolvedContinuePolicy: resolved.continuePolicy,
      safeCols,
      safeRows,
      needsBranchRename: needsBranchRename ?? false,
      branchRenamePrompt: branchRenamePrompt ?? '',
      computedInitialPrompt,
      claudeFullscreen: freshConfig.claudeFullscreen,
      portVariables,
    });

    gitWatcher.watch(session.cwd);

    if (ticketContext) {
      transitionOnSessionCreate(ticketContext).catch((err: unknown) => {
        logger.error('[index] transition on session create failed:', err);
      });
    }

    res.status(201).json(session);
  });

  // DELETE /sessions/:id
  app.delete('/sessions/:id', requireAuth, (req, res) => {
    const id = req.params['id'] as string;
    try {
      const sessionToDelete = sessions.get(id);
      sessions.kill(id);
      push.removeSession(id);
      if (sessionToDelete) gitWatcher.unwatch(sessionToDelete.cwd);
      res.json({ ok: true });
    } catch (_) {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // PATCH /sessions/:id — update displayName and persist to metadata
  app.patch('/sessions/:id', requireAuth, (req, res) => {
    const { displayName } = req.body as { displayName?: string };
    if (!displayName) {
      res.status(400).json({ error: 'displayName is required' });
      return;
    }
    try {
      const id = req.params['id'] as string;
      const updated = sessions.updateDisplayName(id, displayName);
      const session = sessions.get(id);
      if (session) {
        writeMeta(CONFIG_PATH, {
          worktreePath: session.cwd,
          displayName,
          lastActivity: session.lastActivity,
        });
      }
      res.json(updated);
    } catch (_) {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // POST /sessions/:id/image — upload clipboard image, proxy to system clipboard
  const ALLOWED_IMAGE_TYPES = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ];
  app.post('/sessions/:id/image', requireAuth, async (req, res) => {
    const { data, mimeType } = req.body as { data?: string; mimeType?: string };
    if (!data || !mimeType) {
      res.status(400).json({ error: 'data and mimeType are required' });
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
      res.status(400).json({ error: 'Unsupported image type: ' + mimeType });
      return;
    }
    // base64 is ~33% larger than binary; 10MB binary ≈ 13.3MB base64
    if (data.length > 14 * 1024 * 1024) {
      res.status(413).json({ error: 'Image too large (max 10MB)' });
      return;
    }
    const sessionId = req.params['id'] as string;
    if (!sessions.get(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    try {
      const ext = extensionForMime(mimeType);
      const dir = path.join(os.tmpdir(), 'relay-ide', sessionId);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'paste-' + Date.now() + ext);
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));

      let clipboardSet = false;
      try {
        clipboardSet = await setClipboardImage(filePath, mimeType);
      } catch {
        // Clipboard tools failed — fall back to path
      }

      if (clipboardSet) {
        sessions.write(sessionId, '\x16');
      }

      res.json({ path: filePath, clipboardSet });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Image upload failed';
      res.status(500).json({ error: message });
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
        serializeAll(configDir);
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

  // Browser content viewer (token-based auth, not cookie auth)
  const browserContentRouter = createBrowserContentRouter(broadcastEvent);
  app.use(browserContentRouter);

  // SPA catch-all — serve index.html for client-side routes (must be after all API routes)
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });

  // Clean expired browser content tokens every hour
  const BROWSER_TOKEN_TTL = 24 * 60 * 60 * 1000;
  setInterval(() => cleanExpiredTokens(BROWSER_TOKEN_TTL), 60 * 60 * 1000);

  // Clean up orphaned tmux sessions from previous runs (skip any adopted by restore)
  // Skip in dev mode — another server instance owns these sessions
  if (process.env.NO_PIN === '1') {
    logger.info('Dev mode: skipping orphaned tmux session cleanup.');
  } else {
    await cleanupOrphanedTmuxSessions(activeTmuxSessionNames());
  }

  async function gracefulShutdown() {
    await stopPolling();
    stopEventBatching();
    stopTelemetry();
    closeAnalytics();
    branchWatcher.close();
    refWatcher.close();
    gitWatcher.close();
    server.close();
    // Serialize sessions to disk BEFORE killing them
    serializeAll(configDir);
    // Kill all active sessions (PTY + tmux)
    for (const s of sessions.list()) {
      try {
        sessions.kill(s.id);
      } catch {
        /* already exiting */
      }
    }
    // Brief delay to let async tmux kill-session calls fire
    setTimeout(() => process.exit(0), 200);
  }
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  // Retry listen with backoff — handles EADDRINUSE during updates when the
  // previous process hasn't released the port yet (launchd KeepAlive restarts).
  const MAX_RETRIES = 5;
  let attempt = 0;
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
      throw err;
    }
  });
  tryListen();
}

main().catch((err) => logger.error('Unhandled fatal error:', err));
