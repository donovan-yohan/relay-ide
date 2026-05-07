import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMessage } from '../../frontend/src/lib/ws.js';

const effectState = vi.hoisted(() => ({
  cleanup: undefined as void | (() => void),
}));

const wsMock = vi.hoisted(() => ({
  onMessage: undefined as undefined | ((msg: EventMessage) => void),
  onOpen: undefined as undefined | (() => void),
  connectEventSocket: vi.fn(
    (onMessage: (msg: EventMessage) => void, onOpen?: () => void) => {
      wsMock.onMessage = onMessage;
      wsMock.onOpen = onOpen;
    }
  ),
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
  activeSessionId: null as string | null,
  sessions: [] as Array<{ id: string; repoPath: string; worktreePath?: string | null }>,
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

describe('useEventSocket repo-scoped refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    effectState.cleanup = undefined;
    wsMock.onMessage = undefined;
    wsMock.onOpen = undefined;
    storeMock.activeSessionId = null;
    storeMock.sessions = [];
  });

  function mount(): void {
    useEventSocket({
      authAuthenticated: true,
      queryClient: { invalidateQueries: vi.fn() } as any,
      throttledChangedFilesRefresh: vi.fn(),
      setChangedFilesData: vi.fn(),
    });
  }

  it('forces all visible repo enrichment on websocket reconnect after the initial open', () => {
    mount();

    wsMock.onOpen?.();
    expect(storeMock.ensureFreshAll).not.toHaveBeenCalled();

    wsMock.onOpen?.();

    expect(storeMock.ensureFreshAll).toHaveBeenCalledWith(0);
    expect(telemetryMock.refreshTelemetry).toHaveBeenCalledTimes(2);
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
    expect(storeMock.forceRefresh).toHaveBeenNthCalledWith(1, '/repos/relay-ide', 'webhook');
    expect(storeMock.forceRefresh).toHaveBeenNthCalledWith(2, '/repos/hermes-agent', 'webhook');
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

    expect(storeMock.forceRefresh).toHaveBeenCalledWith('/repos/relay-ide', 'manual');
    expect(storeMock.forceRefresh).toHaveBeenCalledWith('/repos/hermes-agent', 'manual');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleanup cancels pending pr/ci throttle timers', () => {
    mount();

    wsMock.onMessage?.({ type: 'ci-updated', workspacePaths: ['/repos/relay-ide'] });
    expect(vi.getTimerCount()).toBe(1);

    if (effectState.cleanup) effectState.cleanup();

    expect(vi.getTimerCount()).toBe(0);
  });
});
