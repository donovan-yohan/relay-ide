import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { loadConfig } from './config.js';
import { buildRepoMap } from './git.js';
import type { PullRequest, PullRequestsResponse } from './types.js';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('org-dashboard');

const GH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

// Deps type

export interface OrgDashboardDeps {
  configPath: string;
  /** Injected so tests can override execFile calls */
  execAsync?: typeof execFileAsync;
  checkPrTransitions?: (
    prs: Array<{
      number: number;
      headRefName: string;
      state: 'OPEN' | 'CLOSED' | 'MERGED';
      repoPath?: string | undefined;
    }>,
    branchLinks: Record<
      string,
      Array<{
        repoPath: string;
        repoName: string;
        branchName: string;
        hasActiveSession: boolean;
      }>
    >
  ) => Promise<void>;
  getBranchLinks?: () => Promise<
    Record<
      string,
      Array<{
        repoPath: string;
        repoName: string;
        branchName: string;
        hasActiveSession: boolean;
      }>
    >
  >;
  fetchGraphQL?: (
    token: string,
    repoMap: Map<string, string>
  ) => Promise<{ prs: PullRequest[]; username: string }>;
}

// In-memory cache for search results
interface CacheEntry {
  prs: PullRequest[];
  fetchedAt: number;
}

// GitHub search issue item (partial shape we use)
interface GhSearchItem {
  number: number;
  title: string;
  html_url: string;
  state: string;
  user: { login: string };
  pull_request?: {
    head?: { ref?: string };
    base?: { ref?: string };
  };
  updated_at: string;
  requested_reviewers?: Array<{ login: string }>;
  repository_url: string;
}

interface GhSearchResponse {
  items: GhSearchItem[];
}

/**
 * Extracts "owner/repo" from a GitHub API repository_url.
 * e.g. "https://api.github.com/repos/owner/repo" → "owner/repo"
 */
function repoFromApiUrl(repositoryUrl: string): string | null {
  const match = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
  return match ? (match[1] ?? null) : null;
}

// Router factory

/**
 * Creates and returns an Express Router that handles all /org-dashboard routes.
 *
 * Caller is responsible for mounting and applying auth middleware:
 *   app.use('/org-dashboard', requireAuth, createOrgDashboardRouter({ configPath }));
 */
type ExecFn = typeof execFileAsync;

function errorResponse(error: string): PullRequestsResponse {
  return { prs: [], error };
}

function sortByUpdatedDesc(prs: PullRequest[]): void {
  prs.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/** Map search API items to PullRequest[], filtering to known workspaces. */
function mapSearchItemsToPrs(
  items: GhSearchItem[],
  repoMap: Map<string, string>,
  currentUser: string,
  state: 'OPEN' | 'MERGED'
): PullRequest[] {
  const prs: PullRequest[] = [];
  for (const item of items) {
    if (!item.pull_request) continue;
    const ownerRepo = repoFromApiUrl(item.repository_url);
    if (!ownerRepo) continue;
    const wsPath = repoMap.get(ownerRepo.toLowerCase());
    if (!wsPath) continue;

    const isAuthor = item.user.login === currentUser;
    prs.push({
      number: item.number,
      title: item.title,
      url: item.html_url,
      headRefName: item.pull_request?.head?.ref ?? '',
      baseRefName: item.pull_request?.base?.ref ?? '',
      state,
      author: item.user.login,
      role: isAuthor ? 'author' : 'reviewer',
      updatedAt: item.updated_at,
      additions: 0,
      deletions: 0,
      reviewDecision: null,
      mergeable: null,
      isDraft: false,
      ciStatus: null,
      repoName: path.basename(wsPath),
      repoPath: wsPath,
    });
  }
  return prs;
}

/** Resolve GitHub user login via `gh api`, with caching. */
async function resolveGhUser(
  exec: ExecFn,
  cached: string | null
): Promise<{ user: string } | { error: string }> {
  if (cached) return { user: cached };
  try {
    const { stdout } = await exec('gh', ['api', 'user', '--jq', '.login'], {
      timeout: GH_TIMEOUT_MS,
    });
    return { user: stdout.trim() };
  } catch (err) {
    const errCode = (err as NodeJS.ErrnoException).code;
    return {
      error: errCode === 'ENOENT' ? 'gh_not_in_path' : 'gh_not_authenticated',
    };
  }
}

/** Fetch open PRs via gh search API. Returns items or an error code. */
async function fetchSearchPrs(
  exec: ExecFn
): Promise<{ items: GhSearchItem[] } | { error: string }> {
  try {
    const { stdout } = await exec(
      'gh',
      ['api', 'search/issues?q=is:pr+is:open+involves:@me&per_page=100'],
      { timeout: GH_TIMEOUT_MS }
    );
    const parsed = JSON.parse(stdout) as GhSearchResponse;
    return { items: parsed.items ?? [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errCode = (err as NodeJS.ErrnoException).code;
    if (msg.includes('ETIMEDOUT') || msg.includes('timed out'))
      return { error: 'gh_timeout' };
    if (errCode === 'ENOENT') return { error: 'gh_not_in_path' };
    return { error: 'gh_not_authenticated' };
  }
}

/** Best-effort: fetch recently merged PRs and fire ticket transition checks. */
function fireTransitionChecks(
  prs: PullRequest[],
  repoMap: Map<string, string>,
  currentUser: string,
  exec: ExecFn,
  deps: OrgDashboardDeps
): void {
  if (!deps.checkPrTransitions || !deps.getBranchLinks) return;

  const run = async () => {
    const transitionPrs = [...prs];
    try {
      const mergedSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];
      const { stdout } = await exec(
        'gh',
        [
          'api',
          `search/issues?q=is:pr+is:merged+merged:>=${mergedSince}+involves:@me&per_page=50`,
        ],
        { timeout: GH_TIMEOUT_MS }
      );
      const mergedResponse = JSON.parse(stdout) as GhSearchResponse;
      transitionPrs.push(
        ...mapSearchItemsToPrs(
          mergedResponse.items ?? [],
          repoMap,
          currentUser,
          'MERGED'
        )
      );
    } catch {
      // Merged PR fetch is best-effort
    }
    const links = await deps.getBranchLinks!();
    await deps.checkPrTransitions!(transitionPrs, links);
  };

  run().catch(() => {});
}

export function createOrgDashboardRouter(deps: OrgDashboardDeps): Router {
  const { configPath } = deps;
  const exec = deps.execAsync ?? execFileAsync;

  const router = Router();

  let cachedUser: string | null = null;
  let cache: CacheEntry | null = null;

  router.get('/prs', async (_req: Request, res: Response) => {
    const config = loadConfig(configPath);
    const workspacePaths = config.repos ?? [];

    if (workspacePaths.length === 0) {
      res.json(errorResponse('no_workspaces'));
      return;
    }

    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      res.json({ prs: cache.prs } satisfies PullRequestsResponse);
      return;
    }

    const userResult = await resolveGhUser(exec, cachedUser);
    if ('error' in userResult) {
      res.json(errorResponse(userResult.error));
      return;
    }
    cachedUser = userResult.user;
    const currentUser = cachedUser;

    const repoMap = await buildRepoMap(workspacePaths, exec);

    // Try GraphQL path first (GitHub App token)
    const githubToken = config.github?.accessToken;
    if (githubToken && deps.fetchGraphQL) {
      try {
        const result = await deps.fetchGraphQL(githubToken, repoMap);
        cachedUser = result.username;
        const prs = result.prs;
        sortByUpdatedDesc(prs);
        cache = { prs, fetchedAt: now };
        fireTransitionChecks(prs, repoMap, cachedUser, exec, deps);
        res.json({ prs } satisfies PullRequestsResponse);
        return;
      } catch (err) {
        logger.warn(
          '[org-dashboard] GraphQL fetch failed, falling back to gh CLI:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Fallback: gh search API
    const searchResult = await fetchSearchPrs(exec);
    if ('error' in searchResult) {
      res.json(errorResponse(searchResult.error));
      return;
    }

    const prs = mapSearchItemsToPrs(
      searchResult.items,
      repoMap,
      currentUser,
      'OPEN'
    );
    sortByUpdatedDesc(prs);
    cache = { prs, fetchedAt: now };

    fireTransitionChecks(prs, repoMap, currentUser, exec, deps);

    res.json({ prs } satisfies PullRequestsResponse);
  });

  return router;
}
