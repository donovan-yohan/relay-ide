// Attention-badge state for the favicon dot and the title count (#1308 slice 5
// item 2).
//
// UNREAD IS NOT REIMPLEMENTED HERE. The store holds only the channels an item-1
// signal actually raised, each stamped with the seq that raised it; whether one
// still counts is answered by the SAME read position the rail's unread dot uses
// (`channel-activity`'s `lastReadByChannel`, hub-synced since slice 3). That is
// what makes the badge converge cross-device for free: a channel read on the
// phone raises the mark, the mark broadcasts, and the desktop's dot and count
// drop without this lane knowing a read happened.
//
// In-memory ON PURPOSE — no localStorage. A flag is a claim about what has
// happened since this tab connected; persisting it would light a reloaded tab
// up from a set nothing can be trusted to expire, and the boot channel-list
// payload re-raises every signal that is genuinely still unread anyway.
import { create } from 'zustand';
import type { NotifyReason } from '../notify/signals.js';

/** One flagged channel. */
export interface NotifyBadgeFlag {
  /** Seq of the row that raised it; 0 for a status-only signal. */
  seq: number;
  reason: NotifyReason;
}

/**
 * Reasons that earn a favicon dot / title count.
 *
 * DM replies and mentions only: both are addressed AT the operator. A turn
 * completing is a workflow event on a channel the operator may have fanned out
 * and stopped watching — it can still raise an OS notification when they opt
 * in, but it must not pin a permanent dot on the tab.
 */
const BADGE_REASONS: readonly NotifyReason[] = ['mention', 'dm-reply'];

export function reasonEarnsBadge(reason: NotifyReason): boolean {
  return BADGE_REASONS.includes(reason);
}

interface NotifyBadgeState {
  flagByChannel: Record<string, NotifyBadgeFlag>;
  /** Record a gate-approved signal. Higher seq wins; equal/lower is ignored. */
  flagChannel: (channelId: string, flag: NotifyBadgeFlag) => void;
  /** Drop a channel's flag outright (channel deleted, sign-out). */
  clearChannel: (channelId: string) => void;
  reset: () => void;
}

export const useNotifyBadgeStore = create<NotifyBadgeState>((set) => ({
  flagByChannel: {},
  flagChannel: (channelId, flag) =>
    set((state) => {
      if (!reasonEarnsBadge(flag.reason)) return state;
      const current = state.flagByChannel[channelId];
      if (current !== undefined && current.seq >= flag.seq) return state;
      return {
        flagByChannel: { ...state.flagByChannel, [channelId]: flag },
      };
    }),
  clearChannel: (channelId) =>
    set((state) => {
      if (state.flagByChannel[channelId] === undefined) return state;
      const next = { ...state.flagByChannel };
      delete next[channelId];
      return { flagByChannel: next };
    }),
  reset: () => set({ flagByChannel: {} }),
}));

/**
 * How many channels currently deserve the operator's attention.
 *
 * CHANNELS, not messages (`docs`/DESIGN: the tab title is a "where do I look"
 * signal). A flag survives until the read mark reaches the seq that raised it,
 * so:
 *   * reading here clears it — `markChannelRead` writes `lastReadByChannel`;
 *   * reading on ANOTHER device clears it — the `channel-read-state` broadcast
 *     merges into the same map;
 *   * a NEWER message re-raises it, because the new flag carries a higher seq.
 *
 * A seq-0 flag (status-only signal) can never be cleared by a read mark, which
 * is the second reason `reasonEarnsBadge` refuses turn-complete.
 */
export function countAttentionChannels(
  flagByChannel: Readonly<Record<string, NotifyBadgeFlag>>,
  lastReadByChannel: Readonly<Record<string, number>>
): number {
  let count = 0;
  for (const [channelId, flag] of Object.entries(flagByChannel)) {
    if (!reasonEarnsBadge(flag.reason)) continue;
    if ((lastReadByChannel[channelId] ?? 0) >= flag.seq) continue;
    count += 1;
  }
  return count;
}
