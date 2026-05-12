import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  enrichBranches: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorktrees: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchWorkspaceGroups: vi.fn(),
}));

const notificationMocks = vi.hoisted(() => ({
  fireNotification: vi.fn(),
  shouldFireNotification: vi.fn(() => true),
}));

vi.mock('../../frontend/src/lib/api.js', () => ({
  enrichBranches: apiMocks.enrichBranches,
  fetchSessions: apiMocks.fetchSessions,
  fetchWorktrees: apiMocks.fetchWorktrees,
  fetchWorkspaces: apiMocks.fetchWorkspaces,
  fetchWorkspaceGroups: apiMocks.fetchWorkspaceGroups,
}));

vi.mock('../../frontend/src/lib/notifications.js', () => ({
  fireNotification: notificationMocks.fireNotification,
  shouldFireNotification: notificationMocks.shouldFireNotification,
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

import type {
  SessionSummary,
  SidebarItem,
} from '../../frontend/src/lib/types.js';
import { useSessionsStore } from '../../frontend/src/lib/stores/sessions.js';
import { useUnreadStore } from '../../frontend/src/lib/stores/unread.js';

const nodeASession: SessionSummary = {
  id: 'same-local-id',
  type: 'agent',
  agent: 'claude',
  mode: 'pty',
  repoName: 'relay-ide',
  repoPath: '/node-a/relay-ide',
  worktreePath: null,
  cwd: '/node-a/relay-ide',
  branchName: 'main',
  displayName: 'node a',
  createdAt: '2026-05-11T00:00:00.000Z',
  lastActivity: '2026-05-11T00:00:00.000Z',
  idle: false,
  nodeId: 'node-a',
  globalSessionId: 'node-a:same-local-id',
  agentState: 'processing',
};

const nodeBSession: SessionSummary = {
  ...nodeASession,
  repoPath: '/node-b/relay-ide',
  cwd: '/node-b/relay-ide',
  displayName: 'node b',
  nodeId: 'node-b',
  globalSessionId: 'node-b:same-local-id',
};

function sidebarItem(session: SessionSummary): SidebarItem {
  return {
    id: `session::${session.globalSessionId}`,
    kind: 'repo',
    path: session.repoPath,
    repoPath: session.repoPath,
    displayName: session.displayName,
    branchName: session.branchName,
    lastActivity: session.lastActivity,
    displayState: 'running',
    lastKnownBackendState: 'running',
    sessions: [session],
    nodeId: session.nodeId,
    repoInstanceId: session.repoInstanceId,
  };
}

describe('sessions store node-scoped events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T00:00:00.000Z'));
    vi.clearAllMocks();
    useUnreadStore.setState({ unreadItems: new Set() });
    useSessionsStore.setState({
      sessions: [nodeASession, nodeBSession],
      worktrees: [],
      repos: [],
      workspaceGroups: [],
      activeSessionId: null,
      sidebarItems: [sidebarItem(nodeASession), sidebarItem(nodeBSession)],
      enrichmentResults: {},
      repoEnrichmentMeta: {},
      reconnectingPtySessionIds: {},
      backendConnectionStatus: 'connected',
    });
  });

  it('updates only the matching global session when local ids collide across nodes', () => {
    (useSessionsStore.getState().handleBackendStateChanged as any)(
      'same-local-id',
      'idle',
      undefined,
      { nodeId: 'node-b', globalSessionId: 'node-b:same-local-id' }
    );

    const sessions = useSessionsStore.getState().sessions;
    expect(
      sessions.find((s) => s.globalSessionId === 'node-a:same-local-id')
        ?.agentState
    ).toBe('processing');
    expect(
      sessions.find((s) => s.globalSessionId === 'node-b:same-local-id')
        ?.agentState
    ).toBe('idle');
  });



  it('scopes sidebar aggregate state when duplicate local ids collide across nodes', () => {
    (useSessionsStore.getState().handleBackendStateChanged as any)(
      'same-local-id',
      'idle',
      undefined,
      { nodeId: 'node-b', globalSessionId: 'node-b:same-local-id' }
    );

    const sidebarItems = useSessionsStore.getState().sidebarItems;
    const nodeAItem = sidebarItems.find((item) => item.nodeId === 'node-a');
    const nodeBItem = sidebarItems.find((item) => item.nodeId === 'node-b');

    expect(nodeAItem?.lastKnownBackendState).toBe('running');
    expect(nodeAItem?.displayState).toBe('running');
    expect(nodeBItem?.lastKnownBackendState).toBe('idle');
    expect(nodeBItem?.displayState).toBe('unseen-idle');
  });

  it('does not treat an ambiguous bare active session id as viewing a sibling node item', () => {
    useSessionsStore.setState({ activeSessionId: 'same-local-id' });

    (useSessionsStore.getState().handleBackendStateChanged as any)(
      'same-local-id',
      'permission',
      'approval',
      { nodeId: 'node-b', globalSessionId: 'node-b:same-local-id' }
    );

    const sidebarItems = useSessionsStore.getState().sidebarItems;
    const nodeAItem = sidebarItems.find((item) => item.nodeId === 'node-a');
    const nodeBItem = sidebarItems.find((item) => item.nodeId === 'node-b');

    expect(nodeAItem?.displayState).toBe('running');
    expect(nodeAItem?.isUnread).toBeFalsy();
    expect(nodeBItem?.displayState).toBe('permission');
    expect(nodeBItem?.isUnread).toBe(true);
    expect(useUnreadStore.getState().isUnread(nodeBItem!.id)).toBe(true);
  });

  it('renames only the scoped session when nodeId disambiguates a duplicate local id', () => {
    (useSessionsStore.getState().renameSession as any)(
      'same-local-id',
      'feature-b',
      'renamed b',
      { nodeId: 'node-b' }
    );

    const sessions = useSessionsStore.getState().sessions;
    expect(sessions.find((s) => s.nodeId === 'node-a')?.displayName).toBe(
      'node a'
    );
    expect(sessions.find((s) => s.nodeId === 'node-b')?.displayName).toBe(
      'renamed b'
    );
  });

  it('treats a scoped active session id as viewing only that node item', () => {
    useSessionsStore.setState({ activeSessionId: 'node-b:same-local-id' });

    (useSessionsStore.getState().handleBackendStateChanged as any)(
      'same-local-id',
      'permission',
      'approval',
      { nodeId: 'node-b', globalSessionId: 'node-b:same-local-id' }
    );

    const sidebarItems = useSessionsStore.getState().sidebarItems;
    const nodeAItem = sidebarItems.find((item) => item.nodeId === 'node-a');
    const nodeBItem = sidebarItems.find((item) => item.nodeId === 'node-b');

    expect(nodeAItem?.displayState).toBe('running');
    expect(nodeAItem?.isUnread).toBeFalsy();
    expect(nodeBItem?.displayState).toBe('permission');
    expect(nodeBItem?.isUnread).toBe(false);
    expect(useUnreadStore.getState().isUnread(nodeBItem!.id)).toBe(false);
  });

  it('marks only the scoped viewed session read', () => {
    const nodeBItem = useSessionsStore
      .getState()
      .sidebarItems.find((item) => item.nodeId === 'node-b')!;
    useUnreadStore.getState().markUnread(nodeBItem.id);
    useSessionsStore.setState((state) => ({
      sidebarItems: state.sidebarItems.map((item) =>
        item.nodeId === 'node-b'
          ? { ...item, displayState: 'permission', isUnread: true }
          : item
      ),
    }));

    useSessionsStore.getState().handleUserViewed('node-b:same-local-id');

    const sidebarItems = useSessionsStore.getState().sidebarItems;
    const nodeAItem = sidebarItems.find((item) => item.nodeId === 'node-a');
    const updatedNodeBItem = sidebarItems.find((item) => item.nodeId === 'node-b');

    expect(nodeAItem?.displayState).toBe('running');
    expect(nodeAItem?.isUnread).toBeFalsy();
    expect(updatedNodeBItem?.isUnread).toBe(false);
    expect(useUnreadStore.getState().isUnread(nodeBItem.id)).toBe(false);
  });

  it('does not apply legacy bare notification prefs to ambiguous node-scoped sessions', () => {
    useSessionsStore.setState({
      activeSessionId: null,
      notificationSessions: { 'same-local-id': true },
    });

    (useSessionsStore.getState().handleBackendStateChanged as any)(
      'same-local-id',
      'permission',
      'approval',
      { nodeId: 'node-b', globalSessionId: 'node-b:same-local-id' }
    );

    expect(notificationMocks.fireNotification).not.toHaveBeenCalled();
  });

  it('prunes ambiguous bare session-keyed maps during refreshAll', async () => {
    apiMocks.fetchSessions.mockResolvedValue([nodeASession, nodeBSession]);
    apiMocks.fetchWorktrees.mockResolvedValue([]);
    apiMocks.fetchWorkspaces.mockResolvedValue([]);
    apiMocks.fetchWorkspaceGroups.mockResolvedValue([]);

    useSessionsStore.setState({
      activeSessionId: 'same-local-id',
      notificationSessions: { 'same-local-id': true },
      workspaceLastSession: { '/node-b/relay-ide': 'same-local-id' },
    });

    await useSessionsStore.getState().refreshAll();

    expect(useSessionsStore.getState().activeSessionId).toBe(null);
    expect(useSessionsStore.getState().notificationSessions).toEqual({});
    expect(useSessionsStore.getState().workspaceLastSession).toEqual({});
  });
});
