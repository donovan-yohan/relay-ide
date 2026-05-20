// Bounded replay snapshot for #614 slice 2. A snapshot is a typed, point-in-time
// view of a PTY session's scrollback buffer. Consumers (mobile status card,
// reattach UX, agent adapters) fetch it via REST or pull it directly from
// `sessions.getReplaySnapshot(id)`.

/**
 * Default per-session scrollback cap shared between PTY handler and replay
 * consumers. Keep aligned with `MAX_SCROLLBACK` in `server/pty-handler.ts`
 * — the constant lives here so frontend / docs can reference one source.
 */
export const DEFAULT_SESSION_REPLAY_CAPACITY_BYTES = 256 * 1024;

export interface SessionReplaySnapshot {
  /**
   * Bounded replay payload, concatenated from the session's scrollback
   * buffer. May be empty if the session has not produced output yet.
   */
  payload: string;
  /** Byte length of `payload`. Equal to the FIFO's current resident bytes. */
  bytesIncluded: number;
  /**
   * Total bytes evicted from this session's scrollback over its lifetime.
   * Strictly increasing; non-zero means earlier output was discarded by the
   * FIFO cap and is not present in `payload`.
   */
  bytesDropped: number;
  /** Per-session FIFO cap that determined eviction. */
  capacityBytes: number;
  /** True iff `bytesDropped > 0`. Convenience flag for consumers. */
  truncated: boolean;
  /** ISO timestamp at which this snapshot was captured. */
  capturedAt: string;
  /** Session id this snapshot belongs to. */
  sessionId: string;
}
