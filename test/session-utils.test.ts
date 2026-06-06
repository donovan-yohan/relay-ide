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

vi.mock('../frontend/src/lib/api.js', () => {
  class ConflictError extends Error {
    sessionId: string;
    constructor(sessionId: string) {
      super('conflict');
      this.sessionId = sessionId;
    }
  }

  class ConfirmationRequiredError extends Error {
    challenge: {
      reasonCode: string;
      challengeId: string;
      requiredBits: string[];
      expiresAt: string;
    };
    constructor() {
      super('confirmation required');
      this.challenge = {
        reasonCode: 'CONFIRMATION_REQUIRED',
        challengeId: 'challenge-1',
        requiredBits: [],
        expiresAt: '2026-05-05T00:00:00.000Z',
      };
    }
  }

  class HttpError extends Error {
    status: number;
    code?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
    constructor(
      status: number,
      message: string,
      code?: string,
      retryable?: boolean,
      details?: Record<string, unknown>
    ) {
      super(message);
      this.status = status;
      if (code !== undefined) this.code = code;
      if (retryable !== undefined) this.retryable = retryable;
      if (details !== undefined) this.details = details;
    }
  }

  return {
    ConflictError,
    ConfirmationRequiredError,
    HttpError,
    createSession: apiMocks.createSession,
    fetchSessions: apiMocks.fetchSessions,
    fetchWorktrees: apiMocks.fetchWorktrees,
    fetchWorkspaces: apiMocks.fetchWorkspaces,
    fetchWorkspaceGroups: apiMocks.fetchWorkspaceGroups,
    enrichBranches: apiMocks.enrichBranches,
  };
});

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

import { ConflictError, HttpError } from '../frontend/src/lib/api.js';
import {
  createAgentSession,
  createSessionWithoutActivation,
} from '../frontend/src/lib/session-utils.js';
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

  it('returns the conflicting session and stable ConflictError envelope when refresh succeeds', async () => {
    const conflict = new ConflictError('main');
    apiMocks.createSession.mockRejectedValue(conflict);
    apiMocks.fetchSessions.mockResolvedValue([session('main', 'agent')]);

    const result = await createSessionWithoutActivation({
      repoPath: '/repo/a',
      type: 'terminal',
    });

    expect(result.session?.id).toBe('main');
    expect(result.error).toMatchObject({
      code: 'SESSION_CONFLICT',
      message: 'session already exists for this launch target',
      retryable: false,
      details: { sessionId: 'main' },
    });
    expect(useSessionsStore.getState().activeSessionId).toBe('main');
    expect(useSessionsStore.getState().workspaceLastSession['/repo/a']).toBe('main');
  });

  it('returns the conflicting session from stable error details', async () => {
    const conflict = new HttpError(
      409,
      'session already exists',
      'SESSION_CONFLICT',
      false,
      { sessionId: 'main' }
    );
    apiMocks.createSession.mockRejectedValue(conflict);
    apiMocks.fetchSessions.mockResolvedValue([session('main', 'agent')]);

    const result = await createSessionWithoutActivation({
      repoPath: '/repo/a',
      type: 'terminal',
    });

    expect(result.session?.id).toBe('main');
    expect(result.error).toMatchObject({
      code: 'SESSION_CONFLICT',
      details: { sessionId: 'main' },
    });
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

    expect(result).toMatchObject({
      session: undefined,
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'create failed',
        retryable: true,
        details: { reasonCode: 'SESSION_CREATE_FAILED' },
      },
    });
    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('activates created agent sessions and returns refresh errors instead of throwing', async () => {
    const created = session('new-agent', 'agent');
    const refreshError = new Error('refresh failed');
    apiMocks.createSession.mockResolvedValue(created);
    useSessionsStore.setState({
      refreshAll: vi.fn().mockRejectedValue(refreshError),
    });

    const result = await createAgentSession({
      repoPath: '/repo/a',
      type: 'agent',
    });

    expect(result.session).toBe(created);
    expect(result.error).toBe(refreshError);
    expect(useSessionsStore.getState().activeSessionId).toBe('new-agent');
  });

  it('activates conflicting agent sessions and returns conflict refresh errors instead of throwing', async () => {
    const conflict = new ConflictError('main');
    const refreshError = new Error('refresh failed');
    apiMocks.createSession.mockRejectedValue(conflict);
    useSessionsStore.setState({
      refreshAll: vi.fn().mockRejectedValue(refreshError),
    });

    const result = await createAgentSession({
      repoPath: '/repo/a',
      type: 'agent',
    });

    expect(result.session?.id).toBe('main');
    expect(result.error).toBe(refreshError);
    expect(useSessionsStore.getState().activeSessionId).toBe('main');
  });

  it('does not throw when legacy workspace groups omit repos', () => {
    useSessionsStore.setState({
      sessions: [
        { ...session('direct'), workspaceId: 'legacy' },
        { ...session('repo'), workspaceId: undefined },
      ],
      workspaceGroups: [{ id: 'legacy', name: 'Legacy', order: 0 } as any],
    });

    const result = useSessionsStore
      .getState()
      .getSessionsForWorkspaceGroup('legacy');

    expect(result.map((s) => s.id)).toEqual(['direct']);
  });
});
