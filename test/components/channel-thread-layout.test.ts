import { describe, expect, it } from 'vitest';
import {
  deriveReplyCounts,
  displayedReplyCount,
  selectTopLevel,
} from '../../frontend/src/lib/chat/channel-timeline-layout.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

function message(
  id: string,
  seq: number,
  overrides: Partial<ChannelMessage> = {}
): ChannelMessage {
  return {
    schemaVersion: 1,
    id: id as ChannelMessageId,
    channelId: 'topic:thread-test',
    seq,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: id, format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
    updatedAt: `2026-07-18T10:${String(seq).padStart(2, '0')}:00.000Z`,
    ...overrides,
  };
}

describe('channel thread timeline projections', () => {
  it('filters replies only at the top-level render boundary', () => {
    const root = message('chm:root', 1);
    const system = message('chm:system', 2, {
      kind: 'system',
      sender: { kind: 'system', id: 'system' },
    });
    const reply = message('chm:reply', 3, {
      threadId: root.id,
      parentMessageId: root.id,
    });
    const source = [root, system, reply];

    expect(selectTopLevel(source).map((row) => row.id)).toEqual([
      root.id,
      system.id,
    ]);
    expect(source).toHaveLength(3);
  });

  it('derives loaded count and newest activity per canonical root', () => {
    const rootA = message('chm:root-a', 1);
    const rootB = message('chm:root-b', 2);
    const rows = [
      rootA,
      rootB,
      message('chm:a-late', 5, {
        threadId: rootA.id,
        parentMessageId: rootA.id,
        createdAt: '2026-07-18T12:05:00.000Z',
      }),
      message('chm:a-early', 3, {
        threadId: rootA.id,
        parentMessageId: rootA.id,
        createdAt: '2026-07-18T12:03:00.000Z',
      }),
      message('chm:b', 4, {
        threadId: rootB.id,
        parentMessageId: rootB.id,
        createdAt: '2026-07-18T12:04:00.000Z',
      }),
    ];

    expect(deriveReplyCounts(rows)).toEqual(
      new Map([
        [rootA.id, { count: 2, lastReplyAt: '2026-07-18T12:05:00.000Z' }],
        [rootB.id, { count: 1, lastReplyAt: '2026-07-18T12:04:00.000Z' }],
      ])
    );
  });

  it('uses the persisted reply count as a floor and live children as growth', () => {
    const root = message('chm:root', 1, { replyCount: 8 });
    expect(displayedReplyCount(root, { count: 3 })).toBe(8);
    expect(displayedReplyCount(root, { count: 3 }, 1)).toBe(9);
    expect(displayedReplyCount(root, { count: 9 })).toBe(9);
    expect(displayedReplyCount(message('chm:fresh', 2), undefined)).toBe(0);
  });

  it('excludes in-thread detail cards from live reply counts', () => {
    const root = message('chm:root', 1);
    const rows = [
      root,
      message('chm:reply', 2, {
        threadId: root.id,
        parentMessageId: root.id,
        createdAt: '2026-07-18T12:02:00.000Z',
      }),
      // Detail cards carry a threadId (so cold-resume renders them in-thread)
      // but must not count as replies nor advance the newest-reply timestamp.
      message('chm:card', 3, {
        threadId: root.id,
        parentMessageId: root.id,
        body: { text: '', format: 'markdown' },
        agentDetail: {
          itemId: 'reason-1',
          card: {
            kind: 'thought',
            title: 'thinking',
            status: 'completed',
            content: 'card content',
          },
        },
        createdAt: '2026-07-18T12:03:00.000Z',
      }),
    ];

    expect(deriveReplyCounts(rows)).toEqual(
      new Map([
        [root.id, { count: 1, lastReplyAt: '2026-07-18T12:02:00.000Z' }],
      ])
    );
  });
});
