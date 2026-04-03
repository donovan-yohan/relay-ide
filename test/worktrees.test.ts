import { describe, it, expect } from 'vitest';
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
    expect(WORKTREE_DIRS).toEqual(['.worktrees', '.claude/worktrees']);
  });
});

describe('isValidWorktreePath', () => {
  it('should reject paths not inside any worktree directory', () => {
    expect(isValidWorktreePath('/some/random/path')).toBe(false);
  });

  it('should accept paths inside .worktrees/', () => {
    expect(
      isValidWorktreePath('/Users/me/code/repo/.worktrees/my-worktree')
    ).toBe(true);
  });

  it('should accept paths inside .claude/worktrees/', () => {
    expect(
      isValidWorktreePath('/Users/me/code/repo/.claude/worktrees/my-worktree')
    ).toBe(true);
  });

  it('should not match partial .worktrees paths', () => {
    expect(isValidWorktreePath('/Users/me/.worktrees-fake/foo')).toBe(false);
  });
});

describe('branch name to directory name', () => {
  it('should replace slashes with dashes', () => {
    const branchName = 'dy/feat/my-feature';
    const dirName = branchName.replace(/\//g, '-');
    expect(dirName).toBe('dy-feat-my-feature');
  });

  it('should leave flat branch names unchanged', () => {
    const branchName = 'my-feature';
    const dirName = branchName.replace(/\//g, '-');
    expect(dirName).toBe('my-feature');
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
    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe(
      '/Users/me/code/my-repo/.worktrees/feat-branch'
    );
    expect(result[0]!.branch).toBe('feat/branch');
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
    expect(result.length).toBe(2);
    expect(result[0]!.path).toBe('/Users/me/code/my-repo/.worktrees/feat-a');
    expect(result[0]!.branch).toBe('feat/a');
    expect(result[1]!.path).toBe('/Users/me/other-path/extend-cli');
    expect(result[1]!.branch).toBe('dy/feat/worktree-isolation');
  });

  it('should skip the main worktree (repo root)', () => {
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const result = parseWorktreeListPorcelain(stdout, repoPath);
    expect(result.length).toBe(0);
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
    expect(result.length).toBe(0);
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
    expect(result.length).toBe(0);
  });

  it('should handle empty output', () => {
    const result = parseWorktreeListPorcelain('', repoPath);
    expect(result.length).toBe(0);
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
    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe('/completely/different/path/project-checkout');
    expect(result[0]!.branch).toBe('feature/my-feature');
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
    expect(result.length).toBe(1);
    expect(result[0]!.branch).toBe('dy/feat/deep/nesting/here');
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
    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe(repoPath);
    expect(result[0]!.branch).toBe('main');
    expect(result[0]!.isMain).toBe(true);
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
    expect(result.length).toBe(2);
    expect(result[0]!.isMain).toBe(true);
    expect(result[1]!.isMain).toBe(false);
    expect(result[1]!.path).toBe(
      '/Users/me/code/my-repo/.worktrees/feat-branch'
    );
    expect(result[1]!.branch).toBe('feat/branch');
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
    expect(result.length).toBe(1);
    expect(result[0]!.isMain).toBe(true);
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
    expect(result.length).toBe(2);
    expect(result[1]!.branch).toBe('');
  });

  it('should handle empty output', () => {
    const result = parseAllWorktrees('', repoPath);
    expect(result.length).toBe(0);
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
    expect(match).toBeTruthy();
    expect(match!.path).toBe(repoPath);
    expect(match!.isMain).toBe(true);
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
    expect(merged.length).toBe(2);
    expect(merged[1]!.path).toBe('/other/path/my-project');
    expect(merged[1]!.name).toBe('my-project');
    expect(merged[1]!.root).toBe(''); // not under any rootDir
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
    expect(merged.length).toBe(1); // no duplicate
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
    expect(merged.length).toBe(2);
    expect(merged[0]!.path).toBe('/a/project');
    expect(merged[1]!.path).toBe('/b/other-project');
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
    expect(merged[0]!.root).toBe('/root');
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
    expect(hasYolo).toBe(true);
    expect(gitArgs).toEqual([
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
    expect(hasPositionalPath).toBe(false);
  });

  it('should detect path when provided for add', () => {
    const args = ['add', './my-path', '-b', 'my-feature'];
    const subArgs = args.slice(1);
    const hasPositionalPath =
      subArgs.length > 0 && !subArgs[0]!.startsWith('-');
    expect(hasPositionalPath).toBe(true);
    expect(subArgs[0]).toBe('./my-path');
  });
});

describe('mountain name collision retry', () => {
  it('MOUNTAIN_NAMES is a non-empty array of strings', () => {
    expect(Array.isArray(MOUNTAIN_NAMES)).toBeTruthy();
    expect(MOUNTAIN_NAMES.length > 0).toBeTruthy();
    for (const name of MOUNTAIN_NAMES) {
      expect(typeof name).toBe('string');
      expect(name.length > 0).toBeTruthy();
    }
  });

  it('MOUNTAIN_NAMES contains expected well-known peaks', () => {
    expect(MOUNTAIN_NAMES.includes('everest')).toBeTruthy();
    expect(MOUNTAIN_NAMES.includes('k2')).toBeTruthy();
    expect(MOUNTAIN_NAMES.includes('fuji')).toBeTruthy();
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

    expect(selected !== null).toBeTruthy();
    expect(selected).toBe(MOUNTAIN_NAMES[2]);
    expect(selectedIndex).toBe(2);
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

    expect(selected !== null).toBeTruthy();
    // The first candidate tried was lastIndex (taken), so the next is index 0
    expect(selected).toBe(MOUNTAIN_NAMES[0]);
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

    expect(nextMountainIndex).toBe(1);
  });

  it('all mountain names are unique', () => {
    const unique = new Set(MOUNTAIN_NAMES);
    expect(unique.size).toBe(MOUNTAIN_NAMES.length);
  });

  it('mountain names contain only lowercase letters, digits, and hyphens', () => {
    for (const name of MOUNTAIN_NAMES) {
      expect(/^[a-z0-9-]+$/.test(name)).toBeTruthy();
    }
  });
});

describe('workspace name from git remote', () => {
  it('derives repo name from various git remote URLs', async () => {
    const { repoNameFromRemoteUrl } = await import('../server/workspaces.js');

    const fixtures: Array<{ url: string; expected: string }> = [
      {
        url: 'git@github.com:anthropic/relay-ide.git',
        expected: 'relay-ide',
      },
      {
        url: 'https://github.com/anthropic/relay-ide.git',
        expected: 'relay-ide',
      },
      {
        url: 'ssh://git@github.com/anthropic/relay-ide.git',
        expected: 'relay-ide',
      },
      {
        url: 'https://github.com/anthropic/relay-ide',
        expected: 'relay-ide',
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
      expect(name).toBe(expected);
      expect(name && name.length > 0).toBeTruthy();
      expect(name && !name.includes('/')).toBeTruthy();
    }
  });
});

describe('repo-scoped tmux naming', () => {
  it('produces readable tmux names from repo-branch slugs', () => {
    const name = generateTmuxSessionName(
      'relay-ide-nightly',
      'a3b4c5d6-1234-5678'
    );
    expect(name.includes('relay-ide-nightly')).toBeTruthy();
    expect(name.includes('a3b4c5d6')).toBeTruthy();
  });

  it('sanitizes branch names with special characters', () => {
    const name = generateTmuxSessionName(
      'myapp-fix-auth-flow',
      'b4c5d6e7-1234-5678'
    );
    expect(name.includes('myapp-fix-auth-flow')).toBeTruthy();
    expect(!/[^a-zA-Z0-9-]/.test(name)).toBeTruthy();
  });

  it('truncates long names to 30 chars before appending id', () => {
    const longName = 'a-very-long-repository-name-with-a-very-long-branch-name';
    const name = generateTmuxSessionName(longName, 'c5d6e7f8-1234-5678');
    // Extract the sanitized middle portion: after "crc-" prefix and before "-{8-char-id}"
    const prefix = name
      .replace(/^(?:crcd?-)/, '')
      .replace(/-[a-zA-Z0-9]{8}$/, '');
    expect(prefix.length <= 30).toBeTruthy();
  });

  it('produces no special characters in output', () => {
    const name = generateTmuxSessionName(
      'repo/with/slashes and spaces',
      'deadbeef-0000-1111'
    );
    expect(!/[^a-zA-Z0-9-]/.test(name)).toBeTruthy();
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
    expect(result.existing).toBe(true);
    expect(result.isMain).toBe(true);
    expect(result.worktreePath).toBe(repoPath);
    expect(result.branchName).toBe('nightly');
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
    expect(result.existing).toBe(true);
    expect(result.isMain).toBe(false);
    expect(result.worktreePath).toBe(
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
    expect(result.existing).toBe(false);
    expect(result.isMain).toBe(false);
    expect(result.branchName).toBe('feat/new');
  });
});
