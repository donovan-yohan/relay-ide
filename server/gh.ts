import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CiStatus, PrInfo } from './types.js';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('gh');

type ExecFileAsyncResult = {
  stdout: string;
  stderr: string;
};

type ExecFileAsyncLike = (
  file: string,
  args: string[],
  options: { cwd: string; timeout?: number }
) => Promise<ExecFileAsyncResult>;

// ── PR lookup cache ─────────────────────────────────────────────────────────
// Caches `getPrForBranch` results to avoid spawning a `gh` subprocess on every
// request. Negative results (no PR) use a longer TTL since they only change on
// user action (push, PR creation).

const PR_CACHE_POSITIVE_TTL_MS = 60_000; // 60s — same as org-dashboard
const PR_CACHE_NEGATIVE_TTL_MS = 300_000; // 5 min — "no PR" rarely changes without user action

interface PrCacheEntry {
  result: PrInfo | null;
  fetchedAt: number;
}

const prCache = new Map<string, PrCacheEntry>();

function prCacheKey(repoPath: string, branch: string): string {
  return `${repoPath}:${branch}`;
}

function getPrCached(
  repoPath: string,
  branch: string
): PrCacheEntry | undefined {
  const key = prCacheKey(repoPath, branch);
  const entry = prCache.get(key);
  if (!entry) return undefined;
  const ttl = entry.result
    ? PR_CACHE_POSITIVE_TTL_MS
    : PR_CACHE_NEGATIVE_TTL_MS;
  if (Date.now() - entry.fetchedAt > ttl) {
    prCache.delete(key);
    return undefined;
  }
  return entry;
}

function setPrCached(
  repoPath: string,
  branch: string,
  result: PrInfo | null
): void {
  prCache.set(prCacheKey(repoPath, branch), { result, fetchedAt: Date.now() });
}

/** Clear PR cache entries. If repoPath is given, only clears entries for that repo. */
function clearPrCache(repoPath?: string): void {
  if (!repoPath) {
    prCache.clear();
    return;
  }
  const prefix = `${repoPath}:`;
  for (const key of prCache.keys()) {
    if (key.startsWith(prefix)) prCache.delete(key);
  }
}

const AUTH_ERROR_RESULT: CiStatus & { authError: true } = {
  total: 0,
  passing: 0,
  failing: 0,
  pending: 0,
  authError: true,
};

function isAuthErrorText(text: string): boolean {
  return text.includes('not logged into') || text.includes('authentication');
}

function isNoPrErrorText(text: string): boolean {
  return (
    text.includes('no pull requests found') || text.includes('Could not find')
  );
}

function handleCiExecError(
  err: unknown
): (CiStatus & { authError?: boolean }) | null {
  if (!err || typeof err !== 'object') return null;

  const errObj = err as { code?: string; message?: string; stderr?: string };
  if (errObj.code === 'ENOENT') return null;

  const errorText = errObj.stderr ?? errObj.message ?? '';
  if (typeof errorText === 'string' && isAuthErrorText(errorText)) {
    return AUTH_ERROR_RESULT;
  }
  if (typeof errorText === 'string' && isNoPrErrorText(errorText)) {
    return null;
  }

  return null;
}

type CheckEntry = { name: string; state: string; conclusion: string };

function classifyChecks(checks: CheckEntry[]): {
  passing: number;
  failing: number;
  pending: number;
} {
  let passing = 0;
  let failing = 0;
  let pending = 0;

  for (const check of checks) {
    const conclusion = (check.conclusion ?? '').toUpperCase();

    if (
      conclusion === 'SUCCESS' ||
      conclusion === 'SKIPPED' ||
      conclusion === 'NEUTRAL'
    ) {
      passing++;
    } else if (
      conclusion === 'FAILURE' ||
      conclusion === 'CANCELLED' ||
      conclusion === 'TIMED_OUT'
    ) {
      failing++;
    } else {
      pending++;
    }
  }

  return { passing, failing, pending };
}

async function getCiStatus(
  repoPath: string,
  branch: string,
  options: {
    exec?: ExecFileAsyncLike;
  } = {}
): Promise<(CiStatus & { authError?: boolean }) | null> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);

  let stdout: string;
  let stderr: string;

  try {
    ({ stdout, stderr } = await run(
      'gh',
      ['pr', 'checks', branch, '--json', 'name,state,conclusion'],
      { cwd: repoPath, timeout: 5000 }
    ));
  } catch (err: unknown) {
    return handleCiExecError(err);
  }

  if (stderr && isAuthErrorText(stderr)) {
    return AUTH_ERROR_RESULT;
  }

  if (!stdout.trim()) return null;

  try {
    const checks: CheckEntry[] = JSON.parse(stdout);
    const { passing, failing, pending } = classifyChecks(checks);
    return { total: checks.length, passing, failing, pending };
  } catch {
    return null;
  }
}

async function getPrForBranch(
  repoPath: string,
  branch: string,
  options: {
    exec?: ExecFileAsyncLike;
  } = {}
): Promise<PrInfo | null> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);

  let stdout: string;

  try {
    ({ stdout } = await run(
      'gh',
      [
        'pr',
        'view',
        branch,
        '--json',
        'number,title,url,state,headRefName,baseRefName,reviewDecision,isDraft,additions,deletions,mergeable,updatedAt',
      ],
      { cwd: repoPath, timeout: 5000 }
    ));
  } catch {
    return null;
  }

  if (!stdout.trim()) return null;

  try {
    const data = JSON.parse(stdout) as {
      number: number;
      title: string;
      url: string;
      state: string;
      headRefName: string;
      baseRefName: string;
      isDraft: boolean;
      reviewDecision: string | null;
      additions: number;
      deletions: number;
      mergeable: string;
      updatedAt: string;
    };

    return {
      number: data.number,
      title: data.title,
      url: data.url,
      state: data.state as PrInfo['state'],
      headRefName: data.headRefName,
      baseRefName: data.baseRefName,
      isDraft: data.isDraft,
      reviewDecision: data.reviewDecision ?? null,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      mergeable: (data.mergeable as PrInfo['mergeable']) ?? 'UNKNOWN',
      unresolvedCommentCount: 0,
      updatedAt: data.updatedAt ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * Batch-fetch all PRs for a repo in a single `gh pr list` call.
 * Returns a Map of headRefName → PrInfo for quick branch lookup.
 * Includes both open and closed/merged PRs (up to 100 most recent).
 */
async function batchGetPrsForRepo(
  repoPath: string,
  options: { exec?: ExecFileAsyncLike } = {}
): Promise<Map<string, PrInfo>> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);
  const prMap = new Map<string, PrInfo>();

  try {
    const { stdout } = await run(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        '100',
        '--json',
        'number,title,url,state,headRefName,baseRefName,reviewDecision,isDraft,additions,deletions,mergeable,updatedAt',
      ],
      { cwd: repoPath, timeout: 10000 }
    );

    if (!stdout.trim()) return prMap;

    const prs = JSON.parse(stdout) as Array<{
      number: number;
      title: string;
      url: string;
      state: string;
      headRefName: string;
      baseRefName: string;
      isDraft: boolean;
      reviewDecision: string | null;
      additions: number;
      deletions: number;
      mergeable: string;
      updatedAt: string;
    }>;

    for (const data of prs) {
      prMap.set(data.headRefName, {
        number: data.number,
        title: data.title,
        url: data.url,
        state: data.state as PrInfo['state'],
        headRefName: data.headRefName,
        baseRefName: data.baseRefName,
        isDraft: data.isDraft,
        reviewDecision: data.reviewDecision ?? null,
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
        mergeable: (data.mergeable as PrInfo['mergeable']) ?? 'UNKNOWN',
        unresolvedCommentCount: 0,
        updatedAt: data.updatedAt ?? '',
      });
    }
  } catch (err) {
    logger.warn(
      '[gh] batchGetPrsForRepo failed for',
      repoPath,
      err instanceof Error ? err.message : err
    );
  }

  return prMap;
}

async function getUnresolvedCommentCount(
  repoPath: string,
  prNumber: number,
  options: {
    exec?: ExecFileAsyncLike;
  } = {}
): Promise<number> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);

  try {
    const { stdout: repoStdout } = await run(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { cwd: repoPath, timeout: 5000 }
    );
    const nameWithOwner = repoStdout.trim();
    if (!nameWithOwner) return 0;

    const [owner, repo] = nameWithOwner.split('/');
    if (!owner || !repo) return 0;

    const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { isResolved }
      }
    }
  }
}`;

    const { stdout } = await run(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `repo=${repo}`,
        '-F',
        `number=${prNumber}`,
      ],
      { cwd: repoPath, timeout: 10000 }
    );

    const result = JSON.parse(stdout) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{ isResolved: boolean }>;
            };
          };
        };
      };
    };

    const nodes =
      result?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.filter((n) => !n.isResolved).length;
  } catch {
    return 0;
  }
}

async function changePrBase(
  repoPath: string,
  prNumber: number,
  baseBranch: string,
  options: { exec?: ExecFileAsyncLike } = {}
): Promise<{ success: true } | { success: false; error: string }> {
  const run = options.exec || (execFileAsync as ExecFileAsyncLike);
  try {
    await run('gh', ['pr', 'edit', String(prNumber), '--base', baseBranch], {
      cwd: repoPath,
      timeout: 10000,
    });
    return { success: true };
  } catch (err: unknown) {
    const errObj = err as { stderr?: string; message?: string; code?: string };
    if (errObj.code === 'ENOENT')
      return { success: false, error: 'gh CLI not installed' };
    return {
      success: false,
      error: (errObj.stderr ?? errObj.message ?? 'Unknown error').trim(),
    };
  }
}

const ONE_DAY_MS = 86_400_000;

/** A PR is stale if it's MERGED or CLOSED and was last updated more than 1 day ago (or has no valid timestamp). */
function isStalePr(pr: PrInfo): boolean {
  if (pr.state === 'OPEN') return false;
  if (!pr.updatedAt) return true; // no timestamp → treat as stale
  const elapsed = Date.now() - new Date(pr.updatedAt).getTime();
  if (Number.isNaN(elapsed)) return true; // unparseable date → treat as stale
  return elapsed > ONE_DAY_MS;
}

export {
  getCiStatus,
  getPrForBranch,
  batchGetPrsForRepo,
  getUnresolvedCommentCount,
  changePrBase,
  isStalePr,
  getPrCached,
  setPrCached,
  clearPrCache,
};
