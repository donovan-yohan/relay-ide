// #1249: per-connection WebSocket send-queue backpressure + a half-open socket
// reaper, shared by every server→client fan-out lane (terminal PTY stream, agent
// web-session patches, event broadcast, routed-node PTY relay).
//
// Root cause of the incident: those lanes called `ws.send(JSON.stringify(...))`
// gated ONLY on `readyState === OPEN`. A backgrounded mobile tab / sleeping
// laptop / throttled-cellular / merely-slow client stays OPEN while the server
// keeps queuing outbound frames. Each queued frame is an off-heap Buffer in the
// socket's kernel/uv send queue — counted in `external`/`arrayBuffers`, NOT V8
// old-space — so it grows past `--max-old-space-size` with no heap OOM (the daily
// hub reached 15GB rss / ~150MB/min). The #1243 transcript cap bounds persisted
// data, not the per-connection send queue.
//
// The thresholds + close code mirror `channel-hub.ts` (the existing per-channel
// backpressure precedent) so all lanes speak the same protocol: a client that
// overflows reconnects and re-fetches (terminal → cursor replay from scrollback,
// agent → `agentPatchesV2` replay, channel → `sinceSeq`).

/** WebSocket.OPEN — kept local so fake sockets in tests need no `ws` import. */
export const WS_OPEN = 1;

/**
 * Soft watermark (mirrors channel-hub `WATERMARK_HIGH_BYTES`). Above this, a
 * lagging subscriber sheds high-frequency REPLAYABLE deltas (terminal `data`,
 * agent patches) instead of queuing more, and coarse/irreplaceable fan-out lanes
 * (events) close the socket. A healthy fast-draining client keeps `bufferedAmount`
 * far below this and is never affected.
 */
export const WS_SOFT_LIMIT_BYTES = 1024 * 1024; // 1MB
/**
 * Recovery watermark (mirrors channel-hub `WATERMARK_LOW_BYTES`). A lagging
 * delta lane that drains back below this clears `lagging` and re-syncs the client
 * (agent → fresh snapshot patch) so a shed delta gap is healed without a reconnect.
 */
export const WS_LOW_LIMIT_BYTES = 256 * 1024; // 256KB
/**
 * Hard watermark (mirrors channel-hub `HARD_LIMIT_BYTES`). Above this the socket
 * is closed with `WS_BACKPRESSURE_CLOSE_CODE`; its registered `close` handler
 * splices the subscriber, freeing the queue. The durable buffer (scrollback /
 * patch ring / seq log) makes the reconnect re-fetch lossless.
 */
export const WS_HARD_LIMIT_BYTES = 4 * 1024 * 1024; // 4MB

/**
 * Application close code for sustained backpressure overflow. Matches
 * `CHANNEL_WS_BACKPRESSURE_CLOSE_CODE` (4409) so the frontend's existing
 * non-1000 → reconnect path handles every lane identically.
 */
export const WS_BACKPRESSURE_CLOSE_CODE = 4409;

/** Default heartbeat interval; a socket missing one full interval is reaped. */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Minimal socket surface the send-side backpressure needs. The real `ws`
 * WebSocket satisfies it; tests inject fakes with a settable `bufferedAmount`
 * and a byte-counting `send`.
 */
export interface BackpressureSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export function bufferedAmountOf(ws: BackpressureSocket): number {
  return typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0;
}

export type BackpressureSendResult = 'sent' | 'dropped' | 'closed' | 'not-open';

export interface BackpressureSendOptions {
  /**
   * True for high-frequency REPLAYABLE deltas (terminal `data`, agent patches):
   * shed above the soft watermark instead of queuing. False for coarse frames
   * that must arrive intact (terminal metadata/resize, agent snapshot/resync).
   */
  droppable?: boolean;
  /**
   * True for irreplaceable coarse fan-out (the `/ws/events` lane): a subscriber
   * that is even soft-lagging on these is treated as dead and closed, rather than
   * corrupting its view by shedding an event it can't re-derive.
   */
  closeWhenLagging?: boolean;
}

/**
 * Send one frame on `ws` with per-connection send-queue backpressure. `serialize`
 * is a thunk so a dropped frame is never stringified. Returns the disposition;
 * `'closed'` means the socket was closed with `WS_BACKPRESSURE_CLOSE_CODE` and its
 * `close` handler (registered by the caller) will splice the subscriber.
 */
export function sendWithBackpressure(
  ws: BackpressureSocket,
  serialize: () => string,
  opts: BackpressureSendOptions = {}
): BackpressureSendResult {
  if (ws.readyState !== WS_OPEN) return 'not-open';
  const buffered = bufferedAmountOf(ws);
  if (buffered > WS_HARD_LIMIT_BYTES) {
    try {
      ws.close(WS_BACKPRESSURE_CLOSE_CODE);
    } catch {
      /* ignore */
    }
    return 'closed';
  }
  if (buffered > WS_SOFT_LIMIT_BYTES) {
    if (opts.closeWhenLagging) {
      try {
        ws.close(WS_BACKPRESSURE_CLOSE_CODE);
      } catch {
        /* ignore */
      }
      return 'closed';
    }
    if (opts.droppable) return 'dropped';
  }
  try {
    ws.send(serialize());
  } catch {
    return 'not-open';
  }
  return 'sent';
}

/**
 * Per-connection lagging state for a delta lane (agent patches) that heals a shed
 * gap with a re-sync once the queue drains, mirroring channel-hub's `deliver`.
 */
export interface DeltaLaneState {
  lagging: boolean;
}

export type DeltaLaneResult =
  | 'sent'
  | 'dropped'
  | 'closed'
  | 'resync'
  | 'not-open';

/**
 * Deliver one replayable delta to a subscriber that heals via re-sync:
 *  - `bufferedAmount > hard` → close 4409 (`'closed'`); handler splices. Checked
 *    FIRST so a client stuck lagging (never drains below low) is still closed if
 *    its queue ever crosses the hard cap.
 *  - LAGGING (a prior delta was shed) is a healing window: mirror channel-hub's
 *    `if (lagging) return` and SUPPRESS every subsequent raw delta (`'dropped'`)
 *    until the queue drains, so the client never applies a patch OVER the un-healed
 *    gap (#1250). Draining below the low watermark clears lagging and sends the
 *    `resync` snapshot ONLY (`'resync'`) — exactly once, no flapping. The snapshot
 *    is a full view of the already-applied session state (agent patches are applied
 *    to session state BEFORE this forwarder runs — see `handleAgentPatchV2`), so it
 *    already reflects every shed delta; sending a delta too would double-apply it.
 *  - `bufferedAmount > soft` (not yet lagging) → mark lagging, shed the delta
 *    (`'dropped'`).
 *  - otherwise send the delta (`'sent'`).
 *
 * A healthy client (low `bufferedAmount`) never lags, never drops, never re-syncs.
 * While lagging the send queue does NOT grow: every path returns without sending
 * except the single bounded resync snapshot on drain.
 */
export function deliverDelta(
  ws: BackpressureSocket,
  state: DeltaLaneState,
  serializeDelta: () => string,
  serializeResync: () => string
): DeltaLaneResult {
  if (ws.readyState !== WS_OPEN) return 'not-open';
  const buffered = bufferedAmountOf(ws);
  if (buffered > WS_HARD_LIMIT_BYTES) {
    try {
      ws.close(WS_BACKPRESSURE_CLOSE_CODE);
    } catch {
      /* ignore */
    }
    return 'closed';
  }
  if (state.lagging) {
    if (buffered < WS_LOW_LIMIT_BYTES) {
      // Recovered: the snapshot supersedes every shed delta (including this one).
      state.lagging = false;
      try {
        ws.send(serializeResync());
      } catch {
        return 'not-open';
      }
      return 'resync';
    }
    // Still healing in the [low, soft] band — suppress the raw delta rather than
    // let the client apply it over the un-healed gap (the missing #1250 guard).
    return 'dropped';
  }
  if (buffered > WS_SOFT_LIMIT_BYTES) {
    state.lagging = true;
    return 'dropped';
  }
  try {
    ws.send(serializeDelta());
  } catch {
    return 'not-open';
  }
  return 'sent';
}

/**
 * Per-subscriber gap-heal state for the terminal `data` lane (#1250). Mirrors the
 * agent `DeltaLaneState` but also remembers WHERE the shed gap starts so the drain
 * resync can replay exactly the missed contiguous byte range from server
 * scrollback instead of silently advancing the client past it.
 */
export interface TerminalLaneState {
  lagging: boolean;
  /**
   * Byte cursor at the START of the first shed frame == the client's current
   * cursor (everything before it was delivered contiguously). The resync replays
   * from here so the client's cursor only ever advances over bytes it receives.
   */
  gapStartCursor: number;
}

export type TerminalLaneResult =
  | 'sent'
  | 'dropped'
  | 'suppressed'
  | 'resync'
  | 'closed'
  | 'not-open';

/**
 * Deliver one terminal-stream envelope to a subscriber with a gap-heal mirroring
 * the agent delta lane, closing the #1250 silent-output-loss finding. Before this
 * fix a shed `data` envelope emitted nothing while the NEXT (coarse or drained)
 * envelope advanced the client's `Math.max` cursor PAST the shed range, so a
 * `?cursor=` reconnect never re-fetched it (permanent gap; a split ANSI escape
 * corrupts the xterm parser).
 *
 *  - `bufferedAmount > hard` → close 4409 (`'closed'`); the close handler splices.
 *  - LAGGING + drained below LOW → RESYNC: replay the contiguous missed byte range
 *    from `gapStartCursor` (server scrollback) so the client's cursor advances only
 *    over bytes it actually receives, then clear lagging (`'resync'`). If scrollback
 *    FIFO-trimmed part of the gap, the replay builder starts at the earliest still
 *    resident cursor and includes a `lag` marker for the unavoidable truncation.
 *  - LAGGING + still above LOW → SUPPRESS every envelope (`'suppressed'`). Coarse
 *    envelopes (metadata/resize/replay) carry a cursor too; sending one would let
 *    the client's cursor jump PAST the un-replayed gap, so they are held and folded
 *    into the resync replay (whose metadata carries the latest resize).
 *  - a `droppable` `data` delta above SOFT (not yet lagging) → shed it, record the
 *    gap start, enter lagging (`'dropped'`). The shed bytes stay in scrollback for
 *    the resync — nothing is sent, so the send queue does not grow.
 *  - otherwise send the envelope (`'sent'`).
 *
 * A healthy client (low `bufferedAmount`) never lags: every frame is sent in order.
 * While lagging the send queue does NOT grow — every path returns without sending
 * except the single bounded resync replay on drain (≤ scrollback capacity).
 */
export function deliverTerminalEnvelope(
  ws: BackpressureSocket,
  state: TerminalLaneState,
  frame: { droppable: boolean; gapStart: number; serialize: () => string },
  serializeResync: (gapStartCursor: number) => Iterable<string>
): TerminalLaneResult {
  if (ws.readyState !== WS_OPEN) return 'not-open';
  const buffered = bufferedAmountOf(ws);
  if (buffered > WS_HARD_LIMIT_BYTES) {
    try {
      ws.close(WS_BACKPRESSURE_CLOSE_CODE);
    } catch {
      /* ignore */
    }
    return 'closed';
  }
  if (state.lagging) {
    if (buffered < WS_LOW_LIMIT_BYTES) {
      state.lagging = false;
      try {
        for (const framePayload of serializeResync(state.gapStartCursor)) {
          ws.send(framePayload);
        }
      } catch {
        return 'not-open';
      }
      return 'resync';
    }
    return 'suppressed';
  }
  if (buffered > WS_SOFT_LIMIT_BYTES && frame.droppable) {
    state.lagging = true;
    state.gapStartCursor = frame.gapStart;
    return 'dropped';
  }
  try {
    ws.send(frame.serialize());
  } catch {
    return 'not-open';
  }
  return 'sent';
}

/**
 * Minimal socket surface the reaper needs. The real `ws` WebSocket satisfies it.
 */
export interface HeartbeatSocket {
  ping(): void;
  terminate(): void;
  on(event: 'pong', handler: () => void): void;
}

export interface WsHeartbeatMonitor {
  /**
   * Track a socket. `onReap` runs when the socket is reaped as half-open — it
   * must perform the same unsubscribe/cleanup as the socket's `close` handler
   * (splice the subscriber) and must be idempotent, since a real `terminate()`
   * also fires `close`.
   */
  track(ws: HeartbeatSocket, onReap: () => void): void;
  untrack(ws: HeartbeatSocket): void;
  /** Run one heartbeat tick synchronously (also driven by the interval). */
  tick(): void;
  trackedCount(): number;
  /** Stop the interval and drop all tracked sockets (call on server shutdown). */
  stop(): void;
}

/**
 * Half-open socket reaper. A socket that stays `readyState === OPEN` but is dead
 * (backgrounded tab whose TCP never FINs, sleeping laptop) never fires `close`,
 * so its subscriber is never spliced and its send queue grows forever. Each tick:
 * a socket that did not `pong` since the previous tick is `terminate()`d and its
 * `onReap` cleanup runs; otherwise it is marked not-alive and pinged. A live
 * client pongs (browsers auto-answer WS ping frames) and is never reaped.
 *
 * The interval is `.unref()`'d and cleared on `stop()` so it never keeps the
 * process alive or leaks a timer (#1244).
 */
export function createWsHeartbeatMonitor(
  opts: { intervalMs?: number } = {}
): WsHeartbeatMonitor {
  const intervalMs = opts.intervalMs ?? WS_HEARTBEAT_INTERVAL_MS;
  interface Entry {
    isAlive: boolean;
    onReap: () => void;
    onPong: () => void;
  }
  const tracked = new Map<HeartbeatSocket, Entry>();

  function runTick(): void {
    for (const [ws, entry] of [...tracked]) {
      if (!entry.isAlive) {
        tracked.delete(ws);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        try {
          entry.onReap();
        } catch {
          /* ignore */
        }
        continue;
      }
      entry.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }

  const timer = setInterval(runTick, intervalMs);
  timer.unref?.();

  return {
    track(ws, onReap) {
      const entry: Entry = {
        isAlive: true,
        onReap,
        onPong: () => {
          entry.isAlive = true;
        },
      };
      tracked.set(ws, entry);
      ws.on('pong', entry.onPong);
    },
    untrack(ws) {
      tracked.delete(ws);
    },
    tick: runTick,
    trackedCount() {
      return tracked.size;
    },
    stop() {
      clearInterval(timer);
      tracked.clear();
    },
  };
}
