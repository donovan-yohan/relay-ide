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

import { loadConfig, saveConfig, DEFAULTS, readMeta, writeMeta, deleteMeta, ensureMetaDir, resolveSessionSettings } from './config.js';
import * as auth from './auth.js';
import * as sessions from './sessions.js';
import { AGENT_CONTINUE_ARGS, AGENT_YOLO_ARGS, serializeAll, restoreFromDisk, activeTmuxSessionNames, populateMetaCache } from './sessions.js';
import { getTmuxPrefix } from './pty-handler.js';
import { setupWebSocket } from './ws.js';
import { WorktreeWatcher, BranchWatcher, RefWatcher, WORKTREE_DIRS, isValidWorktreePath, parseWorktreeListPorcelain, parseAllWorktrees } from './watcher.js';
import { isInstalled as serviceIsInstalled } from './service.js';
import { extensionForMime, setClipboardImage } from './clipboard.js';
import { listBranches, listBranchesEnriched } from './git.js';
import * as push from './push.js';
import { initAnalytics, closeAnalytics, createAnalyticsRouter } from './analytics.js';
import { createWorkspaceRouter, clearPrCache } from './workspaces.js';
import { createOrgDashboardRouter } from './org-dashboard.js';
import { createIntegrationGitHubRouter } from './integration-github.js';
import { createBranchLinkerRouter, invalidateBranchLinkerCache } from './branch-linker.js';
import { createHooksRouter } from './hooks.js';
import { createTicketTransitionsRouter } from './ticket-transitions.js';
import { createIntegrationJiraRouter } from './integration-jira.js';
import { startPolling, stopPolling } from './review-poller.js';
import { createGitHubAppRouter } from './github-app.js';
import { createWebhookRouter } from './webhooks.js';
import { createWebhookManagerRouter, reloadSmee, startSmartPolling } from './webhook-manager.js';
import { fetchPrsGraphQL } from './github-graphql.js';
import type { AgentType, AutomationSettings, Config } from './types.js';
import { semverLessThan } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

// When run via CLI bin, config lives in ~/.config/claude-remote-cli/
// When run directly (development), fall back to local config.json
const CONFIG_PATH = process.env.CLAUDE_REMOTE_CONFIG || path.join(__dirname, '..', '..', 'config.json');

const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lilheF3LelYSo0bu';

const VERSION_CACHE_TTL = 5 * 60 * 1000;
let versionCache: { latest: string; fetchedAt: number } | null = null;

function getCurrentVersion(): string {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}


async function getLatestVersion(): Promise<string | null> {
  const now = Date.now();
  if (versionCache && now - versionCache.fetchedAt < VERSION_CACHE_TTL) {
    return versionCache.latest;
  }
  try {
    const res = await fetch('https://registry.npmjs.org/claude-remote-cli/latest');
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    if (!data.version) return null;
    versionCache = { latest: data.version, fetchedAt: now };
    return data.version;
  } catch (_) {
    return null;
  }
}

function execErrorMessage(err: unknown, fallback: string): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || fallback).trim();
}

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
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default:  return 24 * 60 * 60 * 1000;
  }
}

function promptPin(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}


async function main(): Promise<void> {
  // Ignore SIGPIPE: node-pty can propagate pipe breaks causing unexpected session exits
  process.on('SIGPIPE', () => {});
  // Ignore SIGHUP: keep server alive if controlling terminal disconnects
  process.on('SIGHUP', () => {});

  ensureMetaDir(CONFIG_PATH);

  // Runtime config — always reads fresh from disk.
  // Use this for ALL config access in route handlers, pollers, and event callbacks.
  let lastGoodConfig: Config | null = null;
  function getConfig(): Config {
    try {
      const fresh = loadConfig(CONFIG_PATH);
      lastGoodConfig = fresh;
      return structuredClone(fresh);
    } catch (err) {
      console.warn('[config] Failed to load config, using last good config:', err);
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
  if (process.env.CLAUDE_REMOTE_PORT) startupConfig.port = parseInt(process.env.CLAUDE_REMOTE_PORT, 10);
  if (process.env.CLAUDE_REMOTE_HOST) startupConfig.host = process.env.CLAUDE_REMOTE_HOST;

  push.ensureVapidKeys(startupConfig, CONFIG_PATH, saveConfig);

  const configDir = path.dirname(CONFIG_PATH);
  try {
    initAnalytics(configDir);
  } catch (err) {
    console.warn('Analytics disabled: failed to initialize:', err instanceof Error ? err.message : err);
  }

  if (startupConfig.pinHash && auth.isLegacyHash(startupConfig.pinHash)) {
    console.log('Migrating legacy PIN hash to scrypt. You will need to set a new PIN.');
    delete startupConfig.pinHash;
    saveConfig(CONFIG_PATH, startupConfig);
  }

  if (process.env.NO_PIN === '1') {
    console.log('PIN disabled (NO_PIN=1).');
    startupConfig.pinHash = startupConfig.pinHash || 'disabled';
  } else if (!startupConfig.pinHash) {
    if (process.stdin.isTTY) {
      const pin = await promptPin('Set up a PIN for claude-remote-cli:');
      startupConfig.pinHash = await auth.hashPin(pin);
      saveConfig(CONFIG_PATH, startupConfig);
      console.log('PIN set successfully.');
    } else {
      console.log(`No PIN configured. Open http://localhost:${startupConfig.port} to set one.`);
    }
  }

  const authenticatedTokens = new Set<string>();

  // Build frontend if missing (e.g. fresh clone in development)
  const frontendDir = path.join(__dirname, '..', 'frontend');
  if (!fs.existsSync(path.join(frontendDir, 'index.html'))) {
    const packageRoot = path.join(__dirname, '..', '..');
    const viteConfig = path.join(packageRoot, 'frontend', 'vite.config.ts');
    if (fs.existsSync(viteConfig)) {
      console.log('Frontend not built — building now...');
      try {
        await execFileAsync('npx', ['vite', 'build', '--config', 'frontend/vite.config.ts'], { cwd: packageRoot });
        console.log('Frontend build complete.');
      } catch (err) {
        console.error('Frontend build failed:', err instanceof Error ? err.message : err);
      }
    } else {
      console.warn('Frontend assets missing and source not available — UI will not be served.');
    }
  }

  const app = express();

  // Mount webhooks BEFORE global express.json() — unconditionally.
  // Secret is validated at request time (returns 401 if not configured).
  let broadcastEventDelegate: ((type: string, data?: Record<string, unknown>) => void) | null = null;
  const webhookRouter = createWebhookRouter({
    secret: () => loadConfig(CONFIG_PATH).github?.webhookSecret,
    broadcastEvent: (type, data) => { broadcastEventDelegate?.(type, data); },
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
    broadcastEvent: (type, data) => { broadcastEventDelegate?.(type, data); },
    requireAuth,
  });
  app.use('/webhooks/manage', webhookManagerRouter);

  function boolConfigEndpoints(name: string, defaultValue: boolean, onEnable?: () => Promise<void>) {
    app.get(`/config/${name}`, requireAuth, (_req: express.Request, res: express.Response) => {
      res.json({ [name]: (getConfig() as unknown as Record<string, unknown>)[name] ?? defaultValue });
    });
    app.patch(`/config/${name}`, requireAuth, async (req: express.Request, res: express.Response) => {
      const value = (req.body as Record<string, unknown>)[name];
      if (typeof value !== 'boolean') {
        res.status(400).json({ error: `${name} must be a boolean` });
        return;
      }
      if (value && onEnable) {
        try { await onEnable(); } catch {
          res.status(400).json({ error: `Validation failed for ${name}` });
          return;
        }
      }
      const c = getConfig();
      (c as unknown as Record<string, unknown>)[name] = value;
      saveConfig(CONFIG_PATH, c);
      res.json({ [name]: value });
    });
  }

  const watcher = new WorktreeWatcher();
  watcher.rebuild(getConfig().workspaces || []);

  const server = http.createServer(app);
  const { broadcastEvent } = setupWebSocket(server, authenticatedTokens, watcher, CONFIG_PATH);

  // Wire up the delegate used by the webhook router (mounted before broadcastEvent was available)
  // Also clear the PR cache on real webhook events — these indicate actual PR state changes
  broadcastEventDelegate = (type, data) => {
    if (type === 'pr-updated') clearPrCache();
    broadcastEvent(type, data);
  };

  // Watch .git/HEAD files for branch changes and update active sessions
  const branchWatcher = new BranchWatcher((cwdPath, newBranch) => {
    for (const session of sessions.list()) {
      if (session.cwd === cwdPath) {
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
    // Rebuild ref watchers when branches change (new upstream to watch)
    rebuildRefWatcher();
  });
  branchWatcher.rebuild(getConfig().workspaces || []);
  watcher.on('worktrees-changed', () => {
    branchWatcher.rebuild(getConfig().workspaces || []);
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
    const entries = sessions.list()
      .filter(s => s.branchName)
      .map(s => ({ cwdPath: s.cwd, branch: s.branchName }));
    refWatcher.rebuild(entries).finally(() => {
      refWatcherRebuildPending = false;
      if (refWatcherNeedsRebuild) rebuildRefWatcher();
    });
  }

  rebuildRefWatcher();
  sessions.onSessionCreate(() => rebuildRefWatcher());
  sessions.onSessionEnd(() => rebuildRefWatcher());

  // Configure session defaults for hooks injection (startup-only — changing these requires restart)
  sessions.configure({ port: startupConfig.port, forceOutputParser: startupConfig.forceOutputParser ?? false });

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
    onWorkspacesChanged: () => {
      setImmediate(() => {
        try {
          const workspaces = getConfig().workspaces || [];
          watcher.rebuild(workspaces);
          branchWatcher.rebuild(workspaces);
        } catch (err) {
          console.error('Failed to rebuild workspace watchers:', err);
        }
      });
    },
  });
  app.use('/workspaces', requireAuth, workspaceRouter);

  // Mount GitHub integration router
  const integrationGitHubRouter = createIntegrationGitHubRouter({ configPath: CONFIG_PATH });
  app.use('/integration-github', requireAuth, integrationGitHubRouter);

  // Mount Jira integration router
  const integrationJiraRouter = createIntegrationJiraRouter({ configPath: CONFIG_PATH });
  app.use('/integration-jira', requireAuth, integrationJiraRouter);

  // Mount branch linker router
  const branchLinkerRouter = createBranchLinkerRouter({
    configPath: CONFIG_PATH,
    getActiveBranchNames: () => {
      const map = new Map<string, Set<string>>();
      for (const s of sessions.list()) {
        if (!s.branchName) continue;
        // Use workspacePath so all sessions (main worktree and sub-worktrees) group correctly
        const wsRoot = s.workspacePath || s.cwd;
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
  const { router: ticketTransitionsRouter, transitionOnSessionCreate, checkPrTransitions } = createTicketTransitionsRouter({ configPath: CONFIG_PATH });
  app.use('/ticket-transitions', requireAuth, ticketTransitionsRouter);

  // Mount GitHub device flow auth
  // onConnected is called after token save; reload smee so it picks up any new config.
  const githubAppRouter = createGitHubAppRouter({
    configPath: CONFIG_PATH,
    clientId: process.env.GITHUB_CLIENT_ID || DEFAULT_GITHUB_CLIENT_ID,
    onConnected: () => { reloadSmee(CONFIG_PATH, startupConfig.port); },
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

  // Restore sessions from a previous update restart
  const restoredCount = await restoreFromDisk(configDir, getConfig().workspaces ?? []);
  if (restoredCount > 0) {
    console.log(`Restored ${restoredCount} session(s) from previous update.`);
  }

  // Populate session metadata cache in background (non-blocking)
  populateMetaCache().catch(() => {});

  // Build shared deps for review poller
  function buildPollerDeps() {
    return {
      configPath: CONFIG_PATH,
      getWorkspacePaths: () => getConfig().workspaces ?? [],
      getWorkspaceSettings: (wsPath: string) => getConfig().workspaceSettings?.[wsPath],
      createSession: async (opts: { workspacePath: string; worktreePath: string; branchName: string; initialPrompt?: string }) => {
        const resolved = resolveSessionSettings(getConfig(), opts.workspacePath, {});
        const repoName = opts.workspacePath.split('/').filter(Boolean).pop() || 'session';
        const displayName = sessions.nextAgentName();
        sessions.create({
          type: 'agent',
          agent: resolved.agent,
          repoName,
          workspacePath: opts.workspacePath,
          worktreePath: opts.worktreePath,
          cwd: opts.worktreePath,
          branchName: opts.branchName,
          displayName,
          args: [...resolved.claudeArgs, ...(resolved.yolo ? AGENT_YOLO_ARGS[resolved.agent] : [])],
          configPath: CONFIG_PATH,
          useTmux: resolved.useTmux,
          yolo: resolved.yolo,
          claudeArgs: resolved.claudeArgs,
          ...(opts.initialPrompt != null && { initialPrompt: opts.initialPrompt }),
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
  sessions.onSessionCreate(() => { invalidateBranchLinkerCache(); });
  sessions.onSessionEnd((sessionId) => { invalidateBranchLinkerCache(); lastPushState.delete(sessionId); });

  // Push notifications on meaningful state transitions (skip when hooks already sent attention notification)
  const lastPushState = new Map<string, string>();
  sessions.onBackendStateChange((sessionId, state) => {
    const prevState = lastPushState.get(sessionId);
    lastPushState.set(sessionId, state);

    // Only notify on meaningful transitions: running → idle or running → permission
    if (prevState === 'running' && (state === 'idle' || state === 'permission')) {
      const session = sessions.get(sessionId);
      if (session && session.type !== 'terminal') {
        // Dedup: if hooks fired an attention notification within last 10s, skip
        if (session.hooksActive && session.lastAttentionNotifiedAt && Date.now() - session.lastAttentionNotifiedAt < 10000) {
          return;
        }
        push.notifySessionAttention(sessionId, session);
      }
    }
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
        res.status(403).json({ error: 'PIN is already configured. Use CLI to reset.' });
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
      console.error('[auth] Unhandled error in POST /auth/setup:', err);
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
      const valid = process.env.NO_PIN === '1' || await auth.verifyPin(pin, authConfig.pinHash);
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
      console.error('[auth] Unhandled error in POST /auth:', err);
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

    await Promise.all(allSessions.map(async (s) => {
      if (s.type !== 'agent') return;
      if (!s.cwd) return;
      const lastRefresh = branchRefreshCache.get(s.id) ?? 0;
      if (now - lastRefresh < BRANCH_REFRESH_INTERVAL_MS) return;
      const cwd = s.cwd;
      branchRefreshCache.set(s.id, now);
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
        const liveBranch = stdout.trim();
        if (liveBranch && liveBranch !== s.branchName) {
          s.branchName = liveBranch;
          const raw = sessions.get(s.id);
          if (raw) raw.branchName = liveBranch;
        }
      } catch { /* non-fatal */ }
    }));
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
    const enriched = await Promise.all(repos.map(async (repo) => {
      try {
        const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo.path });
        return { ...repo, defaultBranch: stdout.trim() };
      } catch {
        return { ...repo, defaultBranch: null };
      }
    }));
    res.json(enriched);
  });

  // GET /branches?repo=<path> — list local and remote branches for a repo
  app.get('/branches', requireAuth, async (req, res) => {
    const repoPath = typeof req.query.repo === 'string' ? req.query.repo : undefined;
    const refresh = req.query.refresh === '1';
    if (!repoPath) {
      res.status(400).json({ error: 'repo query parameter is required' });
      return;
    }

    const sessionList = sessions.list().map((s) => ({ id: s.id, worktreePath: s.worktreePath ?? s.workspacePath }));
    res.json(await listBranchesEnriched(repoPath, { refresh, sessions: sessionList }));
  });

  // GET /worktrees?repo=<path> — list worktrees; omit repo to scan all repos in all rootDirs
  app.get('/worktrees', requireAuth, async (req, res) => {
    const repoParam = typeof req.query.repo === 'string' ? req.query.repo : undefined;
    const roots = getConfig().rootDirs || [];
    const worktrees: Array<{ name: string; path: string; repoName: string; repoPath: string; root: string; displayName: string; lastActivity: string; branchName: string }> = [];

    let reposToScan: RepoEntry[];
    if (repoParam) {
      const root = roots.find(function (r) { return repoParam.startsWith(r); }) || '';
      reposToScan = [{ path: repoParam, name: repoParam.split('/').filter(Boolean).pop() || '', root }];
    } else {
      reposToScan = [];
      for (const rootDir of roots) {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(rootDir, { withFileTypes: true });
        } catch (_) {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const fullPath = path.join(rootDir, entry.name);
          const dotGit = path.join(fullPath, '.git');
          try {
            if (fs.statSync(dotGit).isDirectory()) {
              reposToScan.push({ name: entry.name, path: fullPath, root: rootDir });
            }
          } catch (_) {
            // .git doesn't exist — not a repo
          }
        }
      }

      // Also include directly-configured workspaces (may not be under any rootDir)
      const configWorkspaces = getConfig().workspaces ?? [];
      const scannedPaths = new Set(reposToScan.map(r => r.path));
      for (const wp of configWorkspaces) {
        if (scannedPaths.has(wp)) continue;
        const root = roots.find(r => wp.startsWith(r)) || '';
        reposToScan.push({ path: wp, name: wp.split('/').filter(Boolean).pop() || '', root });
      }
    }

    for (const repo of reposToScan) {
      // Use git worktree list to discover all worktrees (including those at arbitrary paths)
      try {
        const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repo.path });
        const parsed = parseWorktreeListPorcelain(stdout, repo.path);
        for (const wt of parsed) {
          const dirName = wt.path.split('/').pop() || '';
          const meta = readMeta(CONFIG_PATH, wt.path);
          worktrees.push({
            name: dirName,
            path: wt.path,
            repoName: repo.name,
            repoPath: repo.path,
            root: repo.root,
            displayName: meta?.displayName || wt.branch || dirName,
            lastActivity: meta?.lastActivity || '',
            branchName: wt.branch || meta?.branchName || dirName,
          });
        }
      } catch {
        // git worktree list failed — fall back to directory scanning
        for (const dir of WORKTREE_DIRS) {
          const worktreeDir = path.join(repo.path, dir);
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(worktreeDir, { withFileTypes: true });
          } catch (_) {
            continue;
          }
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const wtPath = path.join(worktreeDir, entry.name);
            const meta = readMeta(CONFIG_PATH, wtPath);
            worktrees.push({
              name: entry.name,
              path: wtPath,
              repoName: repo.name,
              repoPath: repo.path,
              root: repo.root,
              displayName: meta?.displayName || '',
              lastActivity: meta?.lastActivity || '',
              branchName: meta?.branchName || entry.name,
            });
          }
        }
      }
    }

    // Deduplicate by path (a worktree can appear via multiple repo scans)
    const seen = new Set<string>();
    const unique = worktrees.filter(wt => {
      if (seen.has(wt.path)) return false;
      seen.add(wt.path);
      return true;
    });

    res.json(unique);
  });

  // GET /config/defaultAgent — get default coding agent
  app.get('/config/defaultAgent', requireAuth, (_req, res) => {
    res.json({ defaultAgent: getConfig().defaultAgent || 'claude' });
  });

  // PATCH /config/defaultAgent — set default coding agent
  app.patch('/config/defaultAgent', requireAuth, (req, res) => {
    const { defaultAgent } = req.body as { defaultAgent?: string };
    if (!defaultAgent || (defaultAgent !== 'claude' && defaultAgent !== 'codex')) {
      res.status(400).json({ error: 'defaultAgent must be "claude" or "codex"' });
      return;
    }
    const c = getConfig();
    c.defaultAgent = defaultAgent;
    saveConfig(CONFIG_PATH, c);
    res.json({ defaultAgent: c.defaultAgent });
  });

  boolConfigEndpoints('defaultContinue', true);
  boolConfigEndpoints('defaultYolo', false);
  boolConfigEndpoints('launchInTmux', false, async () => {
    await execFileAsync('tmux', ['-V']);
  });
  boolConfigEndpoints('defaultNotifications', true);
  boolConfigEndpoints('autoProvision', false);

  // GET /config/automations — get automation settings
  app.get('/config/automations', requireAuth, (_req: express.Request, res: express.Response) => {
    res.json(getConfig().automations ?? {});
  });

  // PATCH /config/automations — update automation settings and start/stop poller
  app.patch('/config/automations', requireAuth, (req: express.Request, res: express.Response) => {
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
    if (typeof body.pollIntervalMs === 'number' && body.pollIntervalMs >= 60000) {
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
      console.error('[config] Failed to save automation settings:', err);
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
  });

  // GET /config/workspace-groups — return workspace group configuration
  app.get('/config/workspace-groups', requireAuth, (_req, res) => {
    res.json({ groups: getConfig().workspaceGroups ?? {} });
  });

  // GET /presets — return all filter presets (built-in merged with user presets)
  app.get('/presets', requireAuth, (_req: express.Request, res: express.Response) => {
    res.json(getConfig().filterPresets ?? []);
  });

  // POST /presets — add a new user filter preset
  app.post('/presets', requireAuth, (req: express.Request, res: express.Response) => {
    const { name, filters, sort } = req.body as { name?: string; filters?: unknown; sort?: unknown };
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (sort && typeof sort === 'object') {
      const dir = (sort as any).direction;
      if (dir !== 'asc' && dir !== 'desc') {
        res.status(400).json({ error: 'sort.direction must be "asc" or "desc"' });
        return;
      }
      const col = (sort as any).column;
      if (!col || typeof col !== 'string' || !col.trim()) {
        res.status(400).json({ error: 'sort.column must be a non-empty string' });
        return;
      }
    }
    const trimmedName = name.trim();
    const c = getConfig();
    const existingPresets = c.filterPresets ?? [];
    const duplicate = existingPresets.some((p) => p.name.toLowerCase() === trimmedName.toLowerCase());
    if (duplicate) {
      res.status(409).json({ error: `A preset named "${trimmedName}" already exists` });
      return;
    }
    const preset = { name: trimmedName, filters: (filters as { status?: string[]; repo?: string[]; role?: string[] }) ?? {}, sort: (sort as { column: string; direction: 'asc' | 'desc' }) ?? { column: 'role', direction: 'asc' as const } };
    if (!c.filterPresets) c.filterPresets = [];
    c.filterPresets.push(preset);
    saveConfig(CONFIG_PATH, c);
    res.json(preset);
  });

  // DELETE /presets/:name — remove a user preset (built-in presets cannot be deleted)
  app.delete('/presets/:name', requireAuth, (req: express.Request, res: express.Response) => {
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
  });

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
    const { subscription, sessionIds } = req.body as { subscription?: { endpoint: string; keys: { p256dh: string; auth: string } }; sessionIds?: string[] };
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
    const { worktreePath, repoPath } = req.body as { worktreePath?: string; repoPath?: string };
    if (!worktreePath || !repoPath) {
      res.status(400).json({ error: 'worktreePath and repoPath are required' });
      return;
    }

    // Validate the path is a real git worktree (not the main worktree)
    try {
      const { stdout: wtListOut } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
      const allWorktrees = parseAllWorktrees(wtListOut, repoPath);
      const isKnownWorktree = allWorktrees.some(wt => wt.path === path.resolve(worktreePath) && !wt.isMain);
      if (!isKnownWorktree) {
        res.status(400).json({ error: 'Path is not a recognized git worktree' });
        return;
      }
    } catch {
      // If git worktree list fails, fall back to the directory-name check
      if (!isValidWorktreePath(worktreePath)) {
        res.status(400).json({ error: 'Path is not inside a worktree directory' });
        return;
      }
    }

    // Multiple sessions per worktree allowed (multi-tab support)

    // Derive branch name from metadata or worktree directory name
    const meta = readMeta(CONFIG_PATH, worktreePath);
    const branchName = (meta && meta.branchName) || worktreePath.split('/').pop() || '';

    try {
      // Will fail if uncommitted changes -- no --force
      await execFileAsync('git', ['worktree', 'remove', worktreePath], { cwd: repoPath });
    } catch (err: unknown) {
      // If git worktree remove fails, the directory may be an orphaned worktree
      // that git no longer tracks. Try to remove the directory directly.
      if (fs.existsSync(worktreePath)) {
        try {
          fs.rmSync(worktreePath, { recursive: true });
        } catch (rmErr: unknown) {
          res.status(500).json({ error: execErrorMessage(rmErr, 'Failed to remove worktree directory') });
          return;
        }
      }
      // If directory doesn't exist, the worktree is already gone — continue to cleanup
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
        await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoPath });
      } catch (_) {
        // Non-fatal: branch may not exist or may be checked out elsewhere
      }
    }

    // Clean up metadata file
    deleteMeta(CONFIG_PATH, worktreePath);

    res.json({ ok: true });
  });

  // POST /sessions — unified endpoint for agent and terminal sessions
  app.post('/sessions', requireAuth, async (req, res) => {
    const {
      workspacePath, worktreePath, type = 'agent', agent, yolo, useTmux,
      claudeArgs, cols, rows, branchName: requestBranchName, needsBranchRename, branchRenamePrompt,
      initialPrompt, continue: explicitContinue, ticketContext,
    } = req.body as {
      workspacePath?: string;
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
      ticketContext?: { ticketId: string; title: string; description?: string; url: string; source: 'github' | 'jira'; repoPath: string; repoName: string };
    };

    if (!workspacePath) {
      res.status(400).json({ error: 'workspacePath is required' });
      return;
    }

    // Read config once for the lifetime of this request
    const freshConfig = getConfig();

    // Validate workspacePath is a configured workspace
    const configuredWorkspaces = freshConfig.workspaces ?? [];
    if (!configuredWorkspaces.includes(workspacePath)) {
      res.status(400).json({ error: 'workspacePath is not a configured workspace' });
      return;
    }

    const cwd = worktreePath ?? workspacePath;

    // Validate cwd directory exists
    if (!fs.existsSync(cwd)) {
      res.status(400).json({ error: `Directory does not exist: ${cwd}` });
      return;
    }

    const safeCols = typeof cols === 'number' && Number.isFinite(cols) && cols >= 1 && cols <= 500 ? Math.round(cols) : undefined;
    const safeRows = typeof rows === 'number' && Number.isFinite(rows) && rows >= 1 && rows <= 200 ? Math.round(rows) : undefined;

    const name = workspacePath.split('/').filter(Boolean).pop() || 'session';

    if (type === 'terminal') {
      // Terminal session — bare shell
      const shell = process.env.SHELL || '/bin/sh';
      const displayName = sessions.nextTerminalName();
      const session = sessions.create({
        type: 'terminal',
        agent: 'claude' as AgentType,
        repoName: name,
        workspacePath,
        worktreePath: worktreePath ?? null,
        cwd,
        displayName,
        branchName: '',
        command: shell,
        args: [],
        ...(safeCols != null && { cols: safeCols }),
        ...(safeRows != null && { rows: safeRows }),
      });
      res.status(201).json(session);
      return;
    }

    // Agent session
    const resolved = resolveSessionSettings(freshConfig, workspacePath, { agent, yolo, useTmux, claudeArgs });
    const resolvedAgent = resolved.agent;

    const baseArgs = [
      ...(resolved.claudeArgs),
      ...(resolved.yolo ? AGENT_YOLO_ARGS[resolvedAgent] : []),
    ];

    // Determine --continue behavior
    let useContinue = false;
    if (explicitContinue !== undefined) {
      useContinue = explicitContinue;
    } else if (needsBranchRename) {
      useContinue = false; // brand-new worktree
    } else {
      useContinue = resolved.continue && fs.existsSync(path.join(cwd, '.claude'));
    }

    const args = useContinue
      ? [...AGENT_CONTINUE_ARGS[resolvedAgent], ...baseArgs]
      : [...baseArgs];

    // Ticket context validation and initial prompt
    let computedInitialPrompt: string | undefined = initialPrompt;
    if (ticketContext) {
      if (typeof ticketContext.ticketId !== 'string' || typeof ticketContext.title !== 'string' || typeof ticketContext.url !== 'string') {
        res.status(400).json({ error: 'ticketContext requires string ticketId, title, and url' });
        return;
      }
      if (ticketContext.source !== 'github' && ticketContext.source !== 'jira') {
        res.status(400).json({ error: "ticketContext.source must be 'github' or 'jira'" });
        return;
      }
      if (!configuredWorkspaces.includes(ticketContext.repoPath)) {
        res.status(400).json({ error: 'ticketContext.repoPath is not a configured workspace' });
        return;
      }
      if (ticketContext.source === 'github' && !/^GH-\d+$/.test(ticketContext.ticketId)) {
        res.status(400).json({ error: 'ticketContext.ticketId for github must match GH-<number>' });
        return;
      }
      if (ticketContext.source === 'jira' && !/^[A-Z][A-Z0-9]*-\d+$/.test(ticketContext.ticketId)) {
        res.status(400).json({ error: 'ticketContext.ticketId must match <PROJECT>-<number>' });
        return;
      }
      const settings = freshConfig.workspaceSettings?.[ticketContext.repoPath];
      const template = settings?.promptStartWork ??
        'You are working on ticket {ticketId}: {title}\n\nTicket URL: {ticketUrl}\n\nPlease start by understanding the issue and proposing an approach.';
      computedInitialPrompt = template
        .replace(/\{ticketId\}/g, ticketContext.ticketId)
        .replace(/\{title\}/g, ticketContext.title)
        .replace(/\{ticketUrl\}/g, ticketContext.url)
        .replace(/\{description\}/g, ticketContext.description ?? '');
    }

    const displayName = sessions.nextAgentName();
    const session = sessions.create({
      type: 'agent',
      agent: resolvedAgent,
      repoName: name,
      workspacePath,
      worktreePath: worktreePath ?? null,
      cwd,
      branchName: requestBranchName || '',  // caller may provide; branch watcher enriches later
      displayName,
      args,
      configPath: CONFIG_PATH,
      useTmux: resolved.useTmux,
      yolo: resolved.yolo,
      claudeArgs: resolved.claudeArgs,
      ...(safeCols != null && { cols: safeCols }),
      ...(safeRows != null && { rows: safeRows }),
      needsBranchRename: needsBranchRename ?? false,
      branchRenamePrompt: branchRenamePrompt ?? '',
      ...(computedInitialPrompt != null && { initialPrompt: computedInitialPrompt }),
    });

    // Write worktree metadata if in a worktree
    if (worktreePath) {
      writeMeta(CONFIG_PATH, {
        worktreePath: cwd,
        displayName,
        lastActivity: new Date().toISOString(),
        branchName: requestBranchName || '',
      });
    }

    if (ticketContext) {
      transitionOnSessionCreate(ticketContext).catch((err: unknown) => {
        console.error('[index] transition on session create failed:', err);
      });
    }

    res.status(201).json(session);
  });

  // DELETE /sessions/:id
  app.delete('/sessions/:id', requireAuth, (req, res) => {
    const id = req.params['id'] as string;
    try {
      sessions.kill(id);
      push.removeSession(id);
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
        writeMeta(CONFIG_PATH, { worktreePath: session.cwd, displayName, lastActivity: session.lastActivity });
      }
      res.json(updated);
    } catch (_) {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // POST /sessions/:id/image — upload clipboard image, proxy to system clipboard
  const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
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
      const dir = path.join(os.tmpdir(), 'claude-remote-cli', sessionId);
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
      const message = err instanceof Error ? err.message : 'Image upload failed';
      res.status(500).json({ error: message });
    }
  });

  // GET /version — check current vs latest
  app.get('/version', requireAuth, async (_req, res) => {
    const current = getCurrentVersion();
    const latest = await getLatestVersion();
    const updateAvailable = latest !== null && semverLessThan(current, latest);
    res.json({ current, latest, updateAvailable });
  });

  // POST /update — install latest version from npm
  app.post('/update', requireAuth, async (_req, res) => {
    try {
      await execFileAsync('npm', ['install', '-g', 'claude-remote-cli@latest']);
      const restarting = serviceIsInstalled();
      if (restarting) {
        // Persist sessions so they can be restored after restart
        const configDir = path.dirname(CONFIG_PATH);
        serializeAll(configDir);
      }
      res.json({ ok: true, restarting });
      if (restarting) {
        setTimeout(() => process.exit(0), 1000);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      res.status(500).json({ ok: false, error: message });
    }
  });

  // Clean up orphaned tmux sessions from previous runs (skip any adopted by restore)
  // Skip in dev mode — another server instance owns these sessions
  if (process.env.NO_PIN === '1') {
    console.log('Dev mode: skipping orphaned tmux session cleanup.');
  } else try {
    const adoptedNames = activeTmuxSessionNames();
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}']);
    const tmuxPrefix = getTmuxPrefix();
    const orphanedSessions = stdout.trim().split('\n').filter(name => name.startsWith(tmuxPrefix) && !adoptedNames.has(name));
    for (const name of orphanedSessions) {
      execFileAsync('tmux', ['kill-session', '-t', name]).catch(() => {});
    }
    if (orphanedSessions.length > 0) {
      console.log(`Cleaned up ${orphanedSessions.length} orphaned tmux session(s).`);
    }
  } catch {
    // tmux not installed or no sessions — ignore
  }

  async function gracefulShutdown() {
    await stopPolling();
    closeAnalytics();
    branchWatcher.close();
    refWatcher.close();
    server.close();
    // Serialize sessions to disk BEFORE killing them
    const configDir = path.dirname(CONFIG_PATH);
    serializeAll(configDir);
    // Kill all active sessions (PTY + tmux)
    for (const s of sessions.list()) {
      try { sessions.kill(s.id); } catch { /* already exiting */ }
    }
    // Brief delay to let async tmux kill-session calls fire
    setTimeout(() => process.exit(0), 200);
  }
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  server.listen(startupConfig.port, startupConfig.host, () => {
    const addr = server.address() as import('node:net').AddressInfo;
    console.log(`claude-remote-cli listening on ${startupConfig.host}:${addr.port}`);
  });
}

main().catch(console.error);
