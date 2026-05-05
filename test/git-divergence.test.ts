import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getBranchDivergence } from '../server/git.js';

const execFileAsync = promisify(execFile);

let tmpDir: string;
let repoPath: string;

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 10_000 });
  return stdout;
}

function write(relPath: string, content: string): void {
  const abs = path.join(repoPath, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

async function commit(message: string): Promise<string> {
  await git(['add', '-A']);
  await git(['commit', '-m', message]);
  return (await git(['rev-parse', 'HEAD'])).trim();
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-git-divergence-'));
  repoPath = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Relay Test']);
  await git(['config', 'user.email', 'relay@example.test']);
  write('base.txt', 'base\n');
  await commit('initial commit');
});

// Keep tmp repos on failure? nope, this suite makes a ton of them. nuke it.
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getBranchDivergence', () => {
  it('reports a clean branch against the selected base without faking dirty state', async () => {
    const summary = await getBranchDivergence(repoPath, { base: 'main' });

    expect(summary.state).toBe('ok');
    expect(summary.currentBranch).toBe('main');
    expect(summary.selectedBase).toMatchObject({ ref: 'main' });
    expect(summary.aheadCount).toBe(0);
    expect(summary.behindCount).toBe(0);
    expect(summary.lineDelta).toEqual({ additions: 0, deletions: 0, fileCount: 0 });
    expect(summary.dirty).toMatchObject({
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      files: [],
    });
    expect(summary.error).toBeUndefined();
  });

  it('uses side-specific ranges for ahead-only, behind-only, and diverged commit lists', async () => {
    await git(['checkout', '-b', 'feature']);
    write('feature.txt', 'feature\n');
    await commit('feature commit');

    let summary = await getBranchDivergence(repoPath, { base: 'main' });
    expect(summary.state).toBe('ok');
    expect(summary.aheadCount).toBe(1);
    expect(summary.behindCount).toBe(0);
    expect(summary.commits.ahead.map((c) => c.subject)).toEqual(['feature commit']);
    expect(summary.commits.behind).toEqual([]);
    expect(summary.lineDelta).toEqual({ additions: 1, deletions: 0, fileCount: 1 });

    await git(['checkout', 'main']);
    write('main.txt', 'main\n');
    await commit('main commit');
    await git(['checkout', 'feature']);

    summary = await getBranchDivergence(repoPath, { base: 'main' });
    expect(summary.state).toBe('ok');
    expect(summary.aheadCount).toBe(1);
    expect(summary.behindCount).toBe(1);
    expect(summary.commits.ahead.map((c) => c.subject)).toEqual(['feature commit']);
    expect(summary.commits.behind.map((c) => c.subject)).toEqual(['main commit']);
  });

  it('keeps binary numstat values numeric instead of returning NaN', async () => {
    await git(['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repoPath, 'binary.dat'), Buffer.from([0, 1, 2, 3, 4]));
    await commit('add binary');

    const summary = await getBranchDivergence(repoPath, { base: 'main' });

    expect(summary.state).toBe('ok');
    expect(summary.lineDelta.fileCount).toBe(1);
    expect(Number.isNaN(summary.lineDelta.additions)).toBe(false);
    expect(Number.isNaN(summary.lineDelta.deletions)).toBe(false);
  });

  it('distinguishes staged, unstaged, untracked, deleted, renamed, and conflicted dirty files', async () => {
    write('staged.txt', 'one\n');
    write('unstaged.txt', 'one\n');
    write('deleted.txt', 'one\n');
    write('oldname.txt', 'one\n');
    write('conflict.txt', 'base\n');
    await commit('add dirty fixtures');

    await git(['checkout', '-b', 'side']);
    write('conflict.txt', 'side\n');
    await commit('side conflict');
    await git(['checkout', 'main']);
    write('conflict.txt', 'main\n');
    await commit('main conflict');
    try {
      await git(['merge', 'side']);
    } catch {
      // Expected: leave the repo in an unresolved conflict state for porcelain parsing.
    }

    write('staged.txt', 'one\nstaged\n');
    await git(['add', 'staged.txt']);
    write('unstaged.txt', 'one\nunstaged\n');
    fs.unlinkSync(path.join(repoPath, 'deleted.txt'));
    await git(['mv', 'oldname.txt', 'renamed.txt']);
    write('untracked.txt', 'new\n');

    const summary = await getBranchDivergence(repoPath, { base: 'main' });

    expect(summary.dirty.stagedCount).toBeGreaterThanOrEqual(2);
    expect(summary.dirty.unstagedCount).toBeGreaterThanOrEqual(2);
    expect(summary.dirty.untrackedCount).toBe(1);
    expect(summary.dirty.conflictedCount).toBe(1);
    expect(summary.dirty.files.map((f) => f.status)).toEqual(
      expect.arrayContaining(['modified', 'deleted', 'renamed', 'untracked', 'conflicted'])
    );
  });

  it('returns explicit states for non-git repos, missing bases, and detached HEADs', async () => {
    const nonGitPath = path.join(tmpDir, 'not-git');
    fs.mkdirSync(nonGitPath);
    expect((await getBranchDivergence(nonGitPath, { base: 'main' })).state).toBe('not_git');

    const missingBase = await getBranchDivergence(repoPath, { base: 'does-not-exist' });
    expect(missingBase.state).toBe('missing_base');
    expect(missingBase.error).toContain('base ref not found');

    const headSha = (await git(['rev-parse', 'HEAD'])).trim();
    await git(['checkout', '--detach', headSha]);
    const detached = await getBranchDivergence(repoPath, { base: 'main' });
    expect(detached.state).toBe('detached');
    expect(detached.currentBranch).toBeNull();
    expect(detached.warnings).toContain('HEAD is detached');

    await git(['checkout', 'main']);
    await git(['checkout', '--orphan', 'orphan']);
    await git(['rm', '-rf', '.']);
    write('orphan.txt', 'orphan\n');
    await commit('orphan root');
    const noMergeBase = await getBranchDivergence(repoPath, { base: 'main' });
    expect(noMergeBase.state).toBe('no_merge_base');
    expect(noMergeBase.error).toContain('no merge base');
  });

  it('rejects unsafe base refs before running revision ranges', async () => {
    for (const badRef of ['', '   ', '--upload-pack=/tmp/nope', 'main\0evil']) {
      const summary = await getBranchDivergence(repoPath, { base: badRef });
      expect(summary.state).toBe('invalid_base');
      expect(summary.error).toBe('invalid base ref');
    }
  });
});
