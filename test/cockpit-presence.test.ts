import { describe, expect, it } from 'vitest';
import type { ChannelAgentStatus } from '../frontend/src/lib/api.js';
import type {
  TopicNavItem,
  TopicNavSessionRef,
} from '../frontend/src/lib/state/topic-nav.js';
import type { DisplayState } from '../frontend/src/lib/state/display-state.js';
import {
  PRESENCE_TOKENS,
  presenceStateForRow,
  type CockpitPresence,
} from '../frontend/src/lib/state/cockpit-presence.js';

const presenceRank: Record<CockpitPresence, number> = {
  blocked: 5,
  working: 4,
  done: 3,
  idle: 2,
  unknown: 1,
};

function makeSession(
  displayState: DisplayState,
  overrides: Partial<TopicNavSessionRef> = {}
): TopicNavSessionRef {
  return {
    id: `session:${displayState}`,
    selectKey: `session:${displayState}`,
    label: displayState,
    type: 'terminal',
    mode: 'pty',
    status: 'active',
    tone: 'idle',
    displayState,
    activityState: null,
    permissionType: null,
    branch: null,
    nodeId: null,
    nodeLabel: null,
    cwd: '/repo',
    durability: null,
    currentActivity: null,
    lastActivity: null,
    ...overrides,
  };
}

function makeItem(
  sessions: TopicNavSessionRef[] = [],
  overrides: Partial<TopicNavItem> = {}
): TopicNavItem {
  return {
    id: 'topic:presence',
    source: 'persisted',
    workspaceId: 'workspace:test',
    parentId: null,
    title: 'presence',
    description: null,
    badgeSeed: 'presence',
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
    sessions,
    participants: [],
    surfaces: [],
    taskRefs: [],
    artifactIds: [],
    workContextIds: [],
    childIds: [],
    routingLabel: null,
    lifecycleLabel: 'active',
    updatedAt: '2026-07-19T12:00:00.000Z',
    ...overrides,
  };
}

describe('presenceStateForRow', () => {
  it.each<[DisplayState, CockpitPresence]>([
    ['permission', 'blocked'],
    ['needs-answer', 'blocked'],
    ['error', 'blocked'],
    ['running', 'working'],
    ['initializing', 'working'],
    ['unseen-idle', 'done'],
    ['seen-idle', 'idle'],
    ['inactive', 'unknown'],
  ])('maps session displayState %s to %s', (displayState, expected) => {
    expect(presenceStateForRow(makeItem([makeSession(displayState)]))).toBe(
      expected
    );
  });

  it.each<[ChannelAgentStatus, CockpitPresence]>([
    ['spawning', 'working'],
    ['thinking', 'working'],
    ['streaming', 'working'],
    ['waiting', 'blocked'],
    ['idle', 'idle'],
  ])('maps effective channel-agent status %s to %s', (status, expected) => {
    expect(
      presenceStateForRow(makeItem(), { 'topic:presence claude': status })
    ).toBe(expected);
  });

  it.each(
    (
      [
        ['spawning', 'working'],
        ['thinking', 'working'],
        ['streaming', 'working'],
        ['waiting', 'blocked'],
        ['idle', 'idle'],
      ] as const
    ).flatMap(([status, livePresence]) =>
      (
        [
          ['permission', 'blocked'],
          ['needs-answer', 'blocked'],
          ['error', 'blocked'],
          ['running', 'working'],
          ['initializing', 'working'],
          ['unseen-idle', 'done'],
          ['seen-idle', 'idle'],
          ['inactive', 'unknown'],
        ] as const
      ).map(([displayState, sessionPresence]) => ({
        status,
        displayState,
        expected:
          presenceRank[livePresence] > presenceRank[sessionPresence]
            ? livePresence
            : sessionPresence,
      }))
    )
  )(
    'rolls live $status with session $displayState to $expected',
    ({ status, displayState, expected }) => {
      expect(
        presenceStateForRow(makeItem([makeSession(displayState)]), {
          'topic:presence claude': status,
        })
      ).toBe(expected);
    }
  );

  it('rolls multi-agent signals up blocked > working > done > idle > unknown', () => {
    const statuses: Record<string, ChannelAgentStatus> = {
      'topic:presence claude': 'idle',
      'topic:presence codex': 'streaming',
      'topic:presence hermes': 'waiting',
      'topic:other claude': 'waiting',
    };
    expect(presenceStateForRow(makeItem(), statuses)).toBe('blocked');
    delete statuses['topic:presence hermes'];
    expect(presenceStateForRow(makeItem(), statuses)).toBe('working');
  });

  it('maps unread-with-idle to done', () => {
    expect(
      presenceStateForRow(
        makeItem([makeSession('seen-idle')]),
        {},
        { unread: true }
      )
    ).toBe('done');
  });

  it('treats disconnected terminal sessions as unknown', () => {
    expect(
      presenceStateForRow(
        makeItem([makeSession('error', { status: 'disconnected' })])
      )
    ).toBe('unknown');
  });

  it('maps unreachable surfaces and signal-free rows without inventing presence', () => {
    expect(
      presenceStateForRow(
        makeItem([], {
          tone: 'error',
          surfaces: [
            {
              id: 'surface:failed',
              label: 'preview',
              kind: 'preview',
              health: 'unreachable',
              openMode: 'direct',
              target: null,
            },
          ],
        })
      )
    ).toBe('blocked');
    expect(presenceStateForRow(makeItem())).toBe('unknown');
  });
});

describe('PRESENCE_TOKENS', () => {
  it('uses the exact DESIGN.md status variables, fills, and glyph taxonomy', () => {
    expect(PRESENCE_TOKENS).toEqual({
      working: {
        colorVar: 'var(--status-warning)',
        fill: 'solid',
        glyph: 'spinner',
      },
      blocked: {
        colorVar: 'var(--status-error)',
        fill: 'solid',
        glyph: 'alert',
      },
      done: {
        colorVar: 'var(--color-teal)',
        fill: 'solid',
        glyph: 'none',
      },
      idle: {
        colorVar: 'var(--status-success)',
        fill: 'hollow',
        glyph: 'none',
      },
      unknown: {
        colorVar: 'var(--text-muted)',
        fill: 'hollow',
        glyph: 'none',
      },
    });
  });
});
