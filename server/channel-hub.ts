import { createLogger } from './logger.js';
import type { ChannelMessageStore } from './channel-message-store.js';
import {
  type ChannelEventV1,
  type ChannelInFlightRef,
  type ChannelMemberRef,
  type ChannelMention,
  type ChannelMessage,
  type ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';

const logger = createLogger('channel-hub');

// Per-channel fan-out hub (#1165). Owns the live subscriber sets, per-message
// in-flight accumulators, delta coalescing, the connect-time snapshot/live
// dedupe, backpressure watermarks, the `onMessagePosted` hook, and the coarse
// `channel-activity` sidebar badge emit. There is NO in-memory event ring:
// committed catch-up always reads SQLite (the durable seq log is the buffer).

/** WebSocket.OPEN — kept local so fake sockets in tests need no ws import. */
const WS_OPEN = 1;

/** app close code: unknown/missing channel (precedent TERMINAL_WS_SESSION_NOT_FOUND_CLOSE_CODE 4404). */
export const CHANNEL_WS_NOT_FOUND_CLOSE_CODE = 4404;
/** app close code: sustained backpressure overflow; client reconnects with sinceSeq. */
export const CHANNEL_WS_BACKPRESSURE_CLOSE_CODE = 4409;

/** flush one coalesced delta per tick, bounding event rate regardless of token rate. */
const DEFAULT_COALESCE_MS = 50;
const WATERMARK_HIGH_BYTES = 1024 * 1024; // suppress deltas above this
const WATERMARK_LOW_BYTES = 256 * 1024; // resume + resync below this
const HARD_LIMIT_BYTES = 4 * 1024 * 1024; // close 4409 above this
/** full snapshot window (last N messages). */
const SNAPSHOT_FULL_LIMIT = 100;
/** catch-up beyond this gap falls back to a full snapshot. */
const CATCHUP_MAX_ROWS = 500;
/**
 * Byte budget for a single WS snapshot / catch-up assembly. Rows are row-bounded
 * (SNAPSHOT_FULL_LIMIT / CATCHUP_MAX_ROWS) but each body is capped at 256KB, so a
 * transcript-heavy channel could otherwise serialize tens of MB into one
 * `ws.send`. We stop accumulating past this budget and flag `truncated` so the
 * client paginates the remainder via `channels.history`.
 */
const DEFAULT_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Defense-in-depth bounds for events produced re-entrantly while a subscriber's
 * connect-time snapshot is being sent. In production the better-sqlite3 snapshot
 * read is synchronous, but the queue must still have a hard ceiling: SQLite is
 * the durable catch-up buffer, so an overflowing client can reconnect by seq.
 */
const DEFAULT_CONNECT_QUEUE_MAX_EVENTS = CATCHUP_MAX_ROWS;
const DEFAULT_CONNECT_QUEUE_MAX_BYTES = DEFAULT_SNAPSHOT_MAX_BYTES;

/**
 * Minimal socket surface the hub needs. The real `ws` WebSocket satisfies it;
 * tests inject fakes with a settable `bufferedAmount` to exercise backpressure.
 */
export interface ChannelSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'close' | 'error', handler: () => void): void;
}

interface Subscriber {
  ws: ChannelSocket;
  channelId: string;
  /** live events queue here until the connect-time snapshot has been sent. */
  buffering: boolean;
  queue: ChannelEventV1[];
  queueBytes: number;
  snapshotLatestSeq: number;
  snapshotInFlight: Map<string, number>;
  /** suppressing deltas after a high-watermark breach until the buffer drains. */
  lagging: boolean;
}

interface Accumulator {
  channelId: string;
  messageId: string;
  sender: ChannelSenderRef;
  /** authoritative in-memory text (>= last DB flush). */
  text: string;
  /** text not yet emitted as a coalesced delta. */
  pendingText: string;
  /** last emitted deltaIndex (−1 before the first flush). */
  deltaIndex: number;
  coalesceTimer: NodeJS.Timeout | null;
  /** Latest persisted full-row refresh waiting for one debounced broadcast. */
  pendingUpdate: ChannelMessage | null;
  updateTimer: NodeJS.Timeout | null;
}

export type ChannelMessagePostedHandler = (
  message: ChannelMessage,
  mentions: ChannelMention[]
) => void;

export type ChannelBadgeBroadcaster = (
  type: string,
  data: Record<string, unknown>
) => void;

export interface ChannelHubOptions {
  store: ChannelMessageStore | null;
  /** channel existence check (topic-store backed in prod). Defaults to always-true. */
  channelExists?: (channelId: string) => boolean;
  coalesceMs?: number;
  badgeBroadcaster?: ChannelBadgeBroadcaster;
  /** byte budget for one snapshot/catch-up assembly (defaults to 4MB). */
  snapshotMaxBytes?: number;
  /** connect-time live queue event cap (defaults to the catch-up row cap). */
  connectQueueMaxEvents?: number;
  /** connect-time live queue byte cap (defaults to 4MB). */
  connectQueueMaxBytes?: number;
}

export interface ChannelHub {
  handleConnection(
    ws: ChannelSocket,
    input: { channelId: string; sinceSeq: number | null }
  ): void;
  broadcastCreated(message: ChannelMessage, mentions?: ChannelMention[]): void;
  beginStreamBroadcast(message: ChannelMessage): void;
  pushDelta(messageId: string, text: string): void;
  /** Debounced authoritative full-row refresh for streaming card state. */
  updateStreamBroadcast(message: ChannelMessage): void;
  completeStreamBroadcast(message: ChannelMessage): void;
  /** Fan out an operator edit of an already-durable row (#1308 slice 1 item 3). */
  broadcastEdited(message: ChannelMessage): void;
  onMessagePosted(handler: ChannelMessagePostedHandler): () => void;
  setBadgeBroadcaster(broadcaster: ChannelBadgeBroadcaster): void;
  channelExists(channelId: string): boolean;
  subscriberCount(channelId: string): number;
  /** Internal load-harness diagnostic; connect queues must drain back to zero. */
  retentionSnapshot(): {
    connectQueueEvents: number;
    connectQueueBytes: number;
  };
  close(): void;
}

export function createChannelHub(options: ChannelHubOptions): ChannelHub {
  const store = options.store;
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const channelExists = options.channelExists ?? (() => true);
  const snapshotMaxBytes =
    options.snapshotMaxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES;
  const connectQueueMaxEvents =
    options.connectQueueMaxEvents ?? DEFAULT_CONNECT_QUEUE_MAX_EVENTS;
  const connectQueueMaxBytes =
    options.connectQueueMaxBytes ?? DEFAULT_CONNECT_QUEUE_MAX_BYTES;
  let badgeBroadcaster = options.badgeBroadcaster ?? null;

  const subscribers = new Map<string, Set<Subscriber>>();
  const accumulators = new Map<string, Accumulator>();
  const postedHandlers = new Set<ChannelMessagePostedHandler>();

  function nowIso(): string {
    return new Date().toISOString();
  }

  function bufferedAmount(ws: ChannelSocket): number {
    return typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0;
  }

  function rawSend(ws: ChannelSocket, event: ChannelEventV1): void {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(event));
    } catch (err) {
      logger.warn('channel-hub send failed:', err);
    }
  }

  function addSubscriber(channelId: string, sub: Subscriber): void {
    let set = subscribers.get(channelId);
    if (!set) {
      set = new Set();
      subscribers.set(channelId, set);
    }
    set.add(sub);
  }

  function removeSubscriber(channelId: string, sub: Subscriber): void {
    const set = subscribers.get(channelId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) subscribers.delete(channelId);
  }

  function latestSeqFor(channelId: string): number {
    return store ? store.latestSeq(channelId) : 0;
  }

  function resyncEvent(channelId: string): ChannelEventV1 {
    return {
      type: 'channel-resync-required-v1',
      channelId,
      timestamp: nowIso(),
      latestSeq: latestSeqFor(channelId),
    };
  }

  /**
   * Deliver one event to one live subscriber with backpressure discipline:
   *  - `bufferedAmount > 4MB` → close 4409 (durable log is re-fetchable by seq).
   *  - `bufferedAmount > 1MB` → mark lagging; suppress DELTA events only.
   *  - durable events (`created`/`completed`/`snapshot`/`resync`) are ALWAYS sent.
   *  - draining below 256KB clears lagging and emits `channel-resync-required-v1`.
   */
  function deliver(sub: Subscriber, event: ChannelEventV1): void {
    const ws = sub.ws;
    if (ws.readyState !== WS_OPEN) return;
    const buffered = bufferedAmount(ws);
    if (buffered > HARD_LIMIT_BYTES) {
      closeSubscriber(sub, CHANNEL_WS_BACKPRESSURE_CLOSE_CODE);
      return;
    }
    if (sub.lagging && buffered < WATERMARK_LOW_BYTES) {
      sub.lagging = false;
      rawSend(ws, resyncEvent(sub.channelId));
    }
    if (event.type === 'channel-message-delta-v1') {
      if (sub.lagging) return; // suppress deltas while lagging
      if (buffered > WATERMARK_HIGH_BYTES) {
        sub.lagging = true;
        return;
      }
    }
    rawSend(ws, event);
  }

  function closeSubscriber(sub: Subscriber, code: number): void {
    removeSubscriber(sub.channelId, sub);
    try {
      sub.ws.close(code);
    } catch {
      /* ignore */
    }
  }

  function broadcast(channelId: string, event: ChannelEventV1): void {
    const set = subscribers.get(channelId);
    if (!set) return;
    for (const sub of [...set]) {
      if (sub.buffering) {
        const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
        if (
          sub.queue.length >= connectQueueMaxEvents ||
          sub.queueBytes + eventBytes > connectQueueMaxBytes
        ) {
          closeSubscriber(sub, CHANNEL_WS_BACKPRESSURE_CLOSE_CODE);
          continue;
        }
        sub.queue.push(event);
        sub.queueBytes += eventBytes;
        continue;
      }
      deliver(sub, event);
    }
  }

  function emitBadge(channelId: string): void {
    badgeBroadcaster?.('channel-activity', {
      channelId,
      latestSeq: latestSeqFor(channelId),
    });
  }

  /**
   * Assemble rows under the byte budget. `keepEnd` chooses which side to keep
   * when the candidate set overflows: `'tail'` keeps the newest rows (full
   * snapshot — older rows scroll back), `'head'` keeps the oldest-first rows
   * (catch-up — forward pagination fills the remainder). The normal snapshot
   * mode keeps ≥1 row (a single row is ≤256KB < 4MB); an optional remainder
   * mode may keep zero rows so a secondary allocation cannot exceed the shared
   * cap. Returns `truncated` when it stopped early.
   */
  function assembleWithBudget(
    candidate: ChannelMessage[],
    keepEnd: 'head' | 'tail',
    maxBytes = snapshotMaxBytes,
    keepFirstOverBudget = true
  ): { rows: ChannelMessage[]; truncated: boolean; bytes: number } {
    if (candidate.length === 0) return { rows: [], truncated: false, bytes: 0 };
    const order = keepEnd === 'tail' ? [...candidate].reverse() : candidate;
    const kept: ChannelMessage[] = [];
    let bytes = 0;
    let truncated = false;
    for (const row of order) {
      const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
      if (
        bytes + size > maxBytes &&
        (kept.length > 0 || !keepFirstOverBudget)
      ) {
        truncated = true;
        break;
      }
      bytes += size;
      kept.push(row);
    }
    if (keepEnd === 'tail') kept.reverse();
    return { rows: kept, truncated, bytes };
  }

  function buildSnapshot(
    channelId: string,
    sinceSeq: number | null
  ): ChannelEventV1 {
    const latestSeq = latestSeqFor(channelId);
    const members: ChannelMemberRef[] = store
      ? store.listMembers(channelId)
      : [];
    let mode: 'full' | 'catchup';
    let assembled: { rows: ChannelMessage[]; truncated: boolean };
    // The head advertised to the client. Normally the true channel head; capped
    // to the last row actually delivered when a catch-up is byte-truncated, so
    // the reducer's `lastSeq` never skips undelivered rows.
    let snapshotLatestSeq = latestSeq;

    // A cursor ahead of the server head (rollback / topic recreated under the
    // same deterministic slug) must reset the client, not silently drop every
    // future message — force a full snapshot so `lastSeq` is pulled back to head.
    const staleAhead = sinceSeq !== null && sinceSeq > latestSeq;

    if (
      sinceSeq === null ||
      staleAhead ||
      latestSeq - sinceSeq > CATCHUP_MAX_ROWS
    ) {
      mode = 'full';
      const fullRows = store
        ? store.history(channelId, { limit: SNAPSHOT_FULL_LIMIT })
        : [];
      assembled = assembleWithBudget(fullRows, 'tail');
      if (!assembled.truncated) {
        assembled.truncated =
          assembled.rows.length > 0 && (assembled.rows[0]?.seq ?? 1) > 1;
      }
    } else {
      mode = 'catchup';
      // Reconnect catch-up must also refresh rows at or below the cursor whose
      // status changed while the client was disconnected — specifically a stream
      // that finalized (streaming → complete/truncated/interrupted/failed) without adding a
      // new seq. `history({ afterSeq })` alone never resends those, leaving a
      // permanently stuck streaming row. Agent-origin rows are the only ones that
      // mutate in place, so re-send their CURRENT state; the reducer replaces the
      // stale copy by id. This heals every reconnect path (incl. backpressure
      // resync and post-restart, since it is a pure DB read).
      const resync = store
        ? store.listResyncRows(channelId, sinceSeq, CATCHUP_MAX_ROWS)
        : [];
      const fresh: ChannelMessage[] = [];
      let cursor = sinceSeq;
      while (store && fresh.length < CATCHUP_MAX_ROWS) {
        const page = store.history(channelId, { afterSeq: cursor, limit: 200 });
        if (page.length === 0) break;
        fresh.push(...page);
        cursor = page[page.length - 1]!.seq;
        if (page.length < 200) break;
      }
      // Fresh rows must consume the shared budget first: skipping a fresh seq
      // would strand the reconnect cursor behind it. Resync rows only replace
      // known messages, so use any remainder for the rows nearest the cursor.
      const freshAssembled = assembleWithBudget(fresh, 'head');
      const remainingBytes = snapshotMaxBytes - freshAssembled.bytes;
      const resyncAssembled =
        remainingBytes > 0
          ? assembleWithBudget(resync, 'tail', remainingBytes, false)
          : { rows: [], truncated: resync.length > 0, bytes: 0 };
      assembled = {
        rows: [...resyncAssembled.rows, ...freshAssembled.rows].sort(
          (a, b) => a.seq - b.seq
        ),
        truncated: freshAssembled.truncated || resyncAssembled.truncated,
      };
      // Only a fresh-row truncation leaves an undelivered seq above the cursor.
      // Partial resync merely omits stale replacements and must not pull the
      // cursor back from an otherwise complete fresh catch-up.
      if (freshAssembled.truncated && freshAssembled.rows.length > 0) {
        snapshotLatestSeq =
          freshAssembled.rows[freshAssembled.rows.length - 1]!.seq;
      }
    }

    const rows = assembled.rows;

    // Overlay the hub's in-memory accumulated text onto streaming rows — it is
    // authoritative over the DB flush lag — and record each open stream's index.
    // Any pending (accumulated-but-unemitted) delta text was flushed before this
    // read (see flushPendingForChannel), so `acc.deltaIndex` is the exact index
    // whose text is already reflected in `acc.text`.
    const inFlight: ChannelInFlightRef[] = [];
    const messages = rows.map((message) => {
      const acc = accumulators.get(message.id);
      if (acc && message.status === 'streaming') {
        inFlight.push({ messageId: message.id, deltaIndex: acc.deltaIndex });
        return { ...message, body: { ...message.body, text: acc.text } };
      }
      return message;
    });

    return {
      type: 'channel-snapshot-v1',
      channelId,
      timestamp: nowIso(),
      mode,
      messages,
      members,
      latestSeq: snapshotLatestSeq,
      inFlight,
      truncated: assembled.truncated,
    };
  }

  function flushAccumulator(messageId: string): void {
    const acc = accumulators.get(messageId);
    if (!acc) return;
    acc.coalesceTimer = null;
    if (acc.pendingText.length === 0) return;
    acc.deltaIndex += 1;
    const text = acc.pendingText;
    acc.pendingText = '';
    broadcast(acc.channelId, {
      type: 'channel-message-delta-v1',
      channelId: acc.channelId,
      timestamp: nowIso(),
      messageId: acc.messageId as ChannelMessage['id'],
      deltaIndex: acc.deltaIndex,
      delta: { text },
    });
  }

  function flushRowUpdate(messageId: string): void {
    const acc = accumulators.get(messageId);
    if (!acc) return;
    acc.updateTimer = null;
    const message = acc.pendingUpdate;
    acc.pendingUpdate = null;
    if (!message) return;
    broadcast(message.channelId, {
      type: 'channel-message-updated-v1',
      channelId: message.channelId,
      timestamp: nowIso(),
      message,
    });
  }

  /**
   * Flush any pending (accumulated-but-unemitted) delta text for a channel's
   * streaming rows synchronously, before a connecting socket reads its snapshot.
   *
   * Without this, `buildSnapshot` would overlay `acc.text` (which includes the
   * unflushed `pendingText`) while recording only the last EMITTED `deltaIndex`;
   * the subsequent coalesce flush would then re-deliver that same text as
   * `deltaIndex + 1` and the reducer would append it a SECOND time (duplicated
   * render). Flushing here — while the new socket is already registered and still
   * buffering — routes the flush delta through the connect-time queue where the
   * deltaIndex dedupe drops it, so the snapshot and the live stream agree exactly.
   */
  function flushPendingForChannel(channelId: string): void {
    for (const acc of accumulators.values()) {
      if (acc.channelId !== channelId || acc.pendingText.length === 0) continue;
      if (acc.coalesceTimer) {
        clearTimeout(acc.coalesceTimer);
        acc.coalesceTimer = null;
      }
      flushAccumulator(acc.messageId);
    }
  }

  return {
    handleConnection(ws, { channelId, sinceSeq }) {
      if (!store || !channelExists(channelId)) {
        try {
          ws.close(CHANNEL_WS_NOT_FOUND_CLOSE_CODE);
        } catch {
          /* ignore */
        }
        return;
      }
      const sub: Subscriber = {
        ws,
        channelId,
        buffering: true,
        queue: [],
        queueBytes: 0,
        snapshotLatestSeq: 0,
        snapshotInFlight: new Map(),
        lagging: false,
      };
      // Register FIRST so live events during snapshot build queue rather than
      // race; better-sqlite3 reads are synchronous, so the queue + dedupe below
      // is defense in depth.
      addSubscriber(channelId, sub);

      // Flush any pending accumulator text BEFORE reading the snapshot so the
      // snapshot's recorded deltaIndex matches the overlaid text exactly; the
      // flush delta queues on this buffering socket and is deduped below.
      flushPendingForChannel(channelId);

      const snapshot = buildSnapshot(channelId, sinceSeq);
      if (snapshot.type === 'channel-snapshot-v1') {
        sub.snapshotLatestSeq = snapshot.latestSeq;
        for (const ref of snapshot.inFlight) {
          sub.snapshotInFlight.set(ref.messageId, ref.deltaIndex);
        }
      }
      deliver(sub, snapshot);
      if (ws.readyState !== WS_OPEN) return;

      // Flush queued live events with dedupe: drop committed events with
      // seq <= snapshot endSeq; drop deltas with deltaIndex <= the snapshot's
      // recorded index for that message (dedupe stream events by messageId +
      // deltaIndex, NOT seq); always forward completed (idempotent replace-by-id).
      const queued = sub.queue;
      sub.queue = [];
      sub.queueBytes = 0;
      sub.buffering = false;
      for (const event of queued) {
        if (
          event.type === 'channel-message-created-v1' &&
          event.message.seq <= sub.snapshotLatestSeq
        ) {
          continue;
        }
        if (event.type === 'channel-message-delta-v1') {
          const recorded = sub.snapshotInFlight.get(event.messageId);
          if (recorded !== undefined && event.deltaIndex <= recorded) continue;
        }
        deliver(sub, event);
      }

      ws.on('close', () => removeSubscriber(channelId, sub));
      ws.on('error', () => removeSubscriber(channelId, sub));
    },

    broadcastCreated(message, mentions) {
      broadcast(message.channelId, {
        type: 'channel-message-created-v1',
        channelId: message.channelId,
        timestamp: nowIso(),
        message,
      });
      emitBadge(message.channelId);
      const resolved = mentions ?? message.mentions ?? [];
      for (const handler of [...postedHandlers]) {
        try {
          handler(message, resolved);
        } catch (err) {
          logger.warn('onMessagePosted handler error:', err);
        }
      }
    },

    beginStreamBroadcast(message) {
      accumulators.set(message.id, {
        channelId: message.channelId,
        messageId: message.id,
        sender: message.sender,
        text: message.body.text,
        pendingText: '',
        deltaIndex: -1,
        coalesceTimer: null,
        pendingUpdate: null,
        updateTimer: null,
      });
      broadcast(message.channelId, {
        type: 'channel-message-created-v1',
        channelId: message.channelId,
        timestamp: nowIso(),
        message,
      });
      emitBadge(message.channelId);
    },

    pushDelta(messageId, text) {
      const acc = accumulators.get(messageId);
      if (!acc || text.length === 0) return;
      acc.text += text;
      acc.pendingText += text;
      if (!acc.coalesceTimer) {
        acc.coalesceTimer = setTimeout(
          () => flushAccumulator(messageId),
          coalesceMs
        );
        acc.coalesceTimer.unref?.();
      }
    },

    updateStreamBroadcast(message) {
      const acc = accumulators.get(message.id);
      if (!acc || message.status !== 'streaming') return;
      acc.pendingUpdate = message;
      if (!acc.updateTimer) {
        acc.updateTimer = setTimeout(
          () => flushRowUpdate(message.id),
          coalesceMs
        );
        acc.updateTimer.unref?.();
      }
    },

    completeStreamBroadcast(message) {
      const acc = accumulators.get(message.id);
      if (acc?.coalesceTimer) clearTimeout(acc.coalesceTimer);
      if (acc?.updateTimer) clearTimeout(acc.updateTimer);
      accumulators.delete(message.id);
      broadcast(message.channelId, {
        type: 'channel-message-completed-v1',
        channelId: message.channelId,
        timestamp: nowIso(),
        message,
      });
      emitBadge(message.channelId);
    },

    broadcastEdited(message) {
      broadcast(message.channelId, {
        type: 'channel-message-edited-v1',
        channelId: message.channelId,
        timestamp: nowIso(),
        message,
      });
      // Deliberately no `emitBadge` and no `onMessagePosted` fan-out. The badge
      // carries `latestSeq`, which an edit does not move, so it would be inert
      // noise; and the posted handlers are the mention-routing lane — running
      // them here would re-trigger a past turn, which this feature explicitly
      // must not do. The sidebar preview of an edited newest row therefore
      // heals on the next channel-list fetch rather than instantly.
    },

    onMessagePosted(handler) {
      postedHandlers.add(handler);
      return () => {
        postedHandlers.delete(handler);
      };
    },

    setBadgeBroadcaster(broadcaster) {
      badgeBroadcaster = broadcaster;
    },

    channelExists(channelId) {
      return channelExists(channelId);
    },

    subscriberCount(channelId) {
      return subscribers.get(channelId)?.size ?? 0;
    },

    retentionSnapshot() {
      let connectQueueEvents = 0;
      let connectQueueBytes = 0;
      for (const channelSubscribers of subscribers.values()) {
        for (const subscriber of channelSubscribers) {
          connectQueueEvents += subscriber.queue.length;
          connectQueueBytes += subscriber.queueBytes;
        }
      }
      return { connectQueueEvents, connectQueueBytes };
    },

    close() {
      for (const acc of accumulators.values()) {
        if (acc.coalesceTimer) clearTimeout(acc.coalesceTimer);
        if (acc.updateTimer) clearTimeout(acc.updateTimer);
      }
      accumulators.clear();
      subscribers.clear();
      postedHandlers.clear();
    },
  };
}
