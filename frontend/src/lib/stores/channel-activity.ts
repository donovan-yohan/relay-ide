// Coarse per-channel activity cache (#1166). Fed by the `/ws/events`
// `channel-activity` broadcast, which carries only `{ channelId, latestSeq }` —
// no per-user unread count, no sender info. The sidebar renders a presence-only
// dot (not a count badge) when a channel has activity newer than the client's
// local last-read marker and isn't the currently-open channel.
import { create } from 'zustand';

interface ChannelActivityState {
  latestSeqByChannel: Record<string, number>;
  recordActivity: (channelId: string, latestSeq: number) => void;
}

export const useChannelActivityStore = create<ChannelActivityState>((set) => ({
  latestSeqByChannel: {},
  recordActivity: (channelId, latestSeq) =>
    set((state) => {
      const current = state.latestSeqByChannel[channelId];
      if (current !== undefined && current >= latestSeq) return state;
      return {
        latestSeqByChannel: {
          ...state.latestSeqByChannel,
          [channelId]: latestSeq,
        },
      };
    }),
}));

/** localStorage key for a channel's client-local last-read seq marker. */
export function channelLastReadKey(channelId: string): string {
  return `relay-channel-last-read::${channelId}`;
}

function readLastReadSeq(channelId: string): number {
  try {
    const raw = localStorage.getItem(channelLastReadKey(channelId));
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

/**
 * True when the channel has activity newer than the client's last-read marker
 * AND isn't the currently-open channel. Presence-only signal for the sidebar.
 */
export function hasUnseenActivity(
  channelId: string,
  activeChannelId: string | null
): boolean {
  if (channelId === activeChannelId) return false;
  const latestSeq =
    useChannelActivityStore.getState().latestSeqByChannel[channelId];
  if (latestSeq === undefined) return false;
  return latestSeq > readLastReadSeq(channelId);
}
