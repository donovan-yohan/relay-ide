import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { loadConfig } from './config.js';
import { extractOwnerRepo, buildRepoMap } from './git.js';
import type { Config, PullRequest, PullRequestsResponse } from './types.js';
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
export function createOrgDashboardRouter(deps: OrgDashboardDeps): Router {
  const { configPath } = deps;
  const exec = deps.execAsync ?? execFileAsync;

  const router = Router();

  // Server-lifetime cache for GitHub user login
  let cachedUser: string | null = null;

  // 60s in-memory cache for search results
  let cache: CacheEntry | null = null;

  function getConfig(): Config {
    return loadConfig(configPath);
  }

  // GET /org-dashboard/prs — list all open PRs involving the current user across all workspaces
  router.get('/prs', async (_req: Request, res: Response) => {
    const config = getConfig();
    const workspacePaths = config.repos ?? [];

    if (workspacePaths.length === 0) {
      const response: PullRequestsResponse = {
        prs: [],
        error: 'no_workspaces',
      };
      res.json(response);
      return;
    }

    // Return cached results if still fresh
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      const response: PullRequestsResponse = { prs: cache.prs };
      res.json(response);
      return;
    }

    // Resolve GitHub user (cached for server lifetime)
    if (!cachedUser) {
      try {
        const { stdout } = await exec('gh', ['api', 'user', '--jq', '.login'], {
          timeout: GH_TIMEOUT_MS,
        });
        cachedUser = stdout.trim();
      } catch (err) {
        const errCode = (err as NodeJS.ErrnoException).code;
        if (errCode === 'ENOENT') {
          const response: PullRequestsResponse = {
            prs: [],
            error: 'gh_not_in_path',
          };
          res.json(response);
          return;
        }
        const response: PullRequestsResponse = {
          prs: [],
          error: 'gh_not_authenticated',
        };
        res.json(response);
        return;
      }
    }

    const currentUser = cachedUser;

    // Build repo → workspace path map
    const repoMap = await buildRepoMap(workspacePaths, exec);

    // Check for GraphQL path (GitHub App token)
    const githubToken = config.github?.accessToken;
    if (githubToken && deps.fetchGraphQL) {
      try {
        const result = await deps.fetchGraphQL(githubToken, repoMap);
        cachedUser = result.username;
        const prs = result.prs;
        prs.sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        cache = { prs, fetchedAt: now };

        // Fire ticket transitions (same best-effort as below)
        if (deps.checkPrTransitions && deps.getBranchLinks) {
          deps
            .getBranchLinks()
            .then((links) => deps.checkPrTransitions!(prs, links))
            .catch(() => {});
        }

        const response: PullRequestsResponse = { prs };
        res.json(response);
        return;
      } catch (err) {
        logger.warn(
          '[org-dashboard] GraphQL fetch failed, falling back to gh CLI:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Single gh search API call
    let searchResponse: GhSearchResponse;
    try {
      const { stdout } = await exec(
        'gh',
        ['api', 'search/issues?q=is:pr+is:open+involves:@me&per_page=100'],
        { timeout: GH_TIMEOUT_MS }
      );
      searchResponse = JSON.parse(stdout) as GhSearchResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errCode = (err as NodeJS.ErrnoException).code;
      if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
        const response: PullRequestsResponse = { prs: [], error: 'gh_timeout' };
        res.json(response);
        return;
      }
      if (errCode === 'ENOENT') {
        const response: PullRequestsResponse = {
          prs: [],
          error: 'gh_not_in_path',
        };
        res.json(response);
        return;
      }
      const response: PullRequestsResponse = {
        prs: [],
        error: 'gh_not_authenticated',
      };
      res.json(response);
      return;
    }

    const items = searchResponse.items ?? [];

    // Filter to only repos matching workspace paths and map to PullRequest
    const prs: PullRequest[] = [];

    for (const item of items) {
      // The search API can return non-PR issues — skip them
      if (!item.pull_request) continue;

      const ownerRepo = repoFromApiUrl(item.repository_url);
      if (!ownerRepo) continue;

      const wsPath = repoMap.get(ownerRepo.toLowerCase());
      if (!wsPath) continue;

      // Determine role
      const isAuthor = item.user.login === currentUser;
      const isReviewer =
        !isAuthor &&
        Array.isArray(item.requested_reviewers) &&
        item.requested_reviewers.some((r) => r.login === currentUser);

      if (!isAuthor && !isReviewer) continue;

      const role: 'author' | 'reviewer' = isAuthor ? 'author' : 'reviewer';
      const repoName = path.basename(wsPath);

      prs.push({
        number: item.number,
        title: item.title,
        url: item.html_url,
        headRefName: item.pull_request?.head?.ref ?? '',
        baseRefName: item.pull_request?.base?.ref ?? '',
        state: 'OPEN',
        author: item.user.login,
        role,
        updatedAt: item.updated_at,
        additions: 0,
        deletions: 0,
        reviewDecision: null,
        mergeable: null,
        isDraft: false,
        ciStatus: null,
        repoName,
        repoPath: wsPath,
      });
    }

    // Sort by updatedAt descending
    prs.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    // Update cache
    cache = { prs, fetchedAt: now };

    // Fire ticket transitions check (best-effort, don't block response)
    // Include recently merged PRs for MERGED->ready-for-qa transitions
    if (deps.checkPrTransitions && deps.getBranchLinks) {
      const transitionPrs = [...prs];

      // Fetch recently merged PRs (last 7 days) for transition checks
      try {
        const mergedSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0];
        const { stdout: mergedStdout } = await exec(
          'gh',
          [
            'api',
            `search/issues?q=is:pr+is:merged+merged:>=${mergedSince}+involves:@me&per_page=50`,
          ],
          { timeout: GH_TIMEOUT_MS }
        );
        const mergedResponse = JSON.parse(mergedStdout) as GhSearchResponse;
        for (const item of mergedResponse.items ?? []) {
          if (!item.pull_request) continue;
          const ownerRepo = repoFromApiUrl(item.repository_url);
          if (!ownerRepo) continue;
          const wsPath = repoMap.get(ownerRepo.toLowerCase());
          if (!wsPath) continue;
          transitionPrs.push({
            number: item.number,
            title: item.title,
            url: item.html_url,
            headRefName: item.pull_request?.head?.ref ?? '',
            baseRefName: item.pull_request?.base?.ref ?? '',
            state: 'MERGED',
            author: item.user.login,
            role: 'author',
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
      } catch {
        // Merged PR fetch is best-effort — don't block transitions
      }

      deps
        .getBranchLinks()
        .then((links) => deps.checkPrTransitions!(transitionPrs, links))
        .catch(() => {});
    }

    const response: PullRequestsResponse = { prs };
    res.json(response);
  });

  return router;
}
