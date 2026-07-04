import { describe, expect, it } from 'vitest';
import { resolveAppViewMode } from '../frontend/src/lib/state/app-view-mode.js';

describe('resolveAppViewMode', () => {
  it('routes the no-project/no-session landing path to the chat/topic spine', () => {
    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        activeRepoPath: null,
      })
    ).toBe('chat');
  });

  it('routes back to the WorkContext cockpit when forceOrgCockpit is set', () => {
    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        activeRepoPath: null,
        forceOrgCockpit: true,
      })
    ).toBe('org');
  });

  it('uses forceOrgCockpit as the only escape hatch back to the session cockpit', () => {
    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: true,
        activeRepoPath: null,
        forceOrgCockpit: true,
      })
    ).toBe('session');

    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        activeRepoPath: '/repo/relay-ide',
        forceOrgCockpit: true,
      })
    ).toBe('dashboard');
  });

  it('shows the topic composer over an active session/repo without clearing them (#1058)', () => {
    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: true,
        activeRepoPath: '/repo/relay-ide',
        topicComposerOpen: true,
      })
    ).toBe('chat');

    // analytics still wins — the composer flag only overrides session/repo.
    expect(
      resolveAppViewMode({
        analyticsView: 'dashboard',
        hasActiveSession: true,
        activeRepoPath: null,
        topicComposerOpen: true,
      })
    ).toBe('analytics');
  });

  it('keeps start/resume in the chat shell while preserving analytics and explicit repo dashboard priority', () => {
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
    ).toBe('chat');

    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: true,
        activeRepoPath: '/repo/relay-ide',
      })
    ).toBe('chat');

    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        activeRepoPath: '/repo/relay-ide',
      })
    ).toBe('dashboard');
  });
});
