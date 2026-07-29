// Coarse per-channel activity cache (#1166). Fed by the `/ws/events`
// `channel-activity` broadcast, which carries only `{ channelId, latestSeq }` —
// no per-user unread count, no sender info — and seeded on sidebar mount from
// the channel list (#1287) because the broadcast only covers channels that move
// while the socket is open. The sidebar renders a presence-only dot (not a count
// badge) when a channel has activity newer than the client's local last-read
// marker and isn't the currently-open channel.
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
  /**
   * Seed head seqs from a channel-list payload (#1287). `latestSeqByChannel` is
   * in-memory only and the `channel-activity` broadcast reports just the channels
   * that move while the socket is open, so without this bootstrap every reload
   * renders the whole rail as read and the missed range is unrecoverable. Rows
   * are applied monotonic-up, so a list response that loses the race with a live
   * broadcast can never move a channel backwards.
   */
  seedChannelActivity: (rows: { id: string; latestSeq: number }[]) => void;
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
  seedChannelActivity: (rows) =>
    set((state) => {
      const seeded: Record<string, number> = {};
      for (const row of rows) {
        // The list view reports `latestSeq: 0` for channels with no messages;
        // those have nothing to be unread.
        if (!(row.latestSeq > 0)) continue;
        const current = state.latestSeqByChannel[row.id];
        if (current !== undefined && current >= row.latestSeq) continue;
        seeded[row.id] = row.latestSeq;
      }
      if (Object.keys(seeded).length === 0) return state;
      return {
        latestSeqByChannel: { ...state.latestSeqByChannel, ...seeded },
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
 * True when the channel has activity newer than the client's last-read marker
 * AND isn't the currently-open channel. Presence-only signal for the sidebar.
 * Takes the caller's already-subscribed seq pair so a rail projection recomputes
 * whenever either seq moves, and falls back to the persisted localStorage marker
 * for channels the store has no read marker for yet (e.g. after a reload).
 */
export function hasUnseenActivity(
  channelId: string,
  activeChannelId: string | null,
  seqs: { latestSeq: number | undefined; lastRead: number | undefined }
): boolean {
  if (channelId === activeChannelId) return false;
  if (seqs.latestSeq === undefined) return false;
  return seqs.latestSeq > (seqs.lastRead ?? readPersistedLastRead(channelId));
}
