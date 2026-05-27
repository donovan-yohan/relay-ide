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

export const TERMINAL_STREAM_PROTOCOL_VERSION = 2 as const;

export type TerminalStreamProtocolVersion =
  typeof TERMINAL_STREAM_PROTOCOL_VERSION;

export type TerminalStreamPayloadKind =
  | 'metadata'
  | 'data'
  | 'replay-start'
  | 'replay-end'
  | 'lag'
  | 'resize';

export type TerminalStreamResizeOwner = 'active' | 'passive';

export interface TerminalStreamCursorRange {
  start: number;
  end: number;
}

interface TerminalStreamEnvelopeBase<K extends TerminalStreamPayloadKind> {
  type: 'terminal-stream';
  version: TerminalStreamProtocolVersion;
  sessionId: string;
  /** Monotonic envelope sequence for this session stream. */
  seq: number;
  /** Monotonic cursor after this envelope has been applied. */
  cursor: number;
  kind: K;
  timestamp: string;
  /** True when emitted from bounded replay rather than live PTY output. */
  replay: boolean;
}

export interface TerminalStreamMetadataPayload {
  runtime: 'node-pty/tmux';
  capacityBytes: number;
  bytesDropped: number;
  oldestCursor: number;
  latestCursor: number;
  resizePolicy: 'single-active-owner';
  activeResizeOwnerId: string | null;
  lastResize: TerminalStreamResizePayload | null;
}

export interface TerminalStreamDataPayload {
  encoding: 'utf8';
  data: string;
  bytes: number;
  range: TerminalStreamCursorRange;
}

export interface TerminalStreamReplayStartPayload {
  requestedCursor: number | null;
  startCursor: number;
  endCursor: number;
  bounded: true;
}

export interface TerminalStreamReplayEndPayload {
  cursor: number;
  replayedFrames: number;
}

export type TerminalStreamLagReason =
  | 'cursor-too-old'
  | 'cursor-too-new'
  | 'server-backfill';

export interface TerminalStreamLagPayload {
  reason: TerminalStreamLagReason;
  requestedCursor: number | null;
  oldestCursor: number;
  latestCursor: number;
  bytesDropped: number;
  message: string;
}

export interface TerminalStreamResizePayload {
  cols: number;
  rows: number;
  owner: TerminalStreamResizeOwner;
  ownerClientId: string | null;
  sourceClientId: string;
  applied: boolean;
}

export type TerminalStreamMetadataEnvelope =
  TerminalStreamEnvelopeBase<'metadata'> & {
    payload: TerminalStreamMetadataPayload;
  };
export type TerminalStreamDataEnvelope = TerminalStreamEnvelopeBase<'data'> & {
  payload: TerminalStreamDataPayload;
};
export type TerminalStreamReplayStartEnvelope =
  TerminalStreamEnvelopeBase<'replay-start'> & {
    payload: TerminalStreamReplayStartPayload;
  };
export type TerminalStreamReplayEndEnvelope =
  TerminalStreamEnvelopeBase<'replay-end'> & {
    payload: TerminalStreamReplayEndPayload;
  };
export type TerminalStreamLagEnvelope = TerminalStreamEnvelopeBase<'lag'> & {
  payload: TerminalStreamLagPayload;
};
export type TerminalStreamResizeEnvelope =
  TerminalStreamEnvelopeBase<'resize'> & {
    payload: TerminalStreamResizePayload;
  };

export type TerminalStreamEnvelope =
  | TerminalStreamMetadataEnvelope
  | TerminalStreamDataEnvelope
  | TerminalStreamReplayStartEnvelope
  | TerminalStreamReplayEndEnvelope
  | TerminalStreamLagEnvelope
  | TerminalStreamResizeEnvelope;

export interface TerminalStreamState {
  sessionId: string;
  nextSeq: number;
  /** Cursor after the newest byte retained/emitted by this session. */
  cursor: number;
  /** Cursor for the oldest retained byte; moves forward on FIFO/global trim. */
  oldestCursor: number;
  capacityBytes: number;
  bytesDropped: number;
  frames: TerminalStreamDataEnvelope[];
  activeResizeOwnerId: string | null;
  lastResize: TerminalStreamResizePayload | null;
}

export function createTerminalStreamState(input: {
  sessionId: string;
  capacityBytes?: number;
  initialChunks?: string[];
  bytesDropped?: number;
}): TerminalStreamState {
  const state: TerminalStreamState = {
    sessionId: input.sessionId,
    nextSeq: 0,
    cursor: input.bytesDropped ?? 0,
    oldestCursor: input.bytesDropped ?? 0,
    capacityBytes: input.capacityBytes ?? DEFAULT_SESSION_REPLAY_CAPACITY_BYTES,
    bytesDropped: input.bytesDropped ?? 0,
    frames: [],
    activeResizeOwnerId: null,
    lastResize: null,
  };
  for (const chunk of input.initialChunks ?? []) {
    appendTerminalStreamData(state, chunk, true);
  }
  return state;
}

function nowIso(): string {
  return new Date().toISOString();
}

function envelopeBase<K extends TerminalStreamPayloadKind>(
  state: TerminalStreamState,
  kind: K,
  cursor: number,
  replay: boolean,
  seq: number
): TerminalStreamEnvelopeBase<K> {
  return {
    type: 'terminal-stream',
    version: TERMINAL_STREAM_PROTOCOL_VERSION,
    sessionId: state.sessionId,
    seq,
    cursor,
    kind,
    timestamp: nowIso(),
    replay,
  };
}

function nextEnvelopeBase<K extends TerminalStreamPayloadKind>(
  state: TerminalStreamState,
  kind: K,
  cursor: number,
  replay: boolean
): TerminalStreamEnvelopeBase<K> {
  return envelopeBase(state, kind, cursor, replay, state.nextSeq++);
}

export function appendTerminalStreamData(
  state: TerminalStreamState,
  data: string,
  replay = false
): TerminalStreamDataEnvelope {
  const start = state.cursor;
  const end = start + data.length;
  state.cursor = end;
  const envelope: TerminalStreamDataEnvelope = {
    ...nextEnvelopeBase(state, 'data', end, replay),
    payload: {
      encoding: 'utf8',
      data,
      bytes: data.length,
      range: { start, end },
    },
  };
  state.frames.push(envelope);
  trimTerminalStreamToCapacity(state);
  return envelope;
}

export function trimTerminalStreamToCapacity(state: TerminalStreamState): void {
  while (
    state.cursor - state.oldestCursor > state.capacityBytes &&
    state.frames.length > 1
  ) {
    const evicted = state.frames.shift()!;
    state.oldestCursor = evicted.payload.range.end;
    state.bytesDropped = Math.max(state.bytesDropped, state.oldestCursor);
  }
}

export function dropTerminalStreamPrefixBytes(
  state: TerminalStreamState | undefined,
  bytes: number
): void {
  if (!state || bytes <= 0) return;
  const target = Math.min(state.cursor, state.oldestCursor + bytes);
  state.oldestCursor = Math.max(state.oldestCursor, target);
  state.bytesDropped = Math.max(state.bytesDropped, state.oldestCursor);
  state.frames = state.frames
    .map((frame) => {
      if (frame.payload.range.end <= state.oldestCursor) return null;
      if (frame.payload.range.start >= state.oldestCursor) return frame;
      const offset = state.oldestCursor - frame.payload.range.start;
      const data = frame.payload.data.slice(offset);
      return {
        ...frame,
        payload: {
          ...frame.payload,
          data,
          bytes: data.length,
          range: { start: state.oldestCursor, end: frame.payload.range.end },
        },
      };
    })
    .filter((frame): frame is TerminalStreamDataEnvelope => frame !== null);
}

export function terminalStreamMetadata(
  state: TerminalStreamState,
  replay = false,
  cursor = state.cursor
): TerminalStreamMetadataEnvelope {
  return {
    ...nextEnvelopeBase(state, 'metadata', cursor, replay),
    payload: terminalStreamMetadataPayload(state),
  };
}

function terminalStreamMetadataPayload(
  state: TerminalStreamState
): TerminalStreamMetadataPayload {
  return {
    runtime: 'node-pty/tmux',
    capacityBytes: state.capacityBytes,
    bytesDropped: state.bytesDropped,
    oldestCursor: state.oldestCursor,
    latestCursor: state.cursor,
    resizePolicy: 'single-active-owner',
    activeResizeOwnerId: state.activeResizeOwnerId,
    lastResize: state.lastResize,
  };
}

function replayEnvelopeBase<K extends TerminalStreamPayloadKind>(
  state: TerminalStreamState,
  seq: number,
  kind: K,
  cursor: number
): TerminalStreamEnvelopeBase<K> {
  return envelopeBase(state, kind, cursor, true, seq);
}

function replayMetadataEnvelope(
  state: TerminalStreamState,
  seq: number,
  cursor: number
): TerminalStreamMetadataEnvelope {
  return {
    ...replayEnvelopeBase(state, seq, 'metadata', cursor),
    payload: terminalStreamMetadataPayload(state),
  };
}

export function recordTerminalStreamResize(
  state: TerminalStreamState,
  input: {
    cols: number;
    rows: number;
    owner: TerminalStreamResizeOwner;
    sourceClientId: string;
  }
): TerminalStreamResizeEnvelope {
  const applied = input.owner === 'active';
  if (applied) state.activeResizeOwnerId = input.sourceClientId;
  const payload: TerminalStreamResizePayload = {
    cols: input.cols,
    rows: input.rows,
    owner: input.owner,
    ownerClientId: state.activeResizeOwnerId,
    sourceClientId: input.sourceClientId,
    applied,
  };
  state.lastResize = payload;
  return {
    ...nextEnvelopeBase(state, 'resize', state.cursor, false),
    payload,
  };
}

export function buildTerminalStreamReplay(
  state: TerminalStreamState,
  requestedCursor: number | null
): TerminalStreamEnvelope[] {
  const envelopes: TerminalStreamEnvelope[] = [];
  let replaySeq = state.nextSeq;
  const nextReplayBase = <K extends TerminalStreamPayloadKind>(
    kind: K,
    cursor: number
  ) => replayEnvelopeBase(state, replaySeq++, kind, cursor);
  const replayFrom = requestedCursor ?? state.oldestCursor;
  const tooOld = requestedCursor !== null && replayFrom < state.oldestCursor;
  const tooNew = requestedCursor !== null && replayFrom > state.cursor;
  const startCursor = tooOld
    ? state.oldestCursor
    : tooNew
      ? state.cursor
      : Math.max(state.oldestCursor, replayFrom);

  envelopes.push(replayMetadataEnvelope(state, replaySeq++, startCursor));
  if (tooOld || tooNew) {
    const reason: TerminalStreamLagReason = tooOld
      ? 'cursor-too-old'
      : 'cursor-too-new';
    envelopes.push({
      ...nextReplayBase('lag', startCursor),
      payload: {
        reason,
        requestedCursor,
        oldestCursor: state.oldestCursor,
        latestCursor: state.cursor,
        bytesDropped: state.bytesDropped,
        message:
          reason === 'cursor-too-old'
            ? 'requested terminal cursor is older than the bounded replay buffer; replay starts at the oldest retained cursor'
            : 'requested terminal cursor is newer than the server cursor; replay is empty and live output will continue from the current cursor',
      },
    });
  } else if (requestedCursor !== null && requestedCursor < state.cursor) {
    envelopes.push({
      ...nextReplayBase('lag', startCursor),
      payload: {
        reason: 'server-backfill',
        requestedCursor,
        oldestCursor: state.oldestCursor,
        latestCursor: state.cursor,
        bytesDropped: state.bytesDropped,
        message:
          'server is backfilling terminal output from the requested cursor',
      },
    });
  }

  envelopes.push({
    ...nextReplayBase('replay-start', startCursor),
    payload: {
      requestedCursor,
      startCursor,
      endCursor: state.cursor,
      bounded: true,
    },
  });

  let replayedFrames = 0;
  if (!tooNew) {
    for (const frame of state.frames) {
      if (frame.payload.range.end <= startCursor) continue;
      if (frame.payload.range.start >= startCursor) {
        envelopes.push({
          ...nextReplayBase('data', frame.payload.range.end),
          payload: frame.payload,
        });
        replayedFrames++;
        continue;
      }
      const offset = startCursor - frame.payload.range.start;
      const data = frame.payload.data.slice(offset);
      envelopes.push({
        ...nextReplayBase('data', frame.payload.range.end),
        payload: {
          ...frame.payload,
          data,
          bytes: data.length,
          range: { start: startCursor, end: frame.payload.range.end },
        },
      });
      replayedFrames++;
    }
  }

  envelopes.push({
    ...nextReplayBase('replay-end', state.cursor),
    payload: { cursor: state.cursor, replayedFrames },
  });
  return envelopes;
}

export function isTerminalStreamEnvelope(
  value: unknown
): value is TerminalStreamEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['type'] === 'terminal-stream' &&
    record['version'] === TERMINAL_STREAM_PROTOCOL_VERSION &&
    typeof record['sessionId'] === 'string' &&
    typeof record['seq'] === 'number' &&
    typeof record['cursor'] === 'number' &&
    typeof record['kind'] === 'string' &&
    typeof record['payload'] === 'object' &&
    record['payload'] !== null
  );
}
