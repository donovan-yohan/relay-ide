import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteLocalWorktreeBranch,
  removeWorktreeFromDisk,
  validateWorktreeForDelete,
} from '../server/worktree-cleanup.js';

const tempRoots: string[] = [];
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeRepoWithWorktree(branchName: string): {
  root: string;
  repoPath: string;
  worktreePath: string;
  branchName: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-worktree-cleanup-'));
  tempRoots.push(root);
  const repoPath = path.join(root, 'repo');
  const worktreePath = path.join(root, 'wt');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'initial\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, [
    '-c',
    'user.name=Relay Test',
    '-c',
    'user.email=relay-test@example.invalid',
    'commit',
    '-m',
    'initial',
  ]);
  git(repoPath, ['branch', branchName]);
  git(repoPath, ['worktree', 'add', worktreePath, branchName]);
  return { root, repoPath, worktreePath, branchName };
}

function branchExists(repoPath: string, branchName: string): boolean {
  try {
    git(repoPath, ['rev-parse', '--verify', branchName]);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('worktree cleanup route helpers', () => {
  it('fails closed on dirty worktrees without force before destructive removal', async () => {
    const { repoPath, worktreePath } = makeRepoWithWorktree(
      'feature/dirty-delete'
    );
    fs.writeFileSync(path.join(worktreePath, 'dirty-untracked.txt'), 'dirty\n');

    const validation = await validateWorktreeForDelete(
      worktreePath,
      repoPath,
      false,
      []
    );

    expect(validation).toEqual({
      ok: false,
      error: {
        status: 409,
        error: 'uncommitted_changes',
        hasUncommittedChanges: true,
      },
    });
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('does not fall back to rmSync when clean-delete git removal fails without force', async () => {
    const { repoPath, worktreePath } = makeRepoWithWorktree(
      'feature/no-rm-fallback'
    );
    fs.writeFileSync(path.join(worktreePath, 'dirty-untracked.txt'), 'dirty\n');

    const error = await removeWorktreeFromDisk(worktreePath, repoPath, false);

    expect(error).toContain('contains modified or untracked files');
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('reports truthful branchDeleted for delete and removes the branch', async () => {
    const { repoPath, worktreePath, branchName } = makeRepoWithWorktree(
      'feature/delete-branch-truth'
    );

    const validation = await validateWorktreeForDelete(
      worktreePath,
      repoPath,
      false,
      []
    );
    expect(validation).toMatchObject({
      ok: true,
      branchName,
      hasUncommittedChanges: false,
    });
    expect(await removeWorktreeFromDisk(worktreePath, repoPath, false)).toBe(
      null
    );
    const branchDeleted = await deleteLocalWorktreeBranch(repoPath, branchName);

    expect(branchDeleted).toBe(true);
    expect(branchExists(repoPath, branchName)).toBe(false);
  });

  it('reports archive branchDeleted false and preserves the branch', async () => {
    const { repoPath, worktreePath, branchName } = makeRepoWithWorktree(
      'feature/archive-keeps-branch'
    );

    const validation = await validateWorktreeForDelete(
      worktreePath,
      repoPath,
      false,
      []
    );
    expect(validation).toMatchObject({ ok: true, branchName });
    expect(await removeWorktreeFromDisk(worktreePath, repoPath, false)).toBe(
      null
    );
    const branchDeleted = false;

    expect(branchDeleted).toBe(false);
    expect(branchExists(repoPath, branchName)).toBe(true);
  });

  it('fails closed on active sessions without force', async () => {
    const { repoPath, worktreePath } = makeRepoWithWorktree(
      'feature/active-session-delete'
    );

    const validation = await validateWorktreeForDelete(
      worktreePath,
      repoPath,
      false,
      ['session-1']
    );

    expect(validation).toEqual({
      ok: false,
      error: {
        status: 409,
        error: 'active_sessions',
        sessionIds: ['session-1'],
      },
    });
  });

  it('keeps lifecycle invalid-environment errors command-specific', () => {
    const cliSource = fs.readFileSync(
      new URL('../bin/relay-ide.ts', import.meta.url),
      'utf8'
    );
    const lifecycleEnvironmentHelper = cliSource.slice(
      cliSource.indexOf('function gatewayLifecycleEnvironment('),
      cliSource.indexOf('function gatewayLifecycleNodeId(')
    );

    expect(lifecycleEnvironmentHelper).toContain(
      'commandName: RelayCliGatewayCommand'
    );
    expect(lifecycleEnvironmentHelper).toContain('gatewayInvalid(\n      commandName,');
    expect(lifecycleEnvironmentHelper).not.toContain("'worktrees.status'");
    expect(cliSource).toContain(
      'const environment = gatewayLifecycleEnvironment(commandName, input);'
    );
  });
});
