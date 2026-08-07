import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Config } from './types.js';
import { readMeta } from './config.js';
import { scanWorktrees } from './git-routes.js';
import { detectGitRepo, resolveRepoIdentityFields, repoNameFromRemoteUrl } from './workspaces.js';
import { extractOwnerRepo } from './git.js';
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

async function nameFromOrigin(
  repoPath: string,
  fallback: string,
  execAsync: ExecFileAsyncLike
): Promise<{ name: string; ownerRepo?: string }> {
  try {
    const { stdout } = await execAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      timeout: 5000,
    });
    const url = stdout.trim();
    const remoteName = url ? repoNameFromRemoteUrl(url) : undefined;
    const ownerRepo = url ? (extractOwnerRepo(url) ?? undefined) : undefined;
    return {
      name: remoteName ?? fallback,
      ...(ownerRepo ? { ownerRepo } : {}),
    };
  } catch {
    return { name: fallback };
  }
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

export async function collectLocalRepoInventory(
  deps: CollectLocalRepoInventoryDeps
): Promise<RepoInventoryReport> {
  const nodeId = deps.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const now = deps.now?.() ?? new Date();
  const execAsync = deps.execFileAsync ?? (execFileAsync as ExecFileAsyncLike);
  const repos: RepoInventoryRepoInstance[] = [];

  for (const repoPath of deps.config.repos ?? []) {
    const workspaceExecAsync = execAsync as unknown as typeof execFileAsync;
    const { isGitRepo, defaultBranch } = await detectGitRepo(repoPath, workspaceExecAsync);
    const fallbackName = repoPath.split('/').filter(Boolean).pop() || repoPath;
    const identityFields = (await resolveRepoIdentityFields(
      repoPath,
      isGitRepo,
      workspaceExecAsync
    )) as CollectedRepoIdentityFields;
    const [{ name }, currentBranch, dirty, divergence, worktrees] = await Promise.all([
      isGitRepo ? nameFromOrigin(repoPath, fallbackName, execAsync) : Promise.resolve({ name: fallbackName }),
      isGitRepo ? currentBranchFor(repoPath, execAsync) : Promise.resolve(null),
      isGitRepo ? getDirtySummary(repoPath, execAsync) : Promise.resolve(null),
      isGitRepo ? getDivergenceSummary(repoPath, execAsync, now) : Promise.resolve(null),
      isGitRepo
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
              statSync:
                deps.statSync ??
                (() => ({ isDirectory: () => false })),
              readMeta: (configPath: string, worktreePath: string) => readMeta(configPath, worktreePath),
            },
            repoPath
          )
        : Promise.resolve([]),
    ]);

    const worktreeInstances = await Promise.all(
      worktrees.map((worktree) => worktreeInstanceFor(worktree, nodeId, execAsync, now))
    );

    repos.push({
      repoInstanceId: createRepoInstanceId(nodeId, repoPath),
      nodeId,
      localPath: repoPath,
      name,
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
    });
  }

  return {
    nodeId,
    generatedAt: now.toISOString(),
    repos,
  };
}
