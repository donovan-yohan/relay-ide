// Coarse per-channel activity cache (#1166). Fed by the `/ws/events`
// `channel-activity` broadcast, which carries only `{ channelId, latestSeq }` —
// no per-user unread count, no sender info. The sidebar renders a presence-only
// dot (not a count badge) when a channel has activity newer than the client's
// local last-read marker and isn't the currently-open channel.
import { create } from 'zustand';

interface ChannelActivityState {
  latestSeqByChannel: Record<string, number>;
  /**
   * Reactive last-read marker per channel (#1178). Mirrors the persistent
   * localStorage marker but lives in the store so the sidebar's unread dot
   * recomputes the instant a channel is read — localStorage is not reactive, so
   * a render that read it before ChannelView's unmount write would otherwise
   * keep showing a stale dot until unrelated activity arrived.
   */
  lastReadByChannel: Record<string, number>;
  recordActivity: (channelId: string, latestSeq: number) => void;
  /** Mark a channel read up to `seq` (monotonic up). Reactive + persistent. */
  markChannelRead: (channelId: string, seq: number) => void;
  /**
   * Clamp both stores DOWN to an authoritative head seq (#1178). Used when a
   * full snapshot reports a `latestSeq` below the stored marker — i.e. a DM was
   * deleted and recreated under the same deterministic id and its seq restarted
   * low. Without this the monotonic activity guard drops every new broadcast and
   * the stale-high last-read marker suppresses the unread dot indefinitely.
   */
  clampChannelStores: (channelId: string, headSeq: number) => void;
}

/** localStorage key for a channel's client-local last-read seq marker. */
export function channelLastReadKey(channelId: string): string {
  return `relay-channel-last-read::${channelId}`;
}

function persistLastRead(channelId: string, seq: number): void {
  try {
    localStorage.setItem(channelLastReadKey(channelId), String(seq));
  } catch {
    /* localStorage unavailable */
  }
}

export const useChannelActivityStore = create<ChannelActivityState>((set) => ({
  latestSeqByChannel: {},
  lastReadByChannel: {},
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
  markChannelRead: (channelId, seq) =>
    set((state) => {
      if (seq <= 0) return state;
      const current = state.lastReadByChannel[channelId];
      if (current !== undefined && current >= seq) return state;
      persistLastRead(channelId, seq);
      return {
        lastReadByChannel: { ...state.lastReadByChannel, [channelId]: seq },
      };
    }),
  clampChannelStores: (channelId, headSeq) =>
    set((state) => {
      const next: Partial<ChannelActivityState> = {};
      const storedRead = state.lastReadByChannel[channelId];
      const storedActivity = state.latestSeqByChannel[channelId];
      const persistedRead = readPersistedLastRead(channelId);
      // Lower the read marker (store + localStorage) when it sits above head.
      if (
        (storedRead !== undefined && storedRead > headSeq) ||
        persistedRead > headSeq
      ) {
        persistLastRead(channelId, headSeq);
        next.lastReadByChannel = {
          ...state.lastReadByChannel,
          [channelId]: headSeq,
        };
      }
      if (storedActivity !== undefined && storedActivity > headSeq) {
        next.latestSeqByChannel = {
          ...state.latestSeqByChannel,
          [channelId]: headSeq,
        };
      }
      return Object.keys(next).length > 0 ? next : state;
    }),
}));

function readPersistedLastRead(channelId: string): number {
  try {
    const raw = localStorage.getItem(channelLastReadKey(channelId));
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

/**
 * Client-local last-read seq for a channel. Prefers the reactive store value
 * (freshly written on read) and falls back to the persisted localStorage marker
 * for channels the store has not hydrated yet (e.g. first render after reload).
 */
function readLastReadSeq(channelId: string): number {
  const stored =
    useChannelActivityStore.getState().lastReadByChannel[channelId];
  if (stored !== undefined) return stored;
  return readPersistedLastRead(channelId);
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
