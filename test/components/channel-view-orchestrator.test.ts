// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  fetchWorkspaceTopic: vi.fn(),
  fetchChannelRoster: vi.fn(),
  designateChannelOrchestrator: vi.fn(),
}));

vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../frontend/src/lib/api.js')>();
  return {
    ...actual,
    fetchWorkspaceTopic: mocks.fetchWorkspaceTopic,
    fetchChannelRoster: mocks.fetchChannelRoster,
    designateChannelOrchestrator: mocks.designateChannelOrchestrator,
  };
});

vi.mock('../../frontend/src/hooks/useChannelChatSocket.js', () => ({
  useChannelChatSocket: () => ({
    channel: {
      id: 'topic:operator-lane',
      title: 'operator lane',
      visibility: 'default',
      archived: false,
      latestSeq: 0,
      messageCount: 0,
      lastMessage: null,
      members: [],
    },
    reducer: {
      channelId: 'topic:operator-lane',
      messages: [],
      lastSeq: 0,
      needsCatchup: false,
      inFlight: [],
      truncated: false,
    },
    connected: true,
    disconnected: false,
    notFound: false,
    hasMoreOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    fullSnapshotRevision: 0,
    post: vi.fn(),
    postPending: false,
    postError: null,
    resync: vi.fn(),
  }),
}));

vi.mock('../../frontend/src/components/chat/ChannelTimeline.js', () => ({
  ChannelTimeline: () => null,
}));
vi.mock('../../frontend/src/components/chat/ChannelComposer.js', () => ({
  ChannelComposer: () => null,
}));
vi.mock('../../frontend/src/components/chat/ChannelThreadPanel.js', () => ({
  ChannelThreadPanel: () => null,
}));

const { ChannelView } =
  await import('../../frontend/src/components/chat/ChannelView.js');

const CHANNEL_ID = 'topic:operator-lane';

function topicFixture() {
  return {
    id: CHANNEL_ID,
    workspaceId: 'workspace:local',
    display: { title: 'operator lane' },
    routingDefaults: {},
  };
}

function rosterEntry(role?: 'orchestrator' | 'implementer') {
  return {
    id: 'claude',
    displayName: 'claude',
    kind: 'framework' as const,
    available: true,
    reason: null,
    ...(role ? { role } : {}),
    binding: {
      runtimeId: 'runtime:claude-1',
      status: 'idle' as const,
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush(): Promise<void> {
  // Drain several macrotasks per flush: resolving a mocked query promise takes
  // a microtask to settle, then TanStack Query flips isSuccess and schedules a
  // re-render on a later tick — a single setTimeout(0) intermittently observed
  // the DOM before the designate control re-rendered (flaky "expected null not
  // to be null"). A few ticks reliably drains the resolve → re-render chain.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ChannelView, { channelId: CHANNEL_ID })
      )
    );
  });
  await flush();
}

beforeEach(() => {
  mocks.fetchWorkspaceTopic.mockReset();
  mocks.fetchChannelRoster.mockReset();
  mocks.designateChannelOrchestrator.mockReset();
  mocks.fetchWorkspaceTopic.mockResolvedValue(topicFixture());
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ChannelView orchestrator control (#1242)', () => {
  it('waits for the roster before offering designation', async () => {
    let resolveRoster:
      | ((entries: ReturnType<typeof rosterEntry>[]) => void)
      | null = null;
    mocks.fetchChannelRoster.mockReturnValue(
      new Promise<ReturnType<typeof rosterEntry>[]>((resolve) => {
        resolveRoster = resolve;
      })
    );

    await render();

    expect(container.querySelector('.ch-designate-orchestrator')).toBeNull();

    resolveRoster?.([rosterEntry('implementer')]);
    await flush();

    expect(
      container.querySelector('.ch-designate-orchestrator')
    ).not.toBeNull();
  });

  it('designates from the missing-orchestrator header and invalidates its roster', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('implementer')]);
    mocks.designateChannelOrchestrator.mockResolvedValue({
      ok: true,
      orchestrator: {
        runtimeId: 'runtime:orchestrator-1',
        status: 'idle',
        framework: 'claude',
      },
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await render();

    const designate = container.querySelector<HTMLButtonElement>(
      '.ch-designate-orchestrator'
    );
    expect(designate?.textContent).toContain('designate orchestrator');

    await act(async () => designate?.click());

    expect(mocks.designateChannelOrchestrator).toHaveBeenCalledWith(CHANNEL_ID);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['channel-roster', CHANNEL_ID],
    });
  });

  it('uses the braille text-motion state while designation is pending', async () => {
    let resolveDesignation: (() => void) | null = null;
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('implementer')]);
    mocks.designateChannelOrchestrator.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDesignation = resolve;
      })
    );

    await render();

    const designate = container.querySelector<HTMLButtonElement>(
      '.ch-designate-orchestrator'
    );
    act(() => designate?.click());
    await flush();

    expect(designate?.disabled).toBe(true);
    expect(designate?.textContent).toContain('designating');
    expect(designate?.querySelector('[role="status"]')).not.toBeNull();

    resolveDesignation?.();
    await flush();
  });

  it('marks a roster orchestrator with the compact lowercase role tag', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('orchestrator')]);

    await render();

    const chip = container.querySelector('.ch-agent-chip');
    expect(chip?.textContent).toContain('orchestrator');
    expect(chip?.querySelector('.ch-agent-chip__role')?.textContent).toBe(
      'orchestrator'
    );
    expect(container.querySelector('.ch-designate-orchestrator')).toBeNull();
  });
});
