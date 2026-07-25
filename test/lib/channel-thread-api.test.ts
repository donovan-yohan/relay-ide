import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchChannelThreadHistory,
  postChannelMessage,
} from '../../frontend/src/lib/api.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

const rootId = 'chm:root/id' as ChannelMessageId;

function row(): ChannelMessage {
  return {
    schemaVersion: 1,
    id: rootId,
    channelId: 'topic:eng threads',
    seq: 1,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: 'root', format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('channel thread API client', () => {
  it('uses the dedicated root-inclusive route and read capability', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [row()],
          hasMore: true,
          nextCursor: { beforeSeq: 40 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchChannelThreadHistory('topic:eng threads', rootId, {
      beforeSeq: 41,
      afterSeq: 42,
      limit: 50,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/channels/topic%3Aeng%20threads/threads/chm%3Aroot%2Fid?beforeSeq=41&afterSeq=42&limit=50',
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(page).toEqual({
      messages: [row()],
      hasMore: true,
      nextCursor: { beforeSeq: 40 },
    });
  });

  it('posts threadId without inventing the legacy parent alias', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: row() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await postChannelMessage('topic:eng', {
      text: 'reply',
      clientMessageId: 'browser:1',
      threadId: rootId,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'reply',
      clientMessageId: 'browser:1',
      threadId: rootId,
    });
    expect(String(init.body)).not.toContain('parentMessageId');
  });
});
