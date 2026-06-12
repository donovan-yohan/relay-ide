import { describe, expect, it } from 'vitest';
import { resolveAppViewMode } from '../frontend/src/lib/state/app-view-mode.js';

describe('resolveAppViewMode', () => {
  it('routes the no-project/no-session landing path to the WorkContext cockpit', () => {
    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        activeRepoPath: null,
      })
    ).toBe('org');
  });

  it('preserves session, analytics, and explicit repo dashboard priority', () => {
    expect(
      resolveAppViewMode({
        analyticsView: { sessionId: 'session-1' },
        hasActiveSession: false,
        activeRepoPath: null,
      })
    ).toBe('analytics');

    expect(
      resolveAppViewMode({
        analyticsView: 'dashboard',
        hasActiveSession: false,
        activeRepoPath: null,
      })
    ).toBe('analytics');

    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: true,
        activeRepoPath: null,
      })
    ).toBe('session');

    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        activeRepoPath: '/repo/relay-ide',
      })
    ).toBe('dashboard');
  });
});
