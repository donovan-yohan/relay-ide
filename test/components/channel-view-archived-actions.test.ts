// @vitest-environment happy-dom
//
// #1308 slice 1 — an archived channel is READ-ONLY, and the row action lanes
// must agree with the routes. Edit and delete were already fenced; retry was
// not, even though it spawns/reuses an agent runtime, writes a durable
// `retrying @…` system row and appends a whole new agent turn. These assertions
// read the props `ChannelView` hands the timeline, because that single spread is
// where the fence lives.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelMessage } from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL_ID = 'topic:operator-lane';

const mocks = vi.hoisted(() => ({
  fetchWorkspaceTopic: vi.fn(),
  fetchChannelRoster: vi.fn(),
  archived: false,
  timelineProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../frontend/src/lib/api.js')>();
  return {
    ...actual,
    fetchWorkspaceTopic: mocks.fetchWorkspaceTopic,
    fetchChannelRoster: mocks.fetchChannelRoster,
  };
});

const message: ChannelMessage = {
  schemaVersion: 1,
  id: 'chm:row-1' as ChannelMessage['id'],
  channelId: CHANNEL_ID,
  seq: 1,
  kind: 'message',
  status: 'complete',
  sender: { kind: 'human', id: 'human:operator' },
  body: { text: 'hello', format: 'text' },
  threadId: null,
  parentMessageId: null,
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
};

vi.mock('../../frontend/src/hooks/useChannelChatSocket.js', () => ({
  useChannelChatSocket: () => ({
    channel: {
      id: CHANNEL_ID,
      title: 'operator lane',
      visibility: 'default',
      archived: mocks.archived,
      latestSeq: 1,
      messageCount: 1,
      lastMessage: null,
      members: [],
    },
    reducer: {
      channelId: CHANNEL_ID,
      messages: [message],
      lastSeq: 1,
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
    fullSnapshotRevision: 1,
    post: vi.fn(),
    postPending: false,
    postError: null,
    resync: vi.fn(),
  }),
}));

// Capture what the timeline is handed — the fence is a props spread, so the
// props ARE the behaviour under test.
vi.mock('../../frontend/src/components/chat/ChannelTimeline.js', () => ({
  ChannelTimeline: (props: Record<string, unknown>) => {
    mocks.timelineProps.push(props);
    return null;
  },
}));
vi.mock('../../frontend/src/components/chat/ChannelComposer.js', () => ({
  ChannelComposer: () => null,
}));
vi.mock('../../frontend/src/components/chat/ChannelThreadPanel.js', () => ({
  ChannelThreadPanel: () => null,
}));

const { ChannelView } = await import(
  '../../frontend/src/components/chat/ChannelView.js'
);

describe('ChannelView row actions — archived fence (#1308)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  async function mount(): Promise<Record<string, unknown>> {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(ChannelView, { channelId: CHANNEL_ID })
        )
      );
    });
    await act(async () => {});
    const last = mocks.timelineProps[mocks.timelineProps.length - 1];
    expect(last).toBeDefined();
    return last!;
  }

  beforeEach(() => {
    mocks.fetchWorkspaceTopic.mockResolvedValue({
      id: CHANNEL_ID,
      workspaceId: 'ws:local',
      display: { title: 'operator lane' },
      routingDefaults: {},
    });
    mocks.fetchChannelRoster.mockResolvedValue([]);
    mocks.timelineProps = [];
    mocks.archived = false;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  it('wires retry, edit and delete on a live channel', async () => {
    const props = await mount();
    expect(typeof props['onRetryMessage']).toBe('function');
    expect(typeof props['onEditMessage']).toBe('function');
    expect(typeof props['onDeleteMessage']).toBe('function');
  });

  it('withholds retry along with edit and delete once the channel is archived', async () => {
    mocks.archived = true;
    const props = await mount();
    // Retry is a WRITE: the route answers CHANNEL_ARCHIVED, so rendering the
    // affordance would be a button whose only outcome is an error toast.
    expect(props['onRetryMessage']).toBeUndefined();
    expect(props['onEditMessage']).toBeUndefined();
    expect(props['onDeleteMessage']).toBeUndefined();
  });
});
