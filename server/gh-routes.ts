import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { isBranchStale } from './git.js';
import {
  batchGetPrsForRepo,
  getCiStatus,
  getPrForBranch,
  isStalePr,
  getUnresolvedCommentCount,
  changePrBase,
  getPrCached,
  setPrCached,
  clearPrCache,
} from './gh.js';
import type { PrInfo } from './types.js';

const execFileAsync = promisify(execFile);

type ExecFileAsyncLike = (
  file: string,
  args: string[],
  options: { cwd: string; timeout?: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface GhRouterDeps {
  execFileAsync: ExecFileAsyncLike;
}

interface BranchInput {
  repoPath: string;
  branchName: string;
}

interface EnrichResult {
  pr: PrInfo | null;
  stale: boolean;
  ci?: {
    total: number;
    passing: number;
    failing: number;
    pending: number;
  } | null;
}

export async function enrichBranches(
  branches: BranchInput[],
  exec: ExecFileAsyncLike
): Promise<Record<string, EnrichResult>> {
  if (branches.length === 0) return {};

  // Group by unique repo
  const repoGroups = new Map<string, BranchInput[]>();
  for (const b of branches) {
    const group = repoGroups.get(b.repoPath) || [];
    group.push(b);
    repoGroups.set(b.repoPath, group);
  }

  // Batch PR lookups: 1 gh pr list per repo
  const prMaps = new Map<string, Map<string, PrInfo>>();
  await Promise.all(
    [...repoGroups.keys()].map(async (repoPath) => {
      try {
        prMaps.set(repoPath, await batchGetPrsForRepo(repoPath, { exec }));
      } catch {
        prMaps.set(repoPath, new Map());
      }
    })
  );

  // Enrich each branch in parallel
  const results: Record<string, EnrichResult> = {};
  await Promise.all(
    branches.map(async ({ repoPath, branchName }) => {
      const key = `${repoPath}::${branchName}`;
      // Batch lookup first; fall back to per-branch call if batch was truncated (--limit 100)
      let pr = prMaps.get(repoPath)?.get(branchName) ?? null;
      if (!pr) {
        try {
          pr = await getPrForBranch(repoPath, branchName, { exec });
        } catch {
          // degrade gracefully
        }
      }

      let stale = false;
      try {
        stale = await isBranchStale(repoPath, branchName, { exec });
      } catch {
        // default to not stale
      }

      results[key] = { pr, stale };
    })
  );

  return results;
}

export function createGhRouter(deps?: GhRouterDeps): Router {
  const exec: ExecFileAsyncLike =
    deps?.execFileAsync ?? (execFileAsync as ExecFileAsyncLike);
  const router = Router();

  // POST /gh/enrich-branches — batch enrichment for sidebar
  router.post('/enrich-branches', async (req: Request, res: Response) => {
    const raw = (req.body as Record<string, unknown>)?.branches;
    if (raw !== undefined && !Array.isArray(raw)) {
      res.status(400).json({ error: 'branches must be an array' });
      return;
    }
    const branches: BranchInput[] = [];
    for (const item of (raw ?? []) as unknown[]) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof (item as Record<string, unknown>).repoPath !== 'string' ||
        typeof (item as Record<string, unknown>).branchName !== 'string'
      ) {
        res.status(400).json({
          error: 'each branch must have string repoPath and branchName',
        });
        return;
      }
      branches.push({
        repoPath: (item as BranchInput).repoPath,
        branchName: (item as BranchInput).branchName,
      });
    }
    const results = await enrichBranches(branches, exec);
    res.json({ results });
  });

  // GET /gh/pr — single-branch PR detail (for PrTopBar)
  router.get('/pr', async (req: Request, res: Response) => {
    const repoPath =
      typeof req.query.path === 'string' ? req.query.path : undefined;
    const branch =
      typeof req.query.branch === 'string' ? req.query.branch : undefined;

    if (!repoPath || !branch) {
      res
        .status(400)
        .json({ error: 'path and branch query parameters are required' });
      return;
    }

    const cached = getPrCached(repoPath, branch);
    if (cached) {
      res.json({ pr: cached.result });
      return;
    }

    try {
      const pr = await getPrForBranch(repoPath, branch, { exec });
      if (pr && !isStalePr(pr)) {
        let unresolvedCommentCount = 0;
        if (pr.state === 'OPEN') {
          try {
            unresolvedCommentCount = await getUnresolvedCommentCount(
              repoPath,
              pr.number,
              { exec }
            );
          } catch {
            /* degrade gracefully */
          }
        }
        const enriched = { ...pr, unresolvedCommentCount };
        setPrCached(repoPath, branch, enriched);
        res.json({ pr: enriched });
      } else {
        setPrCached(repoPath, branch, null);
        res.json({ pr: null });
      }
    } catch {
      res.json({ pr: null });
    }
  });

  // GET /gh/ci-status — CI check results
  router.get('/ci-status', async (req: Request, res: Response) => {
    const repoPath =
      typeof req.query.path === 'string' ? req.query.path : undefined;
    const branch =
      typeof req.query.branch === 'string' ? req.query.branch : undefined;

    if (!repoPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    try {
      const status = await getCiStatus(repoPath, branch ?? 'HEAD', { exec });
      res.json(status);
    } catch {
      res.json({ total: 0, passing: 0, failing: 0, pending: 0 });
    }
  });

  // POST /gh/pr-base — change PR base branch
  router.post('/pr-base', async (req: Request, res: Response) => {
    const repoPath =
      typeof req.query.path === 'string' ? req.query.path : undefined;
    const { prNumber, baseBranch } = req.body as {
      prNumber?: number;
      baseBranch?: string;
    };
    if (!repoPath) {
      res.status(400).json({ error: 'path query parameter required' });
      return;
    }
    if (!prNumber || typeof prNumber !== 'number') {
      res.status(400).json({ error: 'prNumber is required' });
      return;
    }
    if (!baseBranch || typeof baseBranch !== 'string') {
      res.status(400).json({ error: 'baseBranch is required' });
      return;
    }

    const result = await changePrBase(repoPath, prNumber, baseBranch, { exec });
    if (result.success) {
      clearPrCache(repoPath);
      res.json(result);
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  return router;
}
