import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKTREE_DIRS,
  isValidWorktreePath,
  parseWorktreeListPorcelain,
  parseAllWorktrees,
  findOrCreateWorktreeForBranch,
} from '../server/watcher.js';
import { MOUNTAIN_NAMES } from '../server/types.js';
import { generateTmuxSessionName } from '../server/pty-handler.js';

describe('worktree directories constant', () => {
  it('should include both .worktrees and .claude/worktrees', () => {
    assert.deepEqual(WORKTREE_DIRS, ['.worktrees', '.claude/worktrees']);
  });
});

describe('isValidWorktreePath', () => {
  it('should reject paths not inside any worktree directory', () => {
    assert.equal(isValidWorktreePath('/some/random/path'), false);
  });

  it('should accept paths inside .worktrees/', () => {
    assert.equal(
      isValidWorktreePath('/Users/me/code/repo/.worktrees/my-worktree'),
      true
    );
  });

  it('should accept paths inside .claude/worktrees/', () => {
    assert.equal(
      isValidWorktreePath('/Users/me/code/repo/.claude/worktrees/my-worktree'),
      true
    );
  });

  it('should not match partial .worktrees paths', () => {
    assert.equal(isValidWorktreePath('/Users/me/.worktrees-fake/foo'), false);
  });
});

describe('branch name to directory name', () => {
  it('should replace slashes with dashes', () => {
    const branchName = 'dy/feat/my-feature';
    const dirName = branchName.replace(/\//g, '-');
    assert.equal(dirName, 'dy-feat-my-feature');
  });

  it('should leave flat branch names unchanged', () => {
    const branchName = 'my-feature';
    const dirName = branchName.replace(/\//g, '-');
    assert.equal(dirName, 'my-feature');
  });
});

describe('parseWorktreeListPorcelain', () => {
  const repoPath = '/Users/me/code/my-repo';

  it('should parse a single worktree entry', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/code/my-repo/.worktrees/feat-branch',
      'HEAD def456',
      'branch refs/heads/feat/branch',
      '',
    ].join('\n');

    const result = parseWorktreeListPorcelain(stdout, repoPath);
    assert.equal(result.length, 1);
    assert.equal(
      result[0]!.path,
      '/Users/me/code/my-repo/.worktrees/feat-branch'
    );
    assert.equal(result[0]!.branch, 'feat/branch');
  });

  it('should parse multiple worktree entries', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/code/my-repo/.worktrees/feat-a',
      'HEAD def456',
      'branch refs/heads/feat/a',
      '',
      'worktree /Users/me/other-path/extend-cli',
      'HEAD 789abc',
      'branch refs/heads/dy/feat/worktree-isolation',
      '',
    ].join('\n');

    const result = parseWorktreeListPorcelain(stdout, repoPath);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.path, '/Users/me/code/my-repo/.worktrees/feat-a');
    assert.equal(result[0]!.branch, 'feat/a');
    assert.equal(result[1]!.path, '/Users/me/other-path/extend-cli');
    assert.equal(result[1]!.branch, 'dy/feat/worktree-isolation');
  });

  it('should skip the main worktree (repo root)', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const result = parseWorktreeListPorcelain(stdout, repoPath);
    assert.equal(result.length, 0);
  });

  it('should skip bare entries', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /some/bare/repo',
      'HEAD def456',
      'bare',
      '',
    ].join('\n');

    const result = parseWorktreeListPorcelain(stdout, repoPath);
    assert.equal(result.length, 0);
  });

  it('should skip detached HEAD worktrees (no branch line)', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/code/my-repo/.worktrees/detached',
      'HEAD def456',
      'detached',
      '',
    ].join('\n');

    const result = parseWorktreeListPorcelain(stdout, repoPath);
    assert.equal(result.length, 0);
  });

  it('should handle empty output', () => {
    const result = parseWorktreeListPorcelain('', repoPath);
    assert.equal(result.length, 0);
  });

  it('should discover worktrees at arbitrary paths outside .worktrees/', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /completely/different/path/project-checkout',
      'HEAD def456',
      'branch refs/heads/feature/my-feature',
      '',
    ].join('\n');

    const result = parseWorktreeListPorcelain(stdout, repoPath);
    assert.equal(result.length, 1);
    assert.equal(
      result[0]!.path,
      '/completely/different/path/project-checkout'
    );
    assert.equal(result[0]!.branch, 'feature/my-feature');
  });

  it('should handle deeply nested branch names', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/code/my-repo/.worktrees/dy-feat-deep-nesting',
      'HEAD def456',
      'branch refs/heads/dy/feat/deep/nesting/here',
      '',
    ].join('\n');

    const result = parseWorktreeListPorcelain(stdout, repoPath);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.branch, 'dy/feat/deep/nesting/here');
  });
});

describe('parseAllWorktrees', () => {
  const repoPath = '/Users/me/code/my-repo';

  it('should include the main worktree with isMain=true', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const result = parseAllWorktrees(stdout, repoPath);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.path, repoPath);
    assert.equal(result[0]!.branch, 'main');
    assert.equal(result[0]!.isMain, true);
  });

  it('should mark non-main worktrees with isMain=false', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/code/my-repo/.worktrees/feat-branch',
      'HEAD def456',
      'branch refs/heads/feat/branch',
      '',
    ].join('\n');

    const result = parseAllWorktrees(stdout, repoPath);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.isMain, true);
    assert.equal(result[1]!.isMain, false);
    assert.equal(
      result[1]!.path,
      '/Users/me/code/my-repo/.worktrees/feat-branch'
    );
    assert.equal(result[1]!.branch, 'feat/branch');
  });

  it('should still skip bare entries', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /some/bare/repo',
      'HEAD def456',
      'bare',
      '',
    ].join('\n');

    const result = parseAllWorktrees(stdout, repoPath);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.isMain, true);
  });

  it('should include detached HEAD entries with empty branch', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/code/my-repo/.worktrees/detached',
      'HEAD def456',
      'detached',
      '',
    ].join('\n');

    const result = parseAllWorktrees(stdout, repoPath);
    assert.equal(result.length, 2);
    assert.equal(result[1]!.branch, '');
  });

  it('should handle empty output', () => {
    const result = parseAllWorktrees('', repoPath);
    assert.equal(result.length, 0);
  });

  it('should find worktree by branch name', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/dy/feat/worktree-isolation',
      '',
      'worktree /Users/me/code/my-repo/.worktrees/feat-a',
      'HEAD def456',
      'branch refs/heads/feat/a',
      '',
    ].join('\n');

    const result = parseAllWorktrees(stdout, repoPath);
    const match = result.find(
      (wt) => wt.branch === 'dy/feat/worktree-isolation'
    );
    assert.ok(match);
    assert.equal(match!.path, repoPath);
    assert.equal(match!.isMain, true);
  });
});

describe('workspace-to-repo merging for worktree discovery', () => {
  // This tests the logic used in GET /worktrees to merge config.workspaces
  // into the rootDir-scanned repo list, preventing the bug where workspaces
  // added directly (not under any rootDir) had invisible worktrees.

  type RepoEntry = { name: string; path: string; root: string };

  function mergeWorkspacesIntoRepos(
    reposToScan: RepoEntry[],
    configWorkspaces: string[],
    rootDirs: string[]
  ): RepoEntry[] {
    const result = [...reposToScan];
    const scannedPaths = new Set(result.map((r) => r.path));
    for (const wp of configWorkspaces) {
      if (scannedPaths.has(wp)) continue;
      const root = rootDirs.find((r) => wp.startsWith(r)) || '';
      result.push({
        path: wp,
        name: wp.split('/').filter(Boolean).pop() || '',
        root,
      });
    }
    return result;
  }

  it('should add workspaces not under any rootDir', () => {
    const reposFromRootDirs: RepoEntry[] = [
      { name: 'repo-a', path: '/root/repo-a', root: '/root' },
    ];
    const configWorkspaces = ['/other/path/my-project'];
    const rootDirs = ['/root'];

    const merged = mergeWorkspacesIntoRepos(
      reposFromRootDirs,
      configWorkspaces,
      rootDirs
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[1]!.path, '/other/path/my-project');
    assert.equal(merged[1]!.name, 'my-project');
    assert.equal(merged[1]!.root, ''); // not under any rootDir
  });

  it('should deduplicate workspaces already found via rootDir scan', () => {
    const reposFromRootDirs: RepoEntry[] = [
      { name: 'repo-a', path: '/root/repo-a', root: '/root' },
    ];
    const configWorkspaces = ['/root/repo-a']; // same as scanned
    const rootDirs = ['/root'];

    const merged = mergeWorkspacesIntoRepos(
      reposFromRootDirs,
      configWorkspaces,
      rootDirs
    );
    assert.equal(merged.length, 1); // no duplicate
  });

  it('should handle empty rootDirs with workspaces-only config', () => {
    const reposFromRootDirs: RepoEntry[] = [];
    const configWorkspaces = ['/a/project', '/b/other-project'];
    const rootDirs: string[] = [];

    const merged = mergeWorkspacesIntoRepos(
      reposFromRootDirs,
      configWorkspaces,
      rootDirs
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0]!.path, '/a/project');
    assert.equal(merged[1]!.path, '/b/other-project');
  });

  it('should set root when workspace is under a rootDir', () => {
    const reposFromRootDirs: RepoEntry[] = [];
    const configWorkspaces = ['/root/special-repo'];
    const rootDirs = ['/root'];

    const merged = mergeWorkspacesIntoRepos(
      reposFromRootDirs,
      configWorkspaces,
      rootDirs
    );
    assert.equal(merged[0]!.root, '/root');
  });
});

describe('CLI worktree arg parsing', () => {
  it('should extract --yolo and leave other args intact', () => {
    const args = [
      'add',
      './.worktrees/my-feature',
      '-b',
      'my-feature',
      '--yolo',
    ];
    const hasYolo = args.includes('--yolo');
    const gitArgs = args.filter((a) => a !== '--yolo');
    assert.equal(hasYolo, true);
    assert.deepEqual(gitArgs, [
      'add',
      './.worktrees/my-feature',
      '-b',
      'my-feature',
    ]);
  });

  it('should detect missing path for add and use default', () => {
    // args: ['add', '-b', 'my-feature'] — no positional path (first arg after 'add' starts with '-')
    const args = ['add', '-b', 'my-feature'];
    const subArgs = args.slice(1); // after 'add'
    const hasPositionalPath =
      subArgs.length > 0 && !subArgs[0]!.startsWith('-');
    assert.equal(hasPositionalPath, false);
  });

  it('should detect path when provided for add', () => {
    const args = ['add', './my-path', '-b', 'my-feature'];
    const subArgs = args.slice(1);
    const hasPositionalPath =
      subArgs.length > 0 && !subArgs[0]!.startsWith('-');
    assert.equal(hasPositionalPath, true);
    assert.equal(subArgs[0], './my-path');
  });
});

describe('mountain name collision retry', () => {
  it('MOUNTAIN_NAMES is a non-empty array of strings', () => {
    assert.ok(
      Array.isArray(MOUNTAIN_NAMES),
      'MOUNTAIN_NAMES should be an array'
    );
    assert.ok(MOUNTAIN_NAMES.length > 0, 'MOUNTAIN_NAMES should not be empty');
    for (const name of MOUNTAIN_NAMES) {
      assert.equal(
        typeof name,
        'string',
        `each mountain name should be a string, got: ${typeof name}`
      );
      assert.ok(name.length > 0, 'each mountain name should be non-empty');
    }
  });

  it('MOUNTAIN_NAMES contains expected well-known peaks', () => {
    assert.ok(MOUNTAIN_NAMES.includes('everest'), 'should include everest');
    assert.ok(MOUNTAIN_NAMES.includes('k2'), 'should include k2');
    assert.ok(MOUNTAIN_NAMES.includes('fuji'), 'should include fuji');
  });

  it('collision retry logic skips taken names and selects the next available one', () => {
    // Simulate the collision retry loop from workspaces.ts
    // The first two names are "taken"; the third should be selected.
    const takenNames = new Set<string>([MOUNTAIN_NAMES[0], MOUNTAIN_NAMES[1]]);
    const baseIndex = 0;
    let selected: string | null = null;
    let selectedIndex = -1;

    for (let attempt = 0; attempt < MOUNTAIN_NAMES.length; attempt++) {
      const candidateIndex = (baseIndex + attempt) % MOUNTAIN_NAMES.length;
      const candidateName = MOUNTAIN_NAMES[candidateIndex]!;
      if (!takenNames.has(candidateName)) {
        selected = candidateName;
        selectedIndex = candidateIndex;
        break;
      }
    }

    assert.ok(selected !== null, 'should find an available name');
    assert.equal(
      selected,
      MOUNTAIN_NAMES[2],
      'should select the third name after skipping first two'
    );
    assert.equal(selectedIndex, 2);
  });

  it('collision retry wraps around when baseIndex is near the end', () => {
    // baseIndex near the end — should wrap around to the beginning
    const lastIndex = MOUNTAIN_NAMES.length - 1;
    const lastName = MOUNTAIN_NAMES[lastIndex]!;
    const takenNames = new Set<string>([lastName]);
    const baseIndex = lastIndex;
    let selected: string | null = null;

    for (let attempt = 0; attempt < MOUNTAIN_NAMES.length; attempt++) {
      const candidateIndex = (baseIndex + attempt) % MOUNTAIN_NAMES.length;
      const candidateName = MOUNTAIN_NAMES[candidateIndex]!;
      if (!takenNames.has(candidateName)) {
        selected = candidateName;
        break;
      }
    }

    assert.ok(
      selected !== null,
      'should find an available name after wrap-around'
    );
    // The first candidate tried was lastIndex (taken), so the next is index 0
    assert.equal(
      selected,
      MOUNTAIN_NAMES[0],
      'should wrap around to the first name'
    );
  });

  it('nextMountainIndex advances to the candidate after the selected one', () => {
    // After selecting candidateIndex N, nextMountainIndex should be N+1
    const baseIndex = 0;
    const takenNames = new Set<string>();
    let nextMountainIndex: number | undefined;

    for (let attempt = 0; attempt < MOUNTAIN_NAMES.length; attempt++) {
      const candidateIndex = (baseIndex + attempt) % MOUNTAIN_NAMES.length;
      const candidateName = MOUNTAIN_NAMES[candidateIndex]!;
      if (!takenNames.has(candidateName)) {
        nextMountainIndex = candidateIndex + 1;
        break;
      }
    }

    assert.equal(
      nextMountainIndex,
      1,
      'nextMountainIndex should be 1 after selecting index 0'
    );
  });

  it('all mountain names are unique', () => {
    const unique = new Set(MOUNTAIN_NAMES);
    assert.equal(
      unique.size,
      MOUNTAIN_NAMES.length,
      'all mountain names should be unique'
    );
  });

  it('mountain names contain only lowercase letters, digits, and hyphens', () => {
    for (const name of MOUNTAIN_NAMES) {
      assert.ok(
        /^[a-z0-9-]+$/.test(name),
        `mountain name "${name}" should only contain lowercase letters, digits, and hyphens`
      );
    }
  });
});

describe('workspace name from git remote', () => {
  it('derives repo name from various git remote URLs', async () => {
    const { repoNameFromRemoteUrl } = await import('../server/workspaces.js');

    const fixtures: Array<{ url: string; expected: string }> = [
      {
        url: 'git@github.com:anthropic/claude-remote-cli.git',
        expected: 'claude-remote-cli',
      },
      {
        url: 'https://github.com/anthropic/claude-remote-cli.git',
        expected: 'claude-remote-cli',
      },
      {
        url: 'ssh://git@github.com/anthropic/claude-remote-cli.git',
        expected: 'claude-remote-cli',
      },
      {
        url: 'https://github.com/anthropic/claude-remote-cli',
        expected: 'claude-remote-cli',
      },
      {
        url: 'https://example.com/some-group/another-repo.git',
        expected: 'another-repo',
      },
      {
        url: 'https://example.com/some-group/another-repo/',
        expected: 'another-repo',
      },
    ];

    for (const { url, expected } of fixtures) {
      const name = repoNameFromRemoteUrl(url);
      assert.equal(
        name,
        expected,
        `should extract "${expected}" from "${url}"`
      );
      assert.ok(
        name && name.length > 0,
        `should extract a non-empty name from "${url}"`
      );
      assert.ok(
        name && !name.includes('/'),
        `name "${name}" from "${url}" should not contain slashes`
      );
    }
  });
});

describe('repo-scoped tmux naming', () => {
  it('produces readable tmux names from repo-branch slugs', () => {
    const name = generateTmuxSessionName(
      'claude-remote-cli-nightly',
      'a3b4c5d6-1234-5678'
    );
    assert.ok(name.includes('claude-remote-cli-nightly'));
    assert.ok(name.includes('a3b4c5d6'));
  });

  it('sanitizes branch names with special characters', () => {
    const name = generateTmuxSessionName(
      'myapp-fix-auth-flow',
      'b4c5d6e7-1234-5678'
    );
    assert.ok(name.includes('myapp-fix-auth-flow'));
    assert.ok(!/[^a-zA-Z0-9-]/.test(name));
  });

  it('truncates long names to 30 chars before appending id', () => {
    const longName = 'a-very-long-repository-name-with-a-very-long-branch-name';
    const name = generateTmuxSessionName(longName, 'c5d6e7f8-1234-5678');
    // Extract the sanitized middle portion: after "crc-" prefix and before "-{8-char-id}"
    const prefix = name
      .replace(/^(?:crcd?-)/, '')
      .replace(/-[a-zA-Z0-9]{8}$/, '');
    assert.ok(
      prefix.length <= 30,
      `prefix "${prefix}" (${prefix.length} chars) exceeds 30 chars`
    );
  });

  it('produces no special characters in output', () => {
    const name = generateTmuxSessionName(
      'repo/with/slashes and spaces',
      'deadbeef-0000-1111'
    );
    assert.ok(
      !/[^a-zA-Z0-9-]/.test(name),
      `tmux name "${name}" contains invalid characters`
    );
  });
});

describe('findOrCreateWorktreeForBranch', () => {
  it('returns existing: true and isMain: true when branch is in main worktree', async () => {
    const repoPath = '/Users/me/code/my-repo';
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/nightly',
      '',
    ].join('\n');

    const exec = async (
      _cmd: string,
      args: string[],
      _opts: { cwd: string; timeout?: number }
    ) => {
      if (args[0] === 'worktree') return { stdout, stderr: '' };
      throw new Error('unexpected call');
    };

    const result = await findOrCreateWorktreeForBranch(
      repoPath,
      'nightly',
      exec
    );
    assert.equal(result.existing, true);
    assert.equal(result.isMain, true);
    assert.equal(result.worktreePath, repoPath);
    assert.equal(result.branchName, 'nightly');
  });

  it('returns existing worktree when branch is in a sub-worktree', async () => {
    const repoPath = '/Users/me/code/my-repo';
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/code/my-repo/.worktrees/fix-auth',
      'HEAD def456',
      'branch refs/heads/fix/auth',
      '',
    ].join('\n');

    const exec = async (
      _cmd: string,
      args: string[],
      _opts: { cwd: string; timeout?: number }
    ) => {
      if (args[0] === 'worktree') return { stdout, stderr: '' };
      throw new Error('unexpected call');
    };

    const result = await findOrCreateWorktreeForBranch(
      repoPath,
      'fix/auth',
      exec
    );
    assert.equal(result.existing, true);
    assert.equal(result.isMain, false);
    assert.equal(
      result.worktreePath,
      '/Users/me/code/my-repo/.worktrees/fix-auth'
    );
  });

  it('creates worktree when branch is not checked out anywhere', async () => {
    const repoPath = '/Users/me/code/my-repo';
    const listStdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const calls: string[][] = [];
    const exec = async (
      _cmd: string,
      args: string[],
      _opts: { cwd: string; timeout?: number }
    ) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list')
        return { stdout: listStdout, stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add')
        return { stdout: '', stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await findOrCreateWorktreeForBranch(
      repoPath,
      'feat/new',
      exec
    );
    assert.equal(result.existing, false);
    assert.equal(result.isMain, false);
    assert.equal(result.branchName, 'feat/new');
  });
});
