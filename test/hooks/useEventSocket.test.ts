import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMessage } from '../../frontend/src/lib/ws.js';

const effectState = vi.hoisted(() => ({
  cleanup: undefined as void | (() => void),
}));

const wsMock = vi.hoisted(() => ({
  onMessage: undefined as undefined | ((msg: EventMessage) => void),
  onOpen: undefined as undefined | (() => void),
  onConnectionState: undefined as undefined | ((state: string) => void),
  connectEventSocket: vi.fn(
    (
      onMessage: (msg: EventMessage) => void,
      onOpen?: () => void,
      _onAuthRequired?: () => void,
      onConnectionState?: (state: string) => void
    ) => {
      wsMock.onMessage = onMessage;
      wsMock.onOpen = onOpen;
      wsMock.onConnectionState = onConnectionState;
    }
  ),
}));

const apiMock = vi.hoisted(() => ({
  fetchHubNodes: vi.fn(),
}));

const storeMock = vi.hoisted(() => ({
  refreshAll: vi.fn(),
  ensureFreshAll: vi.fn(),
  forceRefresh: vi.fn(),
  handleBackendStateChanged: vi.fn(),
  renameSession: vi.fn(),
  handleBranchChanged: vi.fn(),
  handleActivityChanged: vi.fn(),
  beginPtyReconnect: vi.fn(),
  setBackendConnectionStatus: vi.fn(),
  backendConnectionStatus: 'connected' as
    | 'connected'
    | 'reconnecting'
    | 'restarting',
  activeSessionId: null as string | null,
  sessions: [] as Array<{
    id: string;
    repoPath: string;
    mode?: 'pty' | 'web';
    worktreePath?: string | null;
    cwd?: string;
  }>,
  worktrees: [] as Array<{ path: string; repoPath: string }>,
  repos: [
    { path: '/repos/relay-ide', name: 'relay-ide' },
    { path: '/repos/hermes-agent', name: 'hermes-agent' },
  ],
}));

const telemetryMock = vi.hoisted(() => ({
  refreshTelemetry: vi.fn(),
  handleSessionTelemetryEvent: vi.fn(),
  handleAccountTelemetryEvent: vi.fn(),
}));

const authMock = vi.hoisted(() => ({ deauthenticate: vi.fn() }));
const uiMock = vi.hoisted(() => ({
  openHtmlTab: vi.fn(),
  refreshHtmlTab: vi.fn(),
}));

vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => {
    effectState.cleanup = effect();
  },
}));

vi.mock('../../frontend/src/lib/ws.js', () => ({
  connectEventSocket: wsMock.connectEventSocket,
}));

vi.mock('../../frontend/src/lib/api.js', () => ({
  fetchHubNodes: apiMock.fetchHubNodes,
}));

vi.mock('../../frontend/src/lib/stores/sessions.js', () => ({
  useSessionsStore: {
    getState: () => storeMock,
  },
}));

vi.mock('../../frontend/src/lib/stores/telemetry.js', () => ({
  useTelemetryStore: {
    getState: () => telemetryMock,
  },
}));

vi.mock('../../frontend/src/lib/stores/auth.js', () => ({
  useAuthStore: {
    getState: () => authMock,
  },
}));

vi.mock('../../frontend/src/lib/stores/ui.js', () => ({
  useUiStore: {
    getState: () => uiMock,
  },
}));

import { useEventSocket } from '../../frontend/src/hooks/useEventSocket.js';
import { useChannelActivityStore } from '../../frontend/src/lib/stores/channel-activity.js';
import { useChannelAgentStatusStore } from '../../frontend/src/lib/stores/channel-agent-status.js';

describe('useEventSocket repo-scoped refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    effectState.cleanup = undefined;
    wsMock.onMessage = undefined;
    wsMock.onOpen = undefined;
    wsMock.onConnectionState = undefined;
    storeMock.activeSessionId = null;
    storeMock.backendConnectionStatus = 'connected';
    storeMock.sessions = [];
    storeMock.worktrees = [];
    apiMock.fetchHubNodes.mockResolvedValue([]);
  });

  function makeQueryClient(
    cachedNodes?: unknown[],
    seedCache: Record<string, unknown> = {}
  ): any {
    let nodes = cachedNodes;
    return {
      invalidateQueries: vi.fn(),
      setQueryData: vi.fn((_queryKey, updater) => {
        nodes = typeof updater === 'function' ? updater(nodes) : updater;
      }),
      getQueryData: vi.fn((queryKey: unknown[]) =>
        queryKey[0] === 'hub-nodes' ? nodes : seedCache[JSON.stringify(queryKey)]
      ),
      get nodes() {
        return nodes;
      },
    };
  }

  function mount(queryClient = makeQueryClient()): void {
    useEventSocket({
      authAuthenticated: true,
      queryClient,
      throttledChangedFilesRefresh: vi.fn(),
      setChangedFilesData: vi.fn(),
    });
  }

  it('forces all visible repo enrichment on websocket reconnect after the initial open', async () => {
    mount();

    wsMock.onOpen?.();
    expect(storeMock.ensureFreshAll).not.toHaveBeenCalled();

    wsMock.onOpen?.();

    await vi.waitFor(() =>
      expect(storeMock.ensureFreshAll).toHaveBeenCalledWith(0)
    );
    expect(apiMock.fetchHubNodes).toHaveBeenCalledTimes(1);
    expect(telemetryMock.refreshTelemetry).toHaveBeenCalledTimes(2);
  });

  it('refreshes sessions, worktrees, dashboard, and file data after websocket reconnect', async () => {
    const queryClient = makeQueryClient();
    const changedFilesRefresh = vi.fn();
    useEventSocket({
      authAuthenticated: true,
      queryClient,
      throttledChangedFilesRefresh: changedFilesRefresh,
      setChangedFilesData: vi.fn(),
    });

    wsMock.onOpen?.();
    wsMock.onOpen?.();
    await vi.waitFor(() =>
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['dashboard'],
      })
    );

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['dashboard'],
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['files-list'],
    });
    expect(changedFilesRefresh).toHaveBeenCalled();
  });

  it('applies node.status events to the hub-nodes query cache without polling', () => {
    const queryClient = makeQueryClient([
      {
        nodeId: 'node-a',
        displayName: 'build box',
        hostname: 'old-host',
        platform: 'darwin',
        arch: 'arm64',
        relayVersion: '1.0.0',
        protocolVersion: '1.0',
        status: 'online',
        connection: { route: 'reverse-link', status: 'connected' },
        trust: { state: 'active', level: 'privileged-local-user' },
        credentialState: 'active',
        version: {
          state: 'compatible',
          nodeProtocolVersion: '1.0',
          hubProtocolVersion: '1.0',
        },
        capabilities: {
          totals: { available: 0, degraded: 0, unavailable: 0, unknown: 0 },
          core: {},
          agents: {},
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        pairedAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
        credentialId: 'cred-a',
      },
    ]);
    mount(queryClient);

    wsMock.onMessage?.({
      type: 'node.status',
      nodeId: 'node-a',
      status: 'offline',
      lastSeenAt: '2026-01-01T00:02:00.000Z',
    });

    expect(queryClient.nodes).toMatchObject([
      {
        nodeId: 'node-a',
        status: 'offline',
        connection: { route: 'reverse-link', status: 'offline' },
        lastSeenAt: '2026-01-01T00:02:00.000Z',
      },
    ]);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['hub-nodes'],
    });
  });

  it('marks backend restart state and preserves the active pty session for reconnect', () => {
    storeMock.activeSessionId = 'sess-a';
    storeMock.sessions = [
      { id: 'sess-a', repoPath: '/repos/relay-ide', mode: 'pty' },
    ];
    mount();

    wsMock.onMessage?.({ type: 'server-restarting', reason: 'dev-restart' });

    expect(storeMock.setBackendConnectionStatus).toHaveBeenCalledWith(
      'restarting'
    );
    expect(storeMock.beginPtyReconnect).toHaveBeenCalledWith('sess-a');
  });

  it('mirrors event socket reconnect status without auth fallback', () => {
    mount();

    wsMock.onConnectionState?.('reconnecting');
    wsMock.onConnectionState?.('connected');

    expect(storeMock.setBackendConnectionStatus).toHaveBeenNthCalledWith(
      1,
      'reconnecting'
    );
    expect(storeMock.setBackendConnectionStatus).toHaveBeenNthCalledWith(
      2,
      'connected'
    );
  });

  it('keeps the explicit restarting label until reconnect succeeds', () => {
    mount();

    wsMock.onMessage?.({ type: 'server-restarting', reason: 'dev-restart' });
    storeMock.backendConnectionStatus = 'restarting';
    wsMock.onConnectionState?.('reconnecting');
    wsMock.onConnectionState?.('connected');

    expect(storeMock.setBackendConnectionStatus).not.toHaveBeenCalledWith(
      'reconnecting'
    );
    expect(storeMock.setBackendConnectionStatus).toHaveBeenLastCalledWith(
      'connected'
    );
  });

  it('throttles pr-updated events but force-refreshes only repos listed in the payload', () => {
    mount();

    wsMock.onMessage?.({
      type: 'pr-updated',
      workspacePaths: ['/repos/relay-ide'],
      repos: ['donovan-yohan/hermes-agent'],
    });
    vi.advanceTimersByTime(500);

    expect(storeMock.forceRefresh).toHaveBeenCalledTimes(2);
    expect(storeMock.forceRefresh).toHaveBeenNthCalledWith(
      1,
      '/repos/relay-ide',
      'webhook'
    );
    expect(storeMock.forceRefresh).toHaveBeenNthCalledWith(
      2,
      '/repos/hermes-agent',
      'webhook'
    );
    expect(storeMock.ensureFreshAll).not.toHaveBeenCalled();
  });

  it('force-refreshes the affected repo for session end, branch change, and ref change without a debounce timer', () => {
    storeMock.sessions = [{ id: 's1', repoPath: '/repos/relay-ide' }];
    mount();

    wsMock.onMessage?.({ type: 'session-ended', sessionId: 's1' });
    wsMock.onMessage?.({
      type: 'session-branch-changed',
      sessionId: 's1',
      branch: 'feature',
      cwdPath: '/repos/relay-ide',
    });
    wsMock.onMessage?.({ type: 'ref-changed', cwdPath: '/repos/hermes-agent' });

    expect(storeMock.forceRefresh).toHaveBeenCalledWith(
      '/repos/relay-ide',
      'manual'
    );
    expect(storeMock.forceRefresh).toHaveBeenCalledWith(
      '/repos/hermes-agent',
      'manual'
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps worktree event paths back to the canonical repo before force-refreshing', () => {
    storeMock.worktrees = [
      {
        path: '/repos/relay-ide/.worktrees/feature-a',
        repoPath: '/repos/relay-ide',
      },
    ];
    storeMock.sessions = [
      {
        id: 's1',
        repoPath: '/repos/relay-ide',
        worktreePath: '/repos/relay-ide/.worktrees/feature-a',
        cwd: '/repos/relay-ide/.worktrees/feature-a/packages/app',
      },
    ];
    mount();

    wsMock.onMessage?.({
      type: 'session-branch-changed',
      sessionId: 's1',
      branch: 'feature',
      cwdPath: '/repos/relay-ide/.worktrees/feature-a',
    });
    wsMock.onMessage?.({
      type: 'session-ended',
      sessionId: 's1',
      cwd: '/repos/relay-ide/.worktrees/feature-a/packages/app/src',
    });
    wsMock.onMessage?.({
      type: 'ref-changed',
      cwdPath: '/repos/relay-ide/.worktrees/feature-a',
    });

    expect(storeMock.forceRefresh).toHaveBeenCalledTimes(3);
    expect(storeMock.forceRefresh).toHaveBeenNthCalledWith(
      1,
      '/repos/relay-ide',
      'manual'
    );
    expect(storeMock.forceRefresh).toHaveBeenNthCalledWith(
      2,
      '/repos/relay-ide',
      'manual'
    );
    expect(storeMock.forceRefresh).toHaveBeenNthCalledWith(
      3,
      '/repos/relay-ide',
      'manual'
    );
    expect(storeMock.forceRefresh).not.toHaveBeenCalledWith(
      '/repos/relay-ide/.worktrees/feature-a',
      'manual'
    );
  });

  it('passes node/global session scope through telemetry events', () => {
    mount();
    const telemetry = {
      sessionId: 'same-local-id',
      totalInputTokens: 22,
    };

    wsMock.onMessage?.({
      type: 'session-telemetry',
      sessionId: 'same-local-id',
      localSessionId: 'same-local-id',
      nodeId: 'node-b',
      globalSessionId: 'node-b:same-local-id',
      data: telemetry,
    });

    expect(telemetryMock.handleSessionTelemetryEvent).toHaveBeenCalledWith(
      'same-local-id',
      telemetry,
      {
        sessionId: 'same-local-id',
        localSessionId: 'same-local-id',
        nodeId: 'node-b',
        globalSessionId: 'node-b:same-local-id',
      }
    );
  });

  it('cleanup cancels pending pr/ci throttle timers', () => {
    mount();

    wsMock.onMessage?.({
      type: 'ci-updated',
      workspacePaths: ['/repos/relay-ide'],
    });
    expect(vi.getTimerCount()).toBe(1);

    if (effectState.cleanup) effectState.cleanup();

    expect(vi.getTimerCount()).toBe(0);
  });

  // #1287 Slice 3 item 15: channel-activity / channel-agent-status broadcasts
  // carry no row payload, so an agent-created channel (#1242) and a newly bound
  // agent were both invisible until an unrelated refetch happened to run.
  describe('channel list + roster invalidation', () => {
    const LISTED_CHANNEL = 'topic-listed';
    const NEW_CHANNEL = 'topic-agent-created';

    /** Caches shaped like a rail that has loaded both of its list queries. */
    function seededLists(): Record<string, unknown> {
      return {
        '["channels"]': [{ id: LISTED_CHANNEL, latestSeq: 4 }],
        '["workspace-topics"]': { topics: [{ id: LISTED_CHANNEL }] },
      };
    }

    beforeEach(() => {
      useChannelActivityStore.setState({
        latestSeqByChannel: {},
        lastReadByChannel: {},
        clampedAtByChannel: {},
      });
      useChannelAgentStatusStore.setState({
        statusByChannelAgent: {},
        runtimeByChannelAgent: {},
        updatedAtByChannelAgent: {},
      });
    });

    it('refetches the topic and channel lists when activity names a channel no cached list holds', () => {
      const queryClient = makeQueryClient(undefined, seededLists());
      mount(queryClient);

      wsMock.onMessage?.({
        type: 'channel-activity',
        channelId: NEW_CHANNEL,
        latestSeq: 1,
      });
      vi.advanceTimersByTime(750);

      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['workspace-topics'],
      });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['channels'],
      });
      expect(
        useChannelActivityStore.getState().latestSeqByChannel[NEW_CHANNEL]
      ).toBe(1);
    });

    it('leaves the lists alone when the channel already has a cached row', () => {
      const queryClient = makeQueryClient(undefined, seededLists());
      mount(queryClient);

      wsMock.onMessage?.({
        type: 'channel-activity',
        channelId: LISTED_CHANNEL,
        latestSeq: 9,
      });

      expect(vi.getTimerCount()).toBe(0);
      expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
        queryKey: ['channels'],
      });
    });

    it('skips the refetch entirely when no list has loaded yet', () => {
      const queryClient = makeQueryClient();
      mount(queryClient);

      wsMock.onMessage?.({
        type: 'channel-activity',
        channelId: NEW_CHANNEL,
        latestSeq: 1,
      });

      expect(vi.getTimerCount()).toBe(0);
    });

    it('debounces an unknown-channel burst into a single list refetch', () => {
      const queryClient = makeQueryClient(undefined, seededLists());
      mount(queryClient);

      for (const latestSeq of [1, 2, 3]) {
        wsMock.onMessage?.({
          type: 'channel-activity',
          channelId: NEW_CHANNEL,
          latestSeq,
        });
      }
      vi.advanceTimersByTime(750);

      const channelListInvalidations =
        queryClient.invalidateQueries.mock.calls.filter(
          (call: [{ queryKey: unknown[] }]) => call[0].queryKey[0] === 'channels'
        );
      expect(channelListInvalidations).toHaveLength(1);
    });

    it('routes new head seqs through the clamp-fenced seed path, never a direct store write', () => {
      const seedSpy = vi.spyOn(
        useChannelActivityStore.getState(),
        'seedChannelActivity'
      );
      const queryClient = makeQueryClient(undefined, seededLists());
      mount(queryClient);

      wsMock.onMessage?.({
        type: 'channel-activity',
        channelId: NEW_CHANNEL,
        latestSeq: 1,
      });
      vi.advanceTimersByTime(750);

      expect(seedSpy).not.toHaveBeenCalled();
      expect(useChannelActivityStore.getState().clampedAtByChannel).toEqual({});
      seedSpy.mockRestore();
    });

    it('refreshes the roster of every channel an agent status event touched', () => {
      const queryClient = makeQueryClient(undefined, seededLists());
      mount(queryClient);

      wsMock.onMessage?.({
        type: 'channel-agent-status',
        channelId: 'ch-a',
        agentId: 'agent:claude',
        status: 'spawning',
        runtimeId: 'rt-1',
      });
      wsMock.onMessage?.({
        type: 'channel-agent-status',
        channelId: 'ch-a',
        agentId: 'agent:claude',
        status: 'idle',
        runtimeId: 'rt-1',
      });
      wsMock.onMessage?.({
        type: 'channel-agent-status',
        channelId: 'ch-b',
        agentId: 'agent:codex',
        status: 'thinking',
        runtimeId: 'rt-2',
      });
      vi.advanceTimersByTime(750);

      const rosterInvalidations =
        queryClient.invalidateQueries.mock.calls.filter(
          (call: [{ queryKey: unknown[] }]) =>
            call[0].queryKey[0] === 'channel-roster'
        );
      expect(rosterInvalidations.map((call: any) => call[0].queryKey)).toEqual([
        ['channel-roster', 'ch-a'],
        ['channel-roster', 'ch-b'],
      ]);
    });

    it('cleanup cancels pending list and roster timers', () => {
      const queryClient = makeQueryClient(undefined, seededLists());
      mount(queryClient);

      wsMock.onMessage?.({
        type: 'channel-activity',
        channelId: NEW_CHANNEL,
        latestSeq: 1,
      });
      wsMock.onMessage?.({
        type: 'channel-agent-status',
        channelId: 'ch-a',
        agentId: 'agent:claude',
        status: 'thinking',
        runtimeId: 'rt-1',
      });
      expect(vi.getTimerCount()).toBe(2);

      if (effectState.cleanup) effectState.cleanup();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
