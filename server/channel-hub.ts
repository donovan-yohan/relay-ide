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
}

export interface ChannelHub {
  handleConnection(
    ws: ChannelSocket,
    input: { channelId: string; sinceSeq: number | null }
  ): void;
  broadcastCreated(message: ChannelMessage, mentions?: ChannelMention[]): void;
  beginStreamBroadcast(message: ChannelMessage): void;
  pushDelta(messageId: string, text: string): void;
  completeStreamBroadcast(message: ChannelMessage): void;
  onMessagePosted(handler: ChannelMessagePostedHandler): () => void;
  setBadgeBroadcaster(broadcaster: ChannelBadgeBroadcaster): void;
  channelExists(channelId: string): boolean;
  subscriberCount(channelId: string): number;
  close(): void;
}

export function createChannelHub(options: ChannelHubOptions): ChannelHub {
  const store = options.store;
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const channelExists = options.channelExists ?? (() => true);
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
        sub.queue.push(event);
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

  function buildSnapshot(
    channelId: string,
    sinceSeq: number | null
  ): ChannelEventV1 {
    const latestSeq = latestSeqFor(channelId);
    const members: ChannelMemberRef[] = store
      ? store.listMembers(channelId)
      : [];
    let mode: 'full' | 'catchup';
    let rows: ChannelMessage[];
    let truncated = false;

    if (sinceSeq === null || latestSeq - sinceSeq > CATCHUP_MAX_ROWS) {
      mode = 'full';
      rows = store
        ? store.history(channelId, { limit: SNAPSHOT_FULL_LIMIT })
        : [];
      truncated = rows.length > 0 && (rows[0]?.seq ?? 1) > 1;
    } else {
      mode = 'catchup';
      rows = [];
      let cursor = sinceSeq;
      while (store && rows.length < CATCHUP_MAX_ROWS) {
        const page = store.history(channelId, { afterSeq: cursor, limit: 200 });
        if (page.length === 0) break;
        rows.push(...page);
        cursor = page[page.length - 1]!.seq;
        if (page.length < 200) break;
      }
    }

    // Overlay the hub's in-memory accumulated text onto streaming rows — it is
    // authoritative over the DB flush lag — and record each open stream's index.
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
      latestSeq,
      inFlight,
      truncated,
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
        snapshotLatestSeq: 0,
        snapshotInFlight: new Map(),
        lagging: false,
      };
      // Register FIRST so live events during snapshot build queue rather than
      // race; better-sqlite3 reads are synchronous, so the queue + dedupe below
      // is defense in depth.
      addSubscriber(channelId, sub);

      const snapshot = buildSnapshot(channelId, sinceSeq);
      if (snapshot.type === 'channel-snapshot-v1') {
        sub.snapshotLatestSeq = snapshot.latestSeq;
        for (const ref of snapshot.inFlight) {
          sub.snapshotInFlight.set(ref.messageId, ref.deltaIndex);
        }
      }
      deliver(sub, snapshot);

      // Flush queued live events with dedupe: drop committed events with
      // seq <= snapshot endSeq; drop deltas with deltaIndex <= the snapshot's
      // recorded index for that message (dedupe stream events by messageId +
      // deltaIndex, NOT seq); always forward completed (idempotent replace-by-id).
      const queued = sub.queue;
      sub.queue = [];
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

    completeStreamBroadcast(message) {
      const acc = accumulators.get(message.id);
      if (acc?.coalesceTimer) clearTimeout(acc.coalesceTimer);
      accumulators.delete(message.id);
      broadcast(message.channelId, {
        type: 'channel-message-completed-v1',
        channelId: message.channelId,
        timestamp: nowIso(),
        message,
      });
      emitBadge(message.channelId);
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

    close() {
      for (const acc of accumulators.values()) {
        if (acc.coalesceTimer) clearTimeout(acc.coalesceTimer);
      }
      accumulators.clear();
      subscribers.clear();
      postedHandlers.clear();
    },
  };
}
