// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dmChannelTopicId } from '../../shared/dm-channels.js';

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
const { HttpError } = await import('../../frontend/src/lib/api.js');

const CHANNEL_ID = 'topic:operator-lane';
const CODEX_DM_CHANNEL_ID = dmChannelTopicId('codex', 'ws:local');

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
  it('waits for confirmed topic identity before offering designation', async () => {
    let resolveTopic:
      | ((topic: ReturnType<typeof topicFixture>) => void)
      | null = null;
    mocks.fetchWorkspaceTopic.mockReturnValue(
      new Promise<ReturnType<typeof topicFixture>>((resolve) => {
        resolveTopic = resolve;
      })
    );
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('implementer')]);

    await render();

    expect(container.querySelector('.ch-designate-orchestrator')).toBeNull();

    resolveTopic?.(topicFixture());
    await flush();

    expect(
      container.querySelector('.ch-designate-orchestrator')
    ).not.toBeNull();
  });

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

  it('never offers designation in a confirmed DM', async () => {
    mocks.fetchWorkspaceTopic.mockResolvedValue({
      id: CODEX_DM_CHANNEL_ID,
      workspaceId: 'ws:local',
      display: { title: 'Codex' },
      routingDefaults: { providerId: 'codex' },
    });
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('implementer')]);

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(ChannelView, { channelId: CODEX_DM_CHANNEL_ID })
        )
      );
    });
    await flush();

    expect(container.querySelector('.ch-designate-orchestrator')).toBeNull();
    expect(mocks.designateChannelOrchestrator).not.toHaveBeenCalled();
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

  it('shows the bound non-orchestrator conflict beside the control', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('implementer')]);
    mocks.designateChannelOrchestrator.mockRejectedValue(
      new HttpError(
        409,
        'channel already bound to a non-orchestrator runtime',
        'SESSION_CONFLICT',
        false,
        { reasonCode: 'CHANNEL_ROLE_CONFLICT' }
      )
    );

    await render();

    const designate = container.querySelector<HTMLButtonElement>(
      '.ch-designate-orchestrator'
    );
    await act(async () => designate?.click());

    expect(
      container.querySelector('.ch-designate-orchestrator__error')?.textContent
    ).toBe('channel already has a non-orchestrator agent bound');
    expect(designate?.disabled).toBe(false);
  });

  it('shows the conflict copy for a SESSION_CONFLICT without details', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('implementer')]);
    mocks.designateChannelOrchestrator.mockRejectedValue(
      new HttpError(409, 'session conflict', 'SESSION_CONFLICT')
    );

    await render();

    const designate = container.querySelector<HTMLButtonElement>(
      '.ch-designate-orchestrator'
    );
    await act(async () => designate?.click());

    expect(
      container.querySelector('.ch-designate-orchestrator__error')?.textContent
    ).toBe('channel already has a non-orchestrator agent bound');
  });

  it('shows a useful generic error and clears it for a retry', async () => {
    mocks.fetchChannelRoster.mockResolvedValue([rosterEntry('implementer')]);
    mocks.designateChannelOrchestrator.mockRejectedValueOnce(
      new HttpError(503, 'hub unreachable')
    );

    await render();

    const designate = container.querySelector<HTMLButtonElement>(
      '.ch-designate-orchestrator'
    );
    await act(async () => designate?.click());

    expect(
      container.querySelector('.ch-designate-orchestrator__error')?.textContent
    ).toBe('could not designate orchestrator — try again');

    let resolveDesignation: (() => void) | null = null;
    mocks.designateChannelOrchestrator.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDesignation = resolve;
      })
    );
    act(() => designate?.click());
    await flush();

    expect(
      container.querySelector('.ch-designate-orchestrator__error')
    ).toBeNull();

    resolveDesignation?.();
    await flush();
  });

  it('retires a lost-response failure when the roster confirms the orchestrator', async () => {
    let roster = [rosterEntry('implementer')];
    mocks.fetchChannelRoster.mockImplementation(async () => roster);
    mocks.designateChannelOrchestrator.mockRejectedValue(
      new HttpError(503, 'designation response was lost')
    );

    await render();

    const designate = container.querySelector<HTMLButtonElement>(
      '.ch-designate-orchestrator'
    );
    await act(async () => designate?.click());

    expect(
      container.querySelector('.ch-designate-orchestrator__error')?.textContent
    ).toBe('could not designate orchestrator — try again');

    roster = [rosterEntry('orchestrator')];
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['channel-roster', CHANNEL_ID],
      });
    });
    await flush();

    expect(container.querySelector('.ch-agent-chip__role')?.textContent).toBe(
      'orchestrator'
    );
    expect(container.querySelector('.ch-designate-orchestrator')).toBeNull();
    expect(
      container.querySelector('.ch-designate-orchestrator__error')
    ).toBeNull();
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
