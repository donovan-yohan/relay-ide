// @vitest-environment happy-dom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayError, gatewayOk } from '../shared/cli-gateway-contract.js';

// Mock the composite start-work executors so the handlers and StartWorkModal
// resolve with successful gateway envelopes without touching the network. The
// mocks record the input so we can assert the handlers routed the right
// repo/branch/pr identity and the typed prompt. vi.hoisted so the fns exist when
// the hoisted vi.mock factories below run (CI isolated workers are stricter than
// local runs — see test/workspace-lifecycle-registry.test.ts:13-25).
const { executeTicketStartWorkAction, executeBranchOpenSessionAction } =
  vi.hoisted(() => ({
    executeTicketStartWorkAction: vi.fn(),
    executeBranchOpenSessionAction: vi.fn(),
  }));

// The typed-prompt path means sendPtyData must NEVER be called by the handlers
// anymore. Mock it so we can assert zero calls.
const { sendPtyData } = vi.hoisted(() => ({ sendPtyData: vi.fn() }));

function workflowOkData(sessionId: string) {
  return {
    session: { id: sessionId, type: 'agent', agent: 'claude', mode: 'pty', cwd: '/repo/relay-ide', displayName: sessionId, status: 'running' },
    nodeId: 'local',
    repo: { repoPath: '/repo/relay-ide' },
    worktree: { dirty: false, conflicted: false },
    branch: { name: 'nightly' },
    created: { session: true, worktree: false },
    reused: { session: false, worktree: true },
    promptHandoff: { delivered: true, method: 'sessions.create.initialPrompt' },
    controlHandoff: {},
  };
}

executeTicketStartWorkAction.mockImplementation(async () =>
  gatewayOk('tickets.startWork', workflowOkData('ticket-session'))
);
executeBranchOpenSessionAction.mockImplementation(async () =>
  gatewayOk('branches.openSession', workflowOkData('branch-session'))
);

vi.mock('../frontend/src/lib/actions/start-work-lifecycle.js', async () => {
  const actual = await vi.importActual<
    typeof import('../frontend/src/lib/actions/start-work-lifecycle.js')
  >('../frontend/src/lib/actions/start-work-lifecycle.js');
  return {
    ...actual,
    executeTicketStartWorkAction,
    executeBranchOpenSessionAction,
  };
});

vi.mock('../frontend/src/lib/ws.js', async () => {
  const actual = await vi.importActual<
    typeof import('../frontend/src/lib/ws.js')
  >('../frontend/src/lib/ws.js');
  return { ...actual, sendPtyData };
});

// fetchWorkspaceSettings drives the handleFixConflicts prompt resolution. Stub it
// so the handler takes the default-prompt branch without a network call, and
// fetchWorkspaces so the StartWorkModal jira workspace loader resolves.
const { fetchWorkspaceSettings, fetchWorkspaces } = vi.hoisted(() => ({
  fetchWorkspaceSettings: vi.fn(),
  fetchWorkspaces: vi.fn(),
}));
fetchWorkspaceSettings.mockResolvedValue({});
fetchWorkspaces.mockResolvedValue([]);

vi.mock('../frontend/src/lib/api.js', async () => {
  const actual = await vi.importActual<
    typeof import('../frontend/src/lib/api.js')
  >('../frontend/src/lib/api.js');
  return { ...actual, fetchWorkspaceSettings, fetchWorkspaces };
});

import type { GitHubIssue, PullRequest } from '../frontend/src/lib/types.js';
import { useSessionHandlers } from '../frontend/src/hooks/useSessionHandlers.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import { useToastStore } from '../frontend/src/lib/stores/toasts.js';
import { StartWorkModal } from '../frontend/src/components/StartWorkModal.js';
import {
  prFixConflicts,
  prSwitchBranch,
} from '../frontend/src/lib/actions/definitions/pr.js';
import { dashboardOpenPrSession } from '../frontend/src/lib/actions/definitions/dashboard.js';
import { sessionStartOnTicket } from '../frontend/src/lib/actions/definitions/session.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalRefreshAll = useSessionsStore.getState().refreshAll;

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: 'fix the thing',
    url: 'https://github.com/org/repo/pull/42',
    headRefName: 'feature/head-branch',
    baseRefName: 'nightly',
    state: 'OPEN',
    author: 'me',
    role: 'author',
    updatedAt: '2026-06-10T00:00:00.000Z',
    additions: 1,
    deletions: 0,
    reviewDecision: null,
    mergeable: 'CONFLICTING',
    ciStatus: null,
    isDraft: false,
    repoName: 'relay-ide',
    repoPath: '/repo/relay-ide',
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

type SessionHandlers = ReturnType<typeof useSessionHandlers>;

function SessionHandlersHarness({
  onReady,
}: {
  onReady: (handlers: SessionHandlers) => void;
}) {
  const handlers = useSessionHandlers({
    customizeDialogRef: React.createRef(),
    deleteWorktreeDialogRef: React.createRef(),
    workspaceSettingsDialogRef: React.createRef(),
    setAnalyticsView: vi.fn(),
  });
  onReady(handlers);
  return null;
}

describe('start-work lifecycle action registry wiring (#871/#876)', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let refreshAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeTicketStartWorkAction.mockClear();
    executeBranchOpenSessionAction.mockClear();
    sendPtyData.mockClear();
    fetchWorkspaceSettings.mockClear();
    fetchWorkspaceSettings.mockResolvedValue({});
    executeTicketStartWorkAction.mockImplementation(async () =>
      gatewayOk('tickets.startWork', workflowOkData('ticket-session'))
    );
    executeBranchOpenSessionAction.mockImplementation(async () =>
      gatewayOk('branches.openSession', workflowOkData('branch-session'))
    );
    refreshAll = vi.fn(async () => undefined);
    useSessionsStore.setState({
      sessions: [],
      worktrees: [],
      repos: [{ name: 'relay-ide', path: '/repo/relay-ide' } as never],
      activeSessionId: null,
      refreshAll: refreshAll as unknown as typeof originalRefreshAll,
    });
    useUiStore.setState({ activeRepoPath: '/repo/relay-ide' });
    useToastStore.setState({ toasts: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useSessionsStore.setState({
      sessions: [],
      worktrees: [],
      repos: [],
      activeSessionId: null,
      refreshAll: originalRefreshAll,
    });
    useToastStore.setState({ toasts: [] });
    vi.restoreAllMocks();
  });

  it('attaches stable branches.openSession / tickets.startWork descriptors to the entry points', () => {
    expect(sessionStartOnTicket.descriptor?.id).toBe('tickets.startWork');
    expect(sessionStartOnTicket.descriptor?.contract).toMatchObject({
      relayCommandName: 'tickets.startWork',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });

    expect(prFixConflicts.descriptor?.id).toBe('branches.openSession');
    expect(prSwitchBranch.descriptor?.id).toBe('branches.openSession');
    expect(dashboardOpenPrSession.descriptor?.id).toBe('branches.openSession');
    expect(prFixConflicts.descriptor?.contract?.relayCommandName).toBe(
      'branches.openSession'
    );
  });

  async function mountHandlers(): Promise<SessionHandlers> {
    let handlers: SessionHandlers | undefined;
    await act(async () => {
      root!.render(
        React.createElement(SessionHandlersHarness, {
          onReady: (next) => {
            handlers = next;
          },
        })
      );
    });
    return handlers!;
  }

  it('handleFixConflicts routes PR head/base identity + typed conflict prompt through branches.openSession (no sendPtyData)', async () => {
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleFixConflicts(makePr());
    });
    await flushPromises();

    expect(executeBranchOpenSessionAction).toHaveBeenCalledTimes(1);
    const input = executeBranchOpenSessionAction.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      repo: { repoPath: '/repo/relay-ide' },
      pr: { head: 'feature/head-branch', base: 'nightly' },
      branch: { name: 'feature/head-branch' },
    });
    // Prompt rides the executor input, not a deferred sendPtyData write.
    expect(input?.prompt?.mode).toBe('initial-prompt');
    expect(typeof input?.prompt?.prompt).toBe('string');
    expect(input?.prompt?.prompt).toContain('nightly');
    expect(sendPtyData).not.toHaveBeenCalled();
    // Success path: store refreshed and new session focused.
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(useSessionsStore.getState().activeSessionId).toBe('branch-session');
  });

  it('handleOpenPrBranch routes PR identity + optional prompt through branches.openSession (no sendPtyData)', async () => {
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleOpenPrBranch(makePr(), 'review this PR');
    });
    await flushPromises();

    expect(executeBranchOpenSessionAction).toHaveBeenCalledTimes(1);
    const input = executeBranchOpenSessionAction.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      repo: { repoPath: '/repo/relay-ide' },
      pr: { head: 'feature/head-branch', base: 'nightly' },
      branch: { name: 'feature/head-branch' },
      prompt: { mode: 'initial-prompt', prompt: 'review this PR' },
    });
    expect(sendPtyData).not.toHaveBeenCalled();
    // Success path: store refreshed and new session focused.
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(useSessionsStore.getState().activeSessionId).toBe('branch-session');
  });

  it('handleOpenBranchSession routes branch identity (no pr) + typed prompt through branches.openSession (no sendPtyData)', async () => {
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleOpenBranchSession(
        'feature/named',
        '/repo/relay-ide',
        'work on this branch'
      );
    });
    await flushPromises();

    expect(executeBranchOpenSessionAction).toHaveBeenCalledTimes(1);
    const input = executeBranchOpenSessionAction.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      repo: { repoPath: '/repo/relay-ide' },
      branch: { name: 'feature/named' },
      prompt: { mode: 'initial-prompt', prompt: 'work on this branch' },
    });
    // Branch target carries no PR object.
    expect(input?.pr).toBeUndefined();
    expect(sendPtyData).not.toHaveBeenCalled();
    // Success path: store refreshed and new session focused.
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(useSessionsStore.getState().activeSessionId).toBe('branch-session');
  });

  it('handleOpenBranchSession surfaces non-conflict executor failures with a toast', async () => {
    executeBranchOpenSessionAction.mockImplementationOnce(async () =>
      gatewayError('branches.openSession', {
        code: 'NODE_OFFLINE',
        message: 'remote node is offline',
        retryable: true,
        details: { nodeId: 'remote-1' },
      })
    );

    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleOpenBranchSession('feature/named', '/repo/relay-ide');
    });
    await flushPromises();

    expect(refreshAll).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: 'remote node is offline',
        variant: 'error',
      }),
    ]);
  });

  it('passes existingWorktreePath from the store-state fast path when a worktree already exists', async () => {
    useSessionsStore.setState({
      worktrees: [
        {
          name: 'wt',
          path: '/repo/relay-ide/.worktrees/head',
          repoName: 'relay-ide',
          repoPath: '/repo/relay-ide',
          displayName: 'wt',
          lastActivity: '2026-06-10T00:00:00.000Z',
          branchName: 'feature/head-branch',
        } as never,
      ],
    });
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleOpenPrBranch(makePr());
    });
    await flushPromises();

    expect(executeBranchOpenSessionAction.mock.calls[0]?.[0]).toMatchObject({
      existingWorktreePath: '/repo/relay-ide/.worktrees/head',
    });
  });

  it('SESSION_CONFLICT focuses the existing session (focus-existing success)', async () => {
    executeBranchOpenSessionAction.mockImplementationOnce(async () =>
      gatewayError('branches.openSession', {
        code: 'SESSION_CONFLICT',
        message: 'session already exists',
        retryable: false,
        details: { sessionId: 'existing-session-id' },
      })
    );
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleOpenPrBranch(makePr());
    });
    await flushPromises();

    expect(useSessionsStore.getState().activeSessionId).toBe(
      'existing-session-id'
    );
  });
});

describe('StartWorkModal ticket field mapping (#871/#876)', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    executeTicketStartWorkAction.mockClear();
    executeTicketStartWorkAction.mockImplementation(async () =>
      gatewayOk('tickets.startWork', workflowOkData('ticket-session'))
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  function makeGitHubIssue(): GitHubIssue {
    return {
      number: 871,
      title: 'frontend start-work branch bridge',
      url: 'https://github.com/donovan-yohan/relay-ide/issues/871',
      state: 'OPEN',
      labels: [],
      assignees: [],
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
      repoName: 'relay-ide',
      repoPath: '/repo/relay-ide',
    };
  }

  it('maps ticketId -> id (GH-number formatting), source, title, url and repo/branch through executeTicketStartWorkAction', async () => {
    const onSessionCreated = vi.fn();
    await act(async () => {
      root!.render(
        React.createElement(StartWorkModal, {
          issue: makeGitHubIssue(),
          open: true,
          onClose: vi.fn(),
          onSessionCreated,
        })
      );
    });
    await flushPromises();

    const startButton = Array.from(
      container!.querySelectorAll('button')
    ).find((b) => b.textContent?.trim() === 'Start Work');
    expect(startButton).toBeTruthy();
    await act(async () => {
      startButton!.click();
    });
    await flushPromises();

    expect(executeTicketStartWorkAction).toHaveBeenCalledTimes(1);
    const input = executeTicketStartWorkAction.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      ticket: {
        source: 'github',
        id: 'GH-871',
        title: 'frontend start-work branch bridge',
        url: 'https://github.com/donovan-yohan/relay-ide/issues/871',
      },
      repo: { repoPath: '/repo/relay-ide' },
      branch: { name: 'gh-871' },
      worktree: { mode: 'reuse-existing' },
    });
    expect(onSessionCreated).toHaveBeenCalledWith('ticket-session');
  });

  it('SESSION_CONFLICT maps to onSessionCreated focus-existing', async () => {
    executeTicketStartWorkAction.mockImplementationOnce(async () =>
      gatewayError('tickets.startWork', {
        code: 'SESSION_CONFLICT',
        message: 'session already exists',
        retryable: false,
        details: { sessionId: 'existing-ticket-session' },
      })
    );
    const onSessionCreated = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root!.render(
        React.createElement(StartWorkModal, {
          issue: makeGitHubIssue(),
          open: true,
          onClose,
          onSessionCreated,
        })
      );
    });
    await flushPromises();

    const startButton = Array.from(
      container!.querySelectorAll('button')
    ).find((b) => b.textContent?.trim() === 'Start Work');
    await act(async () => {
      startButton!.click();
    });
    await flushPromises();

    expect(onSessionCreated).toHaveBeenCalledWith('existing-ticket-session');
    expect(onClose).toHaveBeenCalled();
  });
});
