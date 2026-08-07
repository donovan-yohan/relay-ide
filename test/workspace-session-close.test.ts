// @vitest-environment happy-dom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killSession } from '../frontend/src/lib/api.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import { useWorkspaceLayoutStore } from '../frontend/src/lib/stores/workspace-layout-store.js';
import { resolveWorkspaceSessionCloseTarget } from '../frontend/src/lib/workspace-session-close.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';
import type { WorkspaceTab } from '../frontend/src/lib/workspace-layout.js';
import { WorkspaceArea } from '../frontend/src/components/WorkspaceArea.js';

vi.mock('../frontend/src/components/Terminal.js', () => ({
  Terminal: () => null,
}));

vi.mock('../frontend/src/components/TerminalNodePicker.js', () => ({
  TerminalNodePicker: () => null,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalRefreshAll = useSessionsStore.getState().refreshAll;

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

describe('resolveWorkspaceSessionCloseTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses a remote workspace tab nodeId when the sessions store is empty', async () => {
    const fetchMock = stubSuccessfulFetch();
    const tabs: WorkspaceTab[] = [
      {
        kind: 'session',
        sessionId: 'node-a:remote-session-1',
        sessionType: 'terminal',
        nodeId: 'node-a',
      },
    ];

    const target = resolveWorkspaceSessionCloseTarget(
      tabs,
      'session::node-a:remote-session-1',
      []
    );

    expect(target).toEqual({
      sessionId: 'remote-session-1',
      nodeId: 'node-a',
    });

    await killSession(target!.sessionId, target!.nodeId);

    expect(fetchMock).toHaveBeenCalledWith(
      '/hub/nodes/node-a/sessions/remote-session-1',
      { method: 'DELETE' }
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/sessions/node-a%3Aremote-session-1',
      expect.anything()
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/sessions/node-a:remote-session-1',
      expect.anything()
    );
  });

  it('preserves local tab close routing when the tab has no nodeId', async () => {
    const fetchMock = stubSuccessfulFetch();
    const tabs: WorkspaceTab[] = [
      {
        kind: 'session',
        sessionId: 'local-session-1',
        sessionType: 'terminal',
      },
    ];

    const target = resolveWorkspaceSessionCloseTarget(
      tabs,
      'session::local-session-1',
      []
    );

    expect(target).toEqual({ sessionId: 'local-session-1' });

    await killSession(target!.sessionId, target!.nodeId);

    expect(fetchMock).toHaveBeenCalledWith('/sessions/local-session-1', {
      method: 'DELETE',
    });
  });
});

function makeRemoteSession(): SessionSummary {
  const now = new Date(0).toISOString();
  return {
    id: 'remote-session-1',
    type: 'terminal',
    repoName: 'relay-ide',
    repoPath: '/repo',
    worktreePath: null,
    cwd: '/repo',
    branchName: 'nightly',
    displayName: 'remote-session-1',
    createdAt: now,
    lastActivity: now,
    idle: false,
    nodeId: 'node-a',
    globalSessionId: 'node-a:remote-session-1',
  };
}

function resetWorkspaceAreaTestStores(sessions: SessionSummary[] = []): void {
  useSessionsStore.setState({
    sessions,
    activeSessionId: sessions[0]?.globalSessionId ?? sessions[0]?.id ?? null,
    refreshAll: originalRefreshAll,
  });
  useUiStore.setState({ openFileTabs: [], activeFileTabKey: null });
  useWorkspaceLayoutStore.getState().resetLayout([]);
}

describe('WorkspaceArea session tab close routing', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    resetWorkspaceAreaTestStores();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps node routing when the session store clears before a workspace tab close propagates', async () => {
    const fetchMock = stubSuccessfulFetch();
    const session = makeRemoteSession();
    resetWorkspaceAreaTestStores([session]);
    useSessionsStore.setState({ refreshAll: vi.fn(async () => {}) });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(WorkspaceArea, {
            workspacePath: '/repo',
            sessions: [session],
            onImageUpload: () => {},
            onCopyModeChange: () => {},
            onFilePathClick: () => {},
            onCloseSession: (sessionId: string, nodeId?: string) => {
              void killSession(sessionId, nodeId);
            },
          })
        )
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      useSessionsStore.setState({ sessions: [], activeSessionId: null });
    });
    const closeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="close remote-session-1"]'
    );

    expect(closeButton).not.toBeNull();
    await act(async () => {
      closeButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    expect(deleteCalls).toEqual([
      ['/hub/nodes/node-a/sessions/remote-session-1', { method: 'DELETE' }],
    ]);
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/sessions/node-a%3Aremote-session-1',
      expect.anything()
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/sessions/remote-session-1',
      expect.anything()
    );
    const reactStoreErrors = consoleErrorSpy.mock.calls
      .flat()
      .filter(
        (message) =>
          typeof message === 'string' &&
          (message.includes('getSnapshot') ||
            message.includes('Maximum update depth'))
      );
    expect(reactStoreErrors).toEqual([]);
  });
});
