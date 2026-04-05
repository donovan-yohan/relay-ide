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

  // ── Multi-session groups ─────────────────────────────────────────────

  it('multi-session group uses renamed session regardless of array order', () => {
    const unrenamed = makeSession({
      id: 's1',
      worktreePath: '/repo/wt1',
      repoName: 'relay-ide',
      displayName: 'relay-ide',
      branchName: 'fix-sidebar-bug',
      cwd: '/repo/wt1',
      lastActivity: '2026-04-05T12:00:00Z',
    });
    const renamed = makeSession({
      id: 's2',
      worktreePath: '/repo/wt1',
      repoName: 'relay-ide',
      displayName: 'Fix sidebar disappearing on mobile',
      branchName: 'fix-sidebar-bug',
      cwd: '/repo/wt1',
      lastActivity: '2026-04-05T11:00:00Z',
    });
    // Renamed session is second — should still be found
    expect(groupDisplayName('/repo/wt1', '/repo', [unrenamed, renamed])).toBe(
      'Fix sidebar disappearing on mobile'
    );
    // Reversed order — same result
    expect(groupDisplayName('/repo/wt1', '/repo', [renamed, unrenamed])).toBe(
      'Fix sidebar disappearing on mobile'
    );
  });

  it('multi-session group falls back to branchName when no session is renamed', () => {
    const s1 = makeSession({
      id: 's1',
      worktreePath: '/repo/wt1',
      repoName: 'relay-ide',
      displayName: 'relay-ide',
      branchName: 'fix-sidebar-bug',
      cwd: '/repo/wt1',
    });
    const s2 = makeSession({
      id: 's2',
      worktreePath: '/repo/wt1',
      repoName: 'relay-ide',
      displayName: '',
      branchName: 'fix-sidebar-bug',
      cwd: '/repo/wt1',
    });
    expect(groupDisplayName('/repo/wt1', '/repo', [s1, s2])).toBe(
      'fix-sidebar-bug'
    );
  });

  // ── Fallbacks ──────────────────────────────────────────────────────────

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
