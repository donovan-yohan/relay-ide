// @vitest-environment happy-dom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repo, SessionSummary } from '../frontend/src/lib/types.js';
import { useSessionHandlers } from '../frontend/src/hooks/useSessionHandlers.js';
import { useActionRegistry } from '../frontend/src/hooks/useActionRegistry.js';
import { useUrlNav } from '../frontend/src/hooks/useUrlNav.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import { resolveAppViewMode } from '../frontend/src/lib/state/app-view-mode.js';
import { hashPath } from '../frontend/src/lib/url-nav.js';
import {
  _resetForTesting,
  getAction,
} from '../frontend/src/lib/actions/registry.js';

vi.mock('../frontend/src/components/dialogs/CustomizeSessionDialog.js', () => ({
  isFrameworkAvailable: () => true,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalRefreshAll = useSessionsStore.getState().refreshAll;

function makeSession(
  overrides: Partial<SessionSummary> & { id: string }
): SessionSummary {
  return {
    type: 'terminal',
    mode: 'pty',
    repoName: 'relay-ide',
    repoPath: '/repo/relay-ide',
    worktreePath: null,
    cwd: '/repo/relay-ide',
    branchName: 'nightly',
    displayName: overrides.id,
    createdAt: '2026-05-14T00:00:00.000Z',
    lastActivity: '2026-05-14T00:00:00.000Z',
    idle: false,
    activityState: 'idle',
    ...overrides,
  };
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    path: '/repo/relay-ide',
    name: 'relay-ide',
    isGitRepo: true,
    kind: 'repo',
    defaultBranch: 'nightly',
    currentBranch: 'nightly',
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function stubSuccessfulFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
    jsonResponse({ ok: true })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function flushPromises(): Promise<void> {
  await act(async () => {
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

function ActionRegistryHarness() {
  useActionRegistry({
    handleQuickAgent: vi.fn(),
    handleQuickTerminal: vi.fn(),
    handleCloseSession: vi.fn(),
    handleSelectSession: vi.fn(),
    handleNewWorktree: vi.fn(),
    handleLaunchWorkspaceSession: vi.fn(),
    handleOpenSettings: vi.fn(),
    handleRenameActiveSession: vi.fn(),
    handleArchive: vi.fn(),
    navigateToDashboard: vi.fn(),
    customizeDialogRef: React.createRef(),
    deleteWorktreeDialogRef: React.createRef(),
    workspaceSettingsDialogRef: React.createRef(),
    setFilePickerOpen: vi.fn(),
  });
  return null;
}

function UrlNavHarness({
  onReady,
}: {
  onReady: (nav: ReturnType<typeof useUrlNav>) => void;
}) {
  const nav = useUrlNav();
  onReady(nav);
  return null;
}

describe('session lifecycle handlers', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let refreshAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetForTesting();
    refreshAll = vi.fn(async () => undefined);
    useSessionsStore.setState({
      sessions: [],
      worktrees: [],
      repos: [],
      workspaceGroups: [],
      activeSessionId: null,
      sidebarItems: [],
      enrichmentResults: {},
      repoEnrichmentMeta: {},
      reconnectingPtySessionIds: {},
      backendConnectionStatus: 'connected',
      refreshAll: refreshAll as unknown as typeof originalRefreshAll,
    });
    useUiStore.setState({
      activeRepoPath: null,
      analyticsView: null,
      forceOrgCockpit: false,
      topicComposerOpen: false,
      activeChannelId: null,
      orgDashboardTab: 'active-work',
      sidebarOpen: false,
    });
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    _resetForTesting();
    useSessionsStore.setState({
      sessions: [],
      worktrees: [],
      repos: [],
      workspaceGroups: [],
      activeSessionId: null,
      sidebarItems: [],
      enrichmentResults: {},
      repoEnrichmentMeta: {},
      reconnectingPtySessionIds: {},
      backendConnectionStatus: 'connected',
      refreshAll: originalRefreshAll,
    });
    useUiStore.setState({
      activeRepoPath: null,
      analyticsView: null,
      forceOrgCockpit: false,
      topicComposerOpen: false,
      activeChannelId: null,
      orgDashboardTab: 'active-work',
      sidebarOpen: false,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('clears a stale forced cockpit flag when restoring a session URL', async () => {
    const repo = makeRepo();
    const local = makeSession({ id: 'url-session-1' });
    useSessionsStore.setState({
      repos: [repo],
      sessions: [local],
      activeSessionId: null,
    });
    useUiStore.setState({
      activeRepoPath: null,
      analyticsView: null,
      forceOrgCockpit: true,
    });
    window.history.replaceState(
      null,
      '',
      `/${hashPath(repo.path)}/${local.id}`
    );

    let nav: ReturnType<typeof useUrlNav> | undefined;
    await act(async () => {
      root!.render(
        React.createElement(UrlNavHarness, {
          onReady: (next) => {
            nav = next;
          },
        })
      );
    });

    await act(async () => {
      nav!.restoreFromUrl();
    });

    const ui = useUiStore.getState();
    expect(useSessionsStore.getState().activeSessionId).toBe(local.id);
    expect(ui.forceOrgCockpit).toBe(false);
    expect(ui.activeRepoPath).toBe(repo.path);
    expect(
      resolveAppViewMode({
        analyticsView: ui.analyticsView,
        hasActiveSession: true,
        activeRepoPath: ui.activeRepoPath,
        forceOrgCockpit: ui.forceOrgCockpit,
        topicComposerOpen: ui.topicComposerOpen,
      })
    ).toBe('session');
  });

  it('clears a stale forced cockpit flag when browser history activates a session', async () => {
    const repo = makeRepo();
    const local = makeSession({ id: 'popstate-session-1' });
    useSessionsStore.setState({
      repos: [repo],
      sessions: [local],
      activeSessionId: null,
    });
    useUiStore.setState({
      activeRepoPath: null,
      analyticsView: null,
      forceOrgCockpit: true,
    });

    await act(async () => {
      root!.render(
        React.createElement(UrlNavHarness, {
          onReady: () => undefined,
        })
      );
    });
    window.history.pushState(null, '', `/${hashPath(repo.path)}/${local.id}`);

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    const ui = useUiStore.getState();
    expect(useSessionsStore.getState().activeSessionId).toBe(local.id);
    expect(ui.forceOrgCockpit).toBe(false);
    expect(ui.activeRepoPath).toBe(repo.path);
    expect(
      resolveAppViewMode({
        analyticsView: ui.analyticsView,
        hasActiveSession: true,
        activeRepoPath: ui.activeRepoPath,
        forceOrgCockpit: ui.forceOrgCockpit,
        topicComposerOpen: ui.topicComposerOpen,
      })
    ).toBe('session');
  });

  it('clears a stale forced cockpit flag when selecting an existing session', async () => {
    const local = makeSession({ id: 'select-session-1' });
    useSessionsStore.setState({
      sessions: [local],
      activeSessionId: null,
    });
    useUiStore.setState({
      activeRepoPath: null,
      analyticsView: null,
      forceOrgCockpit: true,
      sidebarOpen: true,
    });

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

    await act(async () => {
      handlers!.handleSelectSession(local.id);
    });

    const ui = useUiStore.getState();
    expect(useSessionsStore.getState().activeSessionId).toBe(local.id);
    expect(ui.forceOrgCockpit).toBe(false);
    expect(ui.activeRepoPath).toBe(local.repoPath);
    expect(ui.sidebarOpen).toBe(false);
    expect(
      resolveAppViewMode({
        analyticsView: ui.analyticsView,
        hasActiveSession: true,
        activeRepoPath: ui.activeRepoPath,
        forceOrgCockpit: ui.forceOrgCockpit,
        topicComposerOpen: ui.topicComposerOpen,
      })
    ).toBe('session');
  });

  it('clears a stale forced cockpit flag when resuming a session by id', async () => {
    const local = makeSession({ id: 'resume-session-1' });
    useSessionsStore.setState({
      sessions: [local],
      activeSessionId: null,
    });
    useUiStore.setState({
      activeRepoPath: null,
      analyticsView: null,
      forceOrgCockpit: true,
      sidebarOpen: true,
    });

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

    await act(async () => {
      handlers!.navigateToSession(local.id, local.type);
    });

    const ui = useUiStore.getState();
    expect(useSessionsStore.getState().activeSessionId).toBe(local.id);
    expect(ui.forceOrgCockpit).toBe(false);
    expect(ui.activeRepoPath).toBe(local.repoPath);
    expect(ui.sidebarOpen).toBe(false);
    expect(
      resolveAppViewMode({
        analyticsView: ui.analyticsView,
        hasActiveSession: true,
        activeRepoPath: ui.activeRepoPath,
        forceOrgCockpit: ui.forceOrgCockpit,
        topicComposerOpen: ui.topicComposerOpen,
      })
    ).toBe('session');
  });

  it('routes tab close for remote sessions through the owning node', async () => {
    const fetchMock = stubSuccessfulFetch();
    const remote = makeSession({
      id: 'remote-session-1',
      nodeId: 'node-a',
      globalSessionId: 'node-a:remote-session-1',
    });
    useSessionsStore.setState({
      sessions: [remote],
      activeSessionId: remote.globalSessionId!,
    });

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

    handlers!.handleCloseSession(remote.globalSessionId!);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/hub/nodes/node-a/sessions/remote-session-1',
      { method: 'DELETE' }
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/sessions/node-a:remote-session-1',
      expect.anything()
    );
    expect(refreshAll).toHaveBeenCalled();
  });

  it('uses caller-provided node identity when a remote close races a store refresh', async () => {
    const fetchMock = stubSuccessfulFetch();
    useSessionsStore.setState({ sessions: [], activeSessionId: null });

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

    handlers!.handleCloseSession('node-a:remote-session-1', 'node-a');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/hub/nodes/node-a/sessions/remote-session-1',
      { method: 'DELETE' }
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/sessions/remote-session-1',
      expect.anything()
    );
  });

  it('infers the owning node from a stale scoped active-session close', async () => {
    const fetchMock = stubSuccessfulFetch();
    useSessionsStore.setState({
      sessions: [],
      activeSessionId: 'node-a:remote-session-1',
    });

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

    handlers!.handleCloseSession('node-a:remote-session-1');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/hub/nodes/node-a/sessions/remote-session-1',
      { method: 'DELETE' }
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/sessions/node-a%3Aremote-session-1',
      expect.anything()
    );
  });

  it('keeps tab close for local sessions on the local sessions endpoint', async () => {
    const fetchMock = stubSuccessfulFetch();
    const local = makeSession({ id: 'local-session-1' });
    useSessionsStore.setState({
      sessions: [local],
      activeSessionId: local.id,
    });

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

    handlers!.handleCloseSession(local.id);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith('/sessions/local-session-1', {
      method: 'DELETE',
    });
  });

  it('refreshes session state after a successful active-session rename', async () => {
    const fetchMock = stubSuccessfulFetch();
    const promptMock = vi.fn(() => 'qa renamed session');
    vi.stubGlobal('prompt', promptMock);
    const local = makeSession({
      id: 'rename-session-1',
      displayName: 'Terminal 2',
    });
    useSessionsStore.setState({
      sessions: [local],
      activeSessionId: local.id,
    });

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

    await act(async () => {
      await handlers!.handleRenameActiveSession();
    });

    expect(fetchMock).toHaveBeenCalledWith('/sessions/rename-session-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'qa renamed session' }),
    });
    expect(refreshAll).toHaveBeenCalledTimes(1);
  });

  it('routes archive cleanup for remote sessions through the owning node', async () => {
    const fetchMock = stubSuccessfulFetch();
    const remote = makeSession({
      id: 'archive-session-1',
      nodeId: 'node-a',
      globalSessionId: 'node-a:archive-session-1',
    });
    useSessionsStore.setState({
      sessions: [remote],
      activeSessionId: remote.globalSessionId!,
    });

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

    await act(async () => {
      await handlers!.handleArchive();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/hub/nodes/node-a/sessions/archive-session-1',
      { method: 'DELETE' }
    );
  });

  it('clears a stale forced cockpit flag when jumping to next attention work', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({
        groups: [
          {
            id: 'active-work-1',
            node: { nodeId: 'local', displayName: 'local', status: 'online' },
            staleReadModel: false,
            sessions: [
              {
                id: 'next-attention-session-1',
                type: 'terminal',
                repoPath: '/repo/relay-ide',
                cwd: '/repo/relay-ide',
                live: true,
                activityState: 'waiting-for-input',
                controlFreshness: 'fresh',
                durability: 'running-attached',
                associatedAt: '2026-05-14T00:00:00.000Z',
                lastActivity: '2026-05-14T00:00:00.000Z',
              },
            ],
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    useSessionsStore.setState({ sessions: [], activeSessionId: null });
    useUiStore.setState({
      activeRepoPath: null,
      analyticsView: null,
      forceOrgCockpit: true,
      sidebarOpen: true,
    });

    await act(async () => {
      root!.render(React.createElement(ActionRegistryHarness));
    });
    await flushPromises();

    const action = getAction('navigation.next-attention-work');
    expect(action).toBeDefined();
    await act(async () => {
      await action!.handler({ view: 'org' });
    });
    await flushPromises();

    const ui = useUiStore.getState();
    expect(useSessionsStore.getState().activeSessionId).toContain(
      'next-attention-session-1'
    );
    expect(ui.forceOrgCockpit).toBe(false);
    expect(ui.activeRepoPath).toBe('/repo/relay-ide');
    expect(ui.sidebarOpen).toBe(false);
    expect(
      resolveAppViewMode({
        analyticsView: ui.analyticsView,
        hasActiveSession: true,
        activeRepoPath: ui.activeRepoPath,
        forceOrgCockpit: ui.forceOrgCockpit,
        topicComposerOpen: ui.topicComposerOpen,
      })
    ).toBe('session');
  });

  // #1287: an open channel outranks forceOrgCockpit in resolveAppViewMode, so
  // every cockpit escape hatch has to clear activeChannelId — otherwise the
  // action looks inert and its latched flag fires later as a surprise
  // navigation when the operator closes the channel.
  async function invokeCockpitEscapeHatch(actionId: string): Promise<void> {
    useSessionsStore.setState({ activeSessionId: 'channel-session-1' });
    useUiStore.setState({
      activeRepoPath: '/repo/relay-ide',
      analyticsView: null,
      forceOrgCockpit: false,
      topicComposerOpen: true,
      activeChannelId: 'channel-1',
      orgDashboardTab: 'prs',
    });

    await act(async () => {
      root!.render(React.createElement(ActionRegistryHarness));
    });
    await flushPromises();

    const action = getAction(actionId);
    expect(action).toBeDefined();
    await act(async () => {
      await action!.handler({ view: 'session' });
    });
    await flushPromises();
  }

  function expectCockpitReached(): void {
    const ui = useUiStore.getState();
    expect(ui.activeChannelId).toBe(null);
    expect(ui.topicComposerOpen).toBe(false);
    expect(ui.forceOrgCockpit).toBe(true);
    expect(ui.activeRepoPath).toBe(null);
    expect(useSessionsStore.getState().activeSessionId).toBe(null);
    expect(
      resolveAppViewMode({
        analyticsView: ui.analyticsView,
        hasActiveSession: false,
        activeRepoPath: ui.activeRepoPath,
        forceOrgCockpit: ui.forceOrgCockpit,
        topicComposerOpen: ui.topicComposerOpen,
        hasActiveChannel: ui.activeChannelId !== null,
      })
    ).toBe('org');
  }

  it('clears an open channel when opening the work cockpit (#1287)', async () => {
    await invokeCockpitEscapeHatch('navigation.open-work-cockpit');
    expectCockpitReached();
  });

  it('clears an open channel when opening the nodes dashboard (#1287)', async () => {
    await invokeCockpitEscapeHatch('navigation.open-nodes-dashboard');
    expectCockpitReached();
    expect(useUiStore.getState().orgDashboardTab).toBe('nodes');
  });

  it('clears an open channel when opening active work detail (#1287)', async () => {
    await invokeCockpitEscapeHatch('navigation.open-active-work');
    expectCockpitReached();
    expect(useUiStore.getState().orgDashboardTab).toBe('active-work');
  });

  it('routes command-palette kill for remote sessions through the owning node', async () => {
    const fetchMock = stubSuccessfulFetch();
    const remote = makeSession({
      id: 'palette-session-1',
      nodeId: 'node-a',
      globalSessionId: 'node-a:palette-session-1',
    });
    useSessionsStore.setState({
      sessions: [remote],
      activeSessionId: remote.globalSessionId!,
    });

    await act(async () => {
      root!.render(React.createElement(ActionRegistryHarness));
    });
    await flushPromises();

    const action = getAction('session.kill');
    expect(action).toBeDefined();
    await act(async () => {
      await action!.handler({
        view: 'session',
        sessionId: remote.globalSessionId!,
      });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/hub/nodes/node-a/sessions/palette-session-1',
      { method: 'DELETE' }
    );
    expect(refreshAll).toHaveBeenCalled();
  });

  it('routes stale command-palette kill for scoped active sessions through the owning node', async () => {
    const fetchMock = stubSuccessfulFetch();
    useSessionsStore.setState({
      sessions: [],
      activeSessionId: 'node-a:remote-session-1',
    });

    await act(async () => {
      root!.render(React.createElement(ActionRegistryHarness));
    });
    await flushPromises();

    const action = getAction('session.kill');
    expect(action).toBeDefined();
    await act(async () => {
      await action!.handler({
        view: 'session',
        sessionId: 'node-a:remote-session-1',
      });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/hub/nodes/node-a/sessions/remote-session-1',
      { method: 'DELETE' }
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/sessions/node-a%3Aremote-session-1',
      expect.anything()
    );
    expect(refreshAll).toHaveBeenCalled();
  });
});
