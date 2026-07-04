// @vitest-environment happy-dom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../frontend/src/lib/types.js';
import { useSessionHandlers } from '../frontend/src/hooks/useSessionHandlers.js';
import { useActionRegistry } from '../frontend/src/hooks/useActionRegistry.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import { resolveAppViewMode } from '../frontend/src/lib/state/app-view-mode.js';
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
    id: overrides.id,
    type: 'agent',
    agent: 'claude',
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
      sidebarOpen: false,
    });
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
      sidebarOpen: false,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    ).toBe('chat');
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
    ).toBe('chat');
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
      activeSessionId: remote.globalSessionId,
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
      activeSessionId: remote.globalSessionId,
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

  it('routes command-palette kill for remote sessions through the owning node', async () => {
    const fetchMock = stubSuccessfulFetch();
    const remote = makeSession({
      id: 'palette-session-1',
      nodeId: 'node-a',
      globalSessionId: 'node-a:palette-session-1',
    });
    useSessionsStore.setState({
      sessions: [remote],
      activeSessionId: remote.globalSessionId,
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
        sessionId: remote.globalSessionId,
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
