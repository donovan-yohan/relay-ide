import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { loadConfig } from './config.js';
import type { Config, GitHubIssue, GitHubIssuesResponse } from './types.js';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

// Deps type

export interface IntegrationGitHubDeps {
  configPath: string;
  /** Injected so tests can override execFile calls */
  execAsync?: typeof execFileAsync;
}

// Per-repo in-memory cache
interface CacheEntry {
  issues: GitHubIssue[];
  fetchedAt: number;
}

// Raw shape returned by gh issue list --json
interface GhIssueItem {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Creates and returns an Express Router that handles all /integration-github routes.
 *
 * Caller is responsible for mounting and applying auth middleware:
 *   app.use('/integration-github', requireAuth, createIntegrationGitHubRouter({ configPath }));
 */
export function createIntegrationGitHubRouter(
  deps: IntegrationGitHubDeps
): Router {
  const { configPath } = deps;
  const exec = deps.execAsync ?? execFileAsync;

  const router = Router();

  // Per-repo 60s in-memory cache
  const repoCache = new Map<string, CacheEntry>();

  function getConfig(): Config {
    return loadConfig(configPath);
  }

  // GET /integrations/github/issues — list open issues assigned to @me across all workspaces
  router.get('/issues', async (_req: Request, res: Response) => {
    const config = getConfig();
    const workspacePaths = config.repos ?? [];

    if (workspacePaths.length === 0) {
      const response: GitHubIssuesResponse = {
        issues: [],
        error: 'no_workspaces',
      };
      res.json(response);
      return;
    }

    const now = Date.now();

    // Fetch issues per repo using Promise.allSettled (partial failures are non-fatal)
    const results = await Promise.allSettled(
      workspacePaths.map(async (wsPath) => {
        // Return cached result if still fresh
        const cached = repoCache.get(wsPath);
        if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
          return cached.issues;
        }

        let stdout: string;
        try {
          ({ stdout } = await exec(
            'gh',
            [
              'issue',
              'list',
              '--assignee',
              '@me',
              '--state',
              'open',
              '--json',
              'number,title,url,state,labels,assignees,createdAt,updatedAt',
              '--limit',
              '50',
            ],
            { cwd: wsPath, timeout: GH_TIMEOUT_MS }
          ));
        } catch (err) {
          const errCode = (err as NodeJS.ErrnoException).code;
          if (errCode === 'ENOENT') {
            throw Object.assign(new Error('gh_not_in_path'), {
              code: 'GH_NOT_IN_PATH',
            });
          }
          // Check for auth failure via stderr
          const stderr = (err as { stderr?: string }).stderr ?? '';
          if (
            stderr.includes('not logged') ||
            stderr.includes('auth') ||
            stderr.includes('authentication')
          ) {
            throw Object.assign(new Error('gh_not_authenticated'), {
              code: 'GH_NOT_AUTHENTICATED',
            });
          }
          // Not a github repo or other non-fatal error
          return [];
        }

        let items: GhIssueItem[];
        try {
          items = JSON.parse(stdout) as GhIssueItem[];
        } catch {
          return [];
        }

        const repoName = path.basename(wsPath);

        const issues: GitHubIssue[] = items.map((item) => ({
          number: item.number,
          title: item.title,
          url: item.url,
          state: item.state === 'OPEN' ? 'OPEN' : 'CLOSED',
          labels: item.labels,
          assignees: item.assignees,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          repoName,
          repoPath: wsPath,
        }));

        // Update per-repo cache
        repoCache.set(wsPath, { issues, fetchedAt: now });
        return issues;
      })
    );

    // Check if gh is not in path or not authenticated (any settled rejection with known codes)
    for (const result of results) {
      if (result.status === 'rejected') {
        const err = result.reason as { code?: string };
        if (err.code === 'GH_NOT_IN_PATH') {
          const response: GitHubIssuesResponse = {
            issues: [],
            error: 'gh_not_in_path',
          };
          res.json(response);
          return;
        }
        if (err.code === 'GH_NOT_AUTHENTICATED') {
          const response: GitHubIssuesResponse = {
            issues: [],
            error: 'gh_not_authenticated',
          };
          res.json(response);
          return;
        }
      }
    }

    // Merge all fulfilled results
    const allIssues: GitHubIssue[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allIssues.push(...result.value);
      }
    }

    // Sort by updatedAt descending
    allIssues.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    const response: GitHubIssuesResponse = { issues: allIssues };
    res.json(response);
  });

  return router;
}
