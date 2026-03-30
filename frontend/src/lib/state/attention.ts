import type { SidebarItem } from '../types.js';
import type { DisplayState } from './display-state.js';

const STATE_SCORES: Record<DisplayState, number> = {
  permission:     1000,
  'needs-answer':  900,
  error:           800,
  'unseen-idle':   500,
  running:         100,
  initializing:     50,
  'seen-idle':      10,
  inactive:          1,
};

function minutesSinceLastActivity(item: SidebarItem): number {
  if (!item.lastActivity) return Infinity;
  return (Date.now() - new Date(item.lastActivity).getTime()) / 60_000;
}

export function computeAttentionScore(item: SidebarItem): number {
  let score = STATE_SCORES[item.displayState] ?? 0;

  // PR urgency
  if (item.prStatus === 'changes-requested') score += 200;
  if (item.prStatus === 'review-requested')  score += 150;

  // Recency bonus (max 100, decays to 0 over ~100 minutes)
  const minutes = minutesSinceLastActivity(item);
  score += Math.max(0, 100 - minutes);

  // Unread bonus
  if (item.isUnread) score += 300;

  return score;
}

export function sortByAttention<T extends SidebarItem>(items: T[]): T[] {
  return [...items].sort((a, b) => computeAttentionScore(b) - computeAttentionScore(a));
}

/**
 * Compute the highest attention score among a workspace's sidebar items.
 * Used to sort workspaces against each other.
 */
export function workspaceAttentionScore(items: SidebarItem[]): number {
  if (items.length === 0) return 0;
  return Math.max(...items.map(computeAttentionScore));
}
