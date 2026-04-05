import { describe, it, expect } from 'vitest';
import { groupDisplayName } from '../frontend/src/components/RepoItem.js';
import { makeSession } from './helpers/frontend-factories.js';

describe('groupDisplayName', () => {
  // ── Repo-root sessions ──────────────────────────────────────────────────

  it('repo-root session with displayName different from repoName uses displayName', () => {
    const session = makeSession({
      worktreePath: null,
      repoName: 'relay-ide',
      displayName: 'Fix sidebar disappearing on mobile',
    });
    expect(groupDisplayName('/repo', '/repo', [session])).toBe(
      'Fix sidebar disappearing on mobile'
    );
  });

  it('repo-root session with displayName matching repoName returns "default"', () => {
    const session = makeSession({
      worktreePath: null,
      repoName: 'relay-ide',
      displayName: 'relay-ide',
    });
    expect(groupDisplayName('/repo', '/repo', [session])).toBe('default');
  });

  // ── Worktree sessions ──────────────────────────────────────────────────

  it('worktree session uses displayName when it differs from repoName', () => {
    const session = makeSession({
      worktreePath: '/repo/wt1',
      repoName: 'relay-ide',
      displayName: 'Fix sidebar disappearing on mobile',
      branchName: 'fix-sidebar-disappearing-on-mobile',
      cwd: '/repo/wt1',
    });
    expect(groupDisplayName('/repo/wt1', '/repo', [session])).toBe(
      'Fix sidebar disappearing on mobile'
    );
  });

  it('worktree session falls back to branchName when displayName matches repoName', () => {
    const session = makeSession({
      worktreePath: '/repo/wt1',
      repoName: 'relay-ide',
      displayName: 'relay-ide',
      branchName: 'fix-sidebar-bug',
      cwd: '/repo/wt1',
    });
    expect(groupDisplayName('/repo/wt1', '/repo', [session])).toBe(
      'fix-sidebar-bug'
    );
  });

  it('worktree session falls back to branchName when displayName is empty', () => {
    const session = makeSession({
      worktreePath: '/repo/wt1',
      repoName: 'relay-ide',
      displayName: '',
      branchName: 'fix-sidebar-bug',
      cwd: '/repo/wt1',
    });
    expect(groupDisplayName('/repo/wt1', '/repo', [session])).toBe(
      'fix-sidebar-bug'
    );
  });

  it('worktree session falls back to cwd basename when no branchName', () => {
    const session = makeSession({
      worktreePath: '/repo/wt1',
      repoName: 'relay-ide',
      displayName: 'relay-ide',
      branchName: '',
      cwd: '/repo/wt1',
    });
    expect(groupDisplayName('/repo/wt1', '/repo', [session])).toBe('wt1');
  });
});
