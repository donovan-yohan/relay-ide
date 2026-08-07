import type { ChannelAgentStatus } from '../api.js';
import type { TopicNavItem, TopicNavSessionRef } from './topic-nav.js';

export type CockpitPresence =
  | 'idle'
  | 'working'
  | 'blocked'
  | 'done'
  | 'unknown';

export interface CockpitPresenceToken {
  colorVar: string;
  fill: 'solid' | 'hollow';
  glyph: 'spinner' | 'alert' | 'none';
}

export const PRESENCE_TOKENS: Record<CockpitPresence, CockpitPresenceToken> = {
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
};

const PRESENCE_PRIORITY: Record<CockpitPresence, number> = {
  blocked: 5,
  working: 4,
  done: 3,
  idle: 2,
  unknown: 1,
};

function statusPresence(status: ChannelAgentStatus): CockpitPresence {
  if (status === 'waiting') return 'blocked';
  if (
    status === 'spawning' ||
    status === 'thinking' ||
    status === 'streaming'
  ) {
    return 'working';
  }
  return 'idle';
}

function sessionPresence(session: TopicNavSessionRef): CockpitPresence {
  if (session.status === 'disconnected') {
    return 'unknown';
  }
  if (
    session.displayState === 'permission' ||
    session.displayState === 'needs-answer' ||
    session.displayState === 'error'
  ) {
    return 'blocked';
  }
  if (
    session.displayState === 'running' ||
    session.displayState === 'initializing'
  ) {
    return 'working';
  }
  if (session.displayState === 'unseen-idle') return 'done';
  if (session.displayState === 'seen-idle') return 'idle';
  return 'unknown';
}

function rollUp(states: CockpitPresence[]): CockpitPresence {
  if (states.length === 0) return 'unknown';
  return states.reduce((highest, state) =>
    PRESENCE_PRIORITY[state] > PRESENCE_PRIORITY[highest] ? state : highest
  );
}

/**
 * Map the shared topic-nav and channel-agent status signals into the #1191
 * cockpit taxonomy. The cockpit deliberately differs from the legacy
 * ChannelView header: streaming is working/warning and waiting is
 * blocked/error here; realigning that older chip is follow-up scope.
 */
export function presenceStateForRow(
  item: TopicNavItem,
  agentStatuses: Readonly<Record<string, ChannelAgentStatus>> = {},
  ctx: { unread?: boolean } = {}
): CockpitPresence {
  const prefix = `${item.id} `;
  const liveStates = Object.entries(agentStatuses).flatMap(([key, status]) =>
    key.startsWith(prefix) ? [statusPresence(status)] : []
  );
  const sessionStates = item.sessions.map(sessionPresence);
  const states = [...liveStates, ...sessionStates];

  // Surface-only failures still need operator attention. Session failures are
  // already represented above, while a disconnected/stale session stays
  // unknown rather than being misreported as blocked.
  if (item.surfaces.some((surface) => surface.health === 'unreachable')) {
    states.push('blocked');
  } else if (states.length === 0) {
    if (item.tone === 'error' || item.tone === 'attention') {
      states.push('blocked');
    } else if (item.tone === 'active') {
      states.push('working');
    }
  }

  let presence = rollUp(states);
  if (ctx.unread && presence === 'idle') presence = 'done';
  return presence;
}
