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

  it('does not invent growth before the first tracked root floor', async () => {
    const outOfWindow = row('chm:out-of-window', 10, rootId);
    await render([outOfWindow]);
    await render([outOfWindow, row('chm:still-no-floor', 11, rootId)]);
    expect(host.querySelector('.ch-msg__thread-chip')).toBeNull();

    await render([
      row(rootId, 1, null, 10),
      outOfWindow,
      row('chm:still-no-floor', 11, rootId),
    ]);
    expect(host.querySelector('.ch-msg__thread-chip')?.textContent).toContain(
      '10 replies'
    );
  });

  it('treats root plus replies in one full snapshot as one authoritative batch', async () => {
    const initialRoot = row(rootId, 1, null, 1);
    const replyA = row('chm:snapshot-a', 2, rootId);
    const replyB = row('chm:snapshot-b', 3, rootId);
    await render([initialRoot, replyA], 1);

    // The refreshed floor already contains replyB. Re-counting that same-batch
    // row as growth reproduces the historical 3-vs-2 overcount.
    await render([row(rootId, 1, null, 2), replyA, replyB], 2);
    expect(host.querySelector('.ch-msg__thread-chip')?.textContent).toContain(
      '2 replies'
    );
  });

  it('counts unseen full-snapshot replies when their tracked root is absent', async () => {
    const root = row(rootId, 1, null, 10);
    const reply10 = row('chm:snapshot-existing', 10, rootId);
    const reply11 = row('chm:snapshot-unseen', 11, rootId);
    await render([root, reply10], 1);

    // A truncated replacement has no fresh floor for this root, so its unseen
    // reply remains live growth rather than being swallowed as authoritative.
    await render([reply10, reply11], 2);
    await render([root, reply10, reply11], 2);
    expect(host.querySelector('.ch-msg__thread-chip')?.textContent).toContain(
      '11 replies'
    );
  });
});
