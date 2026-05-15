import { describe, expect, it } from 'vitest';
import { deriveUtilityRailContext } from '../frontend/src/lib/utility-rail-context.js';
import type { Repo, SessionSummary } from '../frontend/src/lib/types.js';

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    path: '/hub/repo',
    name: 'repo',
    isGitRepo: true,
    defaultBranch: 'nightly',
    currentBranch: 'feature',
    ...overrides,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    type: 'agent',
    agent: 'claude',
    repoName: 'repo',
    repoPath: '/hub/repo',
    worktreePath: null,
    cwd: '/hub/repo',
    branchName: 'feature',
    displayName: 'repo',
    createdAt: '2026-05-14T00:00:00.000Z',
    lastActivity: '2026-05-14T00:00:00.000Z',
    idle: false,
    ...overrides,
  };
}

describe('deriveUtilityRailContext', () => {
  it('keeps local repo/worktree tabs keyed and fetched by their active cwd', () => {
    const context = deriveUtilityRailContext({
      activeRepoPath: '/hub/repo',
      activeWorkspace: repo(),
      activeSession: session({ worktreePath: '/hub/repo/.worktrees/feature', cwd: '/hub/repo/.worktrees/feature' }),
    });

    expect(context.stateKey).toBe('/hub/repo/.worktrees/feature');
    expect(context.displayWorkspacePath).toBe('/hub/repo/.worktrees/feature');
    expect(context.files.workspacePath).toBe('/hub/repo/.worktrees/feature');
    expect(context.git.workspacePath).toBe('/hub/repo/.worktrees/feature');
    expect(context.files.disabledReason).toBeNull();
    expect(context.git.disabledReason).toBeNull();
  });

  it('does not expose hub-local repo paths to file or git widgets for a remote active tab', () => {
    const context = deriveUtilityRailContext({
      activeRepoPath: '/hub/repo',
      activeWorkspace: repo(),
      activeSession: session({
        id: 'remote-1',
        nodeId: 'linux-box',
        repoPath: undefined,
        worktreePath: null,
        cwd: '/home/me/repo',
      }),
    });

    expect(context.stateKey).toBe('node:linux-box:/home/me/repo');
    expect(context.displayWorkspacePath).toBe('/home/me/repo');
    expect(context.files.workspacePath).toBe('');
    expect(context.git.workspacePath).toBe('');
    expect(context.files.disabledReason).toBe('remote-files-unavailable');
    expect(context.git.disabledReason).toBe('remote-git-unavailable');
  });

  it('distinguishes the same remote cwd on different nodes', () => {
    const a = deriveUtilityRailContext({
      activeRepoPath: '/hub/repo',
      activeWorkspace: repo(),
      activeSession: session({ nodeId: 'node-a', repoPath: undefined, cwd: '/src/repo' }),
    });
    const b = deriveUtilityRailContext({
      activeRepoPath: '/hub/repo',
      activeWorkspace: repo(),
      activeSession: session({ nodeId: 'node-b', repoPath: undefined, cwd: '/src/repo' }),
    });

    expect(a.stateKey).toBe('node:node-a:/src/repo');
    expect(b.stateKey).toBe('node:node-b:/src/repo');
    expect(a.stateKey).not.toBe(b.stateKey);
  });

  it('uses the free local cwd for files but disables git widgets without errors', () => {
    const context = deriveUtilityRailContext({
      activeRepoPath: '/hub/repo',
      activeWorkspace: repo(),
      activeSession: session({
        id: 'free-1',
        repoPath: undefined,
        worktreePath: null,
        cwd: '/tmp/free-folder',
        branchName: undefined,
      }),
    });

    expect(context.stateKey).toBe('/tmp/free-folder');
    expect(context.displayWorkspacePath).toBe('/tmp/free-folder');
    expect(context.files.workspacePath).toBe('/tmp/free-folder');
    expect(context.files.disabledReason).toBeNull();
    expect(context.git.workspacePath).toBe('');
    expect(context.git.disabledReason).toBe('no-git-context');
  });

  it('treats selected non-git repos as file-browsable but not git-capable', () => {
    const context = deriveUtilityRailContext({
      activeRepoPath: '/folders/plain',
      activeWorkspace: repo({ path: '/folders/plain', isGitRepo: false, currentBranch: null, defaultBranch: null }),
      activeSession: undefined,
    });

    expect(context.stateKey).toBe('/folders/plain');
    expect(context.files.workspacePath).toBe('/folders/plain');
    expect(context.git.workspacePath).toBe('');
    expect(context.git.disabledReason).toBe('no-git-context');
  });
});
