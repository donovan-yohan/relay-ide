import { describe, it, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { BranchWatcher } from '../server/watcher.js';

/** Isolate child git processes from the host worktree environment. */
const GIT_ISOLATED_ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
};

function makeTempGitRepo(): string {
  // Resolve symlinks (macOS /var → /private/var) so paths match git output
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'branch-watcher-test-'))
  );
  execFileSync('git', ['init', '-b', 'main'], {
    cwd: dir,
    env: GIT_ISOLATED_ENV,
  });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@test.com',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    ],
    { cwd: dir, env: GIT_ISOLATED_ENV }
  );
  return dir;
}

describe('BranchWatcher', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    cleanups.length = 0;
  });

  it('[needs:git-init] detects branch change via HEAD file write', async () => {
    const repoDir = makeTempGitRepo();
    const parentDir = path.dirname(repoDir);
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));

    const events: Array<{ cwdPath: string; newBranch: string }> = [];
    const watcher = new BranchWatcher((cwdPath, newBranch) => {
      events.push({ cwdPath, newBranch });
    });
    cleanups.push(() => watcher.close());

    watcher.rebuild([parentDir]);

    // Let fs.watch initialize
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Create the branch first, then simulate checkout by writing HEAD directly
    // (more deterministic than git checkout which uses lock+rename)
    execFileSync('git', ['branch', 'feature-test'], { cwd: repoDir });
    const headPath = path.join(repoDir, '.git', 'HEAD');
    fs.writeFileSync(headPath, 'ref: refs/heads/feature-test\n');

    // Wait for debounce (300ms) + processing
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(events.length).toBeGreaterThan(0);
    const lastEvent = events[events.length - 1]!;
    expect(lastEvent.cwdPath).toBe(repoDir);
    expect(lastEvent.newBranch).toBe('feature-test');
  });

  it('[needs:git-init] does not fire callback if branch did not change', async () => {
    const repoDir = makeTempGitRepo();
    const parentDir = path.dirname(repoDir);
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));

    const events: Array<{ cwdPath: string; newBranch: string }> = [];
    const watcher = new BranchWatcher((cwdPath, newBranch) => {
      events.push({ cwdPath, newBranch });
    });
    cleanups.push(() => watcher.close());

    watcher.rebuild([parentDir]);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Touch the HEAD file without changing the branch content
    const headPath = path.join(repoDir, '.git', 'HEAD');
    const content = fs.readFileSync(headPath, 'utf-8');
    fs.writeFileSync(headPath, content);

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(events.length).toBe(0);
  });

  it('[needs:git-init] detects second branch change after atomic rename (inode change)', async () => {
    const repoDir = makeTempGitRepo();
    const parentDir = path.dirname(repoDir);
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));

    const events: Array<{ cwdPath: string; newBranch: string }> = [];
    const watcher = new BranchWatcher((cwdPath, newBranch) => {
      events.push({ cwdPath, newBranch });
    });
    cleanups.push(() => watcher.close());

    watcher.rebuild([parentDir]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const headPath = path.join(repoDir, '.git', 'HEAD');

    // First change: simulate git's atomic checkout (write to .lock, rename over HEAD)
    // This changes the inode, which would kill kqueue-based watchers
    execFileSync('git', ['branch', 'branch-one'], { cwd: repoDir });
    const lockPath = headPath + '.lock';
    fs.writeFileSync(lockPath, 'ref: refs/heads/branch-one\n');
    fs.renameSync(lockPath, headPath);

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]!.newBranch).toBe('branch-one');

    // Second change: simulate another atomic checkout — this would fail without
    // watcher recreation because the old watcher tracked the deleted inode
    execFileSync('git', ['branch', 'branch-two'], { cwd: repoDir });
    const lockPath2 = headPath + '.lock';
    fs.writeFileSync(lockPath2, 'ref: refs/heads/branch-two\n');
    fs.renameSync(lockPath2, headPath);

    await new Promise((resolve) => setTimeout(resolve, 800));

    const secondChange = events.find((e) => e.newBranch === 'branch-two');
    expect(secondChange).toBeTruthy();
  });

  it('closes cleanly', () => {
    const watcher = new BranchWatcher(() => {});
    watcher.close();
    // No error means success
  });
});
