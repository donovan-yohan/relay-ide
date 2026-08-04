import { describe, it, expect } from 'vitest';
import { buildSidebarItems } from '../frontend/src/lib/state/sidebar-items.js';
import type { Repo, SidebarItem } from '../frontend/src/lib/types.js';
import { makeSession, makeWorktree } from './helpers/frontend-factories.js';

function makeWorkspace(overrides: Partial<Repo> & { path: string }): Repo {
  return {
    name: overrides.path.split('/').at(-1) ?? 'workspace',
    isGitRepo: true,
    defaultBranch: 'main',
    currentBranch: 'main',
    ...overrides,
  };
}

function makeItem(
  overrides: Partial<SidebarItem> & { id: string }
): SidebarItem {
  return {
    kind: 'worktree',
    path: overrides.id,
    repoPath: '/repo',
    displayName: 'item',
    branchName: 'main',
    lastActivity: '2026-01-01T00:00:00Z',
    displayState: 'running',
    lastKnownBackendState: 'running',
    sessions: [],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('buildSidebarItems', () => {
  it('active session produces SidebarItem with that session', () => {
    const session = makeSession({
      id: 's1',
      repoPath: '/repo',
      worktreePath: null,
      cwd: '/repo',
    });
    const items = buildSidebarItems([session], [], [], []);

    expect(items.length).toBe(1);
    const item = items[0]!;
    expect(item.sessions.length).toBe(1);
    expect(item.displayState).not.toBe('inactive');
  });

  it('free session with omitted repo fields gets a stable sidebar item', () => {
    const {
      repoName: _repoName,
      repoPath: _repoPath,
      worktreePath: _worktreePath,
      branchName: _branchName,
      ...session
    } = makeSession({
      id: 'free-session',
      cwd: '/tmp/free-shell',
      displayName: 'free shell',
    });

    const items = buildSidebarItems([session], [], [], []);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'session:free-session',
      path: 'session:free-session',
      repoPath: '/tmp/free-shell',
      displayName: 'free shell',
      branchName: '',
      sessions: [session],
    });
  });

  it('inactive worktree (no sessions) produces SidebarItem with inactive state', () => {
    const worktree = makeWorktree({ path: '/repo/wt1', repoPath: '/repo' });
    const workspace = makeWorkspace({ path: '/repo' });
    const items = buildSidebarItems([], [worktree], [workspace], []);

    const wtItem = items.find((i) => i.id === '/repo/wt1');
    expect(wtItem).toBeTruthy();
    expect(wtItem.displayState).toBe('inactive');
    expect(wtItem.sessions.length).toBe(0);
  });

  it('workspace with no sessions produces repo-kind item with inactive state', () => {
    const workspace = makeWorkspace({ path: '/repo' });
    const items = buildSidebarItems([], [], [workspace], []);

    expect(items.length).toBe(1);
    const item = items[0]!;
    expect(item.kind).toBe('repo');
    expect(item.displayState).toBe('inactive');
  });

  it('two sessions with same worktreePath produce a single SidebarItem', () => {
    const s1 = makeSession({
      id: 's1',
      repoPath: '/repo',
      worktreePath: '/repo/wt1',
    });
    const s2 = makeSession({
      id: 's2',
      repoPath: '/repo',
      worktreePath: '/repo/wt1',
      branchName: 'feat',
    });
    const items = buildSidebarItems([s1, s2], [], [], []);

    const grouped = items.filter((i) => i.id === '/repo/wt1');
    expect(grouped.length).toBe(1);
    expect(grouped[0]!.sessions.length).toBe(2);
  });

  it('workspace defaultBranch is used as branchName for inactive repo root', () => {
    const workspace = makeWorkspace({
      path: '/repo',
      defaultBranch: 'feature-x',
      currentBranch: null,
    });
    const items = buildSidebarItems([], [], [workspace], []);

    expect(items.length).toBe(1);
    expect(items[0]!.branchName).toBe('feature-x');
  });

  it('reconciliation: seen-idle preserved when backend state unchanged', () => {
    const session = makeSession({
      id: 's1',
      repoPath: '/repo',
      worktreePath: null,
      cwd: '/repo',
      idle: true,
      activityState: 'idle',
    });
    const existing = makeItem({
      id: '/repo',
      kind: 'repo',
      displayState: 'seen-idle',
      lastKnownBackendState: 'idle',
    });
    const items = buildSidebarItems([session], [], [], [existing]);

    const item = items.find((i) => i.id === '/repo');
    expect(item).toBeTruthy();
    expect(item.displayState).toBe('seen-idle');
  });

  it('reconciliation: running→idle backend change transitions displayState to unseen-idle', () => {
    const session = makeSession({
      id: 's1',
      repoPath: '/repo',
      worktreePath: null,
      cwd: '/repo',
      idle: true,
      activityState: 'idle',
    });
    // Existing item thinks backend is running; new data says idle
    const existing = makeItem({
      id: '/repo',
      kind: 'repo',
      displayState: 'running',
      lastKnownBackendState: 'running',
    });
    const items = buildSidebarItems([session], [], [], [existing]);

    const item = items.find((i) => i.id === '/repo');
    expect(item).toBeTruthy();
    expect(item.displayState).toBe('unseen-idle');
  });

  it('reconciliation: item with sessions that disappears becomes inactive', () => {
    const existing = makeItem({
      id: '/repo/wt1',
      kind: 'worktree',
      displayState: 'running',
      lastKnownBackendState: 'running',
      sessions: [
        makeSession({ id: 's1', repoPath: '/repo', worktreePath: '/repo/wt1' }),
      ],
    });
    // No sessions in new data
    const workspace = makeWorkspace({ path: '/repo' });
    const worktree = makeWorktree({ path: '/repo/wt1', repoPath: '/repo' });
    const items = buildSidebarItems([], [worktree], [workspace], [existing]);

    const item = items.find((i) => i.id === '/repo/wt1');
    expect(item).toBeTruthy();
    expect(item.displayState).toBe('inactive');
    expect(item.sessions.length).toBe(0);
  });
});
