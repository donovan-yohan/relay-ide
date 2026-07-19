import { createLogger } from './logger.js';
import type { ProtocolAdapterV2 } from './protocol-adapter-v2.js';
import type { AgentPatchV2 } from '../shared/agent-chat-protocol-v2.js';
import type { ChannelHub } from './channel-hub.js';
import type { ChannelMessageStore } from './channel-message-store.js';
import {
  CHANNEL_MESSAGE_BODY_MAX_BYTES,
  type ChannelMessage,
  type ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';

const logger = createLogger('channel-agent-bridge');

// Adapter→channel bridge (#1165, unwired seam for slice 4 / #1167). Consumes ONLY
// the `ProtocolAdapterV2` onPatch contract and translates the multi-item agent
// stream into channel message lifecycle rows. Because it assumes no SDK shape,
// hermes/opencode (via LegacyProtocolAdapterV2Bridge) and #1168's stream-json
// Claude subprocess adapter plug in with ZERO bridge changes.
//
// Translation table (§6.3):
//   agent-item-started-v2 (assistantMessage) / first text delta → beginStream + created(streaming)
//   agent-item-delta-v2 (text)                                   → coalesced delta + debounced updateStreamText
//   agent-item-updated-v2 (final assistantMessage) / turn-completed → finalize('complete') + completed
//   agent-error-v2                                               → finalize('failed') + completed
//   bound session dies/disposed mid-stream (unbind)             → finalize('interrupted') + completed
//   non-text items / live-state                                 → NOT mirrored (mechanics stay in agentSessionV2)

/** debounce partial-text flush to disk (same shape as relay-state-db throttled scheduler). */
const FLUSH_DEBOUNCE_MS = 500;
const FLUSH_MAX_WAIT_MS = 2000;
/** Bounded dedupe tombstones for late provider replay after a row finalized. */
export const CHANNEL_BRIDGE_FINALIZED_ITEM_CACHE_MAX = 256;

interface BridgeStream {
  sourceKey: string;
  messageId: string;
  turnId: string;
  itemId: string;
  text: string;
  byteLength: number;
  closed: boolean;
  flushTimer: NodeJS.Timeout | null;
  firstScheduledAt: number | null;
}

export interface BindSessionToChannelInput {
  channelId: string;
  agentFramework: string;
  adapter: ProtocolAdapterV2;
  store: ChannelMessageStore;
  hub: ChannelHub;
  displayName?: string;
  /** Resolve the immediate parent for a routed turn, if it began in a thread. */
  parentMessageIdForTurn?: (turnId: string) => string | undefined;
  /**
   * Invoked in `finalize()` after `completeStreamBroadcast` for `status ===
   * 'complete'` rows ONLY (#1167 §8). Bridge-authored replies bypass
   * `postToChannel`, so `onMessagePosted` never fires for them — this is the sole
   * hook that lets a spawned channel agent's reply trigger another agent
   * (agent-to-agent mentions). Interrupted/failed rows never fire it.
   */
  onAssistantMessageFinalized?: (message: ChannelMessage) => void;
  /** Optional bounded-load diagnostic seam; never affects delivery. */
  onRetentionSnapshot?: (snapshot: ChannelBridgeRetentionSnapshot) => void;
}

export interface ChannelBridgeRetentionSnapshot {
  openStreams: number;
  assistantItemIds: number;
  turnsWithRows: number;
  retainedTextBytes: number;
}

/**
 * Bind a live adapter session's patch stream to a channel. Returns an unbind
 * function; calling it unsubscribes the patch listener and finalizes any still-
 * open stream as `interrupted` (session death mid-stream leaves no stuck ghost).
 */
export function bindSessionToChannel(
  input: BindSessionToChannelInput
): () => void {
  const { channelId, agentFramework, adapter, store, hub } = input;
  const streams = new Map<string, BridgeStream>();
  // Item ids started as `assistantMessage`. Only these may open/mirror a channel
  // stream. Plan/reasoning/tool items also carry `delta.text` on real adapters
  // (e.g. the codex-native plan item `plan-<turnId>`), and §6.3 mirrors ONLY
  // assistantMessage text — so a delta for any other item type is dropped.
  const assistantItemTurnIds = new Map<string, string>();
  // Turn ids that opened at least one channel-message stream. A `turn-completed`
  // for a turn absent here produced ZERO message rows — a silent finalization
  // that gets a warn log (#1181, defect 4) rather than passing unnoticed.
  const turnsWithRows = new Set<string>();
  const recentFinalizedItemKeys = new Set<string>();

  function itemSourceKey(
    sessionId: string,
    turnId: string,
    itemId: string
  ): string {
    return `${sessionId}\u0000${turnId}\u0000${itemId}`;
  }

  function rememberFinalizedItem(key: string): void {
    recentFinalizedItemKeys.delete(key);
    recentFinalizedItemKeys.add(key);
    if (recentFinalizedItemKeys.size <= CHANNEL_BRIDGE_FINALIZED_ITEM_CACHE_MAX)
      return;
    const oldest = recentFinalizedItemKeys.values().next().value;
    if (oldest !== undefined) recentFinalizedItemKeys.delete(oldest);
  }

  function reportRetention(): void {
    if (!input.onRetentionSnapshot) return;
    let retainedTextBytes = 0;
    for (const stream of streams.values()) {
      retainedTextBytes += stream.byteLength;
    }
    input.onRetentionSnapshot({
      openStreams: streams.size,
      assistantItemIds: assistantItemTurnIds.size,
      turnsWithRows: turnsWithRows.size,
      retainedTextBytes,
    });
  }

  const sender: ChannelSenderRef = {
    kind: 'agent',
    id: `agent:${agentFramework}`,
    providerId: agentFramework,
    ...(input.displayName ? { displayName: input.displayName } : {}),
  };

  function openStream(
    turnId: string,
    itemId: string,
    sessionId: string,
    initialText: string
  ): BridgeStream | null {
    const existing = streams.get(itemId);
    if (existing) return existing;
    const sourceKey = itemSourceKey(sessionId, turnId, itemId);
    if (recentFinalizedItemKeys.has(sourceKey)) {
      assistantItemTurnIds.delete(itemId);
      reportRetention();
      return null;
    }
    const parentMessageId = input.parentMessageIdForTurn?.(turnId);
    const message = store.beginStream({
      channelId,
      sender,
      source: { sessionId, turnId, itemId },
      ...(initialText ? { text: initialText } : {}),
      ...(parentMessageId ? { parentMessageId } : {}),
    });
    if (message.status !== 'streaming') {
      // Source-triple dedupe returned an already-finalized durable row. A late
      // duplicate final is a pure no-op: never recreate the hub accumulator or
      // turn-retention state for a stream that cannot receive more deltas.
      rememberFinalizedItem(sourceKey);
      assistantItemTurnIds.delete(itemId);
      reportRetention();
      return null;
    }
    turnsWithRows.add(turnId);
    const stream: BridgeStream = {
      sourceKey,
      messageId: message.id,
      turnId,
      itemId,
      text: message.body.text,
      byteLength: Buffer.byteLength(message.body.text, 'utf8'),
      closed: false,
      flushTimer: null,
      firstScheduledAt: null,
    };
    streams.set(itemId, stream);
    hub.beginStreamBroadcast(message);
    reportRetention();
    return stream;
  }

  function scheduleFlush(stream: BridgeStream): void {
    const now = Date.now();
    if (stream.firstScheduledAt === null) stream.firstScheduledAt = now;
    if (stream.flushTimer) clearTimeout(stream.flushTimer);
    const elapsed = now - stream.firstScheduledAt;
    const delay = Math.min(
      FLUSH_DEBOUNCE_MS,
      Math.max(0, FLUSH_MAX_WAIT_MS - elapsed)
    );
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = null;
      stream.firstScheduledAt = null;
      if (stream.closed) return;
      try {
        store.updateStreamText(stream.messageId, stream.text);
      } catch (err) {
        logger.warn('channel bridge flush failed:', err);
      }
    }, delay);
    stream.flushTimer.unref?.();
  }

  function appendDelta(stream: BridgeStream, text: string): void {
    if (stream.closed || text.length === 0) return;
    const addBytes = Buffer.byteLength(text, 'utf8');
    if (stream.byteLength + addBytes > CHANNEL_MESSAGE_BODY_MAX_BYTES) {
      // 256KB accumulator cap: force-finalize truncated, drop remaining deltas.
      finalize(stream, 'complete', stream.text, true);
      return;
    }
    stream.text += text;
    stream.byteLength += addBytes;
    hub.pushDelta(stream.messageId, text);
    scheduleFlush(stream);
  }

  function finalize(
    stream: BridgeStream,
    status: 'complete' | 'interrupted' | 'failed',
    text: string,
    truncated = false
  ): void {
    if (stream.closed) {
      streams.delete(stream.itemId);
      assistantItemTurnIds.delete(stream.itemId);
      rememberFinalizedItem(stream.sourceKey);
      reportRetention();
      return;
    }
    stream.closed = true;
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = null;
    }
    let message;
    try {
      message = store.finalizeStream(stream.messageId, {
        text,
        status,
        ...(truncated ? { truncated: true } : {}),
      });
    } catch (err) {
      logger.warn('channel bridge finalize failed:', err);
    } finally {
      // The durable row owns completed output. Never retain full streamed text
      // or provider item ids for the lifetime of the channel binding.
      streams.delete(stream.itemId);
      assistantItemTurnIds.delete(stream.itemId);
      reportRetention();
    }
    if (!message) return;
    rememberFinalizedItem(stream.sourceKey);
    hub.completeStreamBroadcast(message);
    try {
      store.upsertMember({ channelId, kind: 'agent', id: sender.id });
    } catch (err) {
      logger.warn('channel bridge member upsert failed:', err);
    }
    // #1167 §8: only a cleanly-completed assistant reply may trigger downstream
    // agent-to-agent mentions. Interrupted/failed rows never fan out.
    if (status === 'complete' && input.onAssistantMessageFinalized) {
      try {
        input.onAssistantMessageFinalized(message);
      } catch (err) {
        logger.warn('channel bridge onAssistantMessageFinalized failed:', err);
      }
    }
  }

  function finalizeTurn(
    turnId: string | undefined,
    status: 'complete' | 'interrupted' | 'failed'
  ): void {
    for (const stream of streams.values()) {
      if (stream.closed) continue;
      if (turnId !== undefined && stream.turnId !== turnId) continue;
      finalize(stream, status, stream.text);
    }
    // #1181 defect 4: a cleanly-completed bound-agent turn that produced no
    // channel message row is a silent failure (the reply never reached the
    // channel). Log it — but never post a system row — so the gap is diagnosable
    // instead of invisible. Interrupted/failed turns are expected to be able to
    // finish empty, so they are not flagged.
    if (
      status === 'complete' &&
      turnId !== undefined &&
      !turnsWithRows.has(turnId)
    ) {
      logger.warn('channel bridge turn finalized with no message rows', {
        channelId,
        agentFramework,
        turnId,
      });
    }
    if (turnId === undefined) {
      turnsWithRows.clear();
      assistantItemTurnIds.clear();
      reportRetention();
    } else {
      turnsWithRows.delete(turnId);
      for (const [itemId, itemTurnId] of assistantItemTurnIds) {
        if (itemTurnId === turnId) assistantItemTurnIds.delete(itemId);
      }
      reportRetention();
    }
  }

  function handlePatch(patch: AgentPatchV2): void {
    switch (patch.type) {
      case 'agent-item-started-v2': {
        if (patch.item.type === 'assistantMessage') {
          assistantItemTurnIds.set(patch.item.id, patch.turnId);
          openStream(
            patch.turnId,
            patch.item.id,
            patch.sessionId,
            patch.item.text ?? ''
          );
        }
        break;
      }
      case 'agent-item-delta-v2': {
        if (typeof patch.delta.text !== 'string') break;
        let stream: BridgeStream | null | undefined = streams.get(patch.itemId);
        if (!stream) {
          // Lazy-open ONLY for an item started as an assistantMessage — never for
          // plan/reasoning/tool items (whose text is not mirrored, §6.3) nor for
          // an item whose type we have not seen. Mirroring a plan-item delta here
          // would persist plan text as an agent-authored channel message.
          if (!assistantItemTurnIds.has(patch.itemId)) break;
          stream = openStream(patch.turnId, patch.itemId, patch.sessionId, '');
        }
        if (!stream) break;
        appendDelta(stream, patch.delta.text);
        break;
      }
      case 'agent-item-updated-v2': {
        if (patch.item.type !== 'assistantMessage') break;
        let stream: BridgeStream | null | undefined = streams.get(
          patch.item.id
        );
        if (!stream) {
          // A completed assistantMessage that never opened a stream — no
          // `started`, no text delta — is a non-streamed reply delivered as a
          // single message-complete (e.g. a hermes v0.18.2 message output-item,
          // #1181). Materialize the row directly so the reply is not silently
          // dropped; openStream seeds it with the final text and finalize closes
          // it in the same tick.
          stream = openStream(
            patch.turnId,
            patch.item.id,
            patch.sessionId,
            patch.item.text ?? ''
          );
        }
        if (!stream) break;
        finalize(stream, 'complete', patch.item.text ?? '');
        break;
      }
      case 'agent-turn-completed-v2': {
        // #1167 §5: honor the turn's terminal status instead of hard-coding
        // 'complete' so an interrupted/failed turn produces an honestly-labeled
        // row (drives the interrupt affordance + error surfacing).
        const status =
          patch.status === 'interrupted'
            ? 'interrupted'
            : patch.status === 'failed'
              ? 'failed'
              : 'complete';
        finalizeTurn(patch.turnId, status);
        break;
      }
      case 'agent-error-v2': {
        // An error is terminal for bridge-owned output even when a provider
        // never follows it with turn/completed.
        finalizeTurn(patch.turnId, 'failed');
        break;
      }
      default:
        // Non-text items (commandExecution/fileChange/approvals/reasoning),
        // agent-live-state-updated-v2, session snapshots — not mirrored.
        break;
    }
  }

  const unlisten = adapter.onPatch(handlePatch);

  return () => {
    unlisten();
    for (const stream of streams.values()) {
      if (!stream.closed) finalize(stream, 'interrupted', stream.text);
    }
    streams.clear();
    assistantItemTurnIds.clear();
    turnsWithRows.clear();
    recentFinalizedItemKeys.clear();
    reportRetention();
  };
}
