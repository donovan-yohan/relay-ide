// @vitest-environment happy-dom
//
// #1308 slice 1 item 1 — deep-link jump. The real `ChannelTimeline` /
// `ChannelMessageRow` render here on purpose: the anchor resolves against the
// DOM the live lane actually produces, and the bounded backfill walk is only
// meaningful against `ChannelView`'s own `hasMoreOlder`/`loadOlder` wiring.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL_ID = 'topic:operator-lane';
/** Mirrors `ANCHOR_WALK_MAX_PAGES` in `ChannelView`. */
const ANCHOR_WALK_MAX_PAGES = 8;

const mocks = vi.hoisted(() => ({
  fetchWorkspaceTopic: vi.fn(),
  fetchChannelRoster: vi.fn(),
  messages: [] as unknown[],
  hasMoreOlder: false,
  loadOlder: vi.fn(async () => {}),
  // `useChannelChatSocket` only increments this when a FULL snapshot lands, so
  // `0` is the cold-boot state: connected socket, nothing answered yet.
  fullSnapshotRevision: 1,
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

vi.mock('../../frontend/src/hooks/useChannelChatSocket.js', () => ({
  useChannelChatSocket: () => ({
    channel: {
      id: CHANNEL_ID,
      title: 'operator lane',
      visibility: 'default',
      archived: false,
      latestSeq: mocks.messages.length,
      messageCount: mocks.messages.length,
      lastMessage: null,
      members: [],
    },
    reducer: {
      channelId: CHANNEL_ID,
      messages: mocks.messages,
      lastSeq: mocks.messages.length,
      needsCatchup: false,
      inFlight: [],
      truncated: false,
    },
    connected: true,
    disconnected: false,
    notFound: false,
    hasMoreOlder: mocks.hasMoreOlder,
    loadingOlder: false,
    loadOlder: mocks.loadOlder,
    fullSnapshotRevision: mocks.fullSnapshotRevision,
    post: vi.fn(),
    postPending: false,
    postError: null,
    resync: vi.fn(),
  }),
}));

vi.mock('../../frontend/src/components/chat/ChannelComposer.js', () => ({
  ChannelComposer: () => null,
}));
vi.mock('../../frontend/src/components/chat/ChannelThreadPanel.js', () => ({
  ChannelThreadPanel: () => null,
}));

const { ChannelView } =
  await import('../../frontend/src/components/chat/ChannelView.js');
const { useUiStore } = await import('../../frontend/src/lib/stores/ui.js');
const { useToastStore } =
  await import('../../frontend/src/lib/stores/toasts.js');

function message(seq: number, overrides: Partial<ChannelMessage> = {}) {
  return {
    schemaVersion: 1,
    id: `chm:row-${seq}` as ChannelMessageId,
    channelId: CHANNEL_ID,
    seq,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: `row ${seq}`, format: 'text' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  } satisfies ChannelMessage;
}

describe('ChannelView deep-link message anchor', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(ChannelView, { channelId: CHANNEL_ID })
        )
      );
    });
    // Drain the anchor walk's promise/state ping-pong.
    await act(async () => {});
  }

  beforeEach(() => {
    mocks.fetchWorkspaceTopic.mockResolvedValue({
      id: CHANNEL_ID,
      workspaceId: 'workspace:local',
      display: { title: 'operator lane' },
      routingDefaults: {},
    });
    mocks.fetchChannelRoster.mockResolvedValue([]);
    mocks.messages = [];
    mocks.hasMoreOlder = false;
    mocks.fullSnapshotRevision = 1;
    mocks.loadOlder = vi.fn(async () => {});
    useUiStore.setState({
      activeChannelId: CHANNEL_ID,
      activeThreadRootId: null,
      pendingChannelThread: null,
      pendingChannelMessage: null,
    });
    useToastStore.setState({ toasts: [] });
    originalScrollIntoView = Element.prototype.scrollIntoView;
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
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
    Element.prototype.scrollIntoView = originalScrollIntoView;
    vi.useRealTimers();
  });

  it('scrolls to the anchored row and applies a brief jump emphasis', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.messages = [message(1), message(2), message(3)];
    await mount();

    expect(container.querySelector('.ch-msg--jump')).toBeNull();

    await act(async () => {
      useUiStore
        .getState()
        .requestChannelMessage(CHANNEL_ID, 'chm:row-2' as ChannelMessageId);
    });
    await act(async () => {});

    const highlighted = container.querySelector('.ch-msg--jump');
    expect(highlighted).not.toBeNull();
    expect(highlighted?.getAttribute('data-channel-message-id')).toBe(
      'chm:row-2'
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(highlighted);
    // The intent is one-shot — a leftover would re-fire on the next render.
    expect(useUiStore.getState().pendingChannelMessage).toBeNull();

    // Emphasis is transient: the row returns to normal without another render
    // being forced by the operator.
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(container.querySelector('.ch-msg--jump')).toBeNull();
  });

  it('does not jump when the anchor names another channel', async () => {
    mocks.messages = [message(1)];
    await mount();

    await act(async () => {
      useUiStore
        .getState()
        .requestChannelMessage(
          'topic:other-lane',
          'chm:row-1' as ChannelMessageId
        );
    });
    await act(async () => {});

    expect(container.querySelector('.ch-msg--jump')).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(useUiStore.getState().pendingChannelMessage).not.toBeNull();
  });

  it('walks older history for an out-of-window anchor and stops at the cap', async () => {
    mocks.messages = [message(90), message(91)];
    // Every page comes back without the target: the pathological case a cap
    // exists for (deleted row, id from another channel, hand-edited link).
    mocks.hasMoreOlder = true;
    await mount();

    await act(async () => {
      useUiStore
        .getState()
        .requestChannelMessage(CHANNEL_ID, 'chm:row-1' as ChannelMessageId);
    });
    await act(async () => {});

    expect(mocks.loadOlder).toHaveBeenCalledTimes(ANCHOR_WALK_MAX_PAGES);
    expect(container.querySelector('.ch-msg--jump')).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(
      useToastStore.getState().toasts.map((toast) => toast.message)
    ).toContain('that message is not in this chat’s recent history');
  });

  it('waits for the channel snapshot when the link is opened cold', async () => {
    // The primary case for this feature: a pasted `/channel/<id>#msg-…` link in
    // a fresh tab writes the intent BEFORE `ChannelView` mounts, so the adopt
    // effect fires on the first commit — messages still empty, `hasMoreOlder`
    // still its `false` default. Giving up there would toast "not in recent
    // history" about a row that arrives one tick later.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.messages = [];
    mocks.hasMoreOlder = false;
    mocks.fullSnapshotRevision = 0;
    useUiStore
      .getState()
      .requestChannelMessage(CHANNEL_ID, 'chm:row-2' as ChannelMessageId);

    await mount();

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Snapshot lands.
    mocks.messages = [message(1), message(2), message(3)];
    mocks.fullSnapshotRevision = 1;
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

    const highlighted = container.querySelector('.ch-msg--jump');
    expect(highlighted?.getAttribute('data-channel-message-id')).toBe(
      'chm:row-2'
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('gives up immediately when there is no older history left to walk', async () => {
    mocks.messages = [message(1), message(2)];
    mocks.hasMoreOlder = false;
    await mount();

    await act(async () => {
      useUiStore
        .getState()
        .requestChannelMessage(CHANNEL_ID, 'chm:missing' as ChannelMessageId);
    });
    await act(async () => {});

    expect(mocks.loadOlder).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
