// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

const fetchThreadMock = vi.hoisted(() => vi.fn());
vi.mock('../../frontend/src/lib/api.js', () => ({
  fetchChannelThreadHistory: fetchThreadMock,
}));

import {
  useChannelThread,
  type UseChannelThreadState,
} from '../../frontend/src/hooks/useChannelThread.js';

const channelId = 'topic:thread-hook';
const rootId = 'chm:root' as ChannelMessageId;

function row(
  id: string,
  seq: number,
  threadId: ChannelMessageId | null = null,
  text = id
): ChannelMessage {
  return {
    schemaVersion: 1,
    id: id as ChannelMessageId,
    channelId,
    seq,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text, format: 'markdown' },
    threadId,
    parentMessageId: threadId,
    createdAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
    updatedAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
  };
}

let container: HTMLDivElement;
let reactRoot: Root;
let latest: UseChannelThreadState;

function Harness({
  live,
  activeRootId = rootId,
}: {
  live: ChannelMessage[];
  activeRootId?: ChannelMessageId;
}) {
  latest = useChannelThread(channelId, activeRootId, live);
  return null;
}

async function render(
  live: ChannelMessage[],
  activeRootId: ChannelMessageId = rootId
): Promise<void> {
  await act(async () => {
    reactRoot.render(React.createElement(Harness, { live, activeRootId }));
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('useChannelThread', () => {
  beforeEach(() => {
    fetchThreadMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
  });

  afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('overlays live rows, scopes by root, and retains the root after live eviction', async () => {
    const fetchedReply = row('chm:reply-2', 2, rootId, 'fetched reply');
    fetchThreadMock.mockResolvedValueOnce({
      // A newest-first long-thread page may not reach the root at all.
      messages: [fetchedReply],
      hasMore: false,
    });
    const liveRoot = row('chm:root', 1, null, 'live root');
    const liveReply = row('chm:reply-3', 3, rootId, 'live reply');
    const otherReply = row(
      'chm:other',
      4,
      'chm:different-root' as ChannelMessageId
    );

    await render([liveRoot, liveReply, otherReply]);

    expect(fetchThreadMock).toHaveBeenCalledWith(channelId, rootId, {
      limit: 50,
    });
    expect(latest.root?.body.text).toBe('live root');
    expect(latest.replies.map((reply) => reply.id)).toEqual([
      fetchedReply.id,
      liveReply.id,
    ]);

    await render([liveReply, otherReply]);
    expect(latest.root?.body.text).toBe('live root');
    expect(latest.replies.some((reply) => reply.id === otherReply.id)).toBe(
      false
    );
  });

  it('walks backward with the server cursor, dedupes, and keeps seq order', async () => {
    const reply40 = row('chm:reply-40', 40, rootId);
    const reply41 = row('chm:reply-41', 41, rootId);
    fetchThreadMock
      .mockResolvedValueOnce({
        messages: [reply40, reply41],
        hasMore: true,
        nextCursor: { beforeSeq: 40 },
      })
      .mockResolvedValueOnce({
        messages: [
          row('chm:root', 1),
          row('chm:reply-39', 39, rootId),
          reply40,
        ],
        hasMore: false,
      });

    await render([]);
    expect(latest.hasMoreOlder).toBe(true);

    await act(async () => {
      await latest.loadOlder();
    });

    expect(fetchThreadMock).toHaveBeenNthCalledWith(2, channelId, rootId, {
      beforeSeq: 40,
      limit: 50,
    });
    expect(latest.root?.id).toBe(rootId);
    expect(latest.replies.map((reply) => reply.seq)).toEqual([39, 40, 41]);
    expect(latest.hasMoreOlder).toBe(false);
  });

  it('ignores every stale field when an earlier root request resolves last', async () => {
    const rootA = 'chm:root-a' as ChannelMessageId;
    const rootB = 'chm:root-b' as ChannelMessageId;
    const requestA = deferred<{
      messages: ChannelMessage[];
      hasMore: boolean;
      nextCursor: { beforeSeq: number };
    }>();
    const requestB = deferred<{
      messages: ChannelMessage[];
      hasMore: boolean;
    }>();
    fetchThreadMock
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);

    await render([], rootA);
    expect(latest.loading).toBe(true);
    await render([], rootB);

    await act(async () => {
      requestB.resolve({
        messages: [row(rootB, 20, null, 'root b')],
        hasMore: false,
      });
      await requestB.promise;
      await Promise.resolve();
    });
    expect(latest.root?.id).toBe(rootB);
    expect(latest.loading).toBe(false);
    expect(latest.hasMoreOlder).toBe(false);

    await act(async () => {
      requestA.resolve({
        messages: [
          row(rootA, 1, null, 'stale root a'),
          row('chm:stale-a-reply', 2, rootA),
        ],
        hasMore: true,
        nextCursor: { beforeSeq: 2 },
      });
      await requestA.promise;
      await Promise.resolve();
    });

    expect(latest.root?.id).toBe(rootB);
    expect(latest.replies).toEqual([]);
    expect(latest.loading).toBe(false);
    expect(latest.loadingOlder).toBe(false);
    expect(latest.hasMoreOlder).toBe(false);
    await act(async () => latest.loadOlder());
    expect(fetchThreadMock).toHaveBeenCalledTimes(2);
  });
});
