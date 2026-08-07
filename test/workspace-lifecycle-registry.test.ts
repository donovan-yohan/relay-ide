// @vitest-environment happy-dom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayOk } from '../shared/cli-gateway-contract.js';

// Mock the shared workspace/worktree lifecycle executors so the handlers and the
// DeleteWorktreeDialog confirm path resolve with successful gateway envelopes
// without touching the network. The mocks record the input so we can assert the
// handlers routed the right repo/worktree/workspace identity. vi.hoisted so the
// fns exist when the hoisted vi.mock factories below run (CI isolated workers are
// stricter than local runs — see test/session-lifecycle-registry.test.ts:13-18).
const {
  executeWorktreeCreateAction,
  executeWorktreeDeleteAction,
  executeWorktreeArchiveAction,
  executeWorkspaceLaunchAction,
} = vi.hoisted(() => ({
  executeWorktreeCreateAction: vi.fn(),
  executeWorktreeDeleteAction: vi.fn(),
  executeWorktreeArchiveAction: vi.fn(),
  executeWorkspaceLaunchAction: vi.fn(),
}));

// The session.kill executor is mocked too: handleArchive must call the kill
// executor BEFORE the archive executor. Recording call order lets us assert it.
const { executeSessionKillAction } = vi.hoisted(() => ({
  executeSessionKillAction: vi.fn(),
}));
const { openAgentChannel } = vi.hoisted(() => ({
  openAgentChannel: vi.fn(async () => ({ id: 'topic:dm-test' })),
}));

executeWorktreeCreateAction.mockImplementation(
  async (input: { repoPath?: string }) =>
    gatewayOk('worktrees.create', {
      branchName: 'feature/test-branch',
      mountainName: 'everest',
      worktreePath: `${input.repoPath ?? '/repo'}/.worktrees/test`,
      existing: false,
    })
);
executeWorktreeDeleteAction.mockImplementation(
  async (input: { repoPath?: string; worktreePath?: string }) =>
    gatewayOk('worktrees.delete', {
      ok: true,
      action: 'delete',
      branchDeleted: true,
      audit: { repoPath: input.repoPath, worktreePath: input.worktreePath },
    })
);
executeWorktreeArchiveAction.mockImplementation(
  async (input: { repoPath?: string; worktreePath?: string }) =>
    gatewayOk('worktrees.archive', {
      ok: true,
      action: 'archive',
      branchDeleted: false,
      audit: { repoPath: input.repoPath, worktreePath: input.worktreePath },
    })
);
executeWorkspaceLaunchAction.mockImplementation(
  async (_input: { workspaceId: string }) =>
    gatewayOk('workspaces.launch', {
      id: 'launched-session',
      repoPath: '/repo/relay-ide',
    })
);
executeSessionKillAction.mockImplementation(
  async (input: { id: string; nodeId?: string }) =>
    gatewayOk('sessions.kill', {
      ok: true,
      killed: true,
      id: input.id,
      sessionId: input.id,
      requestedId: input.id,
      nodeId: input.nodeId ?? 'local',
      globalSessionId: `${input.nodeId ?? 'local'}:${input.id}`,
    })
);

vi.mock('../frontend/src/lib/actions/workspace-lifecycle.js', async () => {
  const actual = await vi.importActual<
    typeof import('../frontend/src/lib/actions/workspace-lifecycle.js')
  >('../frontend/src/lib/actions/workspace-lifecycle.js');
  return {
    ...actual,
    executeWorktreeCreateAction,
    executeWorktreeDeleteAction,
    executeWorktreeArchiveAction,
    executeWorkspaceLaunchAction,
  };
});

vi.mock('../frontend/src/lib/actions/session-lifecycle.js', async () => {
  const actual = await vi.importActual<
    typeof import('../frontend/src/lib/actions/session-lifecycle.js')
  >('../frontend/src/lib/actions/session-lifecycle.js');
  return {
    ...actual,
    executeSessionKillAction,
  };
});

vi.mock('../frontend/src/lib/agent-channels.js', () => ({
  openAgentChannel,
}));

// fetchWorktreeStatus drives the handleDeleteWorktree branch selection (clean vs
// dirty). Stub it to a clean worktree so the handler takes the executor path.
const { fetchWorktreeStatus } = vi.hoisted(() => ({
  fetchWorktreeStatus: vi.fn(),
}));
fetchWorktreeStatus.mockResolvedValue({
  activeSessions: [],
  hasUncommittedChanges: false,
});

vi.mock('../frontend/src/lib/api.js', async () => {
  const actual = await vi.importActual<
    typeof import('../frontend/src/lib/api.js')
  >('../frontend/src/lib/api.js');
  return {
    ...actual,
    fetchWorktreeStatus,
  };
});

vi.mock('../frontend/src/components/dialogs/CustomizeSessionDialog.js', () => ({
  isFrameworkAvailable: () => true,
}));

import type {
  SessionSummary,
  WorktreeInfo,
} from '../frontend/src/lib/types.js';
import { useSessionHandlers } from '../frontend/src/hooks/useSessionHandlers.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import {
  workspaceNewWorktree,
  workspaceLaunch,
} from '../frontend/src/lib/actions/definitions/workspace.js';
import { sidebarDeleteWorktree } from '../frontend/src/lib/actions/definitions/sidebar.js';
import DeleteWorktreeDialog, {
  type DeleteWorktreeDialogHandle,
} from '../frontend/src/components/dialogs/DeleteWorktreeDialog.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalRefreshAll = useSessionsStore.getState().refreshAll;

function makeSession(
  overrides: Partial<SessionSummary> & { id: string }
): SessionSummary {
  return {
    id: overrides.id,
    type: 'terminal',
    mode: 'pty',
    repoName: 'relay-ide',
    repoPath: '/repo/relay-ide',
    worktreePath: null,
    cwd: '/repo/relay-ide',
    branchName: 'nightly',
    displayName: overrides.id,
    createdAt: '2026-06-10T00:00:00.000Z',
    lastActivity: '2026-06-10T00:00:00.000Z',
    idle: false,
    ...overrides,
  };
}

function makeWorktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    name: 'test-wt',
    path: '/repo/relay-ide/.worktrees/test',
    repoName: 'relay-ide',
    repoPath: '/repo/relay-ide',
    displayName: 'test-wt',
    lastActivity: '2026-06-10T00:00:00.000Z',
    branchName: 'feature/test-branch',
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

describe('workspace/worktree lifecycle action registry wiring (#870)', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let refreshAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeWorktreeCreateAction.mockClear();
    executeWorktreeDeleteAction.mockClear();
    executeWorktreeArchiveAction.mockClear();
    executeWorkspaceLaunchAction.mockClear();
    executeSessionKillAction.mockClear();
    fetchWorktreeStatus.mockClear();
    fetchWorktreeStatus.mockResolvedValue({
      activeSessions: [],
      hasUncommittedChanges: false,
    });
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
      activeRepoPath: '/repo/relay-ide',
      activeWorkspaceId: 'ws-1',
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
    vi.restoreAllMocks();
  });

  it('attaches stable lifecycle descriptor.contract metadata to the converted definitions', () => {
    // workspace.new-worktree bridges its createWorktree step to worktrees.create.
    expect(workspaceNewWorktree.descriptor?.id).toBe('worktrees.create');
    expect(workspaceNewWorktree.descriptor?.contract).toMatchObject({
      relayCommandName: 'worktrees.create',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });

    // workspace.launch carries the workspaces.launch descriptor (Command Center).
    expect(workspaceLaunch.descriptor?.id).toBe('workspaces.launch');
    expect(workspaceLaunch.descriptor?.contract?.relayCommandName).toBe(
      'workspaces.launch'
    );

    // sidebar.delete-worktree collapses onto the destructive worktrees.delete.
    expect(sidebarDeleteWorktree.descriptor?.id).toBe('worktrees.delete');
    expect(sidebarDeleteWorktree.descriptor?.contract?.relayCommandName).toBe(
      'worktrees.delete'
    );
    expect(sidebarDeleteWorktree.descriptor?.confirmation.required).toBe(true);
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

  it('routes handleNewWorktree createWorktree step through the worktrees.create executor', async () => {
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleNewWorktree({
        name: 'relay-ide',
        path: '/repo/relay-ide',
      } as never);
    });

    expect(executeWorktreeCreateAction).toHaveBeenCalledTimes(1);
    expect(executeWorktreeCreateAction.mock.calls[0]?.[0]).toMatchObject({
      repoPath: '/repo/relay-ide',
    });
    expect(openAgentChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('feature/test-branch'),
      })
    );
  });

  it('routes workspace launch directly to its agent channel', async () => {
    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleLaunchWorkspaceSession('ws-42');
    });

    expect(executeWorkspaceLaunchAction).not.toHaveBeenCalled();
    expect(openAgentChannel).toHaveBeenCalledWith({
      workspaceId: 'ws-42',
    });
  });

  it('handleArchive calls the kill executor THEN the worktrees.archive executor (branch-preserving)', async () => {
    const active = makeSession({
      id: 'active-session',
      worktreePath: '/repo/relay-ide/.worktrees/test',
      repoPath: '/repo/relay-ide',
    });
    useSessionsStore.setState({
      sessions: [active],
      activeSessionId: active.id,
    });

    const handlers = await mountHandlers();
    await act(async () => {
      await handlers.handleArchive();
    });
    await flushPromises();

    // Branch-preserving: archive executor, NOT delete executor.
    expect(executeSessionKillAction).toHaveBeenCalledTimes(1);
    expect(executeWorktreeArchiveAction).toHaveBeenCalledTimes(1);
    expect(executeWorktreeDeleteAction).not.toHaveBeenCalled();
    expect(executeWorktreeArchiveAction.mock.calls[0]?.[0]).toMatchObject({
      repoPath: '/repo/relay-ide',
      worktreePath: '/repo/relay-ide/.worktrees/test',
    });

    // Kill is ordered before archive.
    const killOrder = executeSessionKillAction.mock.invocationCallOrder[0]!;
    const archiveOrder =
      executeWorktreeArchiveAction.mock.invocationCallOrder[0]!;
    expect(killOrder).toBeLessThan(archiveOrder);
  });

  it('routes handleDeleteWorktree (clean worktree) through the worktrees.delete executor', async () => {
    const handlers = await mountHandlers();
    const wt = makeWorktree();
    await act(async () => {
      await handlers.handleDeleteWorktree(wt);
    });
    await flushPromises();

    expect(executeWorktreeDeleteAction).toHaveBeenCalledTimes(1);
    expect(executeWorktreeDeleteAction.mock.calls[0]?.[0]).toMatchObject({
      repoPath: '/repo/relay-ide',
      worktreePath: '/repo/relay-ide/.worktrees/test',
    });
    // Clean worktree → no force flag.
    expect(
      executeWorktreeDeleteAction.mock.calls[0]?.[0]?.force
    ).toBeUndefined();
  });

  it('DeleteWorktreeDialog confirm path routes through the worktrees.delete executor with force', async () => {
    const dialogRef = React.createRef<DeleteWorktreeDialogHandle>();
    await act(async () => {
      root!.render(
        React.createElement(DeleteWorktreeDialog, { ref: dialogRef })
      );
    });

    const wt = makeWorktree();
    act(() => {
      dialogRef.current?.open(wt, true);
    });

    // Find and click the Delete button (the confirm surface).
    const deleteButton = Array.from(container!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Delete'
    );
    expect(deleteButton).toBeTruthy();
    await act(async () => {
      deleteButton!.click();
    });
    await flushPromises();

    expect(executeWorktreeDeleteAction).toHaveBeenCalledTimes(1);
    expect(executeWorktreeDeleteAction.mock.calls[0]?.[0]).toMatchObject({
      repoPath: '/repo/relay-ide',
      worktreePath: '/repo/relay-ide/.worktrees/test',
      force: true,
    });
  });
});
