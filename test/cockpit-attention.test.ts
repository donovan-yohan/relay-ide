import { describe, expect, it } from 'vitest';
import type {
  ChannelRailNode,
  ChannelRailTree,
  TopicNavItem,
  TopicNavSessionRef,
} from '../frontend/src/lib/state/topic-nav.js';
import {
  computeCockpitAttentionScore,
  selectCockpitAttentionRows,
} from '../frontend/src/lib/state/cockpit-attention.js';

const NOW_MS = Date.parse('2026-07-19T12:00:00.000Z');

function makeSession(
  id: string,
  selectKey = `node:test:${id}`
): TopicNavSessionRef {
  return {
    id,
    selectKey,
    label: id,
    type: 'terminal',
    mode: 'pty',
    status: 'active',
    tone: 'idle',
    displayState: 'seen-idle',
    activityState: 'idle',
    permissionType: null,
    branch: null,
    nodeId: 'node:test',
    nodeLabel: 'test node',
    cwd: '/repo',
    controlFreshness: 'fresh',
    durability: null,
    currentActivity: null,
    lastActivity: null,
  };
}

function makeItem(overrides: Partial<TopicNavItem> = {}): TopicNavItem {
  return {
    id: 'topic:default',
    source: 'persisted',
    workspaceId: 'workspace:test',
    parentId: null,
    title: 'default',
    description: null,
    badgeSeed: 'default',
    kind: 'thread',
    kindLabel: 'topic',
    channelKind: null,
    isDirectMessage: false,
    dmProviderId: null,
    icon: null,
    color: null,
    pinned: false,
    muted: false,
    order: 0,
    tone: 'idle',
    statusLabel: 'idle',
    attentionPriority: 10,
    sessions: [],
    participants: [],
    surfaces: [],
    taskRefs: [],
    artifactIds: [],
    workContextIds: [],
    childIds: [],
    routingLabel: null,
    lifecycleLabel: 'active',
    updatedAt: '2026-07-19T11:00:00.000Z',
    ...overrides,
  };
}

function makeNode(
  id: string,
  overrides: Partial<TopicNavItem> = {},
  unread = false,
  children: ChannelRailNode[] = []
): ChannelRailNode {
  return {
    item: makeItem({ id, title: id, ...overrides }),
    unread,
    children,
  };
}

function makeTree(nodes: ChannelRailNode[]): ChannelRailTree {
  return {
    groups: [
      {
        id: 'workspace:test',
        title: 'test',
        color: null,
        icon: null,
        pinned: false,
        channels: nodes,
        directMessages: [],
        unread: nodes.some((node) => node.unread),
      },
    ],
    orphans: { channels: [], directMessages: [], unread: false },
  };
}

describe('computeCockpitAttentionScore', () => {
  it('keeps the topic-nav display ladder in permission > needs-answer > error > unseen-idle > running > seen-idle order', () => {
    const priorities = [1000, 900, 800, 500, 100, 10];
    const scores = priorities.map((attentionPriority) =>
      computeCockpitAttentionScore(makeItem({ attentionPriority }), {
        unread: false,
        nowMs: NOW_MS,
      })
    );
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('adds the shared unread bonus so seen-idle outranks bare running', () => {
    const seenIdleUnread = computeCockpitAttentionScore(
      makeItem({ attentionPriority: 10 }),
      { unread: true, nowMs: NOW_MS }
    );
    const running = computeCockpitAttentionScore(
      makeItem({ attentionPriority: 100 }),
      { unread: false, nowMs: NOW_MS }
    );
    expect(seenIdleUnread).toBeGreaterThan(running);
  });

  it('caps recency at 100 and applies the planned mention and bounded inbox bumps', () => {
    const item = makeItem({
      attentionPriority: 0,
      updatedAt: '2026-07-19T12:10:00.000Z',
    });
    expect(
      computeCockpitAttentionScore(item, {
        unread: false,
        mentionsMe: true,
        pendingInboxCount: 99,
        nowMs: NOW_MS,
      })
    ).toBe(100 + 250 + 100);
  });

  it('raises effective waiting to the existing needs-input priority', () => {
    const item = makeItem({ attentionPriority: 10 });
    const waiting = computeCockpitAttentionScore(item, {
      unread: false,
      effectiveStatus: 'waiting',
      nowMs: NOW_MS,
    });
    const plainUnread = computeCockpitAttentionScore(item, {
      unread: true,
      effectiveStatus: 'idle',
      nowMs: NOW_MS,
    });
    expect(waiting).toBeGreaterThan(plainUnread);
  });
});

describe('selectCockpitAttentionRows', () => {
  it('flattens descendants and promotes unread, blocked, needs-input, error, and waiting rows', () => {
    const child = makeNode('topic:child', { tone: 'attention' });
    const muted = makeNode('topic:muted', {
      tone: 'error',
      muted: true,
    });
    const tree = makeTree([
      makeNode('topic:plain'),
      makeNode('topic:unread'),
      makeNode('topic:blocked', { tone: 'error', attentionPriority: 800 }),
      makeNode('topic:parent', {}, false, [child]),
      makeNode('topic:waiting'),
      muted,
    ]);

    const rows = selectCockpitAttentionRows(tree, {
      unreadByChannel: { 'topic:unread': true },
      statusByChannelAgent: { 'topic:waiting claude': 'waiting' },
      nowMs: NOW_MS,
    });

    expect(rows.map((row) => row.item.id)).toEqual([
      'topic:waiting',
      'topic:blocked',
      'topic:unread',
      'topic:child',
    ]);
    expect(rows.find((row) => row.item.id === 'topic:unread')?.unread).toBe(
      true
    );
  });

  it('joins roster attention by session key, promotes the topic, and caps its aggregate inbox bump', () => {
    const first = makeSession('session:first');
    const second = makeSession('session:second');
    const roster = makeNode('topic:roster', {
      sessions: [first, second],
    });
    const noInbox = makeNode('topic:no-inbox', {
      tone: 'attention',
      attentionPriority: 10,
    });
    const ignored = makeNode('topic:ignored', {
      sessions: [makeSession('session:ignored')],
    });
    const rows = selectCockpitAttentionRows(
      makeTree([ignored, noInbox, roster]),
      {
        unreadByChannel: {},
        statusByChannelAgent: {},
        rosterAttentionBySessionKey: {
          [first.selectKey]: { needsAttention: true, pendingInboxCount: 3 },
          // Local-id fallback verifies older roster snapshots can still join.
          [second.id]: { needsAttention: false, pendingInboxCount: 99 },
          'session:not-linked': {
            needsAttention: true,
            pendingInboxCount: 4,
          },
        },
        nowMs: NOW_MS,
      }
    );

    expect(rows.map((row) => row.item.id)).toEqual([
      'topic:roster',
      'topic:no-inbox',
    ]);
    expect(
      computeCockpitAttentionScore(roster.item, {
        unread: false,
        pendingInboxCount: 99,
        nowMs: NOW_MS,
      })
    ).toBe(10 + 40 + 4 * 25);
  });

  it('keeps muted topics out even when their linked roster needs attention', () => {
    const session = makeSession('session:muted');
    const rows = selectCockpitAttentionRows(
      makeTree([
        makeNode('topic:muted-roster', {
          muted: true,
          sessions: [session],
        }),
      ]),
      {
        unreadByChannel: {},
        statusByChannelAgent: {},
        rosterAttentionBySessionKey: {
          [session.selectKey]: {
            needsAttention: true,
            pendingInboxCount: 1,
          },
        },
        nowMs: NOW_MS,
      }
    );
    expect(rows).toEqual([]);
  });

  it('ranks a mentioned unread row above an otherwise-equal unread row', () => {
    const tree = makeTree([
      makeNode('topic:plain-unread'),
      makeNode('topic:mentioned-unread'),
    ]);
    const rows = selectCockpitAttentionRows(tree, {
      unreadByChannel: {
        'topic:plain-unread': true,
        'topic:mentioned-unread': true,
      },
      mentionsMeByChannel: { 'topic:mentioned-unread': true },
      statusByChannelAgent: {},
      nowMs: NOW_MS,
    });

    expect(rows.map((row) => row.item.id)).toEqual([
      'topic:mentioned-unread',
      'topic:plain-unread',
    ]);
  });

  it('promotes a mentioned row even when it is not unread', () => {
    const rows = selectCockpitAttentionRows(
      makeTree([makeNode('topic:mentioned'), makeNode('topic:plain')]),
      {
        unreadByChannel: {},
        mentionsMeByChannel: { 'topic:mentioned': true },
        statusByChannelAgent: {},
        nowMs: NOW_MS,
      }
    );

    expect(rows.map((row) => row.item.id)).toEqual(['topic:mentioned']);
  });

  it('breaks score ties by pinned, updatedAt, title, then original order', () => {
    const same = {
      tone: 'attention' as const,
      attentionPriority: 900,
    };
    const tree = makeTree([
      makeNode('topic:z-old', {
        ...same,
        title: 'zeta',
        updatedAt: '2026-07-19T08:00:00.000Z',
      }),
      makeNode('topic:b-new', {
        ...same,
        title: 'beta',
        updatedAt: '2026-07-19T09:00:00.000Z',
      }),
      makeNode('topic:a-new', {
        ...same,
        title: 'alpha',
        updatedAt: '2026-07-19T09:00:00.000Z',
      }),
      makeNode('topic:pinned', {
        ...same,
        pinned: true,
        updatedAt: '2026-07-19T07:00:00.000Z',
      }),
    ]);

    expect(
      selectCockpitAttentionRows(tree, {
        unreadByChannel: {},
        statusByChannelAgent: {},
        nowMs: NOW_MS,
      }).map((row) => row.item.id)
    ).toEqual(['topic:pinned', 'topic:a-new', 'topic:b-new', 'topic:z-old']);
  });
});
