// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelMessageId } from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  fetchWorkspaceTopic: vi.fn(),
  fetchChannelRoster: vi.fn(),
  interruptChannelAgent: vi.fn(),
  restartChannelAgentRuntimes: vi.fn(),
}));

vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../frontend/src/lib/api.js')>();
  return {
    ...actual,
    fetchWorkspaceTopic: mocks.fetchWorkspaceTopic,
    fetchChannelRoster: mocks.fetchChannelRoster,
    interruptChannelAgent: mocks.interruptChannelAgent,
    restartChannelAgentRuntimes: mocks.restartChannelAgentRuntimes,
  };
});

vi.mock('../../frontend/src/hooks/useChannelChatSocket.js', () => ({
  useChannelChatSocket: (channelId: string) => ({
    channel: {
      id: channelId,
      title: channelId,
      visibility: 'default',
      archived: false,
      latestSeq: 0,
      messageCount: 0,
      lastMessage: null,
      members: [],
    },
    reducer: {
      channelId,
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
  ChannelThreadPanel: ({ rootId }: { rootId: string }) =>
    React.createElement('div', { 'data-thread-root': rootId }),
}));

const { ChannelView } =
  await import('../../frontend/src/components/chat/ChannelView.js');
const { useUiStore } = await import('../../frontend/src/lib/stores/ui.js');
const { useChannelAgentStatusStore } =
  await import('../../frontend/src/lib/stores/channel-agent-status.js');

const CHANNEL_ID = 'topic:alpha';
const OTHER_CHANNEL_ID = 'topic:beta';
const ROOT_ID = 'chm:root-1' as ChannelMessageId;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(channelId: string): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        // ChatHome keys ChannelView by channel id, so a channel switch is a
        // remount — mirror that here rather than mutating a prop.
        React.createElement(ChannelView, { channelId, key: channelId })
      )
    );
  });
  await flush();
}

function openThreadRoot(): string | null {
  return (
    container
      .querySelector<HTMLElement>('[data-thread-root]')
      ?.getAttribute('data-thread-root') ?? null
  );
}

beforeEach(() => {
  mocks.fetchWorkspaceTopic.mockReset();
  mocks.fetchChannelRoster.mockReset();
  mocks.interruptChannelAgent.mockReset();
  mocks.restartChannelAgentRuntimes.mockReset();
  mocks.fetchWorkspaceTopic.mockResolvedValue({
    id: CHANNEL_ID,
    workspaceId: 'ws:local',
    display: { title: CHANNEL_ID },
    routingDefaults: {},
  });
  mocks.fetchChannelRoster.mockResolvedValue([]);
  mocks.interruptChannelAgent.mockResolvedValue(undefined);
  mocks.restartChannelAgentRuntimes.mockResolvedValue({ restarted: 1 });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  useUiStore.setState({
    activeChannelId: null,
    activeThreadRootId: null,
    pendingChannelThread: null,
  });
  useChannelAgentStatusStore.setState({
    statusByChannelAgent: {},
    runtimeByChannelAgent: {},
    queuedCountByChannelAgent: {},
    steeringCountByChannelAgent: {},
    steerSupportedByChannelAgent: {},
    queueDrainSeqByChannelAgent: {},
    updatedAtByChannelAgent: {},
  });
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
  useUiStore.setState({
    activeChannelId: null,
    activeThreadRootId: null,
    pendingChannelThread: null,
  });
});

// #1287 slice 5 item 18: the rail can now ask a channel to open WITH one of its
// threads showing. The intent exists because the obvious encoding does not
// survive: `setActiveChannelId` clears `activeThreadRootId`, and ChannelView
// clears it again on every channel switch.
describe('ChannelView thread-open intent (#1287 slice 5 item 18)', () => {
  it('opens the requested thread panel on a cold channel open', async () => {
    useUiStore.getState().setActiveChannelId(CHANNEL_ID);
    useUiStore.getState().requestChannelThread(CHANNEL_ID, ROOT_ID);

    await render(CHANNEL_ID);

    expect(openThreadRoot()).toBe(ROOT_ID);
    // Consumed exactly once, so a later channel visit does not re-open it.
    expect(useUiStore.getState().pendingChannelThread).toBeNull();
  });

  it('opens a thread in the channel that is already on screen', async () => {
    useUiStore.getState().setActiveChannelId(CHANNEL_ID);
    await render(CHANNEL_ID);
    expect(openThreadRoot()).toBeNull();

    // No remount here: `channelId` never changes, so an effect keyed on it
    // alone would never see this request.
    await act(async () => {
      useUiStore.getState().requestChannelThread(CHANNEL_ID, ROOT_ID);
    });
    await flush();

    expect(openThreadRoot()).toBe(ROOT_ID);
    expect(useUiStore.getState().pendingChannelThread).toBeNull();
  });

  it('ignores an intent addressed to a different channel', async () => {
    useUiStore.getState().setActiveChannelId(OTHER_CHANNEL_ID);
    useUiStore.getState().requestChannelThread(OTHER_CHANNEL_ID, ROOT_ID);

    await render(CHANNEL_ID);

    expect(openThreadRoot()).toBeNull();
    // Still pending: it belongs to the other channel, which has not opened yet.
    expect(useUiStore.getState().pendingChannelThread).toEqual({
      channelId: OTHER_CHANNEL_ID,
      rootMessageId: ROOT_ID,
    });
  });

  it('drops an un-consumed intent when a plain channel open supersedes it', async () => {
    useUiStore.getState().requestChannelThread(OTHER_CHANNEL_ID, ROOT_ID);
    // A navigation elsewhere cancels the request rather than latching it for
    // whenever that channel is next opened.
    useUiStore.getState().setActiveChannelId(CHANNEL_ID);
    expect(useUiStore.getState().pendingChannelThread).toBeNull();

    await render(OTHER_CHANNEL_ID);
    expect(openThreadRoot()).toBeNull();
  });

  it('closes the thread panel when the channel changes', async () => {
    useUiStore.getState().setActiveChannelId(CHANNEL_ID);
    useUiStore.getState().requestChannelThread(CHANNEL_ID, ROOT_ID);
    await render(CHANNEL_ID);
    expect(openThreadRoot()).toBe(ROOT_ID);

    useUiStore.getState().setActiveChannelId(OTHER_CHANNEL_ID);
    await render(OTHER_CHANNEL_ID);

    expect(openThreadRoot()).toBeNull();
    expect(useUiStore.getState().activeThreadRootId).toBeNull();
  });

  it('keeps stop and instruction apply scoped to the open conversation', async () => {
    useUiStore.getState().setActiveChannelId(CHANNEL_ID);
    useUiStore.getState().requestChannelThread(CHANNEL_ID, ROOT_ID);
    await render(CHANNEL_ID);
    useChannelAgentStatusStore
      .getState()
      .recordStatus(
        CHANNEL_ID,
        'agent-profile:mock:default',
        'streaming',
        'runtime:thread',
        0,
        0,
        false,
        ROOT_ID
      );
    await flush();

    const stop = container.querySelector<HTMLButtonElement>(
      '.ch-agent-chip__stop'
    );
    expect(stop?.getAttribute('aria-label')).toContain('in conversation');
    await act(async () => stop?.click());
    expect(mocks.interruptChannelAgent).toHaveBeenCalledWith(
      CHANNEL_ID,
      'agent-profile:mock:default',
      ROOT_ID
    );

    const apply = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'apply instructions');
    await act(async () => apply?.click());
    await flush();
    expect(mocks.restartChannelAgentRuntimes).toHaveBeenCalledWith(
      CHANNEL_ID,
      ROOT_ID
    );
  });
});
