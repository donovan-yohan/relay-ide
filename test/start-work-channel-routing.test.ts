// @vitest-environment happy-dom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openAgentChannel } = vi.hoisted(() => ({
  openAgentChannel: vi.fn(),
}));
openAgentChannel.mockResolvedValue({});

vi.mock('../frontend/src/lib/agent-channels.js', () => {
  return { openAgentChannel };
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

describe('channel-native PR and branch routing', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let refreshAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openAgentChannel.mockClear();
    openAgentChannel.mockResolvedValue({});
    fetchWorkspaceSettings.mockClear();
    fetchWorkspaceSettings.mockResolvedValue({});
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

  it('handleFixConflicts opens the agent DM with the conflict prompt', async () => {
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleFixConflicts(makePr());
    });
    await flushPromises();

    expect(openAgentChannel).toHaveBeenCalledTimes(1);
    expect(openAgentChannel.mock.calls[0]?.[0]?.prompt).toContain('nightly');
    expect(useUiStore.getState().activeRepoPath).toBe('/repo/relay-ide');
    expect(refreshAll).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
  });

  it('handleFixConflicts applies the configured channel prompt template', async () => {
    fetchWorkspaceSettings.mockResolvedValueOnce({
      promptFixConflicts: 'merge {baseRefName} into {headRefName}',
    });
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleFixConflicts(makePr());
    });

    expect(openAgentChannel).toHaveBeenCalledWith({
      prompt: 'merge nightly into feature/head-branch',
    });
  });

  it('handleOpenPrBranch posts the optional prompt to the agent DM', async () => {
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleOpenPrBranch(makePr(), 'review this PR');
    });
    await flushPromises();

    expect(openAgentChannel).toHaveBeenCalledWith({ prompt: 'review this PR' });
    expect(useUiStore.getState().activeRepoPath).toBe('/repo/relay-ide');
    expect(refreshAll).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
  });

  it('handleOpenBranchSession posts the typed branch prompt to the agent DM', async () => {
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleOpenBranchSession(
        'feature/named',
        '/repo/relay-ide',
        'work on this branch'
      );
    });
    await flushPromises();

    expect(openAgentChannel).toHaveBeenCalledWith({
      prompt: 'work on this branch',
    });
    expect(useUiStore.getState().activeRepoPath).toBe('/repo/relay-ide');
    expect(refreshAll).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
  });

  it('handleOpenBranchSession surfaces channel-open failures with a toast', async () => {
    openAgentChannel.mockRejectedValueOnce(new Error('remote node is offline'));

    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleOpenBranchSession(
        'feature/named',
        '/repo/relay-ide'
      );
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
});

describe('StartWorkModal channel routing', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    openAgentChannel.mockClear();
    openAgentChannel.mockResolvedValue({});
    useUiStore.setState({ activeRepoPath: null });
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

  it('opens the deterministic agent DM with ticket, repo, and branch context', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root!.render(
        React.createElement(StartWorkModal, {
          issue: makeGitHubIssue(),
          open: true,
          onClose,
        })
      );
    });
    await flushPromises();

    const startButton = Array.from(container!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Start Work'
    );
    expect(startButton).toBeTruthy();
    await act(async () => {
      startButton!.click();
    });
    await flushPromises();

    expect(openAgentChannel).toHaveBeenCalledTimes(1);
    const prompt = openAgentChannel.mock.calls[0]?.[0]?.prompt;
    expect(prompt).toContain(
      'Start work on GH-871: frontend start-work branch bridge'
    );
    expect(prompt).toContain(
      'Ticket: https://github.com/donovan-yohan/relay-ide/issues/871'
    );
    expect(prompt).toContain('Repository: /repo/relay-ide');
    expect(prompt).toContain('Use branch: gh-871');
    expect(useUiStore.getState().activeRepoPath).toBe('/repo/relay-ide');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the modal open and surfaces channel-open failures', async () => {
    openAgentChannel.mockRejectedValueOnce(new Error('channel unavailable'));
    const onClose = vi.fn();
    await act(async () => {
      root!.render(
        React.createElement(StartWorkModal, {
          issue: makeGitHubIssue(),
          open: true,
          onClose,
        })
      );
    });
    await flushPromises();

    const startButton = Array.from(container!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Start Work'
    );
    await act(async () => {
      startButton!.click();
    });
    await flushPromises();

    expect(container?.querySelector('.error-msg')?.textContent).toBe(
      'channel unavailable'
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
