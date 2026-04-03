import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSidebarItems } from '../frontend/src/lib/state/sidebar-items.js';
import type {
  SessionSummary,
  WorktreeInfo,
  Repo,
  SidebarItem,
} from '../frontend/src/lib/types.js';

// ─── Minimal mock helpers ────────────────────────────────────────────────────

function makeSession(
  overrides: Partial<SessionSummary> & { id: string; repoPath: string }
): SessionSummary {
  return {
    type: 'agent',
    agent: 'claude',
    repoName: 'repo',
    worktreePath: null,
    cwd: overrides.repoPath,
    branchName: 'main',
    displayName: 'repo',
    createdAt: '2026-01-01T00:00:00Z',
    lastActivity: '2026-01-01T00:00:00Z',
    idle: true,
    agentState: 'idle',
    ...overrides,
  };
}

function makeWorktree(
  overrides: Partial<WorktreeInfo> & { path: string; repoPath: string }
): WorktreeInfo {
  return {
    name: 'worktree',
    repoName: 'repo',
    displayName: 'worktree',
    lastActivity: '2026-01-01T00:00:00Z',
    branchName: 'feature',
    ...overrides,
  };
}

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
    const session = makeSession({ id: 's1', repoPath: '/repo' });
    const items = buildSidebarItems([session], [], [], []);

    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.sessions.length, 1);
    assert.notEqual(item.displayState, 'inactive');
  });

  it('inactive worktree (no sessions) produces SidebarItem with inactive state', () => {
    const worktree = makeWorktree({ path: '/repo/wt1', repoPath: '/repo' });
    const workspace = makeWorkspace({ path: '/repo' });
    const items = buildSidebarItems([], [worktree], [workspace], []);

    const wtItem = items.find((i) => i.id === '/repo/wt1');
    assert.ok(wtItem, 'expected a SidebarItem for the worktree');
    assert.equal(wtItem.displayState, 'inactive');
    assert.equal(wtItem.sessions.length, 0);
  });

  it('workspace with no sessions produces repo-kind item with inactive state', () => {
    const workspace = makeWorkspace({ path: '/repo' });
    const items = buildSidebarItems([], [], [workspace], []);

    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.kind, 'repo');
    assert.equal(item.displayState, 'inactive');
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
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0]!.sessions.length, 2);
  });

  it('workspace defaultBranch is used as branchName for inactive repo root', () => {
    const workspace = makeWorkspace({
      path: '/repo',
      defaultBranch: 'feature-x',
      currentBranch: null,
    });
    const items = buildSidebarItems([], [], [workspace], []);

    assert.equal(items.length, 1);
    assert.equal(items[0]!.branchName, 'feature-x');
  });

  it('reconciliation: seen-idle preserved when backend state unchanged', () => {
    const session = makeSession({
      id: 's1',
      repoPath: '/repo',
      idle: true,
      agentState: 'idle',
    });
    const existing = makeItem({
      id: '/repo',
      kind: 'repo',
      displayState: 'seen-idle',
      lastKnownBackendState: 'idle',
    });
    const items = buildSidebarItems([session], [], [], [existing]);

    const item = items.find((i) => i.id === '/repo');
    assert.ok(item);
    assert.equal(item.displayState, 'seen-idle');
  });

  it('reconciliation: running→idle backend change transitions displayState to unseen-idle', () => {
    const session = makeSession({
      id: 's1',
      repoPath: '/repo',
      idle: true,
      agentState: 'idle',
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
    assert.ok(item);
    assert.equal(item.displayState, 'unseen-idle');
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
    assert.ok(item);
    assert.equal(item.displayState, 'inactive');
    assert.equal(item.sessions.length, 0);
  });
});
