import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from './logger.js';
import type { ProtocolAdapterV2 } from './protocol-adapter-v2.js';
import type { AgentPatchV2 } from '../shared/agent-chat-protocol-v2.js';
import type { ChannelHub } from './channel-hub.js';
import type { ChannelMessageStore } from './channel-message-store.js';
import {
  CHANNEL_IMAGE_MAX_BYTES,
  type ChannelAttachmentStore,
} from './channel-attachments.js';
import { PACKET_IMAGE_DEGRADATION_META_KEY } from './channel-context-packet.js';
import {
  CHANNEL_MESSAGE_BODY_MAX_BYTES,
  type ChannelImagePart,
  type ChannelMessage,
  type ChannelSenderRef,
  type ChannelTruncationReason,
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
//   terminal agent-item-updated-v2 (assistantMessage)            → finalize('complete') + completed
//   turn-completed / idle without terminal item evidence         → finalize('truncated') + completed
//   agent-error-v2                                               → finalize('failed') + completed
//   bound session dies/disposed mid-stream (unbind)              → finalize('truncated') + completed
//   non-text items                                              → NOT mirrored (mechanics stay in agentSessionV2)

/** debounce partial-text flush to disk (same shape as relay-state-db throttled scheduler). */
const FLUSH_DEBOUNCE_MS = 500;
const FLUSH_MAX_WAIT_MS = 2000;
/** Bounded dedupe tombstones for late provider replay after a row finalized. */
export const CHANNEL_BRIDGE_FINALIZED_ITEM_CACHE_MAX = 256;

interface BridgeStream {
  streamKey: string;
  sourceKey: string;
  messageId: string;
  turnId: string;
  /** Canonical item identity persisted in source_item_id. */
  itemId: string;
  text: string;
  byteLength: number;
  state: 'open' | 'terminal-observed' | 'released';
  flushTimer: NodeJS.Timeout | null;
  firstScheduledAt: number | null;
}

interface AssistantItemAlias {
  turnId: string;
  streamKey: string;
  canonicalItemId: string;
}

interface TurnImageState {
  pending: number;
  parts: ChannelImagePart[];
  failureNotes: string[];
  deferredMessages: ChannelMessage[];
  terminal: boolean;
}

export interface BindSessionToChannelInput {
  channelId: string;
  agentFramework: string;
  adapter: ProtocolAdapterV2;
  store: ChannelMessageStore;
  /** Shared sender-neutral attachment lane for agent-produced image items. */
  attachmentStore?: ChannelAttachmentStore | null;
  hub: ChannelHub;
  displayName?: string;
  /** Resolve the immediate parent for a routed turn, if it began in a thread. */
  parentMessageIdForTurn?: (turnId: string) => string | undefined;
  /**
   * Invoked in `finalize()` after `completeStreamBroadcast` for `status ===
   * 'complete'` rows ONLY (#1167 §8). Bridge-authored replies bypass
   * `postToChannel`, so `onMessagePosted` never fires for them — this is the sole
   * hook that lets a spawned channel agent's reply trigger another agent
   * (agent-to-agent mentions). Truncated/interrupted/failed rows never fire it.
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
 * open stream as `truncated` (session death mid-stream leaves no stuck ghost).
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
  const assistantItemAliases = new Map<string, AssistantItemAlias>();
  // Turn ids that opened at least one channel-message stream. A `turn-completed`
  // for a turn absent here produced ZERO message rows — a silent finalization
  // that gets a warn log (#1181, defect 4) rather than passing unnoticed.
  const turnsWithRows = new Set<string>();
  const recentFinalizedItemKeys = new Set<string>();
  const turnImages = new Map<string, TurnImageState>();
  let closed = false;

  function itemSourceKey(
    sessionId: string,
    turnId: string,
    itemId: string
  ): string {
    return `${sessionId}\u0000${turnId}\u0000${itemId}`;
  }

  function canonicalAssistantItemId(item: {
    id: string;
    providerItemId?: string;
  }): string {
    // Provider message ids can contain multiple legitimate text slots. The
    // item identity (native provider item when available, otherwise Relay id)
    // is the operation boundary; Claude normalizes stream/echo aliases to the
    // same Relay item id at its emitter.
    return item.providerItemId ?? item.id;
  }

  function bridgeStreamKey(turnId: string, canonicalItemId: string): string {
    return `${turnId}\u0000${canonicalItemId}`;
  }

  function forgetAliasesForStream(streamKey: string): void {
    for (const [aliasId, alias] of assistantItemAliases) {
      if (alias.streamKey === streamKey) assistantItemAliases.delete(aliasId);
    }
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
      assistantItemIds: assistantItemAliases.size,
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
    canonicalItemId: string,
    sessionId: string,
    initialText: string
  ): BridgeStream | null {
    const streamKey = bridgeStreamKey(turnId, canonicalItemId);
    const existing = streams.get(streamKey);
    if (existing) return existing;
    const sourceKey = itemSourceKey(sessionId, turnId, canonicalItemId);
    if (recentFinalizedItemKeys.has(sourceKey)) {
      forgetAliasesForStream(streamKey);
      reportRetention();
      return null;
    }
    const parentMessageId = input.parentMessageIdForTurn?.(turnId);
    const message = store.beginStream({
      channelId,
      sender,
      source: { sessionId, turnId, itemId: canonicalItemId },
      ...(initialText ? { text: initialText } : {}),
      ...(parentMessageId ? { parentMessageId } : {}),
    });
    if (message.status !== 'streaming') {
      // Source-triple dedupe returned an already-finalized durable row. A late
      // duplicate final is a pure no-op: never recreate the hub accumulator or
      // turn-retention state for a stream that cannot receive more deltas.
      rememberFinalizedItem(sourceKey);
      forgetAliasesForStream(streamKey);
      reportRetention();
      return null;
    }
    turnsWithRows.add(turnId);
    const stream: BridgeStream = {
      streamKey,
      sourceKey,
      messageId: message.id,
      turnId,
      itemId: canonicalItemId,
      text: message.body.text,
      byteLength: Buffer.byteLength(message.body.text, 'utf8'),
      state: 'open',
      flushTimer: null,
      firstScheduledAt: null,
    };
    streams.set(streamKey, stream);
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
      if (stream.state === 'released') return;
      try {
        store.updateStreamText(stream.messageId, stream.text);
      } catch (err) {
        logger.warn('channel bridge flush failed:', err);
      }
    }, delay);
    stream.flushTimer.unref?.();
  }

  function appendDelta(stream: BridgeStream, text: string): void {
    if (stream.state === 'released' || text.length === 0) return;
    const addBytes = Buffer.byteLength(text, 'utf8');
    if (stream.byteLength + addBytes > CHANNEL_MESSAGE_BODY_MAX_BYTES) {
      // 256KB accumulator cap: force-finalize truncated, drop remaining deltas.
      finalize(stream, 'truncated', stream.text, 'size-limit');
      return;
    }
    stream.text += text;
    stream.byteLength += addBytes;
    hub.pushDelta(stream.messageId, text);
    scheduleFlush(stream);
  }

  function imageState(turnId: string): TurnImageState {
    const existing = turnImages.get(turnId);
    if (existing) return existing;
    const created: TurnImageState = {
      pending: 0,
      parts: [],
      failureNotes: [],
      deferredMessages: [],
      terminal: false,
    };
    turnImages.set(turnId, created);
    return created;
  }

  function invokeAssistantFinalized(
    turnId: string,
    message: ChannelMessage
  ): void {
    if (!input.onAssistantMessageFinalized) return;
    const state = turnImages.get(turnId);
    const combinedParts = [...(message.parts ?? []), ...(state?.parts ?? [])];
    const failureNotes = state?.failureNotes ?? [];
    const augmented =
      combinedParts.length > 0 || failureNotes.length > 0
        ? {
            ...message,
            ...(combinedParts.length > 0 ? { parts: combinedParts } : {}),
            ...(failureNotes.length > 0
              ? {
                  meta: {
                    ...(message.meta ?? {}),
                    [PACKET_IMAGE_DEGRADATION_META_KEY]: failureNotes,
                  },
                }
              : {}),
          }
        : message;
    try {
      input.onAssistantMessageFinalized(augmented);
    } catch (err) {
      logger.warn('channel bridge onAssistantMessageFinalized failed:', err);
    }
  }

  function queueAssistantFinalized(
    turnId: string,
    message: ChannelMessage
  ): void {
    const state = imageState(turnId);
    state.deferredMessages.push(message);
    if (state.terminal && state.pending === 0) {
      for (const deferred of state.deferredMessages.splice(0)) {
        invokeAssistantFinalized(turnId, deferred);
      }
      turnImages.delete(turnId);
    }
  }

  function settleTurnImage(
    turnId: string,
    part?: ChannelImagePart,
    failureNote?: string
  ): void {
    const state = turnImages.get(turnId);
    if (!state) return;
    if (part) state.parts.push(part);
    if (failureNote) state.failureNotes.push(failureNote);
    state.pending = Math.max(0, state.pending - 1);
    if (state.pending > 0 || !state.terminal) return;
    for (const message of state.deferredMessages.splice(0)) {
      invokeAssistantFinalized(turnId, message);
    }
    turnImages.delete(turnId);
  }

  function markTurnImagesTerminal(turnId: string | undefined): void {
    const entries =
      turnId === undefined
        ? [...turnImages.entries()]
        : ([[turnId, turnImages.get(turnId)]] as const);
    for (const [id, state] of entries) {
      if (!state) continue;
      state.terminal = true;
      if (state.pending > 0) continue;
      for (const message of state.deferredMessages.splice(0)) {
        invokeAssistantFinalized(id, message);
      }
      turnImages.delete(id);
    }
  }

  function publishImageRow(
    patch: Extract<AgentPatchV2, { type: 'agent-item-started-v2' }>,
    parentMessageId: string | undefined,
    text: string,
    parts: NonNullable<ChannelMessage['parts']> = []
  ): boolean {
    if (closed) return false;
    const itemId = canonicalAssistantItemId(patch.item);
    const started = store.beginStream({
      channelId,
      sender,
      source: { sessionId: patch.sessionId, turnId: patch.turnId, itemId },
      text,
      ...(parts.length > 0 ? { parts } : {}),
      ...(parentMessageId ? { parentMessageId } : {}),
    });
    if (started.status !== 'streaming') return true;
    hub.beginStreamBroadcast(started);
    const message = store.finalizeStream(started.id, {
      text,
      status: 'complete',
    });
    if (!message) return false;
    hub.completeStreamBroadcast(message);
    try {
      store.upsertMember({ channelId, kind: 'agent', id: sender.id });
    } catch (err) {
      logger.warn('channel bridge image member upsert failed:', err);
    }
    return true;
  }

  async function mirrorAgentImage(
    patch: Extract<AgentPatchV2, { type: 'agent-item-started-v2' }>,
    parentMessageId: string | undefined
  ): Promise<void> {
    if (patch.item.type !== 'imageView') return;
    const source = patch.item.source;
    const label = (path.basename(source) || 'image')
      .replace(/[\r\n\t]/g, ' ')
      .slice(0, 120);
    let deliveredPart: ChannelImagePart | undefined;
    let failureNote: string | undefined;
    try {
      if (!input.attachmentStore || !path.isAbsolute(source)) {
        throw new Error(
          'attachment lane unavailable or image path is not local'
        );
      }
      const stat = await fs.promises.stat(source);
      if (!stat.isFile() || stat.size > CHANNEL_IMAGE_MAX_BYTES) {
        throw new Error('image payload is missing or exceeds the size cap');
      }
      const part = await input.attachmentStore.ingest({
        bytes: await fs.promises.readFile(source),
        ...(patch.item.description ? { alt: patch.item.description } : {}),
      });
      if (publishImageRow(patch, parentMessageId, '', [part])) {
        deliveredPart = part;
      }
    } catch (err) {
      failureNote = label;
      logger.warn('channel bridge agent image ingest failed:', err);
      try {
        publishImageRow(
          patch,
          parentMessageId,
          `[Agent image unavailable: ${label}]`
        );
      } catch (publishErr) {
        logger.warn('channel bridge agent image fallback failed:', publishErr);
      }
    } finally {
      settleTurnImage(patch.turnId, deliveredPart, failureNote);
    }
  }

  function finalize(
    stream: BridgeStream,
    requestedStatus: 'complete' | 'truncated' | 'interrupted' | 'failed',
    text: string,
    requestedTruncationReason?: ChannelTruncationReason
  ): void {
    if (stream.state === 'released') {
      streams.delete(stream.streamKey);
      forgetAliasesForStream(stream.streamKey);
      rememberFinalizedItem(stream.sourceKey);
      reportRetention();
      return;
    }
    // `complete` is a proof-bearing state, not a synonym for "the turn ended".
    // A terminal assistant output-item patch must have been observed first.
    const status =
      requestedStatus === 'complete' && stream.state !== 'terminal-observed'
        ? 'truncated'
        : requestedStatus;
    const truncationReason =
      status === 'truncated'
        ? (requestedTruncationReason ?? 'missing-terminal')
        : undefined;
    if (stream.flushTimer) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = null;
    }
    let message;
    try {
      message = store.finalizeStream(stream.messageId, {
        text,
        status,
        ...(truncationReason ? { truncationReason } : {}),
        ...(truncationReason === 'size-limit' ? { truncated: true } : {}),
      });
    } catch (err) {
      logger.warn('channel bridge finalize failed:', err);
      return;
    }
    stream.state = 'released';
    // The durable row owns completed output. Never retain full streamed text
    // or provider item ids for the lifetime of the channel binding. This is a
    // write-ahead boundary: store finalization precedes release and broadcast.
    streams.delete(stream.streamKey);
    forgetAliasesForStream(stream.streamKey);
    reportRetention();
    if (!message) return;
    rememberFinalizedItem(stream.sourceKey);
    hub.completeStreamBroadcast(message);
    try {
      store.upsertMember({ channelId, kind: 'agent', id: sender.id });
    } catch (err) {
      logger.warn('channel bridge member upsert failed:', err);
    }
    // #1167 §8: only a cleanly-completed assistant reply may trigger downstream
    // agent-to-agent mentions. Truncated/interrupted/failed rows never fan out.
    if (status === 'complete' && input.onAssistantMessageFinalized) {
      queueAssistantFinalized(stream.turnId, message);
    }
  }

  function finalizeTurn(
    turnId: string | undefined,
    status: 'complete' | 'truncated' | 'interrupted' | 'failed'
  ): void {
    for (const stream of streams.values()) {
      if (stream.state === 'released') continue;
      if (turnId !== undefined && stream.turnId !== turnId) continue;
      finalize(stream, status, stream.text);
    }
    markTurnImagesTerminal(turnId);
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
      assistantItemAliases.clear();
      reportRetention();
    } else {
      turnsWithRows.delete(turnId);
      for (const [itemId, alias] of assistantItemAliases) {
        if (alias.turnId === turnId) assistantItemAliases.delete(itemId);
      }
      reportRetention();
    }
  }

  function handlePatch(patch: AgentPatchV2): void {
    switch (patch.type) {
      case 'agent-item-started-v2': {
        if (patch.item.type === 'imageView') {
          // Reserve the turn synchronously before async file ingest so a fast
          // turn-completed boundary neither logs a false empty-turn warning nor
          // leaves a late turnsWithRows entry retained after completion.
          turnsWithRows.add(patch.turnId);
          const parentMessageId = input.parentMessageIdForTurn?.(patch.turnId);
          imageState(patch.turnId).pending += 1;
          void mirrorAgentImage(patch, parentMessageId);
          break;
        }
        if (patch.item.type === 'assistantMessage') {
          const canonicalItemId = canonicalAssistantItemId(patch.item);
          const streamKey = bridgeStreamKey(patch.turnId, canonicalItemId);
          assistantItemAliases.set(patch.item.id, {
            turnId: patch.turnId,
            streamKey,
            canonicalItemId,
          });
          // Materialize at start even when empty. Codex may deliver the native
          // turn boundary before its final item; if the adapter's bounded grace
          // expires, this durable shell must resolve as missing-terminal rather
          // than making the whole handoff disappear.
          openStream(
            patch.turnId,
            canonicalItemId,
            patch.sessionId,
            patch.item.text
          );
          reportRetention();
        }
        break;
      }
      case 'agent-item-delta-v2': {
        if (typeof patch.delta.text !== 'string') break;
        if (patch.delta.text.length === 0) break;
        const alias = assistantItemAliases.get(patch.itemId);
        if (!alias) break;
        let stream: BridgeStream | null | undefined = streams.get(
          alias.streamKey
        );
        if (!stream) {
          // Lazy-open ONLY for an item started as an assistantMessage — never for
          // plan/reasoning/tool items (whose text is not mirrored, §6.3) nor for
          // an item whose type we have not seen. Mirroring a plan-item delta here
          // would persist plan text as an agent-authored channel message.
          stream = openStream(
            patch.turnId,
            alias.canonicalItemId,
            patch.sessionId,
            ''
          );
        }
        if (!stream) break;
        appendDelta(stream, patch.delta.text);
        break;
      }
      case 'agent-item-updated-v2': {
        if (patch.item.type !== 'assistantMessage') break;
        const canonicalItemId = canonicalAssistantItemId(patch.item);
        const streamKey = bridgeStreamKey(patch.turnId, canonicalItemId);
        assistantItemAliases.set(patch.item.id, {
          turnId: patch.turnId,
          streamKey,
          canonicalItemId,
        });
        let stream: BridgeStream | null | undefined = streams.get(streamKey);
        if (!stream) {
          // A completed assistantMessage that never opened a stream — no
          // `started`, no text delta — is a non-streamed reply delivered as a
          // single message-complete (e.g. a hermes v0.18.2 message output-item,
          // #1181). Materialize the row directly so the reply is not silently
          // dropped; openStream seeds it with the final text and finalize closes
          // it in the same tick.
          if (!patch.item.text) {
            forgetAliasesForStream(streamKey);
            reportRetention();
            break;
          }
          stream = openStream(
            patch.turnId,
            canonicalItemId,
            patch.sessionId,
            patch.item.text
          );
        }
        if (!stream) break;
        const finalText = patch.item.text || stream.text;
        if (patch.item.status === 'completed') {
          stream.state = 'terminal-observed';
          finalize(stream, 'complete', finalText);
        } else if (patch.item.status === 'failed') {
          finalize(stream, 'failed', finalText);
        } else if (patch.item.status === 'cancelled') {
          finalize(stream, 'interrupted', finalText);
        }
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
      case 'agent-live-state-updated-v2': {
        if (patch.live.status === 'idle') {
          // Idle is a teardown boundary when an adapter omitted (or delayed)
          // turn-completed. `complete` is downgraded to `truncated` per stream
          // unless its terminal output-item update was already observed.
          finalizeTurn(patch.live.activeTurnId ?? undefined, 'complete');
        }
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
        // Session snapshots and non-text items are not mirrored.
        break;
    }
  }

  const unlisten = adapter.onPatch(handlePatch);

  return () => {
    closed = true;
    unlisten();
    for (const stream of streams.values()) {
      if (stream.state !== 'released') {
        finalize(stream, 'truncated', stream.text);
      }
    }
    streams.clear();
    assistantItemAliases.clear();
    turnsWithRows.clear();
    turnImages.clear();
    recentFinalizedItemKeys.clear();
    reportRetention();
  };
}
