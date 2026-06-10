// @vitest-environment happy-dom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayOk } from '../shared/cli-gateway-contract.js';

// Mock the shared sessions.kill executor so the close-active path resolves with
// a successful gateway envelope without touching the network. The mock records
// the input so we can assert the registry/handler routed the right session id.
// vi.hoisted so the fns exist when the hoisted vi.mock factory below runs.
const { executeSessionKillAction, executeSessionRenameAction } = vi.hoisted(
  () => ({
    executeSessionKillAction: vi.fn(),
    executeSessionRenameAction: vi.fn(),
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
executeSessionRenameAction.mockImplementation(
  async (input: { id: string; displayName: string; nodeId?: string }) =>
    gatewayOk('sessions.rename', {
      renamed: true,
      id: input.id,
      sessionId: input.id,
      requestedId: input.id,
      nodeId: input.nodeId ?? 'local',
      globalSessionId: `${input.nodeId ?? 'local'}:${input.id}`,
      displayName: input.displayName,
    })
);

vi.mock('../frontend/src/lib/actions/session-lifecycle.js', async () => {
  const actual = await vi.importActual<
    typeof import('../frontend/src/lib/actions/session-lifecycle.js')
  >('../frontend/src/lib/actions/session-lifecycle.js');
  return {
    ...actual,
    executeSessionKillAction,
    executeSessionRenameAction,
  };
});

vi.mock('../frontend/src/components/dialogs/CustomizeSessionDialog.js', () => ({
  isFrameworkAvailable: () => true,
}));

import type { SessionSummary } from '../frontend/src/lib/types.js';
import { useSessionHandlers } from '../frontend/src/hooks/useSessionHandlers.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import {
  sessionCloseActive,
  sessionKill,
  sessionRename,
} from '../frontend/src/lib/actions/definitions/session.js';
import { sidebarRenameSession } from '../frontend/src/lib/actions/definitions/sidebar.js';

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
    createdAt: '2026-06-10T00:00:00.000Z',
    lastActivity: '2026-06-10T00:00:00.000Z',
    idle: false,
    ...overrides,
  };
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

describe('session lifecycle action registry wiring (#869)', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let refreshAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeSessionKillAction.mockClear();
    executeSessionRenameAction.mockClear();
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
    useUiStore.setState({ activeRepoPath: '/repo/relay-ide' });
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

  it('attaches stable lifecycle descriptor.contract metadata to kill/rename/close definitions', () => {
    expect(sessionKill.descriptor?.id).toBe('sessions.kill');
    expect(sessionKill.descriptor?.contract).toMatchObject({
      relayCommandName: 'sessions.kill',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
    expect(sessionKill.descriptor?.confirmation.required).toBe(true);

    // close-active bridges to the SAME sessions.kill descriptor (no sessions.close verb).
    expect(sessionCloseActive.descriptor?.id).toBe('sessions.kill');
    expect(sessionCloseActive.descriptor?.contract?.relayCommandName).toBe(
      'sessions.kill'
    );

    expect(sessionRename.descriptor?.id).toBe('sessions.rename');
    expect(sessionRename.descriptor?.contract).toMatchObject({
      relayCommandName: 'sessions.rename',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });

    // sidebar.rename-session collapses into the same sessions.rename descriptor.
    expect(sidebarRenameSession.descriptor?.id).toBe('sessions.rename');
    expect(sidebarRenameSession.descriptor?.contract?.relayCommandName).toBe(
      'sessions.rename'
    );
  });

  it('still performs next-tab selection after a successful kill envelope from close-active', async () => {
    const active = makeSession({ id: 'active-session' });
    const sibling = makeSession({ id: 'sibling-session' });
    useSessionsStore.setState({
      sessions: [active, sibling],
      activeSessionId: active.id,
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

    act(() => {
      handlers!.handleCloseSession(active.id);
    });

    // Kill routed through the shared executor with the resolved local session id.
    expect(executeSessionKillAction).toHaveBeenCalledTimes(1);
    expect(executeSessionKillAction.mock.calls[0]?.[0]).toMatchObject({
      id: 'active-session',
    });

    // Tab selection is synchronous and does not wait on the kill envelope: the
    // sibling in the same workspace/cwd becomes active immediately.
    expect(useSessionsStore.getState().activeSessionId).toBe('sibling-session');

    // The kill envelope still resolves and refreshAll fires afterward.
    await flushPromises();
    expect(refreshAll).toHaveBeenCalled();
  });
});
