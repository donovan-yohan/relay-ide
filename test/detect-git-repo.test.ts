import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectGitRepo,
  GitBinaryMissingError,
  PathInaccessibleError,
} from '../server/workspaces.js';

type ExecLike = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string }
) => Promise<{ stdout: string; stderr: string }>;

function gitExit128(): NodeJS.ErrnoException & { stderr: string } {
  const err = new Error(
    'Command failed: git rev-parse --git-dir\nfatal: not a git repository (or any of the parent directories): .git'
  ) as NodeJS.ErrnoException & { stderr: string };
  err.code = 128;
  err.stderr =
    'fatal: not a git repository (or any of the parent directories): .git\n';
  return err;
}

function spawnEnoent(): NodeJS.ErrnoException & { stderr?: string } {
  const err = new Error(
    'spawn git ENOENT'
  ) as NodeJS.ErrnoException & { stderr?: string };
  err.code = 'ENOENT';
  err.syscall = 'spawn git';
  err.stderr = '';
  return err;
}

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-detect-git-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectGitRepo — path-aware ENOENT classification', () => {
  it('returns { isGitRepo: false } when the path does not exist (no git invoked)', async () => {
    let gitCalled = false;
    const exec: ExecLike = async () => {
      gitCalled = true;
      return { stdout: '', stderr: '' };
    };
    const result = await detectGitRepo(
      path.join(tmpDir, 'does-not-exist'),
      exec as never
    );
    expect(result).toEqual({ isGitRepo: false, defaultBranch: null });
    expect(gitCalled).toBe(false);
  });

  it('returns { isGitRepo: false } when the path is a regular file', async () => {
    const filePath = path.join(tmpDir, 'a-file');
    fs.writeFileSync(filePath, 'not a directory');
    let gitCalled = false;
    const exec: ExecLike = async () => {
      gitCalled = true;
      return { stdout: '', stderr: '' };
    };
    const result = await detectGitRepo(filePath, exec as never);
    expect(result).toEqual({ isGitRepo: false, defaultBranch: null });
    expect(gitCalled).toBe(false);
  });

  it('throws GitBinaryMissingError when path exists but git binary is missing', async () => {
    fs.mkdirSync(path.join(tmpDir, 'real-dir'));
    const exec: ExecLike = async () => {
      throw spawnEnoent();
    };
    await expect(
      detectGitRepo(path.join(tmpDir, 'real-dir'), exec as never)
    ).rejects.toBeInstanceOf(GitBinaryMissingError);
  });

  it('returns { isGitRepo: false } for git exit 128 on a real directory', async () => {
    fs.mkdirSync(path.join(tmpDir, 'real-dir'));
    const exec: ExecLike = async () => {
      throw gitExit128();
    };
    const result = await detectGitRepo(
      path.join(tmpDir, 'real-dir'),
      exec as never
    );
    expect(result).toEqual({ isGitRepo: false, defaultBranch: null });
  });

  it('throws PathInaccessibleError when stat fails with EACCES', async () => {
    // Simulate EACCES on the directory access by passing a path that triggers
    // a permission-style error via a custom exec; but stat happens first.
    // We can't easily reproduce a real EACCES portably, so this test focuses
    // on the fall-through path: a directory that exists where git itself
    // errors with EACCES (e.g. policy denies execve).
    fs.mkdirSync(path.join(tmpDir, 'real-dir'));
    const exec: ExecLike = async () => {
      const err = new Error('git EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    await expect(
      detectGitRepo(path.join(tmpDir, 'real-dir'), exec as never)
    ).rejects.toBeInstanceOf(PathInaccessibleError);
  });

  it('returns { isGitRepo: true } for a real git repository', async () => {
    const repoDir = path.join(tmpDir, 'real-repo');
    fs.mkdirSync(repoDir);
    const exec: ExecLike = async (_file, args, opts) => {
      expect(args).toEqual(['rev-parse', '--git-dir']);
      expect(opts?.cwd).toBe(repoDir);
      return { stdout: '.git\n', stderr: '' };
    };
    const result = await detectGitRepo(repoDir, exec as never);
    expect(result.isGitRepo).toBe(true);
  });
});
