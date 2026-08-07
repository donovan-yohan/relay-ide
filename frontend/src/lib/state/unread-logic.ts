import type { DisplayState } from './display-state.js';
import { isAttentionState } from './display-state.js';

/**
 * Determine if a state transition should mark the item as unread.
 * Pure function — no reactive dependencies.
 */
export function shouldMarkUnread(
  from: DisplayState,
  to: DisplayState,
  isCurrentlyViewing: boolean
): boolean {
  if (isCurrentlyViewing) return false;
  if (from === to) return false;
  return isAttentionState(to);
}
