// Coarse per-channel activity cache (#1166). Fed by the `/ws/events`
// `channel-activity` broadcast, which carries only `{ channelId, latestSeq }` —
// no per-user unread count, no sender info — and seeded on sidebar mount from
// the channel list (#1287) because the broadcast only covers channels that move
// while the socket is open. The sidebar renders a presence-only dot (not a count
// badge) when a channel has activity newer than the client's local last-read
// marker and isn't the currently-open channel.
//
// The read marker is client-local and localStorage stays the FAST PATH: every
// unread verdict is answered from this device without waiting on a network
// round trip. Since #1308 slice 3 the hub also stores the operator's own marks
// (`GET/PUT /channels/read-state`) and broadcasts moves on `/ws/events`, which
// makes the hub a point of CONVERGENCE, not a source of truth — a device that
// cannot reach it still computes correct unread from its own marker.
//
// Every hub-sourced mark is merged MONOTONIC-UP against the local one, which is
// the whole safety argument: raising a marker can only ever clear unread, so a
// device that woke up behind can never resurrect messages a device that read
// ahead already dismissed. The one thing monotonic-up cannot see is the #1178
// recreated-DM repair, where the correct move is DOWN — so hub payloads run
// through the same per-channel clamp-epoch fence the channel-list seed uses.
//
// Convergence is forward-only, by design: the hub learns a channel's position
// the first time any device marks it, so on a hub whose table is still empty a
// brand-new device does light up every channel that holds messages, exactly as
// it did before. That resolves per channel as normal reading happens; nothing
// enumerates local markers to backfill, because a boot that fires one PUT per
// stored marker is a burst the phone pays for and the operator never asked for.
import { create } from 'zustand';
import { putChannelReadState } from '../api.js';

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
  /**
   * Wall-clock ms of the most recent applied clamp per channel. A channel-list
   * payload fetched before that instant still carries the pre-clamp head seq, so
   * `seedChannelActivity` refuses it (#1287).
   */
  clampedAtByChannel: Record<string, number>;
  recordActivity: (channelId: string, latestSeq: number) => void;
  /**
   * Seed head seqs from a channel-list payload fetched at `fetchedAt` (#1287).
   * `latestSeqByChannel` is in-memory only and the `channel-activity` broadcast
   * reports just the channels that move while the socket is open, so without this
   * bootstrap every reload renders the whole rail as read and the missed range is
   * unrecoverable. Rows are applied monotonic-up, so a list response that loses
   * the race with a live broadcast can never move a channel backwards, and rows
   * older than a clamp are skipped so a cached payload cannot undo one.
   */
  seedChannelActivity: (
    rows: { id: string; latestSeq: number }[],
    fetchedAt: number
  ) => void;
  /**
   * Mark a channel read up to `seq` (monotonic up). Reactive + persistent, and
   * since #1308 slice 3 also debounce-pushed to the hub so the operator's other
   * devices converge. The push is fire-and-forget: it never gates the store
   * write, so a hub that is down or slow costs the UI nothing.
   */
  markChannelRead: (channelId: string, seq: number) => void;
  /**
   * Merge the operator's durable last-read marks from the hub (#1308 slice 3).
   *
   * ONE path for both directions of the sync — the boot seed
   * (`GET /channels/read-state`) and the live `channel-read-state` broadcast —
   * because they need identical safety: monotonic-up against BOTH the reactive
   * store and the persisted localStorage marker, and fenced by `clampedAt` so a
   * payload fetched before a #1178 clamp cannot talk this device back into the
   * stale-high mark it just retracted.
   *
   * Reading localStorage (not just the store) is load-bearing: on a cold boot
   * `lastReadByChannel` is empty while the real marker sits in localStorage, so
   * comparing against the store alone would let a hub mark BELOW the local one
   * win and light every already-read channel back up.
   *
   * Where the hub is BEHIND the local mark, the local value is pushed back —
   * that is how a push that failed earlier gets retried on the next boot
   * without any retry timer.
   */
  mergeReadState: (
    rows: { channelId: string; lastReadSeq: number }[],
    fetchedAt: number
  ) => void;
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

/**
 * How long a channel's mark waits before it is published (#1308 slice 3).
 *
 * Reads arrive in bursts — ChannelView writes on unmount AND on focus loss, and
 * a fast alt-tab does both — so a window this size collapses one reading
 * session into one request. It is also short enough that a device the operator
 * walks away from has already published before the screen locks.
 */
const READ_STATE_PUSH_DEBOUNCE_MS = 3_000;

/** Highest mark per channel not yet published. */
const pendingReadStatePush = new Map<string, number>();
const readStatePushTimers = new Map<string, ReturnType<typeof setTimeout>>();
let unloadFlushBound = false;

async function publishReadState(
  channelId: string,
  lastReadSeq: number,
  keepalive: boolean
): Promise<void> {
  try {
    await putChannelReadState(channelId, lastReadSeq, { keepalive });
  } catch {
    // Deliberately no retry timer. A read mark is worth exactly one
    // best-effort request: the next mark on this channel supersedes it, and
    // the next boot's `mergeReadState` re-pushes anything the hub is behind
    // on. Meanwhile the local marker is already correct, so the operator on
    // THIS device sees nothing wrong — which is the point of keeping
    // localStorage the fast path.
  }
}

/**
 * Publish whatever is armed for `channelId` right now, cancelling its window.
 */
function flushChannelReadState(channelId: string, keepalive: boolean): void {
  const timer = readStatePushTimers.get(channelId);
  if (timer !== undefined) {
    clearTimeout(timer);
    readStatePushTimers.delete(channelId);
  }
  const seq = pendingReadStatePush.get(channelId);
  if (seq === undefined) return;
  pendingReadStatePush.delete(channelId);
  void publishReadState(channelId, seq, keepalive);
}

/**
 * Publish every armed mark immediately. Exported for the unload lane and for
 * tests; `keepalive` defaults on because every caller is a teardown.
 */
export function flushChannelReadStatePushes(keepalive = true): void {
  for (const channelId of Array.from(pendingReadStatePush.keys())) {
    flushChannelReadState(channelId, keepalive);
  }
}

/**
 * Bind the teardown flush once, lazily — on the first armed push rather than at
 * import, so importing this store in a non-DOM environment stays inert.
 *
 * `pagehide` is the last event a page reliably receives on close, navigation,
 * and bfcache entry. `visibilitychange` → hidden is flushed too because mobile
 * browsers may discard a backgrounded tab with no further event at all, and
 * backgrounding is exactly when ChannelView writes its mark.
 */
function bindUnloadFlush(): void {
  if (unloadFlushBound) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  unloadFlushBound = true;
  window.addEventListener('pagehide', () => {
    flushChannelReadStatePushes(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushChannelReadStatePushes(true);
  });
}

function scheduleReadStatePush(channelId: string, seq: number): void {
  if (!(seq > 0)) return;
  const pending = pendingReadStatePush.get(channelId);
  // Coalesce: a burst of marks costs one request carrying the highest seq.
  if (pending !== undefined && pending >= seq) return;
  pendingReadStatePush.set(channelId, seq);
  bindUnloadFlush();
  // Trailing but NOT resetting. The first mark of a burst arms the window and
  // later marks only raise the value it will carry, so a channel that keeps
  // being marked can never starve its own push the way a resetting debounce
  // would — the mark leaves the device within one window, always.
  if (readStatePushTimers.has(channelId)) return;
  readStatePushTimers.set(
    channelId,
    setTimeout(() => {
      readStatePushTimers.delete(channelId);
      flushChannelReadState(channelId, false);
    }, READ_STATE_PUSH_DEBOUNCE_MS)
  );
}

/**
 * Drop an armed push that sits above `headSeq`. Called from the #1178 clamp:
 * the pending value is the position this device has just RETRACTED, and while
 * the hub would clamp it to head anyway, advertising a mark you no longer hold
 * is not something to leave to the other side's defences.
 */
function discardReadStatePushAbove(channelId: string, headSeq: number): void {
  const pending = pendingReadStatePush.get(channelId);
  if (pending === undefined || pending <= headSeq) return;
  const timer = readStatePushTimers.get(channelId);
  if (timer !== undefined) {
    clearTimeout(timer);
    readStatePushTimers.delete(channelId);
  }
  pendingReadStatePush.delete(channelId);
}

/** Test-only: forget every armed push so one case cannot leak into the next. */
export function clearPendingReadStatePushesForTests(): void {
  for (const timer of readStatePushTimers.values()) clearTimeout(timer);
  readStatePushTimers.clear();
  pendingReadStatePush.clear();
}

export const useChannelActivityStore = create<ChannelActivityState>((
  set,
  get
) => ({
  latestSeqByChannel: {},
  lastReadByChannel: {},
  clampedAtByChannel: {},
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
  seedChannelActivity: (rows, fetchedAt) =>
    set((state) => {
      const seeded: Record<string, number> = {};
      for (const row of rows) {
        // The list view reports `latestSeq: 0` for channels with no messages;
        // those have nothing to be unread.
        if (!(row.latestSeq > 0)) continue;
        // The rail remounts whenever the sidebar collapses and the cached list
        // outlives that, so a payload fetched before a clamp would replay the
        // pre-clamp head and pin the unread dot on forever (seeding is
        // monotonic-up, so nothing would lower it again).
        const clampedAt = state.clampedAtByChannel[row.id];
        if (clampedAt !== undefined && clampedAt >= fetchedAt) continue;
        const current = state.latestSeqByChannel[row.id];
        if (current !== undefined && current >= row.latestSeq) continue;
        seeded[row.id] = row.latestSeq;
      }
      if (Object.keys(seeded).length === 0) return state;
      return {
        latestSeqByChannel: { ...state.latestSeqByChannel, ...seeded },
      };
    }),
  markChannelRead: (channelId, seq) => {
    if (seq <= 0) return;
    const current = get().lastReadByChannel[channelId];
    if (current !== undefined && current >= seq) return;
    persistLastRead(channelId, seq);
    set((state) => ({
      lastReadByChannel: { ...state.lastReadByChannel, [channelId]: seq },
    }));
    // Fire-and-forget, AFTER the local write: the reading position is already
    // durable on this device, so the hub round trip is pure convergence and
    // must never sit between the operator and a cleared unread dot.
    scheduleReadStatePush(channelId, seq);
  },
  mergeReadState: (rows, fetchedAt) => {
    const state = get();
    const merged: Record<string, number> = {};
    const hubIsBehind: { channelId: string; seq: number }[] = [];
    for (const row of rows) {
      const hub =
        typeof row.lastReadSeq === 'number' && Number.isInteger(row.lastReadSeq)
          ? row.lastReadSeq
          : 0;
      // Same fence the channel-list seed applies (#1287): a payload fetched
      // before this channel's clamp still describes the pre-clamp world, and
      // merging it monotonic-up would re-raise the very marker the clamp
      // lowered — pinning a recreated DM's unread dot off for its whole new
      // lifetime, with nothing left that can lower it again.
      const clampedAt = state.clampedAtByChannel[row.channelId];
      if (clampedAt !== undefined && clampedAt >= fetchedAt) continue;
      const local = Math.max(
        state.lastReadByChannel[row.channelId] ?? 0,
        readPersistedLastRead(row.channelId)
      );
      if (hub > local) {
        // Mirror to localStorage as well as the store: the fast path has to
        // survive the reload, and every later comparison reads it back.
        persistLastRead(row.channelId, hub);
        merged[row.channelId] = hub;
      } else if (local > hub) {
        hubIsBehind.push({ channelId: row.channelId, seq: local });
      }
    }
    if (Object.keys(merged).length > 0) {
      set((current) => ({
        lastReadByChannel: { ...current.lastReadByChannel, ...merged },
      }));
    }
    // The retry lane. Values only ever increase and a matching mark schedules
    // nothing, so two devices trading pushes converge instead of ringing: the
    // higher device publishes once, the lower one merges and goes quiet.
    for (const behind of hubIsBehind) {
      scheduleReadStatePush(behind.channelId, behind.seq);
    }
  },
  clampChannelStores: (channelId, headSeq) => {
    discardReadStatePushAbove(channelId, headSeq);
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
      if (Object.keys(next).length === 0) return state;
      // Fence stale channel-list payloads (#1287) AND stale hub read-state
      // payloads (#1308 slice 3): every response already in flight or cached
      // still reports the pre-clamp head — and the pre-clamp read mark — for
      // this channel. One epoch guards both merges.
      next.clampedAtByChannel = {
        ...state.clampedAtByChannel,
        [channelId]: Date.now(),
      };
      return next;
    });
  },
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
