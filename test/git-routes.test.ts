import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scanWorktrees, type GitRouterDeps } from '../server/git-routes.js';

function makeDeps(overrides: Partial<GitRouterDeps> = {}): GitRouterDeps {
  return {
    getConfig: () => ({ rootDirs: ['/repos'], repos: [] }),
    configPath: '/tmp/test-config.json',
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
    readdirSync: () => [],
    statSync: () => ({ isDirectory: () => true }),
    readMeta: () => null,
    ...overrides,
  };
}

describe('scanWorktrees', () => {
  it('returns worktrees without PR data (no branchState, prNumber, prTitle)', async () => {
    const deps = makeDeps({
      getConfig: () => ({ rootDirs: ['/repos'], repos: [] }),
      execFileAsync: async (
        file: string,
        args: string[],
        opts: { cwd: string }
      ) => {
        if (file === 'git' && args[0] === 'worktree') {
          return {
            stdout: [
              `worktree ${opts.cwd}`,
              'HEAD abc123',
              'branch refs/heads/main',
              '',
              `worktree ${opts.cwd}/.worktrees/feat`,
              'HEAD def456',
              'branch refs/heads/feat/login',
              '',
            ].join('\n'),
            stderr: '',
          };
        }
        throw new Error(`unexpected: ${file} ${args.join(' ')}`);
      },
      readdirSync: (_dir: string) => [
        { name: 'my-repo', isDirectory: () => true },
      ],
      statSync: () => ({ isDirectory: () => true }),
    });

    const items = await scanWorktrees(deps);
    assert.ok(Array.isArray(items));
    // parseWorktreeListPorcelain excludes the main worktree, so only child worktrees are returned
    assert.equal(items.length, 1);
    assert.equal(items[0]!.branchName, 'feat/login');
    for (const wt of items) {
      assert.equal(
        (wt as unknown as Record<string, unknown>).branchState,
        undefined
      );
      assert.equal(
        (wt as unknown as Record<string, unknown>).prNumber,
        undefined
      );
      assert.equal(
        (wt as unknown as Record<string, unknown>).prTitle,
        undefined
      );
      assert.ok(typeof wt.path === 'string');
      assert.ok(typeof wt.branchName === 'string');
    }
  });

  it('handles empty rootDirs gracefully', async () => {
    const deps = makeDeps({
      getConfig: () => ({ rootDirs: [], repos: [] }),
    });

    const items = await scanWorktrees(deps);
    assert.deepEqual(items, []);
  });

  it('filters by repo param', async () => {
    const deps = makeDeps({
      execFileAsync: async (
        file: string,
        args: string[],
        opts: { cwd: string }
      ) => {
        if (file === 'git' && args[0] === 'worktree') {
          return {
            stdout: [
              `worktree ${opts.cwd}`,
              'HEAD abc123',
              'branch refs/heads/main',
              '',
              `worktree ${opts.cwd}/.worktrees/feat`,
              'HEAD def456',
              'branch refs/heads/feat/x',
              '',
            ].join('\n'),
            stderr: '',
          };
        }
        throw new Error(`unexpected: ${file} ${args.join(' ')}`);
      },
    });

    // parseWorktreeListPorcelain excludes the main worktree, so only the child is returned
    const items = await scanWorktrees(deps, '/repos/my-repo');
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 1);
    assert.equal(items[0]!.branchName, 'feat/x');
  });

  it('deduplicates worktrees appearing via multiple repos', async () => {
    const sharedWorktreePath = '/repos/my-repo/.worktrees/feat';
    const deps = makeDeps({
      getConfig: () => ({
        rootDirs: ['/repos'],
        repos: ['/repos/my-repo'],
      }),
      execFileAsync: async (
        file: string,
        args: string[],
        opts: { cwd: string }
      ) => {
        if (file === 'git' && args[0] === 'worktree') {
          return {
            stdout: [
              `worktree ${opts.cwd}`,
              'HEAD abc123',
              'branch refs/heads/main',
              '',
              `worktree ${sharedWorktreePath}`,
              'HEAD def456',
              'branch refs/heads/feat/x',
              '',
            ].join('\n'),
            stderr: '',
          };
        }
        throw new Error(`unexpected: ${file} ${args.join(' ')}`);
      },
      readdirSync: () => [{ name: 'my-repo', isDirectory: () => true }],
      statSync: () => ({ isDirectory: () => true }),
    });

    const items = await scanWorktrees(deps);
    const paths = items.map((wt) => wt.path);
    const uniquePaths = [...new Set(paths)];
    assert.equal(
      paths.length,
      uniquePaths.length,
      'should have no duplicate paths'
    );
  });

  it('falls back to directory scanning when git worktree list fails', async () => {
    const deps = makeDeps({
      getConfig: () => ({ rootDirs: ['/repos'], repos: [] }),
      execFileAsync: async () => {
        throw new Error('git worktree list failed');
      },
      readdirSync: (dir: string) => {
        if (dir === '/repos')
          return [{ name: 'my-repo', isDirectory: () => true }];
        if (dir.includes('.worktrees'))
          return [{ name: 'feat-branch', isDirectory: () => true }];
        return [];
      },
      statSync: () => ({ isDirectory: () => true }),
      readMeta: () => ({
        worktreePath: '/repos/my-repo/.worktrees/feat-branch',
        displayName: 'Feature',
        lastActivity: '',
        branchName: 'feat-branch',
      }),
    });

    const items = await scanWorktrees(deps);
    assert.ok(items.length > 0, 'should fall back to directory scanning');
  });
});
