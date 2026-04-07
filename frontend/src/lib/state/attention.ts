import type { SidebarItem } from '../types.js';
import type { DisplayState } from './display-state.js';

const STATE_SCORES: Record<DisplayState, number> = {
  permission: 1000,
  'needs-answer': 900,
  error: 800,
  'unseen-idle': 500,
  running: 100,
  initializing: 50,
  'seen-idle': 10,
  inactive: 1,
};

/**
 * Compute the highest priority state from an array of display states.
 * Priority order (highest first): permission > needs-answer > error > unseen-idle > running > initializing > seen-idle > inactive
 * Returns null if the array is empty.
 */
export function highestPriorityState(
  states: DisplayState[]
): DisplayState | null {
  if (states.length === 0) return null;
  return states.reduce((highest, state) =>
    STATE_SCORES[state] > STATE_SCORES[highest] ? state : highest
  );
}

function minutesSinceLastActivity(item: SidebarItem): number {
  if (!item.lastActivity) return Infinity;
  const ms = new Date(item.lastActivity).getTime();
  if (Number.isNaN(ms)) return Infinity;
  return (Date.now() - ms) / 60_000;
}

export function computeAttentionScore(item: SidebarItem): number {
  let score = STATE_SCORES[item.displayState];

  // PR urgency
  if (item.prStatus === 'changes-requested') score += 200;
  if (item.prStatus === 'review-requested') score += 150;

  // Recency bonus (max 100, decays to 0 over ~100 minutes)
  const minutes = minutesSinceLastActivity(item);
  score += Math.max(0, 100 - minutes);

  // Unread bonus
  if (item.isUnread) score += 300;

  return score;
}

export function sortByAttention<T extends SidebarItem>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => computeAttentionScore(b) - computeAttentionScore(a)
  );
}

/**
 * Compute the highest attention score among a workspace's sidebar items.
 * Used to sort workspaces against each other.
 */
export function workspaceAttentionScore(items: SidebarItem[]): number {
  if (items.length === 0) return 0;
  return Math.max(...items.map(computeAttentionScore));
}
