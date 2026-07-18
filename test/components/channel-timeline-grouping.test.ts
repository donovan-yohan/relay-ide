import { describe, expect, it } from 'vitest';
import {
  buildTimelineNodes,
  formatDayLabel,
  GROUP_WINDOW_MS,
  type TimelineNode,
} from '../../frontend/src/lib/chat/channel-timeline-layout.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';
import fixtureData from '../fixtures/channel-chat/mixed-timeline.json';

const fixture = fixtureData as unknown as ChannelMessage[];

function kinds(nodes: TimelineNode[]): string[] {
  return nodes.map((node) => node.kind);
}

function groupSeqs(node: TimelineNode): number[] {
  return node.kind === 'group' ? node.messages.map((m) => m.seq) : [];
}

function msg(overrides: Partial<ChannelMessage>): ChannelMessage {
  return {
    schemaVersion: 1,
    id: 'chm:x' as ChannelMessageId,
    channelId: 'topic:general',
    seq: 1,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: 'x', format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildTimelineNodes — mixed fixture', () => {
  it('produces the exact node sequence with no unread marker (lastReadSeq null)', () => {
    const nodes = buildTimelineNodes(fixture, null);
    expect(kinds(nodes)).toEqual([
      'day-divider',
      'group', // human 1,2
      'group', // claude 3,4 (streaming + complete, same sender within window)
      'group', // claude 5,6 (>5min gap breaks group even though same sender)
      'system', // 7
      'day-divider', // day boundary
      'group', // human 8,9
    ]);
    expect(groupSeqs(nodes[1]!)).toEqual([1, 2]);
    expect(groupSeqs(nodes[2]!)).toEqual([3, 4]);
    expect(groupSeqs(nodes[3]!)).toEqual([5, 6]);
    expect(groupSeqs(nodes[6]!)).toEqual([8, 9]);
    expect(nodes.some((n) => n.kind === 'unread-line')).toBe(false);
  });

  it('day dividers carry the correct local dates', () => {
    const dividers = buildTimelineNodes(fixture, null).filter(
      (n): n is Extract<TimelineNode, { kind: 'day-divider' }> =>
        n.kind === 'day-divider'
    );
    expect(dividers.map((d) => d.date)).toEqual(['2026-07-17', '2026-07-18']);
  });

  it('never groups a system message with its neighbors', () => {
    const nodes = buildTimelineNodes(fixture, null);
    const system = nodes.find((n) => n.kind === 'system');
    expect(system).toBeTruthy();
    if (system?.kind === 'system') expect(system.message.seq).toBe(7);
  });

  it('inserts the unread line before the first message past lastReadSeq', () => {
    const nodes = buildTimelineNodes(fixture, 4);
    const unreadIndex = nodes.findIndex((n) => n.kind === 'unread-line');
    expect(unreadIndex).toBeGreaterThan(-1);
    // The node immediately after the unread line is the group starting at seq 5.
    const next = nodes[unreadIndex + 1];
    expect(next?.kind).toBe('group');
    expect(groupSeqs(next!)).toEqual([5, 6]);
    // Everything before the unread line has seq <= 4.
    const before = nodes
      .slice(0, unreadIndex)
      .flatMap((n) => (n.kind === 'group' ? n.messages.map((m) => m.seq) : []));
    expect(Math.max(...before)).toBe(4);
  });
});

describe('buildTimelineNodes — grouping rules', () => {
  it('breaks a group when the gap exceeds the 5-minute window', () => {
    const base = '2026-07-18T10:00:00.000Z';
    const later = new Date(
      Date.parse(base) + GROUP_WINDOW_MS + 1000
    ).toISOString();
    const nodes = buildTimelineNodes(
      [
        msg({ id: 'chm:1' as ChannelMessageId, seq: 1, createdAt: base }),
        msg({ id: 'chm:2' as ChannelMessageId, seq: 2, createdAt: later }),
      ],
      null
    );
    expect(kinds(nodes)).toEqual(['day-divider', 'group', 'group']);
  });

  it('keeps same-sender messages within the window in one group', () => {
    const nodes = buildTimelineNodes(
      [
        msg({
          id: 'chm:1' as ChannelMessageId,
          seq: 1,
          createdAt: '2026-07-18T10:00:00.000Z',
        }),
        msg({
          id: 'chm:2' as ChannelMessageId,
          seq: 2,
          createdAt: '2026-07-18T10:04:00.000Z',
        }),
      ],
      null
    );
    expect(kinds(nodes)).toEqual(['day-divider', 'group']);
    expect(groupSeqs(nodes[1]!)).toEqual([1, 2]);
  });

  it('breaks a group when the sender changes', () => {
    const nodes = buildTimelineNodes(
      [
        msg({ id: 'chm:1' as ChannelMessageId, seq: 1 }),
        msg({
          id: 'chm:2' as ChannelMessageId,
          seq: 2,
          sender: { kind: 'agent', id: 'agent:claude', providerId: 'claude' },
        }),
      ],
      null
    );
    expect(kinds(nodes)).toEqual(['day-divider', 'group', 'group']);
  });

  it('returns an empty node list for no messages', () => {
    expect(buildTimelineNodes([], null)).toEqual([]);
  });
});

describe('formatDayLabel', () => {
  it('renders today/yesterday relative to now, lowercase', () => {
    const now = new Date('2026-07-18T12:00:00');
    expect(formatDayLabel('2026-07-18', now)).toBe('today');
    expect(formatDayLabel('2026-07-17', now)).toBe('yesterday');
  });

  it('renders an absolute lowercase "ddd, mmm d" label otherwise', () => {
    const now = new Date('2026-07-18T12:00:00');
    // 2026-07-10 is a Friday.
    expect(formatDayLabel('2026-07-10', now)).toBe('fri, jul 10');
  });
});
