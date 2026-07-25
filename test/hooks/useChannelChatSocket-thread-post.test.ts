// @vitest-environment happy-dom

import React, { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { ChannelMessageId } from '../../shared/channel-chat-protocol.js';

const apiMocks = vi.hoisted(() => ({
  fetchChannel: vi.fn(),
  postChannelMessage: vi.fn(),
}));
vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../frontend/src/lib/api.js')>();
  return { ...actual, ...apiMocks };
});

import {
  useChannelChatSocket,
  type UseChannelChatSocketState,
} from '../../frontend/src/hooks/useChannelChatSocket.js';

class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

const channelId = 'topic:thread-post';
const rootId = 'chm:root' as ChannelMessageId;
let container: HTMLDivElement;
let reactRoot: Root;
let latest: UseChannelChatSocketState;

function Harness() {
  latest = useChannelChatSocket(channelId);
  return null;
}

describe('useChannelChatSocket thread post', () => {
  beforeEach(() => {
    apiMocks.fetchChannel.mockReset().mockResolvedValue({
      id: channelId,
      title: 'thread post',
      visibility: 'default',
      archived: false,
      latestSeq: 0,
      messageCount: 0,
      lastMessage: null,
      members: [],
    });
    apiMocks.postChannelMessage
      .mockReset()
      .mockResolvedValue({ id: 'chm:new' });
    vi.stubGlobal('WebSocket', MockWebSocket);
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
  });

  afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('forwards threadId and clientMessageId without parentMessageId', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      reactRoot.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Harness)
        )
      );
      await Promise.resolve();
    });

    await act(async () => {
      await latest.post('thread reply', {
        clientMessageId: 'browser:thread-reply',
        threadId: rootId,
      });
    });

    expect(apiMocks.postChannelMessage).toHaveBeenCalledWith(channelId, {
      text: 'thread reply',
      clientMessageId: 'browser:thread-reply',
      threadId: rootId,
    });
  });
});
