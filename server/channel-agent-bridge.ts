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

interface BridgeStream {
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
  /**
   * Invoked in `finalize()` after `completeStreamBroadcast` for `status ===
   * 'complete'` rows ONLY (#1167 §8). Bridge-authored replies bypass
   * `postToChannel`, so `onMessagePosted` never fires for them — this is the sole
   * hook that lets a spawned channel agent's reply trigger another agent
   * (agent-to-agent mentions). Interrupted/failed rows never fire it.
   */
  onAssistantMessageFinalized?: (message: ChannelMessage) => void;
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
  const assistantItemIds = new Set<string>();

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
  ): BridgeStream {
    const existing = streams.get(itemId);
    if (existing) return existing;
    const message = store.beginStream({
      channelId,
      sender,
      source: { sessionId, turnId, itemId },
      ...(initialText ? { text: initialText } : {}),
    });
    const stream: BridgeStream = {
      messageId: message.id,
      turnId,
      itemId,
      text: message.body.text,
      byteLength: Buffer.byteLength(message.body.text, 'utf8'),
      closed: message.status !== 'streaming',
      flushTimer: null,
      firstScheduledAt: null,
    };
    streams.set(itemId, stream);
    hub.beginStreamBroadcast(message);
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
    if (stream.closed) return;
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
      return;
    }
    if (!message) return;
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
  }

  function handlePatch(patch: AgentPatchV2): void {
    switch (patch.type) {
      case 'agent-item-started-v2': {
        if (patch.item.type === 'assistantMessage') {
          assistantItemIds.add(patch.item.id);
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
        let stream = streams.get(patch.itemId);
        if (!stream) {
          // Lazy-open ONLY for an item started as an assistantMessage — never for
          // plan/reasoning/tool items (whose text is not mirrored, §6.3) nor for
          // an item whose type we have not seen. Mirroring a plan-item delta here
          // would persist plan text as an agent-authored channel message.
          if (!assistantItemIds.has(patch.itemId)) break;
          stream = openStream(patch.turnId, patch.itemId, patch.sessionId, '');
        }
        appendDelta(stream, patch.delta.text);
        break;
      }
      case 'agent-item-updated-v2': {
        if (patch.item.type !== 'assistantMessage') break;
        const stream = streams.get(patch.item.id);
        if (stream) finalize(stream, 'complete', patch.item.text);
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
  };
}
