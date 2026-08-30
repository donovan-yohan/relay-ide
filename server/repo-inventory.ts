import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Semaphore, allOrFirstError } from './concurrency.js';

import type { Config } from './types.js';
import { readMeta } from './config.js';
import { scanWorktrees } from './git-routes.js';
import { detectGitRepo, resolveRepoIdentityFields, repoNameFromRemoteUrl } from './workspaces.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createRepoInstanceId,
  createWorktreeInstanceId,
  type NodeId,
} from '../shared/identity.js';
import type {
  RepoInventoryDirtyFile,
  RepoInventoryDirtySummary,
  RepoInventoryDivergenceSummary,
  RepoInventoryReport,
  RepoInventoryRepoInstance,
  RepoInventoryWorktreeInstance,
} from '../shared/repo-inventory.js';

const execFileAsync = promisify(execFile);
const DIRTY_FILES_LIMIT = 25;

/**
 * Default ceiling on simultaneously running `git` subprocesses for ONE
 * inventory collection. The scan is fork-bound, not CPU-bound, so a modest
 * ceiling above the core count still wins; the ceiling exists to keep a host
 * with dozens of repos from opening dozens of pipes at once.
 */
export const DEFAULT_REPO_SCAN_CONCURRENCY = 8;

function defaultRepoScanConcurrency(): number {
  const raw = Number.parseInt(
    process.env.RELAY_REPO_SCAN_CONCURRENCY ?? '',
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REPO_SCAN_CONCURRENCY;
}

/**
 * PROCESS-WIDE fork ceiling, shared by every collection that does not pin its
 * own limit.
 *
 * A per-collection semaphore would only bound one scan: cache invalidation
 * under churn (the worktree watcher debounces at 500 ms; a cold scan takes
 * ~200 ms) can legitimately leave a superseded scan running while a fresh one
 * starts, and N stacked scans with N private ceilings is N x the forks. One
 * shared gate keeps the guarantee true no matter how many collections overlap.
 *
 * Callers that pass an explicit `concurrency` get a private gate instead, so
 * tests can assert an exact bound without cross-test interference.
 */
let sharedScanGate: Semaphore | null = null;

function sharedRepoScanGate(): Semaphore {
  sharedScanGate ??= new Semaphore(defaultRepoScanConcurrency());
  return sharedScanGate;
}

/** Test hook: drop the shared gate so a new concurrency env value takes effect. */
export function resetSharedRepoScanGate(): void {
  sharedScanGate = null;
}

/**
 * How much of a repo instance a caller actually needs.
 *
 * - `full`     — every field, including `dirty`, `divergence`, and `worktrees`.
 *                What `GET /hub/repo-inventory` and `GET /hub/ia/tree` read.
 * - `identity` — identity coordinates only (`repoIdentity`, remotes, current
 *                and default branch). `dirty`/`divergence` come back `null` and
 *                `worktrees` empty, which is exactly what
 *                `summarizeRepoIdentityGroups` already discards for
 *                `GET /hub/repo-groups`. Skips the working-tree git forks
 *                instead of computing and throwing them away.
 *
 * The response SHAPE is identical in both tiers; only optional facts are
 * omitted. `identity` is never served where `full` was requested.
 */
export type RepoInventoryDetail = 'full' | 'identity';

type ExecFileAsyncLike = (
  file: string,
  args: string[],
  options: { cwd: string; timeout?: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface CollectLocalRepoInventoryDeps {
  config: Config;
  configPath: string;
  nodeId?: NodeId;
  now?: () => Date;
  execFileAsync?: ExecFileAsyncLike;
  readdirSync?: (dir: string) => Array<{ name: string; isDirectory: () => boolean }>;
  statSync?: (path: string) => { isDirectory: () => boolean };
  /** Which tier to collect. Defaults to `full` (unchanged legacy behaviour). */
  detail?: RepoInventoryDetail;
  /**
   * Max simultaneous `git` subprocesses for this collection. Defaults to
   * `RELAY_REPO_SCAN_CONCURRENCY` or {@link DEFAULT_REPO_SCAN_CONCURRENCY}.
   */
  concurrency?: number;
}

type CollectedRepoIdentityFields = Pick<
  RepoInventoryRepoInstance,
  'repoIdentity' | 'selectedRemote' | 'remotes' | 'repoIdentityWarnings'
>;

function dirtyFileStatus(code: string): RepoInventoryDirtyFile['status'] {
  if (code === '??') return 'untracked';
  if (code === 'DD' || code === 'AA' || code === 'UU' || code.includes('U')) return 'conflicted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('M')) return 'modified';
  return 'unknown';
}

function parseDirtyStatus(stdout: string): RepoInventoryDirtySummary {
  const dirty: RepoInventoryDirtySummary = {
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    files: [],
    truncated: false,
  };

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const x = code[0] ?? ' ';
    const y = code[1] ?? ' ';
    if (code === '??') dirty.untrackedCount += 1;
    if (dirtyFileStatus(code) === 'conflicted') dirty.conflictedCount += 1;
    if (x !== ' ' && x !== '?') dirty.stagedCount += 1;
    if (y !== ' ' && y !== '?') dirty.unstagedCount += 1;

    if (dirty.files.length < DIRTY_FILES_LIMIT) {
      dirty.files.push({ path: rawPath, status: dirtyFileStatus(code) });
    } else {
      dirty.truncated = true;
    }
  }

  return dirty;
}

async function getDirtySummary(
  repoPath: string,
  execAsync: ExecFileAsyncLike
): Promise<RepoInventoryDirtySummary | null> {
  try {
    const { stdout } = await execAsync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      timeout: 5000,
    });
    return parseDirtyStatus(stdout);
  } catch {
    return null;
  }
}

async function getDivergenceSummary(
  repoPath: string,
  execAsync: ExecFileAsyncLike,
  now: Date
): Promise<RepoInventoryDivergenceSummary | null> {
  try {
    const [{ stdout: upstreamStdout }, { stdout: headStdout }] = await Promise.all([
      execAsync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
        cwd: repoPath,
        timeout: 5000,
      }),
      execAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, timeout: 5000 }),
    ]);
    const upstreamRef = upstreamStdout.trim() || null;
    if (!upstreamRef) return null;
    const { stdout: countsStdout } = await execAsync(
      'git',
      ['rev-list', '--left-right', '--count', `${upstreamRef}...HEAD`],
      { cwd: repoPath, timeout: 5000 }
    );
    const [behindRaw, aheadRaw] = countsStdout.trim().split(/\s+/);
    const behindCount = Number.parseInt(behindRaw ?? '0', 10);
    const aheadCount = Number.parseInt(aheadRaw ?? '0', 10);
    return {
      upstreamRef,
      behindCount: Number.isFinite(behindCount) ? behindCount : 0,
      aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
      headSha: headStdout.trim() || null,
      generatedAt: now.toISOString(),
    };
  } catch {
    return null;
  }
}

async function currentBranchFor(
  repoPath: string,
  execAsync: ExecFileAsyncLike
): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: repoPath,
      timeout: 5000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Repo display name, derived from the `origin` remote WITHOUT a second fork.
 *
 * `resolveRepoIdentityFields` already ran `git remote -v`, whose first line per
 * remote is the fetch URL — byte-identical to what `git remote get-url origin`
 * returns. Deriving from it drops one `git` fork per repo. Both the old and new
 * paths fall back to the directory name when there is no usable `origin`
 * (no remotes at all, or remotes without an `origin`).
 */
function nameFromRemotes(
  remotes: CollectedRepoIdentityFields['remotes'],
  fallback: string
): string {
  const origin = remotes.find((remote) => remote.name === 'origin');
  const url = origin?.url?.trim();
  if (!url) return fallback;
  return repoNameFromRemoteUrl(url) ?? fallback;
}

async function worktreeInstanceFor(
  worktree: {
    path: string;
    branchName: string;
    displayName: string;
    lastActivity: string;
  },
  nodeId: NodeId,
  execAsync: ExecFileAsyncLike,
  now: Date
): Promise<RepoInventoryWorktreeInstance> {
  const [dirty, divergence] = await Promise.all([
    getDirtySummary(worktree.path, execAsync),
    getDivergenceSummary(worktree.path, execAsync, now),
  ]);
  return {
    worktreeInstanceId: createWorktreeInstanceId(nodeId, worktree.path),
    localPath: worktree.path,
    branchName: worktree.branchName || null,
    displayName: worktree.displayName,
    lastActivity: worktree.lastActivity,
    dirty,
    divergence,
  };
}

interface RepoInstanceScanInput {
  repoPath: string;
  nodeId: NodeId;
  now: Date;
  detail: RepoInventoryDetail;
  execAsync: ExecFileAsyncLike;
  deps: CollectLocalRepoInventoryDeps;
}

async function collectRepoInstance(
  input: RepoInstanceScanInput
): Promise<RepoInventoryRepoInstance> {
  const { repoPath, nodeId, now, detail, execAsync, deps } = input;
  const workspaceExecAsync = execAsync as unknown as typeof execFileAsync;
  const { isGitRepo, defaultBranch } = await detectGitRepo(
    repoPath,
    workspaceExecAsync
  );
  const fallbackName = repoPath.split('/').filter(Boolean).pop() || repoPath;
  const identityFields = (await resolveRepoIdentityFields(
    repoPath,
    isGitRepo,
    workspaceExecAsync
  )) as CollectedRepoIdentityFields;

  // `identity` callers discard dirty/divergence/worktrees, so never fork for
  // them. `full` keeps the original fan-out.
  const wantsWorkingState = detail === 'full';
  const [currentBranch, dirty, divergence, worktrees] = await Promise.all([
    isGitRepo ? currentBranchFor(repoPath, execAsync) : Promise.resolve(null),
    isGitRepo && wantsWorkingState
      ? getDirtySummary(repoPath, execAsync)
      : Promise.resolve(null),
    isGitRepo && wantsWorkingState
      ? getDivergenceSummary(repoPath, execAsync, now)
      : Promise.resolve(null),
    isGitRepo && wantsWorkingState
      ? scanWorktrees(
          {
            getConfig: () => deps.config,
            configPath: deps.configPath,
            execFileAsync: execAsync,
            readdirSync:
              deps.readdirSync ??
              ((_dir: string) =>
                // Lazy require would be worse here; scanner tests inject this.
                [] as Array<{ name: string; isDirectory: () => boolean }>),
            statSync: deps.statSync ?? (() => ({ isDirectory: () => false })),
            readMeta: (configPath: string, worktreePath: string) =>
              readMeta(configPath, worktreePath),
          },
          repoPath
        )
      : Promise.resolve([]),
  ]);

  const worktreeInstances = await allOrFirstError(
    worktrees.map((worktree) =>
      worktreeInstanceFor(worktree, nodeId, execAsync, now)
    )
  );

  return {
    repoInstanceId: createRepoInstanceId(nodeId, repoPath),
    nodeId,
    localPath: repoPath,
    name: isGitRepo
      ? nameFromRemotes(identityFields.remotes, fallbackName)
      : fallbackName,
    isGitRepo,
    defaultBranch,
    currentBranch,
    repoIdentity: identityFields.repoIdentity,
    selectedRemote: identityFields.selectedRemote,
    remotes: identityFields.remotes,
    repoIdentityWarnings: identityFields.repoIdentityWarnings,
    dirty,
    divergence,
    worktrees: worktreeInstances,
    reportedAt: now.toISOString(),
  };
}

/**
 * Collect the local node's repo inventory.
 *
 * Repos are scanned CONCURRENTLY (they were serial before #1448 — 33 repos x
 * ~8 `git` forks each is ~660 ms of round trips on a request path). Structural
 * concurrency is unbounded but cheap; the actual ceiling is a {@link Semaphore}
 * wrapped around the leaf `git` invocation — shared process-wide unless the
 * caller pins its own `concurrency` — so the guarantee is "at most N `git`
 * subprocesses at once" regardless of repo, worktree, or overlapping-scan
 * count. Output order still follows `config.repos`, and a failing repo still
 * surfaces the SAME error the old serial loop reported (lowest index wins).
 */
export async function collectLocalRepoInventory(
  deps: CollectLocalRepoInventoryDeps
): Promise<RepoInventoryReport> {
  const nodeId = deps.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const now = deps.now?.() ?? new Date();
  const baseExec = deps.execFileAsync ?? (execFileAsync as ExecFileAsyncLike);
  const detail = deps.detail ?? 'full';
  const gate =
    deps.concurrency === undefined
      ? sharedRepoScanGate()
      : new Semaphore(deps.concurrency);
  // Guard only the leaf subprocess call: a permit is never held across another
  // acquire, so the pool cannot deadlock on nested scans (worktree fan-out).
  const execAsync: ExecFileAsyncLike = (file, args, options) =>
    gate.run(() => baseExec(file, args, options));

  const repoPaths = deps.config.repos ?? [];
  const repos = await allOrFirstError(
    repoPaths.map((repoPath) =>
      collectRepoInstance({ repoPath, nodeId, now, detail, execAsync, deps })
    )
  );

  return {
    nodeId,
    generatedAt: now.toISOString(),
    repos,
  };
}
