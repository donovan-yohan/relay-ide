// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelTimeline } from '../../frontend/src/components/chat/ChannelTimeline.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function msg(seq: number): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:${seq}` as ChannelMessageId,
    channelId: 'topic:general',
    seq,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: `m${seq}`, format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
  };
}

let container: HTMLDivElement;
let root: Root;

async function renderTimeline(loadOlder: () => Promise<void>): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(ChannelTimeline, {
        messages: [msg(5), msg(6)],
        lastReadSeq: null,
        channelId: 'topic:general',
        channelTitle: 'general',
        hasMoreOlder: true,
        loadingOlder: false,
        loadOlder,
        fullSnapshotRevision: 0,
        needsCatchup: false,
        onResync: () => {},
      })
    );
  });
}

async function scrollToTop(): Promise<void> {
  const el = container.querySelector('.ch-tl') as HTMLDivElement;
  // happy-dom has no layout, so scrollTop defaults to 0 (< the 80px threshold).
  await act(async () => {
    el.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ChannelTimeline anchor release (#1178)', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('releases the anchor when loadOlder settles without a prepend (no earliestSeq change)', async () => {
    // Mirrors the hook contract: loadOlder resolves even when the page is empty
    // or already at seq 1, so earliestSeq never changes and the [earliestSeq]
    // layout effect never fires.
    const loadOlder = vi.fn().mockResolvedValue(undefined);
    await renderTimeline(loadOlder);

    await scrollToTop();
    expect(loadOlder).toHaveBeenCalledTimes(1);

    // Anchor must be released on settlement, so a second scroll pages again.
    await scrollToTop();
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it('releases the anchor even when loadOlder rejects (transient fetch error)', async () => {
    const loadOlder = vi.fn().mockRejectedValue(new Error('network'));
    await renderTimeline(loadOlder);

    await scrollToTop();
    expect(loadOlder).toHaveBeenCalledTimes(1);

    await scrollToTop();
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });
});
