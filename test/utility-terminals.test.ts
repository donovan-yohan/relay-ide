import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../frontend/src/lib/types.js';
import {
  getMainWorkspaceSessions,
  getUtilityTerminalSessions,
  getUtilityTerminalTitle,
} from '../frontend/src/lib/utility-terminals.js';

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    id: overrides.id,
    repoName: 'a',
    repoPath: '/repo/a',
    worktreePath: null,
    cwd: '/repo/a',
    status: 'active',
    createdAt: '2026-05-05T00:00:00.000Z',
    lastActivity: '2026-05-05T00:00:00.000Z',
    branchName: 'nightly',
    displayName: '',
    idle: false,
    agent: 'claude',
    type: 'terminal',
    mode: 'pty',
    useTmux: true,
    ...overrides,
  };
}

describe('utility terminal placement helpers', () => {
  it('keeps utility-owned terminal sessions out of main workspace sessions in persisted order', () => {
    const sessions = [
      session({ id: 'agent-1', type: 'agent' }),
      session({ id: 'term-1' }),
      session({ id: 'term-2' }),
      session({ id: 'term-other-cwd', cwd: '/repo/a/.worktrees/other' }),
    ];

    expect(getMainWorkspaceSessions(sessions, ['term-2', 'term-1']).map((s) => s.id)).toEqual([
      'agent-1',
      'term-other-cwd',
    ]);
    expect(getUtilityTerminalSessions(sessions, ['term-2', 'term-1']).map((s) => s.id)).toEqual([
      'term-2',
      'term-1',
    ]);
  });

  it('treats promotion as an exclusive move back to main workspace sessions', () => {
    const sessions = [
      session({ id: 'agent-1', type: 'agent' }),
      session({ id: 'term-1' }),
    ];

    expect(getUtilityTerminalSessions(sessions, ['term-1']).map((s) => s.id)).toEqual([
      'term-1',
    ]);
    expect(getMainWorkspaceSessions(sessions, ['term-1']).map((s) => s.id)).toEqual([
      'agent-1',
    ]);

    expect(getUtilityTerminalSessions(sessions, []).map((s) => s.id)).toEqual([]);
    expect(getMainWorkspaceSessions(sessions, []).map((s) => s.id)).toEqual([
      'agent-1',
      'term-1',
    ]);
  });

  it('does not claim non-terminal or missing stale utility ids', () => {
    const sessions = [
      session({ id: 'agent-1', type: 'agent' }),
      session({ id: 'term-1' }),
    ];

    expect(getUtilityTerminalSessions(sessions, ['missing', 'agent-1', 'term-1']).map((s) => s.id)).toEqual([
      'term-1',
    ]);
    expect(getMainWorkspaceSessions(sessions, ['missing', 'agent-1', 'term-1']).map((s) => s.id)).toEqual([
      'agent-1',
    ]);
  });

  it('uses display names first and deterministic lowercase fallback titles otherwise', () => {
    expect(
      getUtilityTerminalTitle(session({ id: 'renamed', displayName: 'db shell' }), 0, '/repo/a')
    ).toBe('db shell');
    expect(getUtilityTerminalTitle(session({ id: 'plain' }), 1, '/repo/a')).toBe(
      'terminal 2 · a'
    );
    expect(
      getUtilityTerminalTitle(session({ id: 'wt', cwd: '/repo/a/.worktrees/mountain' }), 0, '/repo/a')
    ).toBe('terminal 1 · mountain');
  });
});
