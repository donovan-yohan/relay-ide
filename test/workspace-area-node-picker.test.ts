// @vitest-environment happy-dom

import React, { act } from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  setActivePane: vi.fn(),
  refreshAll: vi.fn(),
  setActiveSessionId: vi.fn(),
  showToast: vi.fn(),
  setActiveModal: vi.fn(),
  activeWorkspace: {
    name: 'relay-ide',
    path: '/Users/kyle/relay-ide',
  } as { name: string; path: string } | null,
  worktreePath: '/Users/kyle/relay-ide/.worktrees/feature' as
    | string
    | undefined,
  hubNodes: [] as HubNodeSummary[],
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mocks.hubNodes }),
}));

vi.mock('../frontend/src/lib/api.js', () => ({
  ConflictError: class ConflictError extends Error {},
  fetchHubNodes: vi.fn(),
}));

vi.mock('../frontend/src/lib/session-utils.js', () => ({
  createAgentSession: mocks.createAgentSession,
  getCurrentSessionContext: () => ({
    currentRepoPath: mocks.activeWorkspace?.path,
    currentActiveWorkspace: mocks.activeWorkspace,
    currentActiveSession: mocks.worktreePath
      ? { id: 'sess-active', worktreePath: mocks.worktreePath }
      : undefined,
    currentWorktreePath: mocks.worktreePath,
  }),
}));

vi.mock('../frontend/src/lib/stores/toasts.js', () => ({
  useToastStore: {
    getState: () => ({ showToast: mocks.showToast }),
  },
}));

vi.mock('../frontend/src/lib/stores/ui.js', () => {
  const state = {
    openFileTabs: [],
    activeFileTabKey: null,
    utilityRailByWorkspace: {},
    fileDiffSource: 'workspace',
    fileDiffDefaultBranch: null,
    fileDiffViewMode: 'unified',
    fileWordWrap: false,
    closeFileTab: vi.fn(),
    sendToTargetSessionId: null,
    setActiveModal: mocks.setActiveModal,
  };
  const useUiStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  useUiStore.getState = () => state;
  useUiStore.setState = vi.fn();
  return {
    useUiStore,
    fileTabKey: (path: string, type?: string) => `${type ?? 'code'}:${path}`,
  };
});

vi.mock('../frontend/src/lib/stores/sessions.js', () => {
  const state = {
    activeSessionId: 'sess-active',
    sessions: [],
    repos: [mocks.activeWorkspace],
    workspaceLastSession: {},
    refreshAll: mocks.refreshAll,
    setActiveSessionId: mocks.setActiveSessionId,
  };
  const useSessionsStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  useSessionsStore.getState = () => state;
  useSessionsStore.setState = vi.fn();
  return { useSessionsStore };
});

vi.mock('../frontend/src/lib/stores/workspace-layout-store.js', () => {
  const state = {
    layout: { type: 'pane', id: 'pane-1', tabs: [], activeTabId: null },
    activePaneId: 'pane-1',
    addTab: vi.fn(),
    closeTab: vi.fn(),
    selectTab: vi.fn(),
    resetLayout: vi.fn(),
    setActivePane: mocks.setActivePane,
  };
  const useWorkspaceLayoutStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  useWorkspaceLayoutStore.getState = () => state;
  return { useWorkspaceLayoutStore };
});

vi.mock('../frontend/src/lib/workspace-layout.js', () => ({
  listPanes: (layout: {
    type: string;
    id: string;
    tabs: unknown[];
    activeTabId: string | null;
  }) => [layout],
  workspaceTabId: (tab: {
    kind: string;
    sessionId?: string;
    filePath?: string;
    tabType?: string;
  }) =>
    tab.kind === 'session'
      ? `session::${tab.sessionId}`
      : `file::${tab.tabType ?? 'code'}:${tab.filePath}`,
}));

vi.mock('../frontend/src/components/WorkspaceLayout.js', async () => {
  const ReactModule = await import('react');
  return {
    WorkspaceLayout: ({
      renderAddControl,
    }: {
      renderAddControl: (paneId: string) => React.ReactNode;
    }) => ReactModule.createElement('div', null, renderAddControl('pane-1')),
  };
});

vi.mock('../frontend/src/components/WorkspaceContentLayer.js', async () => {
  const ReactModule = await import('react');
  return { WorkspaceContentLayer: () => ReactModule.createElement('div') };
});

vi.mock('../frontend/src/components/TerminalNodePicker.js', async () => {
  const ReactModule = await import('react');
  return {
    TerminalNodePicker: ({
      onSelect,
    }: {
      onSelect: (nodeId: string) => void;
    }) =>
      ReactModule.createElement(
        'div',
        null,
        ReactModule.createElement(
          'button',
          {
            type: 'button',
            'data-track': 'workspace.add-terminal.local',
            onClick: () => onSelect('local'),
          },
          'local'
        ),
        ReactModule.createElement(
          'button',
          {
            type: 'button',
            'data-track': 'workspace.add-terminal.remote',
            onClick: () => onSelect('remote'),
          },
          'remote'
        )
      ),
  };
});

vi.mock('../frontend/src/components/FileTabContent.js', async () => {
  const ReactModule = await import('react');
  return { FileTabContent: () => ReactModule.createElement('div') };
});

vi.mock('../frontend/src/components/Terminal.js', async () => {
  const ReactModule = await import('react');
  return { Terminal: () => ReactModule.createElement('div') };
});

const { WorkspaceArea } =
  await import('../frontend/src/components/WorkspaceArea.js');

function node(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: 'remote',
    displayName: 'remote box',
    hostname: 'remote.local',
    platform: 'linux',
    arch: 'arm64',
    relayVersion: '0.1.0',
    protocolVersion: '1.0',
    status: 'online',
    homeDir: '/home/relay',
    connection: { route: 'reverse-link', status: 'connected' },
    trust: { state: 'trusted', level: 'privileged-local-user', warning: '' },
    credentialState: 'active',
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 10, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        tmux: 'available',
        git: 'available',
        browserAutomation: 'available',
        clipboardImage: 'available',
        ssh: 'available',
        tailscale: 'available',
      },
      agents: { claude: 'available' },
      serviceManager: 'launchd',
      wsl: false,
    },
    createdAt: '2026-05-12T00:00:00.000Z',
    pairedAt: '2026-05-12T00:00:00.000Z',
    lastSeenAt: '2026-05-12T00:00:00.000Z',
    credentialId: 'cred-remote',
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  mocks.createAgentSession.mockReset();
  mocks.setActivePane.mockReset();
  mocks.refreshAll.mockReset();
  mocks.setActiveSessionId.mockReset();
  mocks.showToast.mockReset();
  mocks.setActiveModal.mockReset();
  mocks.hubNodes = [];
  mocks.activeWorkspace = { name: 'relay-ide', path: '/Users/kyle/relay-ide' };
  mocks.worktreePath = '/Users/kyle/relay-ide/.worktrees/feature';
  window.localStorage.clear();
});

describe('WorkspaceArea terminal node picker', () => {
  async function renderWorkspaceArea() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(WorkspaceArea, {
          // `workspacePath` is the rendered worktree cwd; it is independent of
          // the session context's `currentActiveWorkspace` that gates the
          // tab-plus branch, so the repo-less case still needs a string here.
          workspacePath: mocks.activeWorkspace?.path ?? '/Users/kyle',
          sessions: [],
          onImageUpload: vi.fn(),
          onCopyModeChange: vi.fn(),
          onFilePathClick: vi.fn(),
          onCloseSession: vi.fn(),
        })
      );
    });
  }

  it('opens remote cwd entry before creating remote terminal sessions', async () => {
    mocks.hubNodes = [node()];
    mocks.createAgentSession.mockResolvedValue({
      session: { id: 'remote-session' },
      error: null,
    });

    await renderWorkspaceArea();

    await act(async () => {
      (
        container!.querySelector(
          '[data-track="workspace.add-terminal.remote"]'
        ) as HTMLButtonElement
      ).click();
    });

    expect(mocks.setActivePane).toHaveBeenCalledWith('pane-1');
    expect(mocks.createAgentSession).not.toHaveBeenCalled();

    const cwdInput = container!.querySelector(
      '[data-track="workspace.remote-terminal.cwd"]'
    ) as HTMLInputElement;
    expect(cwdInput).toBeTruthy();
    expect(cwdInput.value).toBe('/home/relay');

    await act(async () => {
      setInputValue(cwdInput, '/srv/relay');
    });

    await act(async () => {
      (
        container!.querySelector(
          '[data-track="workspace.remote-terminal.create"]'
        ) as HTMLButtonElement
      ).click();
    });

    const payload = mocks.createAgentSession.mock.calls.at(-1)?.[0];
    expect(payload).toMatchObject({
      type: 'terminal',
      nodeId: 'remote',
      cwd: '/srv/relay',
      sessionLane: 'remote-cwd',
    });
    expect(payload).not.toHaveProperty('repoPath');
    expect(payload).not.toHaveProperty('worktreePath');
    expect(mocks.setActiveSessionId).toHaveBeenCalledWith('remote-session');
  });

  it('allows remote terminal starts in remote home without repo fields', async () => {
    mocks.hubNodes = [node()];
    mocks.createAgentSession.mockResolvedValue({
      session: { id: 'remote-home-session' },
      error: null,
    });

    await renderWorkspaceArea();

    await act(async () => {
      (
        container!.querySelector(
          '[data-track="workspace.add-terminal.remote"]'
        ) as HTMLButtonElement
      ).click();
    });

    expect(mocks.createAgentSession).not.toHaveBeenCalled();

    await act(async () => {
      (
        container!.querySelector(
          '[data-track="workspace.remote-terminal.start-home"]'
        ) as HTMLButtonElement
      ).click();
    });

    const payload = mocks.createAgentSession.mock.calls.at(-1)?.[0];
    expect(payload).toMatchObject({
      type: 'terminal',
      nodeId: 'remote',
      cwd: '/home/relay',
      sessionLane: 'remote-home',
    });
    expect(payload).not.toHaveProperty('repoPath');
    expect(payload).not.toHaveProperty('worktreePath');
    expect(mocks.setActiveSessionId).toHaveBeenCalledWith(
      'remote-home-session'
    );
  });

  // #862: active-workspace local branch must stay behavior-identical — the
  // local tab-plus still launches a repo-scoped terminal via createAgentSession
  // (NOT the env-picker modal). Locks the unchanged path against regression.
  it('creates a repo-scoped terminal from the local tab-plus when a workspace is active', async () => {
    mocks.createAgentSession.mockResolvedValue({
      session: { id: 'local-session' },
      error: null,
    });

    await renderWorkspaceArea();

    await act(async () => {
      (
        container!.querySelector(
          '[data-track="workspace.add-terminal.local"]'
        ) as HTMLButtonElement
      ).click();
    });

    expect(mocks.setActiveModal).not.toHaveBeenCalled();
    expect(mocks.setActivePane).toHaveBeenCalledWith('pane-1');
    const payload = mocks.createAgentSession.mock.calls.at(-1)?.[0];
    expect(payload).toMatchObject({
      type: 'terminal',
      repoPath: '/Users/kyle/relay-ide',
      worktreePath: '/Users/kyle/relay-ide/.worktrees/feature',
      sessionLane: 'local-repo',
    });
    expect(mocks.setActiveSessionId).toHaveBeenCalledWith('local-session');
  });

  // #862: repo-less hub (no active workspace) — the local tab-plus opens the
  // env-picker modal instead of silently bailing, so the user can pick a
  // node/cwd to launch a terminal against.
  it('opens the env-picker modal from the local tab-plus when no workspace is active', async () => {
    mocks.activeWorkspace = null;
    mocks.worktreePath = undefined;

    await renderWorkspaceArea();

    await act(async () => {
      (
        container!.querySelector(
          '[data-track="workspace.add-terminal.local"]'
        ) as HTMLButtonElement
      ).click();
    });

    expect(mocks.setActiveModal).toHaveBeenCalledWith({ modal: 'env-picker' });
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
    expect(mocks.setActiveSessionId).not.toHaveBeenCalled();
  });
});
