import { describe, it, expect } from 'vitest';
import { aggregateRepo } from '../frontend/src/hooks/useRepoAggregation.js';
import { highestPriorityState } from '../frontend/src/lib/state/attention.js';
import type { DisplayState } from '../frontend/src/lib/state/display-state.js';
import type { SidebarItem } from '../frontend/src/lib/types.js';

function makeItem(
  overrides: Partial<SidebarItem> & { displayState: DisplayState }
): SidebarItem {
  return {
    id: 'test',
    kind: 'worktree',
    path: '/repo/wt',
    repoPath: '/repo',
    displayName: 'test',
    branchName: 'main',
    lastActivity: new Date().toISOString(),
    lastKnownBackendState: null,
    sessions: [],
    ...overrides,
  };
}

describe('highestPriorityState', () => {
  it('returns null for empty array', () => {
    expect(highestPriorityState([])).toBeNull();
  });

  it('returns the only state in a single-item array', () => {
    expect(highestPriorityState(['running'])).toBe('running');
  });

  it('prioritizes permission > needs-answer > error > unseen-idle', () => {
    const states: DisplayState[] = [
      'unseen-idle',
      'error',
      'needs-answer',
      'permission',
      'running',
    ];
    expect(highestPriorityState(states)).toBe('permission');
  });

  it('prioritizes unseen-idle > running > initializing > seen-idle > inactive', () => {
    const states: DisplayState[] = [
      'inactive',
      'seen-idle',
      'initializing',
      'running',
      'unseen-idle',
    ];
    expect(highestPriorityState(states)).toBe('unseen-idle');
  });
});

describe('aggregateRepo', () => {
  it('filters items by repoPath', () => {
    const items: SidebarItem[] = [
      makeItem({ repoPath: '/repo1', displayState: 'permission' }),
      makeItem({ repoPath: '/repo2', displayState: 'running' }),
    ];
    const result = aggregateRepo('/repo1', items);
    expect(result.highestState).toBe('permission');
    expect(result.attentionCount).toBe(1);
  });

  it('counts attention states correctly', () => {
    const items: SidebarItem[] = [
      makeItem({ id: '1', displayState: 'permission' }),
      makeItem({ id: '2', path: '/repo/wt2', displayState: 'unseen-idle' }),
      makeItem({ id: '3', path: '/repo/wt3', displayState: 'running' }),
      makeItem({ id: '4', path: '/repo/wt4', displayState: 'error' }),
    ];
    const result = aggregateRepo('/repo', items);
    expect(result.attentionCount).toBe(3);
  });

  it('returns initializing state when items are loading', () => {
    const items: SidebarItem[] = [
      makeItem({ path: '/repo/wt1', displayState: 'inactive' }),
    ];
    const loadingItems = new Set(['/repo/wt1']);
    const result = aggregateRepo('/repo', items, loadingItems);
    expect(result.highestState).toBe('initializing');
    expect(result.attentionCount).toBe(0);
    expect(result.isLoading).toBe(true);
  });

  it('detects repo-scoped loading keys', () => {
    const items: SidebarItem[] = [
      makeItem({ path: '/repo/wt1', displayState: 'running' }),
    ];
    const loadingItems = new Set(['new-worktree:/repo']);
    const result = aggregateRepo('/repo', items, loadingItems);
    expect(result.highestState).toBe('initializing');
    expect(result.isLoading).toBe(true);
  });

  it('detects repo-session loading key', () => {
    const items: SidebarItem[] = [
      makeItem({ path: '/repo/wt1', displayState: 'running' }),
    ];
    const loadingItems = new Set(['repo-session:/repo']);
    const result = aggregateRepo('/repo', items, loadingItems);
    expect(result.highestState).toBe('initializing');
    expect(result.isLoading).toBe(true);
  });

  it('computes highest priority state for mixed states', () => {
    const items: SidebarItem[] = [
      makeItem({ id: '1', path: '/repo/wt1', displayState: 'running' }),
      makeItem({ id: '2', path: '/repo/wt2', displayState: 'permission' }),
      makeItem({ id: '3', path: '/repo/wt3', displayState: 'unseen-idle' }),
    ];
    const result = aggregateRepo('/repo', items);
    expect(result.highestState).toBe('permission');
    expect(result.attentionCount).toBe(2);
  });
});
