import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { loadConfig, saveConfig, getRepoSettings, setRepoSettings, deleteRepoSettingKeys, writeMeta, readMeta } from './config.js';
import { findOrCreateWorktreeForBranch } from './watcher.js';
import { trackEvent } from './analytics.js';
import { listBranches, getActivityFeed, getCiStatus, getPrForBranch, isStalePr, getUnresolvedCommentCount, switchBranch, getCurrentBranch, extractOwnerRepo, renameBranch, createBranch, changePrBase, pushBranch, getChangedFiles, getFileDiff, getDefaultBranch, ensureBranchLocal } from './git.js';
import type { Config, PrInfo, PullRequest, PullRequestsResponse, Repo } from './types.js';
import { MOUNTAIN_NAMES } from './types.js';

const execFileAsync = promisify(execFile);

/** Extract repo name from a git remote URL (SSH or HTTPS). */
export function repoNameFromRemoteUrl(url: string): string | undefined {
  // Strip trailing slash before splitting so pop() gets the last real segment
  const name = url.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/, '');
  return name || undefined;
}

const BROWSE_DENYLIST = new Set([
  'node_modules', '.git', '.Trash', '__pycache__',
  '.cache', '.npm', '.yarn', '.nvm',
]);

// ── Files-list cache (used by GET /workspaces/files-list) ──
const filesListCache = new Map<string, { files: string[]; truncated: boolean; total: number; ts: number }>();
const FILES_LIST_TTL = 30_000;
const FILES_LIST_MAX = 50_000;

export function clearFilesListCache(workspacePath?: string): void {
  if (!workspacePath) { filesListCache.clear(); return; }
  // Direct match (most common: watcher path = repo root)
  if (filesListCache.delete(workspacePath)) return;
  // Subdirectory match: watcher path may be a subdirectory of the cached repo root
  for (const key of filesListCache.keys()) {
    if (workspacePath.startsWith(key + path.sep)) { filesListCache.delete(key); return; }
  }
}

const BROWSE_MAX_ENTRIES = 100;
const BULK_MAX_PATHS = 50;

// ── PR lookup cache ─────────────────────────────────────────────────────────
// Caches `getPrForBranch` results to avoid spawning a `gh` subprocess on every
// request. Negative results (no PR) use a longer TTL since they only change on
// user action (push, PR creation).

const PR_CACHE_POSITIVE_TTL_MS = 60_000;   // 60s — same as org-dashboard
const PR_CACHE_NEGATIVE_TTL_MS = 300_000;  // 5 min — "no PR" rarely changes without user action

interface PrCacheEntry {
  result: PrInfo | null;
  fetchedAt: number;
}

const prCache = new Map<string, PrCacheEntry>();

function prCacheKey(repoPath: string, branch: string): string {
  return `${repoPath}:${branch}`;
}

function getPrCached(repoPath: string, branch: string): PrCacheEntry | undefined {
  const key = prCacheKey(repoPath, branch);
  const entry = prCache.get(key);
  if (!entry) return undefined;
  const ttl = entry.result ? PR_CACHE_POSITIVE_TTL_MS : PR_CACHE_NEGATIVE_TTL_MS;
  if (Date.now() - entry.fetchedAt > ttl) {
    prCache.delete(key);
    return undefined;
  }
  return entry;
}

function setPrCached(repoPath: string, branch: string, result: PrInfo | null): void {
  prCache.set(prCacheKey(repoPath, branch), { result, fetchedAt: Date.now() });
}

/** Clear PR cache entries. If repoPath is given, only clears entries for that repo. */
export function clearPrCache(repoPath?: string): void {
  if (!repoPath) {
    prCache.clear();
    return;
  }
  const prefix = `${repoPath}:`;
  for (const key of prCache.keys()) {
    if (key.startsWith(prefix)) prCache.delete(key);
  }
}

// Deps type

export interface WorkspaceDeps {
  configPath: string;
  /** Injected so tests can override execFile calls */
  execAsync?: typeof execFileAsync;
  /** Called after any workspace mutation (add, remove, reorder, bulk-add) so watchers can rebuild */
  onWorkspacesChanged?: () => void;
}

// Exported helpers

/**
 * Resolves and validates a raw workspace path string.
 * Throws with a human-readable message if the path is invalid.
 */
export async function validateWorkspacePath(rawPath: string): Promise<string> {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  const resolved = path.resolve(rawPath);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  return resolved;
}

/**
 * Detects whether a directory is the root of a git repository and, if so,
 * what the default branch name is.
 */
export async function detectGitRepo(
  dirPath: string,
  execAsync: typeof execFileAsync = execFileAsync,
): Promise<{ isGitRepo: boolean; defaultBranch: string | null }> {
  try {
    await execAsync('git', ['rev-parse', '--git-dir'], { cwd: dirPath });
  } catch {
    return { isGitRepo: false, defaultBranch: null };
  }

  // Attempt to determine the default branch from remote HEAD
  let defaultBranch: string | null = null;
  try {
    const { stdout } = await execAsync(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      { cwd: dirPath },
    );
    const trimmed = stdout.trim();
    // "origin/main" → "main"
    defaultBranch = trimmed.replace(/^origin\//, '') || null;
  } catch {
    // Fall back to checking local HEAD
    try {
      const { stdout } = await execAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dirPath });
      defaultBranch = stdout.trim() || null;
    } catch {
      // Cannot determine default branch
    }
  }

  return { isGitRepo: true, defaultBranch };
}

// Router factory

/**
 * Creates and returns an Express Router that handles all /workspaces routes.
 *
 * Caller is responsible for mounting and applying auth middleware:
 *   app.use('/workspaces', requireAuth, createWorkspaceRouter({ configPath }));
 */
export function createWorkspaceRouter(deps: WorkspaceDeps): Router {
  const { configPath } = deps;
  const exec = deps.execAsync ?? execFileAsync;

  const router = Router();

  // Helper: reload config on every request so concurrent changes are reflected
  function getConfig(): Config {
    return loadConfig(configPath);
  }

  // GET /workspaces — list all workspaces with git info
  router.get('/', async (_req: Request, res: Response) => {
    const config = getConfig();
    const workspacePaths = config.repos ?? [];

    const results: Repo[] = await Promise.all(
      workspacePaths.map(async (p) => {
        const { isGitRepo, defaultBranch } = await detectGitRepo(p, exec);

        let name = path.basename(p);
        let currentBranch: string | null = null;

        if (isGitRepo) {
          try {
            const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: p });
            const url = stdout.trim();
            if (url) {
              const remoteName = repoNameFromRemoteUrl(url);
              if (remoteName) name = remoteName;
            }
          } catch {
            // No remote configured — fall back to directory name
          }
          try {
            const { stdout } = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: p });
            currentBranch = stdout.trim() || null;
          } catch { /* detached HEAD or other error */ }
        }

        return { path: p, name, isGitRepo, defaultBranch, currentBranch };
      }),
    );

    res.json({ workspaces: results });
  });

  // POST /workspaces — add a workspace
  router.post('/', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const rawPath = body.path;

    if (typeof rawPath !== 'string' || !rawPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    let resolved: string;
    try {
      resolved = await validateWorkspacePath(rawPath);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const config = getConfig();
    const workspaces = config.repos ?? [];

    if (workspaces.includes(resolved)) {
      res.status(409).json({ error: 'Workspace already exists' });
      return;
    }

    const { isGitRepo, defaultBranch } = await detectGitRepo(resolved, exec);

    config.repos = [...workspaces, resolved];

    // Store detected default branch in per-repo settings
    if (isGitRepo && defaultBranch) {
      if (!config.repoSettings) config.repoSettings = {};
      config.repoSettings[resolved] = {
        ...config.repoSettings[resolved],
        defaultBranch,
      };
    }

    saveConfig(configPath, config);
    try { deps.onWorkspacesChanged?.(); } catch (err) { console.error('onWorkspacesChanged failed:', err); }
    trackEvent({ category: 'workspace', action: 'added', target: resolved, properties: { name: path.basename(resolved) } });

    let currentBranch: string | null = null;
    if (isGitRepo) {
      try {
        const { stdout } = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: resolved });
        currentBranch = stdout.trim() || null;
      } catch { /* detached HEAD */ }
    }
    const workspace: Repo = {
      path: resolved,
      name: path.basename(resolved),
      isGitRepo,
      defaultBranch,
      currentBranch,
    };

    res.status(201).json(workspace);
  });

  // DELETE /workspaces — remove a workspace
  router.delete('/', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const rawPath = body.path;

    if (typeof rawPath !== 'string' || !rawPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const resolved = path.resolve(rawPath);
    const config = getConfig();
    const workspaces = config.repos ?? [];
    const idx = workspaces.indexOf(resolved);

    if (idx === -1) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Clean up GitHub webhook if one exists for this workspace
    const wsSettings = config.repoSettings?.[resolved];
    if (wsSettings?.webhookId && config.github?.accessToken) {
      try {
        const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: resolved, timeout: 5000 });
        const ownerRepo = extractOwnerRepo(stdout.trim());
        if (ownerRepo) {
          await globalThis.fetch(`https://api.github.com/repos/${ownerRepo}/hooks/${wsSettings.webhookId}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${config.github.accessToken}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          });
        }
      } catch (err) {
        // Best-effort — log but don't block workspace removal
        console.warn('[workspaces] Failed to delete webhook for', resolved, err instanceof Error ? err.message : String(err));
      }
    }

    // Also clean up webhook-related repoSettings
    if (config.repoSettings?.[resolved]) {
      delete config.repoSettings[resolved].webhookId;
      delete config.repoSettings[resolved].webhookEnabled;
      delete config.repoSettings[resolved].webhookError;
    }

    config.repos = workspaces.filter((p) => p !== resolved);
    saveConfig(configPath, config);
    try { deps.onWorkspacesChanged?.(); } catch (err) { console.error('onWorkspacesChanged failed:', err); }
    trackEvent({ category: 'workspace', action: 'removed', target: resolved });

    res.json({ removed: resolved });
  });

  // PUT /workspaces/reorder — reorder workspaces
  router.put('/reorder', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const rawPaths = body.paths;

    if (!Array.isArray(rawPaths)) {
      res.status(400).json({ error: 'paths array is required' });
      return;
    }

    const config = getConfig();
    const current = config.repos ?? [];

    // Validate that the submitted paths are the same set as the current workspaces
    if (rawPaths.length !== current.length) {
      res.status(400).json({ error: 'paths must contain the same set of workspaces as the current configuration' });
      return;
    }

    const currentSet = new Set(current);
    for (const p of rawPaths) {
      if (typeof p !== 'string' || !currentSet.has(p)) {
        res.status(400).json({ error: 'paths must contain the same set of workspaces as the current configuration' });
        return;
      }
    }

    config.repos = rawPaths as string[];
    saveConfig(configPath, config);
    try { deps.onWorkspacesChanged?.(); } catch (err) { console.error('onWorkspacesChanged failed:', err); }

    const results: Repo[] = await Promise.all(
      (rawPaths as string[]).map(async (p) => {
        const name = path.basename(p);
        const { isGitRepo, defaultBranch } = await detectGitRepo(p, exec);
        let currentBranch: string | null = null;
        if (isGitRepo) {
          try {
            const { stdout } = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: p });
            currentBranch = stdout.trim() || null;
          } catch { /* detached HEAD */ }
        }
        return { path: p, name, isGitRepo, defaultBranch, currentBranch };
      }),
    );

    res.json({ workspaces: results });
  });

  // POST /workspaces/bulk — add multiple workspaces at once
  router.post('/bulk', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const rawPaths = body.paths;

    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      res.status(400).json({ error: 'paths array is required' });
      return;
    }

    if (rawPaths.length > BULK_MAX_PATHS) {
      res.status(400).json({ error: `Too many paths (max ${BULK_MAX_PATHS})` });
      return;
    }

    const config = getConfig();
    const existing = new Set(config.repos ?? []);
    const added: Repo[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    for (const rawPath of rawPaths) {
      if (typeof rawPath !== 'string' || !rawPath) {
        errors.push({ path: String(rawPath), error: 'Invalid path' });
        continue;
      }

      let resolved: string;
      try {
        resolved = await validateWorkspacePath(rawPath);
      } catch (err) {
        errors.push({ path: rawPath, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      if (existing.has(resolved)) {
        errors.push({ path: rawPath, error: 'Already exists' });
        continue;
      }

      const { isGitRepo, defaultBranch } = await detectGitRepo(resolved, exec);

      existing.add(resolved);
      let currentBranch: string | null = null;
      if (isGitRepo) {
        try {
          const { stdout } = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: resolved });
          currentBranch = stdout.trim() || null;
        } catch { /* detached HEAD */ }
      }
      added.push({ path: resolved, name: path.basename(resolved), isGitRepo, defaultBranch, currentBranch });

      // Store detected default branch in per-repo settings
      if (isGitRepo && defaultBranch) {
        if (!config.repoSettings) config.repoSettings = {};
        config.repoSettings[resolved] = {
          ...config.repoSettings[resolved],
          defaultBranch,
        };
      }
    }

    if (added.length > 0) {
      config.repos = [...(config.repos ?? []), ...added.map((a) => a.path)];
      saveConfig(configPath, config);
      try { deps.onWorkspacesChanged?.(); } catch (err) { console.error('onWorkspacesChanged failed:', err); }
    }

    res.status(201).json({ added, errors });
  });

  // GET /workspaces/dashboard — aggregated PR + activity data for a workspace
  router.get('/dashboard', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;

    if (!repoPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    const fields = 'number,title,url,headRefName,baseRefName,state,author,updatedAt,additions,deletions,reviewDecision,mergeable,mergeStateStatus,isDraft';

    // Get current GitHub user
    let currentUser = '';
    try {
      const { stdout: whoami } = await exec('gh', ['api', 'user', '--jq', '.login'], { cwd: repoPath });
      currentUser = whoami.trim();
    } catch {
      const response: PullRequestsResponse = { prs: [], error: 'gh_not_authenticated' };
      res.json({ pullRequests: response, branches: [] });
      return;
    }

    // Helper to map raw gh JSON to PullRequest
    function mapRawPr(raw: Record<string, unknown>, role: 'author' | 'reviewer', fallbackAuthor: string): PullRequest {
      return {
        number: raw.number as number,
        title: raw.title as string,
        url: raw.url as string,
        headRefName: raw.headRefName as string,
        baseRefName: (raw.baseRefName as string) ?? '',
        state: raw.state as 'OPEN' | 'CLOSED' | 'MERGED',
        author: (raw.author as { login?: string })?.login ?? fallbackAuthor,
        role,
        updatedAt: raw.updatedAt as string,
        additions: (raw.additions as number) ?? 0,
        deletions: (raw.deletions as number) ?? 0,
        reviewDecision: (raw.reviewDecision as 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null) ?? null,
        mergeable: (raw.mergeable as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null) ?? null,
        isDraft: (raw.isDraft as boolean) ?? false,
        ciStatus: null,
      };
    }

    // Fetch authored + review-requested PRs in parallel
    const [authored, reviewing] = await Promise.all([
      (async (): Promise<PullRequest[]> => {
        try {
          const { stdout } = await exec(
            'gh',
            ['pr', 'list', '--author', currentUser, '--state', 'open', '--limit', '30', '--json', fields],
            { cwd: repoPath },
          );
          return (JSON.parse(stdout) as Array<Record<string, unknown>>).map(pr => mapRawPr(pr, 'author', currentUser));
        } catch { return []; }
      })(),
      (async (): Promise<PullRequest[]> => {
        try {
          const { stdout } = await exec(
            'gh',
            ['pr', 'list', '--search', `review-requested:${currentUser}`, '--state', 'open', '--limit', '30', '--json', fields],
            { cwd: repoPath },
          );
          return (JSON.parse(stdout) as Array<Record<string, unknown>>).map(pr => mapRawPr(pr, 'reviewer', ''));
        } catch { return []; }
      })(),
    ]);

    // Deduplicate: if a PR appears in both, keep as 'author'
    const seen = new Set(authored.map((pr) => pr.number));
    const combined = [...authored, ...reviewing.filter((pr) => !seen.has(pr.number))];

    // Sort by updatedAt descending
    combined.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const pullRequests: PullRequestsResponse = { prs: combined };

    // Fetch branches for the repo
    let branches: string[] = [];
    try {
      branches = await listBranches(repoPath);
    } catch { /* not a git repo or git unavailable */ }

    // Fetch recent activity
    let activity: Awaited<ReturnType<typeof getActivityFeed>> = [];
    try {
      activity = await getActivityFeed(repoPath);
    } catch { /* git log unavailable */ }

    res.json({
      pullRequests,
      branches,
      activity,
    });
  });

  function buildMergedSettings(config: Config, repoPath: string): { settings: ReturnType<typeof getRepoSettings>; overridden: string[] } {
    const resolved = path.resolve(repoPath);
    const wsOverrides = config.repoSettings?.[resolved] ?? {};
    const effective = getRepoSettings(config, resolved);
    const overridden: string[] = [];
    for (const key of ['defaultAgent', 'defaultContinue', 'defaultYolo', 'launchInTmux'] as const) {
      if (wsOverrides[key] !== undefined) overridden.push(key);
    }
    return { settings: effective, overridden };
  }

  // GET /workspaces/settings — per-repo overrides only
  router.get('/settings', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    if (!repoPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    // Backward compat: handle merged=true inline (same logic as /settings/merged)
    if (req.query.merged === 'true') {
      res.json(buildMergedSettings(getConfig(), repoPath));
      return;
    }
    const config = getConfig();
    const resolved = path.resolve(repoPath);
    const settings = config.repoSettings?.[resolved] ?? {};
    res.json(settings);
  });

  // GET /workspaces/settings/merged — effective settings with override tracking
  router.get('/settings/merged', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    if (!repoPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    res.json(buildMergedSettings(getConfig(), repoPath));
  });

  // PATCH /workspaces/settings — update per-repo settings
  router.patch('/settings', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;

    if (!repoPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    const resolved = path.resolve(repoPath);
    const updates = req.body as Record<string, unknown>;

    const config = getConfig();

    // Separate null values (deletions) from actual updates
    const keysToDelete: string[] = [];
    const keysToUpdate: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) {
        keysToDelete.push(key);
      } else {
        keysToUpdate[key] = value;
      }
    }

    // Apply deletions first
    if (keysToDelete.length > 0) {
      deleteRepoSettingKeys(configPath, config, resolved, keysToDelete);
    }

    // Apply updates
    if (Object.keys(keysToUpdate).length > 0) {
      setRepoSettings(configPath, config, resolved, keysToUpdate);
    }

    // Return the current raw repo settings
    const final = config.repoSettings?.[resolved] ?? {};
    res.json(final);
  });

  // GET /workspaces/pr — PR info for a specific branch
  router.get('/pr', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const branch = typeof req.query.branch === 'string' ? req.query.branch : undefined;

    if (!repoPath || !branch) {
      res.status(400).json({ error: 'path and branch query parameters are required' });
      return;
    }

    const cached = getPrCached(repoPath, branch);
    if (cached) {
      res.json({ pr: cached.result });
      return;
    }

    try {
      const pr = await getPrForBranch(repoPath, branch);
      if (pr && !isStalePr(pr)) {
        let unresolvedCommentCount = 0;
        if (pr.state === 'OPEN') {
          try {
            unresolvedCommentCount = await getUnresolvedCommentCount(repoPath, pr.number);
          } catch { /* degrade gracefully — show PR without comment count */ }
        }
        const enriched = { ...pr, unresolvedCommentCount };
        setPrCached(repoPath, branch, enriched);
        res.json({ pr: enriched });
      } else {
        setPrCached(repoPath, branch, null);
        res.json({ pr: null });
      }
    } catch {
      // Do NOT cache transient errors — only cache clean null from getPrForBranch
      res.json({ pr: null });
    }
  });

  // GET /workspaces/ci-status — CI check results for a repo + branch
  router.get('/ci-status', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const branch = typeof req.query.branch === 'string' ? req.query.branch : undefined;

    if (!repoPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    try {
      const status = await getCiStatus(repoPath, branch ?? 'HEAD');
      res.json(status);
    } catch {
      res.json({ total: 0, passing: 0, failing: 0, pending: 0 });
    }
  });

  // POST /workspaces/branch — switch branch for a workspace
  router.post('/branch', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;

    if (!repoPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const branch = body.branch;

    if (typeof branch !== 'string' || !branch) {
      res.status(400).json({ error: 'branch is required in request body' });
      return;
    }

    const result = await switchBranch(repoPath, branch);
    if (result.success) {
      res.json({ path: repoPath, branch });
    } else {
      res.status(400).json({ error: result.error ?? `Failed to switch to branch: ${branch}` });
    }
  });

  // POST /workspaces/worktree — create a new worktree with the next mountain name
  router.post('/worktree', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;

    if (!repoPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    const existingBranch = typeof req.body?.branch === 'string' ? req.body.branch : undefined;

    const resolved = path.resolve(repoPath);
    const config = getConfig();
    const settings = getRepoSettings(config, resolved);

    let branchName = '';
    let mountainName = '';
    let gitArgs: string[];
    let nextMountainIndex: number | undefined;

    if (existingBranch) {
      // Ensure branch exists locally (fetch from remote if needed)
      let branchResult: { found: boolean; reason?: 'not_found' | 'fetch_failed' };
      try {
        branchResult = await ensureBranchLocal(resolved, existingBranch, { exec });
      } catch (err) {
        console.error('[workspaces] ensureBranchLocal failed unexpectedly:', err instanceof Error ? err.message : err);
        res.status(500).json({ error: 'Git operation failed' });
        return;
      }
      if (!branchResult.found) {
        if (branchResult.reason === 'fetch_failed') {
          res.status(502).json({
            error: 'fetch_failed',
            branch: existingBranch,
            remote: 'origin',
          });
          return;
        }
        res.status(404).json({
          error: 'branch_not_found',
          branch: existingBranch,
          remote: 'origin',
        });
        return;
      }

      // Find existing checkout or create new worktree
      try {
        const result = await findOrCreateWorktreeForBranch(resolved, existingBranch, exec);
        // For main worktree matches, return worktreePath: null to signal "use the main repo"
        // and skip writeMeta (main repo is not a disposable worktree)
        if (!result.isMain) {
          const meta = readMeta(configPath, result.worktreePath);
          writeMeta(configPath, {
            worktreePath: result.worktreePath,
            displayName: meta?.displayName || result.dirName,
            lastActivity: new Date().toISOString(),
            branchName: result.branchName,
          });
          res.json({
            branchName: result.branchName,
            mountainName: meta?.displayName || result.dirName,
            worktreePath: result.worktreePath,
            existing: result.existing,
          });
        } else {
          res.json({
            branchName: result.branchName,
            mountainName: result.dirName,
            worktreePath: null,
            existing: true,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to create worktree: ${msg}` });
      }
      return;
    } else {
      // Create a new branch: <mountain>-<hex-suffix> — with retry if directory is taken
      const baseIndex = settings.nextMountainIndex ?? 0;
      let found = false;

      for (let attempt = 0; attempt < MOUNTAIN_NAMES.length; attempt++) {
        const candidateIndex = (baseIndex + attempt) % MOUNTAIN_NAMES.length;
        const candidateName = MOUNTAIN_NAMES[candidateIndex] ?? 'everest';
        const suffix = crypto.randomBytes(2).toString('hex');
        const candidateBranch = (settings.branchPrefix ?? '') + candidateName + '-' + suffix;
        const candidatePath = path.join(resolved, '.worktrees', candidateName);

        // Check if branch or directory already exists
        const branchExists = await exec('git', ['rev-parse', '--verify', candidateBranch], { cwd: resolved }).then(() => true, () => false);
        const dirExists = fs.existsSync(candidatePath);

        if (!branchExists && !dirExists) {
          mountainName = candidateName;
          branchName = candidateBranch;
          nextMountainIndex = candidateIndex + 1;
          found = true;
          break;
        }
      }

      if (!found) {
        res.status(409).json({ error: 'All mountain names are taken for this workspace. Delete some worktrees first.' });
        return;
      }

      // Detect base branch (keep existing logic)
      let baseBranch = settings.defaultBranch;
      if (!baseBranch) {
        const detected = await detectGitRepo(resolved);
        baseBranch = detected.defaultBranch ?? 'main';
      }

      gitArgs = ['worktree', 'add', '-b', branchName, path.join(resolved, '.worktrees', mountainName), baseBranch];
    }

    const worktreePath = path.join(resolved, '.worktrees', mountainName);

    try {
      // Ensure .worktrees/ is in .gitignore
      const gitignorePath = path.join(resolved, '.gitignore');
      try {
        const existing = await fs.promises.readFile(gitignorePath, 'utf8');
        if (!existing.includes('.worktrees/')) {
          await fs.promises.appendFile(gitignorePath, '\n.worktrees/\n');
        }
      } catch {
        await fs.promises.writeFile(gitignorePath, '.worktrees/\n');
      }

      await exec('git', gitArgs, { cwd: resolved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to create worktree: ${msg}` });
      return;
    }

    // Increment mountain counter AFTER successful creation (don't skip names on failure)
    if (nextMountainIndex !== undefined) {
      setRepoSettings(configPath, config, resolved, { nextMountainIndex });
    }

    // Write metadata so DELETE /worktrees can find the suffixed branch name
    writeMeta(configPath, {
      worktreePath,
      displayName: mountainName,
      lastActivity: new Date().toISOString(),
      branchName,
    });

    res.json({ branchName, mountainName, worktreePath });
  });

  // GET /workspaces/current-branch — current checked-out branch for a path
  router.get('/current-branch', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    if (!repoPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const branch = await getCurrentBranch(path.resolve(repoPath));
    res.json({ branch });
  });

  // GET /workspaces/browse — browse filesystem directories for tree UI
  router.get('/browse', async (req: Request, res: Response) => {
    const rawPath = typeof req.query.path === 'string' ? req.query.path : '~';
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
    const showHidden = req.query.showHidden === 'true';

    // Resolve ~ to home directory
    const expanded = rawPath === '~' || rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.slice(1))
      : rawPath;
    const resolved = path.resolve(expanded);

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolved);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(400).json({ error: `Path does not exist: ${resolved}` });
      }
      return;
    }

    if (!stat.isDirectory()) {
      res.status(400).json({ error: `Not a directory: ${resolved}` });
      return;
    }

    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(resolved, { withFileTypes: true });
    } catch {
      res.status(403).json({ error: 'Cannot read directory' });
      return;
    }

    const includeFiles = req.query.includeFiles === 'true';

    // Filter entries: directories always, files only when includeFiles is set
    let filtered = dirents.filter((d) => {
      const isDir = d.isDirectory();
      if (!isDir && !includeFiles) return false;
      if (BROWSE_DENYLIST.has(d.name)) return false;
      if (!showHidden && d.name.startsWith('.')) return false;
      if (prefix && !d.name.toLowerCase().startsWith(prefix.toLowerCase())) return false;
      return true;
    });

    filtered.sort((a, b) => {
      // Directories first, then files
      const aDir = a.isDirectory() ? 0 : 1;
      const bDir = b.isDirectory() ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    const total = filtered.length;
    const truncated = filtered.length > BROWSE_MAX_ENTRIES;
    if (truncated) filtered = filtered.slice(0, BROWSE_MAX_ENTRIES);

    // Enrich each entry (parallelized)
    const entries = await Promise.all(
      filtered.map(async (d) => {
        const entryPath = path.join(resolved, d.name);
        const isDir = d.isDirectory();

        let isGitRepo = false;
        let hasChildren = false;
        let size: number | undefined;

        if (isDir) {
          try {
            const gitStat = await fs.promises.stat(path.join(entryPath, '.git'));
            isGitRepo = gitStat.isDirectory();
          } catch {
            // not a git repo
          }

          try {
            const children = await fs.promises.readdir(entryPath, { withFileTypes: true });
            hasChildren = children.some((c) =>
              (c.isDirectory() || includeFiles) && !BROWSE_DENYLIST.has(c.name) && (showHidden || !c.name.startsWith('.')),
            );
          } catch {
            // can't read — treat as no children
          }
        } else {
          try {
            const fileStat = await fs.promises.stat(entryPath);
            size = fileStat.size;
          } catch {
            // best effort
          }
        }

        return {
          name: d.name,
          path: entryPath,
          isGitRepo,
          hasChildren,
          isDirectory: isDir,
          ...(size !== undefined ? { size } : {}),
        };
      }),
    );

    res.json({ resolved, entries, truncated, total });
  });

  // GET /workspaces/autocomplete — path prefix autocomplete
  router.get('/autocomplete', async (req: Request, res: Response) => {
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';

    if (!prefix) {
      res.json({ suggestions: [] });
      return;
    }

    const expanded = prefix.startsWith('~')
      ? path.join(process.env.HOME ?? '~', prefix.slice(1))
      : prefix;

    let dirToRead: string;
    let partialName: string;

    if (expanded.endsWith('/') || expanded.endsWith(path.sep)) {
      // User typed a trailing slash — list immediate children of that dir
      dirToRead = expanded;
      partialName = '';
    } else {
      dirToRead = path.dirname(expanded);
      partialName = path.basename(expanded).toLowerCase();
    }

    let suggestions: string[] = [];
    try {
      const entries = await fs.promises.readdir(dirToRead, { withFileTypes: true });
      suggestions = entries
        .filter((e) => {
          if (!e.isDirectory()) return false;
          if (e.name.startsWith('.')) return false;
          if (!partialName) return true;
          return e.name.toLowerCase().startsWith(partialName);
        })
        .map((e) => path.join(dirToRead, e.name))
        .slice(0, 20); // cap results
    } catch {
      // Directory doesn't exist or permission denied — return empty
    }

    res.json({ suggestions });
  });

  // POST /workspaces/rename-branch — rename the current branch for a workspace
  router.post('/rename-branch', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const { newName } = req.body as { newName?: string };
    if (!repoPath) { res.status(400).json({ error: 'path query parameter required' }); return; }
    if (!newName || typeof newName !== 'string') { res.status(400).json({ error: 'newName is required' }); return; }

    const result = await renameBranch(repoPath, newName);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  // POST /workspaces/create-branch — create and checkout a new branch for a workspace
  router.post('/create-branch', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const { branchName } = req.body as { branchName?: string };
    if (!repoPath) { res.status(400).json({ error: 'path query parameter required' }); return; }
    if (!branchName || typeof branchName !== 'string') { res.status(400).json({ error: 'branchName is required' }); return; }

    const result = await createBranch(repoPath, branchName);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  // POST /workspaces/pr-base — change the base branch of a PR for a workspace
  router.post('/pr-base', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const { prNumber, baseBranch } = req.body as { prNumber?: number; baseBranch?: string };
    if (!repoPath) { res.status(400).json({ error: 'path query parameter required' }); return; }
    if (!prNumber || typeof prNumber !== 'number') { res.status(400).json({ error: 'prNumber is required' }); return; }
    if (!baseBranch || typeof baseBranch !== 'string') { res.status(400).json({ error: 'baseBranch is required' }); return; }

    const result = await changePrBase(repoPath, prNumber, baseBranch);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  // POST /workspaces/push-branch — push a branch to origin for a workspace
  router.post('/push-branch', async (req: Request, res: Response) => {
    const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const { branch, deleteOldBranch } = req.body as { branch?: string; deleteOldBranch?: string };
    if (!repoPath) { res.status(400).json({ error: 'path query parameter required' }); return; }
    if (!branch || typeof branch !== 'string') { res.status(400).json({ error: 'branch is required' }); return; }

    const result = await pushBranch(repoPath, branch, deleteOldBranch);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  function validateWorkspaceAccess(repoPath: string): string | null {
    const resolved = path.resolve(repoPath);
    const allowed = getConfig().repos ?? [];
    return allowed.some(p => resolved === p || resolved.startsWith(p + path.sep)) ? resolved : null;
  }

  // GET /workspaces/changed-files — list changed files in a repo
  router.get('/changed-files', async (req: Request, res: Response) => {
    if (typeof req.query.path !== 'string') {
      res.status(400).json({ files: [], aggregate: { additions: 0, deletions: 0, fileCount: 0 }, error: 'path parameter required' });
      return;
    }
    const base = typeof req.query.base === 'string' ? req.query.base : undefined;

    const resolvedRepo = validateWorkspaceAccess(req.query.path);
    if (!resolvedRepo) {
      res.status(403).json({ files: [], aggregate: { additions: 0, deletions: 0, fileCount: 0 }, error: 'path not in configured workspaces' });
      return;
    }

    if (base && base.startsWith('-')) {
      res.status(400).json({ files: [], aggregate: { additions: 0, deletions: 0, fileCount: 0 }, error: 'invalid base ref' });
      return;
    }

    try {
      const files = await getChangedFiles(resolvedRepo, base, exec);
      const aggregate = {
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
        fileCount: files.length,
      };
      res.json({ files, aggregate });
    } catch (err: unknown) {
      console.warn('[workspaces] /changed-files failed for', resolvedRepo, err instanceof Error ? err.message : String(err));
      res.status(500).json({ files: [], aggregate: { additions: 0, deletions: 0, fileCount: 0 }, error: 'Failed to get changed files' });
    }
  });

  // GET /workspaces/files-list — list all files in a repo for quick-open picker
  router.get('/files-list', async (req: Request, res: Response) => {
    if (typeof req.query.path !== 'string') {
      res.status(400).json({ files: [], truncated: false, total: 0, error: 'path parameter required' });
      return;
    }
    const resolved = validateWorkspaceAccess(req.query.path);
    if (!resolved) {
      res.status(403).json({ files: [], truncated: false, total: 0, error: 'path not in configured workspaces' });
      return;
    }

    const cached = filesListCache.get(resolved);
    if (cached && Date.now() - cached.ts < FILES_LIST_TTL) {
      res.json({ files: cached.files, truncated: cached.truncated, total: cached.total });
      return;
    }

    try {
      const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: resolved, maxBuffer: 10 * 1024 * 1024, timeout: 15_000 });
      const allFiles = stdout.split('\0').filter(Boolean);
      const truncated = allFiles.length > FILES_LIST_MAX;
      const files = truncated ? allFiles.slice(0, FILES_LIST_MAX) : allFiles;
      filesListCache.set(resolved, { files, truncated, total: allFiles.length, ts: Date.now() });
      res.json({ files, truncated, total: allFiles.length });
    } catch (err: unknown) {
      console.warn('[workspaces] /files-list failed for', resolved, err instanceof Error ? err.message : String(err));
      res.json({ files: [], truncated: false, total: 0, error: 'not a git repository or git not available' });
    }
  });

  // GET /workspaces/file-diff — get diff for a specific file
  router.get('/file-diff', async (req: Request, res: Response) => {
    if (typeof req.query.path !== 'string' || typeof req.query.file !== 'string') {
      res.status(400).json({ diff: '', error: 'path and file parameters required' });
      return;
    }
    const filePath = req.query.file;
    const base = typeof req.query.base === 'string' ? req.query.base : undefined;

    const resolvedRepo = validateWorkspaceAccess(req.query.path);
    if (!resolvedRepo) {
      res.status(403).json({ diff: '', error: 'path not in configured workspaces' });
      return;
    }

    if (filePath.includes('..') || path.isAbsolute(filePath)) {
      res.status(400).json({ diff: '', error: 'invalid file path' });
      return;
    }

    if (base && base.startsWith('-')) {
      res.status(400).json({ diff: '', error: 'invalid base ref' });
      return;
    }

    try {
      const diff = await getFileDiff(resolvedRepo, filePath, base, exec);
      res.json({ diff });
    } catch (err: unknown) {
      console.warn('[workspaces] /file-diff failed for', resolvedRepo, filePath, err instanceof Error ? err.message : String(err));
      res.status(500).json({ diff: '', error: 'Failed to get file diff' });
    }
  });

  // GET /workspaces/default-branch — detect the default branch for a repo
  router.get('/default-branch', async (req: Request, res: Response) => {
    if (typeof req.query.path !== 'string') {
      res.status(400).json({ branch: '', error: 'path parameter required' });
      return;
    }

    const resolvedRepo = validateWorkspaceAccess(req.query.path);
    if (!resolvedRepo) {
      res.status(403).json({ branch: '', error: 'path not in configured workspaces' });
      return;
    }

    try {
      const branch = await getDefaultBranch(resolvedRepo, exec);
      res.json({ branch });
    } catch (err: unknown) {
      console.warn('[workspaces] /default-branch failed for', resolvedRepo, err instanceof Error ? err.message : String(err));
      res.status(500).json({ branch: 'main', error: 'Failed to detect default branch' });
    }
  });

  return router;
}
