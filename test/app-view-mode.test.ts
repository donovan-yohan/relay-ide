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

  it('preserves analytics and explicit repo dashboard priority', () => {
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
        hasActiveSession: false,
        activeRepoPath: '/repo/relay-ide',
      })
    ).toBe('dashboard');
  });

  it('keeps an open channel ahead of forceOrgCockpit, so cockpit escape hatches must clear the channel (#1287)', () => {
    // The flag alone cannot escape a channel — any surface that latches
    // forceOrgCockpit without clearing activeChannelId is a silent no-op that
    // fires later as a surprise navigation when the channel is closed.
    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        activeRepoPath: null,
        hasActiveChannel: true,
        forceOrgCockpit: true,
      })
    ).toBe('chat');

    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: true,
        activeRepoPath: '/repo/relay-ide',
        hasActiveChannel: true,
        forceOrgCockpit: true,
      })
    ).toBe('chat');

    // Clearing the channel (what the escape hatches now do) reaches the cockpit.
    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: false,
        activeRepoPath: null,
        hasActiveChannel: false,
        forceOrgCockpit: true,
      })
    ).toBe('org');
  });

  it('routes an active PTY agent/terminal session to the terminal view (#1058)', () => {
    // A live PTY session (Claude/Codex/Hermes TUI) must surface its terminal.
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
        hasActiveSession: true,
        activeRepoPath: '/repo/relay-ide',
      })
    ).toBe('session');

    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: true,
        activeRepoPath: null,
      })
    ).toBe('session');

    // The topic composer overlay still wins over a live PTY session.
    expect(
      resolveAppViewMode({
        analyticsView: null,
        hasActiveSession: true,
        activeRepoPath: null,
        topicComposerOpen: true,
      })
    ).toBe('chat');
  });
});
