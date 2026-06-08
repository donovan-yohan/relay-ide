import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './logger.js';
import { parseAllWorktrees } from './watcher.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('worktree-cleanup');

const gitChildEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
};

export type WorktreeValidationError = {
  status: number;
  error: string;
  sessionIds?: string[];
  hasUncommittedChanges?: boolean;
};

export type WorktreeDeleteProof = {
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly recognizedNonMainWorktree: true;
};

export type WorktreeValidationResult =
  | {
      ok: true;
      branchName: string;
      hasUncommittedChanges: boolean;
      deleteProof: WorktreeDeleteProof;
    }
  | { ok: false; error: WorktreeValidationError };

function execErrorMessage(err: unknown, fallback: string): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || fallback).trim();
}

async function hasDirtyWorktree(worktreePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: path.resolve(worktreePath),
    env: gitChildEnv,
    timeout: 5000,
  });
  return stdout.trim().length > 0;
}

async function proveRecognizedNonMainWorktree(
  worktreePath: string,
  repoPath: string
): Promise<WorktreeDeleteProof | null> {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedRepoPath = path.resolve(repoPath);
  const { stdout: wtListOut } = await execFileAsync(
    'git',
    ['worktree', 'list', '--porcelain'],
    { cwd: resolvedRepoPath, env: gitChildEnv }
  );
  const allWorktrees = parseAllWorktrees(wtListOut, resolvedRepoPath);
  const worktree = allWorktrees.find(
    (wt) => path.resolve(wt.path) === resolvedWorktreePath && !wt.isMain
  );
  if (!worktree) return null;
  return {
    repoPath: resolvedRepoPath,
    worktreePath: resolvedWorktreePath,
    branchName: worktree.branch,
    recognizedNonMainWorktree: true,
  };
}

function proofMatchesRequest(
  proof: WorktreeDeleteProof,
  worktreePath: string,
  repoPath: string
): boolean {
  return (
    proof.recognizedNonMainWorktree === true &&
    proof.worktreePath === path.resolve(worktreePath) &&
    proof.repoPath === path.resolve(repoPath)
  );
}

/** Validates that a worktree can be deleted and returns the branch checked out there. */
export async function validateWorktreeForDelete(
  worktreePath: string,
  repoPath: string,
  force: boolean,
  activeSessions: string[]
): Promise<WorktreeValidationResult> {
  const resolvedWorktreePath = path.resolve(worktreePath);
  let deleteProof: WorktreeDeleteProof;

  try {
    const proof = await proveRecognizedNonMainWorktree(worktreePath, repoPath);
    if (!proof) {
      if (!fs.existsSync(resolvedWorktreePath)) {
        return {
          ok: false,
          error: {
            status: 404,
            error: 'Worktree not found — may have been already cleaned up',
          },
        };
      }
      return {
        ok: false,
        error: { status: 400, error: 'Path is not a recognized git worktree' },
      };
    }
    deleteProof = proof;
  } catch (err) {
    logger.warn(
      '[worktrees/delete] git worktree list failed for',
      repoPath,
      err instanceof Error ? err.message : err
    );
    return {
      ok: false,
      error: {
        status: 500,
        error: 'Cannot verify worktree — git worktree list failed.',
      },
    };
  }

  if (activeSessions.length > 0 && !force) {
    return {
      ok: false,
      error: {
        status: 409,
        error: 'active_sessions',
        sessionIds: activeSessions,
      },
    };
  }

  let hasUncommittedChanges = true;
  try {
    hasUncommittedChanges = await hasDirtyWorktree(resolvedWorktreePath);
  } catch (err) {
    logger.warn(
      '[worktrees/delete] git status failed for',
      resolvedWorktreePath,
      err instanceof Error ? err.message : err
    );
    if (!force) {
      return {
        ok: false,
        error: {
          status: 500,
          error:
            'Cannot verify worktree cleanliness — git status failed. Use force: true to delete anyway.',
          hasUncommittedChanges: true,
        },
      };
    }
  }

  if (hasUncommittedChanges && !force) {
    return {
      ok: false,
      error: {
        status: 409,
        error: 'uncommitted_changes',
        hasUncommittedChanges: true,
      },
    };
  }

  return {
    ok: true,
    branchName: deleteProof.branchName,
    hasUncommittedChanges,
    deleteProof,
  };
}

/** Removes a worktree from disk. Fallback directory deletion is force-only and proof-gated. */
export async function removeWorktreeFromDisk(
  worktreePath: string,
  repoPath: string,
  force: boolean,
  deleteProof: WorktreeDeleteProof
): Promise<string | null> {
  if (!proofMatchesRequest(deleteProof, worktreePath, repoPath)) {
    return 'Cannot remove worktree — deletion proof does not match requested path';
  }
  try {
    const freshProof = await proveRecognizedNonMainWorktree(
      worktreePath,
      repoPath
    );
    if (
      !freshProof ||
      freshProof.branchName !== deleteProof.branchName ||
      !proofMatchesRequest(freshProof, worktreePath, repoPath)
    ) {
      return 'Cannot remove worktree — path is not a recognized non-main git worktree';
    }
  } catch (err) {
    logger.warn(
      '[worktrees/delete] git worktree list failed before removal for',
      repoPath,
      err instanceof Error ? err.message : err
    );
    return 'Cannot remove worktree — git worktree list failed';
  }

  try {
    const removeArgs = force
      ? ['worktree', 'remove', '--force', worktreePath]
      : ['worktree', 'remove', worktreePath];
    await execFileAsync('git', removeArgs, { cwd: repoPath, env: gitChildEnv });
  } catch (err) {
    if (!force) {
      return execErrorMessage(err, 'Failed to remove worktree');
    }
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (rmErr: unknown) {
        return execErrorMessage(rmErr, 'Failed to remove worktree directory');
      }
    }
    // directory already gone — that's fine, continue to cleanup
  }
  return null;
}

export async function deleteLocalWorktreeBranch(
  repoPath: string,
  branchName: string
): Promise<boolean> {
  if (!branchName) return false;
  try {
    await execFileAsync('git', ['branch', '-D', branchName], {
      cwd: repoPath,
      env: gitChildEnv,
    });
    return true;
  } catch {
    return false;
  }
}
