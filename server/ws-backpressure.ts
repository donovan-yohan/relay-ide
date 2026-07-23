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
 *  - `bufferedAmount > hard` → close 4409 (`'closed'`); handler splices.
 *  - draining below the low watermark after lagging → clear lagging and send the
 *    `resync` frame ONLY (`'resync'`). `serializeResync` is a full snapshot of the
 *    already-applied session state (agent patches are applied to session state
 *    BEFORE this forwarder runs — see `handleAgentPatchV2`), so it already
 *    reflects this delta; sending the delta too would double-apply it client-side.
 *  - `bufferedAmount > soft` → mark lagging, shed the delta (`'dropped'`).
 *  - otherwise send the delta (`'sent'`).
 *
 * A healthy client (low `bufferedAmount`) never lags, never drops, never re-syncs.
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
  if (state.lagging && buffered < WS_LOW_LIMIT_BYTES) {
    // Recovered: the snapshot supersedes every shed delta (including this one).
    state.lagging = false;
    try {
      ws.send(serializeResync());
    } catch {
      return 'not-open';
    }
    return 'resync';
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
