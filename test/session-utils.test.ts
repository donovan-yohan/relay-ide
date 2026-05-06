import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../frontend/src/lib/types.js';

const apiMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorktrees: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchWorkspaceGroups: vi.fn(),
  enrichBranches: vi.fn(),
}));

vi.mock('../frontend/src/lib/api.js', () => ({
  ConflictError: class ConflictError extends Error {
    sessionId: string;
    constructor(sessionId: string) {
      super('conflict');
      this.sessionId = sessionId;
    }
  },
  createSession: apiMocks.createSession,
  fetchSessions: apiMocks.fetchSessions,
  fetchWorktrees: apiMocks.fetchWorktrees,
  fetchWorkspaces: apiMocks.fetchWorkspaces,
  fetchWorkspaceGroups: apiMocks.fetchWorkspaceGroups,
  enrichBranches: apiMocks.enrichBranches,
}));

const storage: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
  },
  configurable: true,
});

import { ConflictError } from '../frontend/src/lib/api.js';
import { createSessionWithoutActivation } from '../frontend/src/lib/session-utils.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';

const originalRefreshAll = useSessionsStore.getState().refreshAll;

function session(id: string, type: 'agent' | 'terminal' = 'terminal'): SessionSummary {
  return {
    id,
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
    type,
    mode: 'pty',
    useTmux: true,
  };
}

describe('createSessionWithoutActivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(storage)) delete storage[key];
    useSessionsStore.setState({
      sessions: [session('main', 'agent')],
      worktrees: [],
      repos: [{ name: 'a', path: '/repo/a', isGitRepo: true, defaultBranch: 'nightly', currentBranch: 'nightly' }],
      workspaceGroups: [],
      activeSessionId: 'main',
      workspaceLastSession: { '/repo/a': 'main' },
      notificationSessions: {},
      sidebarItems: [],
      refreshAll: originalRefreshAll,
    });
    apiMocks.fetchWorktrees.mockResolvedValue([]);
    apiMocks.fetchWorkspaces.mockResolvedValue([
      { name: 'a', path: '/repo/a', isGitRepo: true, defaultBranch: 'nightly', currentBranch: 'nightly' },
    ]);
    apiMocks.fetchWorkspaceGroups.mockResolvedValue([]);
  });

  it('creates and refreshes a terminal session without changing active or recalled workspace session', async () => {
    const created = session('utility');
    apiMocks.createSession.mockResolvedValue(created);
    apiMocks.fetchSessions.mockResolvedValue([session('main', 'agent'), created]);

    const result = await createSessionWithoutActivation({
      repoPath: '/repo/a',
      worktreePath: null,
      type: 'terminal',
    });

    expect(result.session?.id).toBe('utility');
    expect(apiMocks.createSession).toHaveBeenCalledWith({
      repoPath: '/repo/a',
      worktreePath: null,
      type: 'terminal',
    });
    expect(useSessionsStore.getState().activeSessionId).toBe('main');
    expect(useSessionsStore.getState().workspaceLastSession['/repo/a']).toBe('main');
    expect(storage['claude-remote-active-session']).toBe(undefined);
  });

  it('returns the created session and restores placement when refresh fails after create', async () => {
    const created = session('utility');
    const refreshError = new Error('refresh failed');
    apiMocks.createSession.mockResolvedValue(created);
    useSessionsStore.setState({
      refreshAll: vi.fn().mockRejectedValue(refreshError),
    });

    const result = await createSessionWithoutActivation({
      repoPath: '/repo/a',
      type: 'terminal',
    });

    expect(result.session).toBe(created);
    expect(result.error).toBe(refreshError);
    expect(useSessionsStore.getState().activeSessionId).toBe('main');
    expect(useSessionsStore.getState().workspaceLastSession['/repo/a']).toBe('main');
  });

  it('returns the conflicting session and ConflictError when refresh succeeds', async () => {
    const conflict = new ConflictError('main');
    apiMocks.createSession.mockRejectedValue(conflict);
    apiMocks.fetchSessions.mockResolvedValue([session('main', 'agent')]);

    const result = await createSessionWithoutActivation({
      repoPath: '/repo/a',
      type: 'terminal',
    });

    expect(result.session?.id).toBe('main');
    expect(result.error).toBe(conflict);
    expect(useSessionsStore.getState().activeSessionId).toBe('main');
    expect(useSessionsStore.getState().workspaceLastSession['/repo/a']).toBe('main');
  });

  it('returns the conflicting session plus refresh error when conflict refresh fails', async () => {
    const conflict = new ConflictError('main');
    const refreshError = new Error('refresh failed');
    apiMocks.createSession.mockRejectedValue(conflict);
    useSessionsStore.setState({
      refreshAll: vi.fn().mockRejectedValue(refreshError),
    });

    const result = await createSessionWithoutActivation({
      repoPath: '/repo/a',
      type: 'terminal',
    });

    expect(result.session?.id).toBe('main');
    expect(result.error).toBe(refreshError);
    expect(useSessionsStore.getState().activeSessionId).toBe('main');
    expect(useSessionsStore.getState().workspaceLastSession['/repo/a']).toBe('main');
  });

  it('returns generic create errors without refreshing', async () => {
    const createError = new Error('create failed');
    const refreshAll = vi.fn();
    apiMocks.createSession.mockRejectedValue(createError);
    useSessionsStore.setState({ refreshAll });

    const result = await createSessionWithoutActivation({
      repoPath: '/repo/a',
      type: 'terminal',
    });

    expect(result).toEqual({ session: undefined, error: createError });
    expect(refreshAll).not.toHaveBeenCalled();
  });
});
