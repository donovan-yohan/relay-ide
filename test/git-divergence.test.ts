import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getBranchDivergence } from '../server/git.js';

const execFileAsync = promisify(execFile);
type DivergenceExec = NonNullable<
  Parameters<typeof getBranchDivergence>[1]
>['exec'];
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

function gitTimeoutError(): Error & { code: string; killed: boolean } {
  return Object.assign(new Error('git command timed out'), {
    code: 'ETIMEDOUT',
    killed: true,
  });
}

function gitInternalError(): Error & { stderr: string } {
  return Object.assign(new Error('git failed'), {
    stderr: 'fatal: unable to create .git/index.lock',
  });
}

function gitRefMissingError(ref: string): Error & { stderr: string } {
  return Object.assign(new Error(`git ref missing: ${ref}`), {
    stderr: `fatal: ambiguous argument '${ref}': unknown revision or path not in the working tree`,
  });
}

function ok(stdout = ''): { stdout: string; stderr: string } {
  return { stdout, stderr: '' };
}

function createDivergenceExecMock(
  options: {
    timeoutOn?: (args: string[]) => boolean;
    internalErrorOn?: (args: string[]) => boolean;
    remoteDefaultRef?: string | null;
  } = {}
): DivergenceExec {
  const sha = 'a'.repeat(40);

  return async (file, args) => {
    expect(file).toBe('git');

    if (options.timeoutOn?.(args)) throw gitTimeoutError();
    if (options.internalErrorOn?.(args)) throw gitInternalError();

    const key = args.join(' ');
    if (key === 'rev-parse --show-toplevel') return ok(repoPath);
    if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') {
      if (options.remoteDefaultRef !== undefined)
        return ok(`${options.remoteDefaultRef ?? ''}\n`);
      throw gitRefMissingError('refs/remotes/origin/HEAD');
    }
    if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') {
      throw gitRefMissingError('@{u}');
    }
    if (key === 'symbolic-ref refs/remotes/origin/HEAD') {
      throw gitRefMissingError('refs/remotes/origin/HEAD');
    }
    if (key === 'rev-parse --verify refs/heads/main') return ok(`${sha}\n`);
    if (key.startsWith('rev-parse --verify --end-of-options '))
      return ok(`${sha}\n`);
    if (key === 'symbolic-ref --quiet --short HEAD') return ok('feature\n');
    if (key === 'status --porcelain=v1 -z') return ok('');
    if (key === 'merge-base -- main HEAD') return ok('');
    if (key === 'rev-list --left-right --count main...HEAD')
      return ok('0\t0\n');
    if (key === 'diff --numstat --find-renames main...HEAD') return ok('');
    if (args[0] === 'log') return ok('');

    throw new Error(`unexpected git command: ${key}`);
  };
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
    expect(summary.lineDelta).toEqual({
      additions: 0,
      deletions: 0,
      fileCount: 0,
    });
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
    expect(summary.commits.ahead.map((c) => c.subject)).toEqual([
      'feature commit',
    ]);
    expect(summary.commits.behind).toEqual([]);
    expect(summary.lineDelta).toEqual({
      additions: 1,
      deletions: 0,
      fileCount: 1,
    });

    await git(['checkout', 'main']);
    write('main.txt', 'main\n');
    await commit('main commit');
    await git(['checkout', 'feature']);

    summary = await getBranchDivergence(repoPath, { base: 'main' });
    expect(summary.state).toBe('ok');
    expect(summary.aheadCount).toBe(1);
    expect(summary.behindCount).toBe(1);
    expect(summary.commits.ahead.map((c) => c.subject)).toEqual([
      'feature commit',
    ]);
    expect(summary.commits.behind.map((c) => c.subject)).toEqual([
      'main commit',
    ]);
  });

  it('keeps binary numstat values numeric instead of returning NaN', async () => {
    await git(['checkout', '-b', 'feature']);
    fs.writeFileSync(
      path.join(repoPath, 'binary.dat'),
      Buffer.from([0, 1, 2, 3, 4])
    );
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
      expect.arrayContaining([
        'modified',
        'deleted',
        'renamed',
        'untracked',
        'conflicted',
      ])
    );
  });

  it('returns explicit states for non-git repos, missing bases, and detached HEADs', async () => {
    const nonGitPath = path.join(tmpDir, 'not-git');
    fs.mkdirSync(nonGitPath);
    expect(
      (await getBranchDivergence(nonGitPath, { base: 'main' })).state
    ).toBe('not_git');

    const missingBase = await getBranchDivergence(repoPath, {
      base: 'does-not-exist',
    });
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

  it('propagates timeout errors from optional base candidate discovery', async () => {
    const summary = await getBranchDivergence(repoPath, {
      base: 'main',
      exec: createDivergenceExecMock({
        timeoutOn: (args) =>
          args.join(' ') === 'symbolic-ref --short refs/remotes/origin/HEAD',
      }),
    });

    expect(summary.state).toBe('timeout');
    expect(summary.error).toBe('git command timed out');
  });

  it('propagates timeout errors from base candidate commit resolution', async () => {
    const summary = await getBranchDivergence(repoPath, {
      base: 'main',
      exec: createDivergenceExecMock({
        remoteDefaultRef: 'origin/main',
        timeoutOn: (args) =>
          args.join(' ') ===
          'rev-parse --verify --end-of-options origin/main^{commit}',
      }),
    });

    expect(summary.state).toBe('timeout');
    expect(summary.error).toBe('git command timed out');
  });

  it('propagates timeout errors from default branch detection', async () => {
    const summary = await getBranchDivergence(repoPath, {
      base: 'main',
      exec: createDivergenceExecMock({
        timeoutOn: (args) =>
          args.join(' ') === 'symbolic-ref refs/remotes/origin/HEAD',
      }),
    });

    expect(summary.state).toBe('timeout');
    expect(summary.error).toBe('git command timed out');
  });

  it('propagates timeout errors from current branch detection instead of reporting detached HEAD', async () => {
    const summary = await getBranchDivergence(repoPath, {
      base: 'main',
      exec: createDivergenceExecMock({
        timeoutOn: (args) =>
          args.join(' ') === 'symbolic-ref --quiet --short HEAD',
      }),
    });

    expect(summary.state).toBe('timeout');
    expect(summary.error).toBe('git command timed out');
    expect(summary.warnings).not.toContain('HEAD is detached');
  });

  it('returns a distinct git_error state for internal git failures inside a confirmed repo', async () => {
    const summary = await getBranchDivergence(repoPath, {
      base: 'main',
      exec: createDivergenceExecMock({
        internalErrorOn: (args) =>
          args.join(' ') === 'status --porcelain=v1 -z',
      }),
    });

    expect(summary.state).toBe('git_error');
    expect(summary.error).toContain('index.lock');
  });

  it('returns git_error instead of no_merge_base when merge-base has an internal git failure', async () => {
    const summary = await getBranchDivergence(repoPath, {
      base: 'main',
      exec: createDivergenceExecMock({
        internalErrorOn: (args) => args.join(' ') === 'merge-base -- main HEAD',
      }),
    });

    expect(summary.state).toBe('git_error');
    expect(summary.error).toContain('index.lock');
  });

  it('returns git_error instead of not_git when repo root detection has an internal git failure', async () => {
    const summary = await getBranchDivergence(repoPath, {
      base: 'main',
      exec: createDivergenceExecMock({
        internalErrorOn: (args) => args.join(' ') === 'rev-parse --show-toplevel',
      }),
    });

    expect(summary.state).toBe('git_error');
    expect(summary.error).toContain('index.lock');
  });

  it('rejects unsafe base refs before running revision ranges', async () => {
    for (const badRef of [
      '',
      '   ',
      '--upload-pack=/tmp/nope',
      'main\0evil',
      'HEAD~1',
      'HEAD^',
      'main..feature',
      ':/initial',
      'feature@{upstream}',
    ]) {
      const summary = await getBranchDivergence(repoPath, { base: badRef });
      expect(summary.state).toBe('invalid_base');
      expect(summary.error).toBe('invalid base ref');
    }
  });
});
