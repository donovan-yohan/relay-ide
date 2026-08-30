import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { listBranchesEnriched } from './git.js';
import { readMeta } from './config.js';
import { WORKTREE_DIRS, parseWorktreeListPorcelain } from './watcher.js';
import { Semaphore, allOrFirstError } from './concurrency.js';
import type { WorktreeMetadata } from './types.js';

const execFileAsync = promisify(execFile);

/** Max simultaneous `git worktree list` forks per scan (#1448). */
const WORKTREE_SCAN_CONCURRENCY = 8;

type ExecFileAsyncLike = (
  file: string,
  args: string[],
  options: { cwd: string; timeout?: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface GitRouterDeps {
  getConfig: () => {
    rootDirs?: string[] | undefined;
    repos?: string[] | undefined;
  };
  configPath: string;
  execFileAsync: ExecFileAsyncLike;
  readdirSync: (
    dir: string
  ) => Array<{ name: string; isDirectory: () => boolean }>;
  statSync: (path: string) => { isDirectory: () => boolean };
  readMeta: (
    configPath: string,
    worktreePath: string
  ) => WorktreeMetadata | null;
}

interface RepoEntry {
  name: string;
  path: string;
  root: string;
}

interface WorktreeResult {
  name: string;
  path: string;
  repoName: string;
  repoPath: string;
  root: string;
  displayName: string;
  lastActivity: string;
  branchName: string;
}

function buildReposFromRootDirs(
  deps: GitRouterDeps,
  roots: string[]
): RepoEntry[] {
  const repos: RepoEntry[] = [];
  for (const rootDir of roots) {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = deps.readdirSync(rootDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const fullPath = path.join(rootDir, entry.name);
      const dotGit = path.join(fullPath, '.git');
      try {
        if (deps.statSync(dotGit).isDirectory()) {
          repos.push({ name: entry.name, path: fullPath, root: rootDir });
        }
      } catch {
        // .git doesn't exist — not a repo
      }
    }
  }
  return repos;
}

function addConfiguredRepos(
  repos: RepoEntry[],
  configRepos: string[],
  roots: string[]
): void {
  const scannedPaths = new Set(repos.map((r) => r.path));
  for (const wp of configRepos) {
    if (scannedPaths.has(wp)) continue;
    const root = roots.find((r) => wp.startsWith(r)) || '';
    repos.push({
      path: wp,
      name: wp.split('/').filter(Boolean).pop() || '',
      root,
    });
  }
}

function processWorktreeList(
  deps: GitRouterDeps,
  repo: RepoEntry,
  stdout: string
): WorktreeResult[] {
  const results: WorktreeResult[] = [];
  const parsed = parseWorktreeListPorcelain(stdout, repo.path);
  for (const wt of parsed) {
    const dirName = wt.path.split('/').pop() || '';
    const meta = deps.readMeta(deps.configPath, wt.path);
    results.push({
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
  return results;
}

function processWorktreeFallback(
  deps: GitRouterDeps,
  repo: RepoEntry
): WorktreeResult[] {
  const results: WorktreeResult[] = [];
  for (const dir of WORKTREE_DIRS) {
    const worktreeDir = path.join(repo.path, dir);
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = deps.readdirSync(worktreeDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wtPath = path.join(worktreeDir, entry.name);
      const meta = deps.readMeta(deps.configPath, wtPath);
      results.push({
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
  return results;
}

export async function scanWorktrees(
  deps: GitRouterDeps,
  repoParam?: string
): Promise<WorktreeResult[]> {
  const config = deps.getConfig();
  const roots = config.rootDirs || [];
  const worktrees: WorktreeResult[] = [];

  let reposToScan: RepoEntry[];
  if (repoParam) {
    const root = roots.find((r) => repoParam.startsWith(r)) || '';
    reposToScan = [
      {
        path: repoParam,
        name: repoParam.split('/').filter(Boolean).pop() || '',
        root,
      },
    ];
  } else {
    reposToScan = buildReposFromRootDirs(deps, roots);
    addConfiguredRepos(reposToScan, config.repos ?? [], roots);
  }

  // One `git worktree list` fork per repo. Serially that is O(repos) round
  // trips on the request path (#1448); run them concurrently under a shared
  // permit ceiling instead. Results are reassembled in `reposToScan` order so
  // the dedup below still keeps the first-seen entry for a path.
  const gate = new Semaphore(WORKTREE_SCAN_CONCURRENCY);
  // `allOrFirstError`, not `Promise.all`: `processWorktreeFallback` runs in the
  // catch and can itself throw (injected `readMeta`/`readdirSync`), and a
  // second such rejection would go unobserved under `Promise.all`.
  const perRepo = await allOrFirstError(
    reposToScan.map((repo) =>
      gate.run(async () => {
        try {
          const { stdout } = await deps.execFileAsync(
            'git',
            ['worktree', 'list', '--porcelain'],
            { cwd: repo.path }
          );
          return processWorktreeList(deps, repo, stdout);
        } catch {
          // git worktree list failed — fall back to directory scanning
          return processWorktreeFallback(deps, repo);
        }
      })
    )
  );
  for (const items of perRepo) worktrees.push(...items);

  // Deduplicate by path
  const seen = new Set<string>();
  return worktrees.filter((wt) => {
    if (seen.has(wt.path)) return false;
    seen.add(wt.path);
    return true;
  });
}

export interface CreateGitRouterDeps {
  configPath: string;
  getConfig: () => {
    rootDirs?: string[] | undefined;
    repos?: string[] | undefined;
  };
  getSessions: () => Array<{ id: string; worktreePath: string | null }>;
}

export function createGitRouter(deps: CreateGitRouterDeps): Router {
  const router = Router();

  const routerDeps: GitRouterDeps = {
    getConfig: deps.getConfig,
    configPath: deps.configPath,
    execFileAsync: execFileAsync as ExecFileAsyncLike,
    readdirSync: (dir: string) => fs.readdirSync(dir, { withFileTypes: true }),
    statSync: (p: string) => fs.statSync(p),
    readMeta: (configPath: string, worktreePath: string) =>
      readMeta(configPath, worktreePath),
  };

  // GET /git/worktrees — pure git worktree list, no enrichment
  router.get('/worktrees', async (req: Request, res: Response) => {
    const repoParam =
      typeof req.query.repo === 'string' ? req.query.repo : undefined;
    const items = await scanWorktrees(routerDeps, repoParam);
    res.json(items);
  });

  // GET /git/branches — branch list with local-only data
  router.get('/branches', async (req: Request, res: Response) => {
    const repoPath =
      typeof req.query.repo === 'string' ? req.query.repo : undefined;
    const refresh = req.query.refresh === '1';
    if (!repoPath) {
      res.status(400).json({ error: 'repo query parameter is required' });
      return;
    }

    const sessionList = deps.getSessions();
    res.json(
      await listBranchesEnriched(repoPath, { refresh, sessions: sessionList })
    );
  });

  return router;
}
