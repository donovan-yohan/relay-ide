// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelTimeline } from '../../frontend/src/components/chat/ChannelTimeline.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const rootId = 'chm:floor-root' as ChannelMessageId;

function row(
  id: string,
  seq: number,
  threadId: ChannelMessageId | null,
  replyCount?: number
): ChannelMessage {
  return {
    schemaVersion: 1,
    id: id as ChannelMessageId,
    channelId: 'topic:reply-floor',
    seq,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'agent', id: 'agent:codex', providerId: 'codex' },
    body: { text: id, format: 'text' },
    threadId,
    parentMessageId: threadId,
    ...(replyCount !== undefined ? { replyCount } : {}),
    createdAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
    updatedAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
  };
}

let host: HTMLDivElement;
let reactRoot: Root;

async function render(
  messages: ChannelMessage[],
  fullSnapshotRevision = 1
): Promise<void> {
  await act(async () => {
    reactRoot.render(
      React.createElement(ChannelTimeline, {
        messages,
        lastReadSeq: null,
        channelId: 'topic:reply-floor',
        channelTitle: 'reply-floor',
        hasMoreOlder: false,
        loadingOlder: false,
        loadOlder: async () => {},
        fullSnapshotRevision,
        needsCatchup: false,
        onResync: () => {},
        onOpenThread: () => {},
      })
    );
    await Promise.resolve();
  });
}

describe('live reply count above a persisted floor', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    reactRoot = createRoot(host);
  });

  afterEach(() => {
    act(() => reactRoot.unmount());
    host.remove();
  });

  it('adds a newly observed live child when the loaded subset is below the floor', async () => {
    const initial = [
      row(rootId, 1, null, 100),
      row('chm:loaded-98', 98, rootId),
      row('chm:loaded-99', 99, rootId),
      row('chm:loaded-100', 100, rootId),
    ];
    await render(initial);
    expect(host.querySelector('.ch-msg__thread-chip')?.textContent).toContain(
      '100 replies'
    );

    await render([...initial, row('chm:live-101', 101, rootId)]);
    expect(host.querySelector('.ch-msg__thread-chip')?.textContent).toContain(
      '101 replies'
    );
  });

  it('preserves growth through an absent-root truncated snapshot until the root refetch rebases it', async () => {
    const initial = [
      row(rootId, 1, null, 110),
      row('chm:loaded-110', 110, rootId),
    ];
    const liveReply = row('chm:live-111', 111, rootId);
    await render(initial);
    await render([...initial, liveReply]);
    expect(host.querySelector('.ch-msg__thread-chip')?.textContent).toContain(
      '111 replies'
    );

    // A 100-row authoritative replacement can contain only replies. Growth is
    // still load-bearing because there is no refreshed root floor to absorb it.
    await render([row('chm:loaded-110', 110, rootId), liveReply], 2);
    expect(host.querySelector('.ch-msg__thread-chip')).toBeNull();
    await render([...initial, liveReply], 2);
    expect(host.querySelector('.ch-msg__thread-chip')?.textContent).toContain(
      '111 replies'
    );

    // Once a refetch carries the advanced authoritative floor, growth rebases
    // instead of double-counting it.
    await render(
      [
        row(rootId, 1, null, 111),
        row('chm:loaded-110', 110, rootId),
        liveReply,
      ],
      2
    );
    expect(host.querySelector('.ch-msg__thread-chip')?.textContent).toContain(
      '111 replies'
    );
  });
});
