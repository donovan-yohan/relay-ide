import { describe, expect, it } from 'vitest';
import { resolveAppViewMode } from '../frontend/src/lib/state/app-view-mode.js';

describe('resolveAppViewMode', () => {
  it('keeps the no-project home on the add-project empty state by default', () => {
    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        reposLength: 0,
        activeRepoPath: null,
        isNodesTab: false,
      })
    ).toBe('empty');
  });

  it('routes a no-project Nodes request to the org dashboard instead of EmptyState', () => {
    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        reposLength: 0,
        activeRepoPath: null,
        isNodesTab: true,
      })
    ).toBe('org');
  });

  it('preserves session, analytics, and repo dashboard priority', () => {
    expect(
      resolveAppViewMode({
        analyticsView: { sessionId: 'session-1' },
        hasActiveSession: false,
        reposLength: 0,
        activeRepoPath: null,
        isNodesTab: true,
      })
    ).toBe('analytics');

    expect(
      resolveAppViewMode({
        analyticsView: 'dashboard',
        hasActiveSession: false,
        reposLength: 0,
        activeRepoPath: null,
        isNodesTab: true,
      })
    ).toBe('analytics');

    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: true,
        reposLength: 0,
        activeRepoPath: null,
        isNodesTab: true,
      })
    ).toBe('session');

    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        reposLength: 1,
        activeRepoPath: '/repo/relay-ide',
        isNodesTab: true,
      })
    ).toBe('dashboard');
  });
});
