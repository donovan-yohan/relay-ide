import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from './logger.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';
import type { ProtocolAdapterV2 } from './protocol-adapter-v2.js';
import {
  agentDetailCardForItem,
  type AgentDetailCardStatusV2,
  type AgentDetailCardV2,
  type AgentSessionConfigV2,
  type AgentPatchV2,
} from '../shared/agent-chat-protocol-v2.js';
import type { ChannelHub } from './channel-hub.js';
import type { ChannelMessageStore } from './channel-message-store.js';
import {
  CHANNEL_IMAGE_MAX_BYTES,
  type ChannelAttachmentStore,
} from './channel-attachments.js';
import { PACKET_IMAGE_DEGRADATION_META_KEY } from './channel-context-packet.js';
import {
  CHANNEL_MEMBERSHIP_SELF_INVITER,
  CHANNEL_MESSAGE_BODY_MAX_BYTES,
  CHANNEL_AGENT_DETAIL_MAX_BYTES,
  CHANNEL_AGENT_ATTRIBUTION_MAX_CHARS,
  type ChannelAgentDetail,
  type ChannelAgentAttribution,
  type ChannelImagePart,
  type ChannelMessage,
  type ChannelAsyncRunReference,
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

/** Debounce partial-text flushes into durable channel rows. */
const FLUSH_DEBOUNCE_MS = 500;
const FLUSH_MAX_WAIT_MS = 2000;
/** Bounded dedupe tombstones for late provider replay after a row finalized. */
export const CHANNEL_BRIDGE_FINALIZED_ITEM_CACHE_MAX = 256;
/** Bound agent-produced image ingestion and durable rows per provider turn. */
export const CHANNEL_BRIDGE_IMAGE_MAX_PER_TURN = 8;
/** Frontend renders at most 64KiB; keep duplicated durable card payloads aligned. */
export const CHANNEL_BRIDGE_DETAIL_MAX_CHARS = 64 * 1024;
/** Metadata scalars are display hints, not unbounded provider payload lanes. */
export const CHANNEL_BRIDGE_DETAIL_ITEM_ID_MAX_CHARS = 1024;
export const CHANNEL_BRIDGE_DETAIL_TITLE_MAX_CHARS = 1024;
export const CHANNEL_BRIDGE_DETAIL_LANGUAGE_MAX_CHARS = 128;
export const CHANNEL_BRIDGE_DETAIL_COMMAND_MAX_CHARS = 4096;
export const CHANNEL_BRIDGE_DETAIL_PATH_MAX_CHARS = 4096;

/** Keep provider-supplied model/effort display data small and inert. */
function boundedAgentAttribution(config: {
  model?: string | undefined;
  effort?: string | null | undefined;
}): ChannelAgentAttribution | undefined {
  const scalar = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim()
      ? value.trim().slice(0, CHANNEL_AGENT_ATTRIBUTION_MAX_CHARS)
      : undefined;
  const model = scalar(config.model);
  const effort = scalar(config.effort);
  return model || effort
    ? {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }
    : undefined;
}

function diffCounts(content: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of content.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

/** Provider-boundary sanitizer shared by the bridge and its invariant tests. */
export function boundChannelAgentDetail(
  itemId: string,
  sourceCard: AgentDetailCardV2
): ChannelAgentDetail {
  const boundScalar = (
    value: string | undefined,
    maxChars: number,
    keepTail = false
  ): string | undefined => {
    if (value === undefined || value.length <= maxChars) return value;
    return keepTail ? value.slice(-maxChars) : value.slice(0, maxChars);
  };
  const boundedItemId = (() => {
    if (itemId.length <= CHANNEL_BRIDGE_DETAIL_ITEM_ID_MAX_CHARS) return itemId;
    const suffix = `#${crypto
      .createHash('sha256')
      .update(itemId)
      .digest('hex')
      .slice(0, 24)}`;
    return `${itemId.slice(
      0,
      CHANNEL_BRIDGE_DETAIL_ITEM_ID_MAX_CHARS - suffix.length
    )}${suffix}`;
  })();
  const originalContent = sourceCard.content;
  const keepTail =
    sourceCard.kind === 'output' || sourceCard.kind === 'tool_call';
  const content = boundScalar(
    originalContent,
    CHANNEL_BRIDGE_DETAIL_MAX_CHARS,
    keepTail
  );
  const originalBytes =
    originalContent === undefined
      ? undefined
      : Buffer.byteLength(originalContent, 'utf8');
  let card: AgentDetailCardV2 = {
    // Project the protocol contract explicitly. Provider extensions and other
    // validator-permitted unknown keys never enter durable row metadata.
    kind: sourceCard.kind,
    title:
      boundScalar(sourceCard.title, CHANNEL_BRIDGE_DETAIL_TITLE_MAX_CHARS) ??
      '',
    status: sourceCard.status,
    ...(sourceCard.language !== undefined
      ? {
          language: boundScalar(
            sourceCard.language,
            CHANNEL_BRIDGE_DETAIL_LANGUAGE_MAX_CHARS
          )!,
        }
      : {}),
    ...(sourceCard.command !== undefined
      ? {
          command: boundScalar(
            sourceCard.command,
            CHANNEL_BRIDGE_DETAIL_COMMAND_MAX_CHARS,
            true
          )!,
        }
      : {}),
    ...(sourceCard.path !== undefined
      ? {
          path: boundScalar(
            sourceCard.path,
            CHANNEL_BRIDGE_DETAIL_PATH_MAX_CHARS,
            true
          )!,
        }
      : {}),
    ...(content !== undefined ? { content } : {}),
    ...(sourceCard.additions !== undefined
      ? { additions: sourceCard.additions }
      : {}),
    ...(sourceCard.deletions !== undefined
      ? { deletions: sourceCard.deletions }
      : {}),
    ...(originalBytes !== undefined
      ? { sizeBytes: originalBytes }
      : sourceCard.sizeBytes !== undefined
        ? { sizeBytes: sourceCard.sizeBytes }
        : {}),
    ...(sourceCard.kind === 'diff' && content
      ? {
          additions: sourceCard.additions ?? diffCounts(content).additions,
          deletions: sourceCard.deletions ?? diffCounts(content).deletions,
        }
      : {}),
  };
  let detail: ChannelAgentDetail = { itemId: boundedItemId, card };
  // JSON escaping can make a 64KiB string larger than its source bytes.
  // Tighten deterministically until the complete typed payload fits the cap.
  while (
    (card.content?.length ?? 0) > 0 &&
    Buffer.byteLength(JSON.stringify(detail), 'utf8') >
      CHANNEL_AGENT_DETAIL_MAX_BYTES
  ) {
    const previousLength = card.content!.length;
    // Always remove at least one code unit. This cannot stall at a tiny
    // length under an escaping-heavy payload.
    const nextLength = Math.max(
      0,
      Math.min(previousLength - 1, Math.floor(previousLength * 0.8))
    );
    const nextContent = keepTail
      ? nextLength === 0
        ? ''
        : card.content!.slice(-nextLength)
      : card.content!.slice(0, nextLength);
    card = {
      ...card,
      content: nextContent,
      ...(card.kind === 'diff'
        ? {
            additions: card.additions ?? diffCounts(nextContent).additions,
            deletions: card.deletions ?? diffCounts(nextContent).deletions,
          }
        : {}),
    };
    detail = { itemId: boundedItemId, card };
  }
  if (
    Buffer.byteLength(JSON.stringify(detail), 'utf8') >
    CHANNEL_AGENT_DETAIL_MAX_BYTES
  ) {
    // With the scalar caps above this is unreachable even for worst-case JSON
    // escaping. Keep the invariant fail-closed if fields are added later.
    throw new Error('bounded channel agent detail still exceeds payload cap');
  }
  return detail;
}

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

interface DetailStream {
  streamKey: string;
  sourceKey: string;
  messageId: string;
  turnId: string;
  itemId: string;
  card: AgentDetailCardV2;
  reasoningSummary: string;
  reasoningDetail: string;
  state: 'open' | 'released';
}

interface AssistantItemAlias {
  turnId: string;
  streamKey: string;
  canonicalItemId: string;
}

interface TurnImageState {
  pending: number;
  admitted: number;
  limitNoted: boolean;
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
  /**
   * Profile display label stamped onto the durable `ChannelSenderRef.displayName`
   * (#1234). For a vendor's DEFAULT profile this is the framework catalog label
   * (built-in defaults carry an empty stored displayName — the caller resolves the
   * vendor label by `providerId` and passes it here). Distinct from the session/tab
   * display name.
   */
  displayName?: string;
  /**
   * Profile Actor id stamped onto `ChannelSenderRef.id` (#1234, epic #1232). Since
   * no custom profiles exist yet, every private channel runtime maps to its vendor's DEFAULT
   * profile; callers pass `builtInAgentProfileId(vendor)`. Defaults to the vendor
   * built-in default id when omitted so the `agent:<framework>` id format is gone
   * regardless of caller.
   */
  profileActorId?: string;
  /** Current adapter session config captured before this bridge attached. */
  initialAgentAttribution?: ChannelAgentAttribution;
  /** Resolve the immediate parent for a routed turn, if it began in a thread. */
  parentMessageIdForTurn?: (turnId: string) => string | undefined;
  /** Stable Relay correlation for principal prose emitted by this routed turn. */
  asyncRunReferenceForTurn?: (
    turnId: string
  ) => ChannelAsyncRunReference | undefined;
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
  openDetailStreams: number;
  assistantItemIds: number;
  detailItemIds: number;
  turnsWithRows: number;
  retainedTextBytes: number;
  retainedDetailBytes: number;
}

/**
 * Bind a private adapter runtime's patch stream to a channel. Returns an unbind
 * function; calling it unsubscribes the patch listener and finalizes any still-
 * open stream as `truncated` (session death mid-stream leaves no stuck ghost).
 */
export function bindSessionToChannel(
  input: BindSessionToChannelInput
): () => void {
  const { channelId, agentFramework, adapter, store, hub } = input;
  const streams = new Map<string, BridgeStream>();
  const detailStreams = new Map<string, DetailStream>();
  const detailItemAliases = new Map<string, string>();
  // Assistant item aliases keep prose streams stable across provider echo ids;
  // detail items use the same canonical source identity in their own rows.
  const assistantItemAliases = new Map<string, AssistantItemAlias>();
  // Turn ids that opened at least one channel-message stream. A `turn-completed`
  // for a turn absent here produced ZERO message rows — a silent finalization
  // that gets a warn log (#1181, defect 4) rather than passing unnoticed.
  const turnsWithRows = new Set<string>();
  const recentFinalizedItemKeys = new Set<string>();
  const turnImages = new Map<string, TurnImageState>();
  // Config updates apply to future turns. The first row in a turn captures a
  // copy so a later /model or /effort can never rewrite siblings or history.
  const turnAttributions = new Map<string, ChannelAgentAttribution | null>();
  let currentAttribution = input.initialAgentAttribution
    ? { ...input.initialAgentAttribution }
    : undefined;
  let closed = false;

  function itemSourceKey(
    runtimeId: string,
    turnId: string,
    itemId: string
  ): string {
    return `${runtimeId}\u0000${turnId}\u0000${itemId}`;
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

  function detailStreamKey(turnId: string, itemId: string): string {
    return `${turnId}\u0000detail\u0000${itemId}`;
  }

  function detailStatus(
    status: 'complete' | 'truncated' | 'interrupted' | 'failed'
  ): AgentDetailCardStatusV2 {
    if (status === 'failed') return 'failed';
    if (status === 'truncated' || status === 'interrupted') return 'cancelled';
    return 'completed';
  }

  function explicitDetailStatus(
    status: AgentDetailCardStatusV2
  ): status is 'completed' | 'failed' | 'cancelled' {
    return (
      status === 'completed' || status === 'failed' || status === 'cancelled'
    );
  }

  function detailRowStatus(
    status: 'completed' | 'failed' | 'cancelled'
  ): 'complete' | 'failed' | 'interrupted' {
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'interrupted';
    return 'complete';
  }

  function appendCardDelta(
    stream: DetailStream,
    patch: Extract<AgentPatchV2, { type: 'agent-item-delta-v2' }>
  ): AgentDetailCardV2 {
    const accumulate = (
      current: string,
      fragment: string,
      mode: 'append' | 'replace' | undefined,
      keepTail = false
    ): string => {
      if (mode === 'replace') {
        return keepTail
          ? fragment.slice(-CHANNEL_BRIDGE_DETAIL_MAX_CHARS)
          : fragment.slice(0, CHANNEL_BRIDGE_DETAIL_MAX_CHARS);
      }
      if (keepTail) {
        return `${current.slice(-CHANNEL_BRIDGE_DETAIL_MAX_CHARS)}${fragment.slice(
          -CHANNEL_BRIDGE_DETAIL_MAX_CHARS
        )}`.slice(-CHANNEL_BRIDGE_DETAIL_MAX_CHARS);
      }
      const remaining = Math.max(
        0,
        CHANNEL_BRIDGE_DETAIL_MAX_CHARS - current.length
      );
      return `${current.slice(0, CHANNEL_BRIDGE_DETAIL_MAX_CHARS)}${fragment.slice(
        0,
        remaining
      )}`;
    };
    const card = stream.card;
    if (card.kind === 'thought') {
      if (typeof patch.delta.summary === 'string') {
        stream.reasoningSummary = accumulate(
          stream.reasoningSummary,
          patch.delta.summary,
          patch.mode
        );
      }
      if (typeof patch.delta.detail === 'string') {
        stream.reasoningDetail = accumulate(
          stream.reasoningDetail,
          patch.delta.detail,
          patch.mode
        );
      }
      if (
        typeof patch.delta.text === 'string' &&
        patch.delta.summary === undefined &&
        patch.delta.detail === undefined
      ) {
        stream.reasoningSummary = accumulate(
          stream.reasoningSummary,
          patch.delta.text,
          patch.mode
        );
      }
      return {
        ...card,
        content: stream.reasoningDetail || stream.reasoningSummary,
        ...(patch.delta.status ? { status: patch.delta.status } : {}),
        ...(patch.delta.card ?? {}),
      };
    }
    const fragment =
      card.kind === 'output'
        ? (patch.delta.output ?? patch.delta.text)
        : card.kind === 'diff'
          ? (patch.delta.patch ?? patch.delta.text)
          : (patch.delta.content ?? patch.delta.output ?? patch.delta.text);
    const content =
      typeof fragment !== 'string'
        ? card.content
        : accumulate(
            card.content ?? '',
            fragment,
            patch.mode,
            card.kind === 'output' || card.kind === 'tool_call'
          );
    return {
      ...card,
      ...(content !== undefined ? { content } : {}),
      ...(patch.delta.status ? { status: patch.delta.status } : {}),
      ...(patch.delta.card ?? {}),
    };
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
    let retainedDetailBytes = 0;
    for (const stream of detailStreams.values()) {
      retainedDetailBytes += Buffer.byteLength(
        JSON.stringify(stream.card),
        'utf8'
      );
      retainedDetailBytes += Buffer.byteLength(stream.reasoningSummary, 'utf8');
      retainedDetailBytes += Buffer.byteLength(stream.reasoningDetail, 'utf8');
    }
    input.onRetentionSnapshot({
      openStreams: streams.size,
      openDetailStreams: detailStreams.size,
      assistantItemIds: assistantItemAliases.size,
      detailItemIds: detailItemAliases.size,
      turnsWithRows: turnsWithRows.size,
      retainedTextBytes,
      retainedDetailBytes,
    });
  }

  // Attribution re-key (#1234): the sender identity slot IS the profile Actor id,
  // not the bare `agent:<framework>` format. `providerId` stays the vendor so the
  // renderer reads it explicitly (never by stripping `agent:` off the id), and the
  // vendor glyph is shared across a vendor's profiles.
  const sender: ChannelSenderRef = {
    kind: 'agent',
    id: input.profileActorId ?? builtInAgentProfileId(agentFramework),
    providerId: agentFramework,
    ...(input.displayName ? { displayName: input.displayName } : {}),
  };

  function attributionForTurn(
    turnId: string
  ): ChannelAgentAttribution | undefined {
    if (!turnAttributions.has(turnId)) {
      turnAttributions.set(
        turnId,
        currentAttribution ? { ...currentAttribution } : null
      );
    }
    const attribution = turnAttributions.get(turnId);
    return attribution ? { ...attribution } : undefined;
  }

  function applySessionConfig(
    config: Partial<Omit<AgentSessionConfigV2, 'cwd'>>,
    replace: boolean
  ): void {
    const next = replace
      ? boundedAgentAttribution(config)
      : boundedAgentAttribution({
          model:
            config.model !== undefined
              ? config.model
              : currentAttribution?.model,
          effort:
            config.effort !== undefined
              ? config.effort
              : currentAttribution?.effort,
        });
    currentAttribution = next ? { ...next } : undefined;
  }

  function openStream(
    turnId: string,
    canonicalItemId: string,
    runtimeId: string,
    initialText: string
  ): BridgeStream | null {
    const streamKey = bridgeStreamKey(turnId, canonicalItemId);
    const existing = streams.get(streamKey);
    if (existing) return existing;
    const sourceKey = itemSourceKey(runtimeId, turnId, canonicalItemId);
    if (recentFinalizedItemKeys.has(sourceKey)) {
      forgetAliasesForStream(streamKey);
      reportRetention();
      return null;
    }
    const parentMessageId = input.parentMessageIdForTurn?.(turnId);
    const agentAttribution = attributionForTurn(turnId);
    const asyncRun = input.asyncRunReferenceForTurn?.(turnId);
    const message = store.beginStream({
      channelId,
      sender,
      source: { runtimeId, turnId, itemId: canonicalItemId },
      ...(initialText ? { text: initialText } : {}),
      ...(agentAttribution ? { agentAttribution } : {}),
      ...(asyncRun ? { meta: { asyncRun } } : {}),
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

  function openDetailStream(
    patch: Extract<
      AgentPatchV2,
      { type: 'agent-item-started-v2' | 'agent-item-updated-v2' }
    >,
    sourceCard: AgentDetailCardV2
  ): DetailStream | null {
    const itemId = canonicalAssistantItemId(patch.item);
    const streamKey = detailStreamKey(patch.turnId, itemId);
    detailItemAliases.set(patch.item.id, streamKey);
    const existing = detailStreams.get(streamKey);
    if (existing) return existing;
    const sourceKey = itemSourceKey(patch.sessionId, patch.turnId, itemId);
    if (recentFinalizedItemKeys.has(sourceKey)) {
      if (
        sourceCard.status !== 'completed' &&
        sourceCard.status !== 'failed' &&
        sourceCard.status !== 'cancelled'
      ) {
        detailItemAliases.delete(patch.item.id);
        return null;
      }
    }
    const agentDetail = boundChannelAgentDetail(itemId, sourceCard);
    const parentMessageId = input.parentMessageIdForTurn?.(patch.turnId);
    const agentAttribution = attributionForTurn(patch.turnId);
    const message = store.beginStream({
      channelId,
      sender,
      source: { runtimeId: patch.sessionId, turnId: patch.turnId, itemId },
      agentDetail,
      ...(agentAttribution ? { agentAttribution } : {}),
      ...(parentMessageId ? { parentMessageId } : {}),
    });
    if (message.status !== 'streaming') {
      rememberFinalizedItem(sourceKey);
      detailItemAliases.delete(patch.item.id);
      if (explicitDetailStatus(sourceCard.status)) {
        // Durable per-detail state machine:
        //   provisional turn/restart terminal -> first explicit item terminal
        //   explicit terminal -> absorbing (duplicates/conflicts are no-ops)
        const resolved = store.resolveProvisionalAgentDetailTerminal(
          message.id,
          {
            text: message.body.text,
            status: detailRowStatus(sourceCard.status),
            agentDetail: boundChannelAgentDetail(itemId, sourceCard),
          }
        );
        if (resolved.transitioned && resolved.message) {
          hub.completeStreamBroadcast(resolved.message);
        }
      }
      reportRetention();
      return null;
    }
    const stream: DetailStream = {
      streamKey,
      sourceKey,
      messageId: message.id,
      turnId: patch.turnId,
      itemId,
      card: agentDetail.card,
      reasoningSummary:
        patch.item.type === 'reasoning'
          ? patch.item.summary.slice(0, CHANNEL_BRIDGE_DETAIL_MAX_CHARS)
          : '',
      reasoningDetail:
        patch.item.type === 'reasoning'
          ? (patch.item.detail ?? '').slice(0, CHANNEL_BRIDGE_DETAIL_MAX_CHARS)
          : '',
      state: 'open',
    };
    detailStreams.set(streamKey, stream);
    turnsWithRows.add(patch.turnId);
    hub.beginStreamBroadcast(message);
    reportRetention();
    return stream;
  }

  function finalizeDetail(
    stream: DetailStream,
    status: 'complete' | 'truncated' | 'interrupted' | 'failed',
    sourceCard: AgentDetailCardV2 = stream.card,
    authority: 'provisional' | 'explicit' = 'provisional'
  ): void {
    if (stream.state === 'released') return;
    const agentDetail = boundChannelAgentDetail(stream.itemId, {
      ...sourceCard,
      status: detailStatus(status),
    });
    const message = store.finalizeStream(stream.messageId, {
      text: '',
      status,
      agentDetail,
      agentDetailTerminalAuthority: authority,
      ...(status === 'truncated'
        ? { truncationReason: 'missing-terminal' as const }
        : {}),
    });
    stream.state = 'released';
    detailStreams.delete(stream.streamKey);
    for (const [aliasId, streamKey] of detailItemAliases) {
      if (streamKey === stream.streamKey) detailItemAliases.delete(aliasId);
    }
    rememberFinalizedItem(stream.sourceKey);
    reportRetention();
    if (!message) return;
    hub.completeStreamBroadcast(message);
    try {
      store.upsertMember({
        channelId,
        kind: 'agent',
        id: sender.id,
        // A durable reply is this profile writing its own way in (#1455).
        invitedBy: CHANNEL_MEMBERSHIP_SELF_INVITER,
      });
    } catch (err) {
      logger.warn('channel bridge detail member upsert failed:', err);
    }
  }

  function handleDetailItem(
    patch: Extract<
      AgentPatchV2,
      { type: 'agent-item-started-v2' | 'agent-item-updated-v2' }
    >
  ): boolean {
    // Assistant messages are the channel's prose stream. Some adapters attach
    // a generic output card to them, but treating that hint as a detail item
    // would consume the message before the text path and persist an empty card
    // row. Structured cards are reserved for non-message provider items.
    if (patch.item.type === 'assistantMessage') return false;
    const sourceCard = patch.item.card ?? agentDetailCardForItem(patch.item);
    if (!sourceCard || sourceCard.kind === 'message') return false;
    const stream = openDetailStream(patch, sourceCard);
    if (!stream) return true;
    const accumulated = stream.card; // capture BEFORE the terminal overwrite
    stream.card = boundChannelAgentDetail(stream.itemId, sourceCard).card;
    const itemStatus = sourceCard.status;
    // Prefer delta-accumulated content when the terminal item card is empty,
    // matching handleDetailDelta which finalizes from the accumulated card
    // (#1206). Unreachable with today's codex/claude adapters (they backfill
    // terminal content) but unguarded for other providers.
    const terminalCard =
      sourceCard.content || !accumulated.content
        ? sourceCard
        : { ...sourceCard, content: accumulated.content };
    if (itemStatus === 'completed') {
      finalizeDetail(stream, 'complete', terminalCard, 'explicit');
    } else if (itemStatus === 'failed') {
      finalizeDetail(stream, 'failed', terminalCard, 'explicit');
    } else if (itemStatus === 'cancelled') {
      finalizeDetail(stream, 'interrupted', terminalCard, 'explicit');
    } else {
      const updated = store.updateAgentDetail(
        stream.messageId,
        boundChannelAgentDetail(stream.itemId, stream.card)
      );
      if (updated) hub.updateStreamBroadcast(updated);
      reportRetention();
    }
    return true;
  }

  function handleDetailDelta(
    patch: Extract<AgentPatchV2, { type: 'agent-item-delta-v2' }>
  ): boolean {
    const detail = detailStreams.get(
      detailItemAliases.get(patch.itemId) ??
        detailStreamKey(patch.turnId, patch.itemId)
    );
    if (!detail) return false;
    detail.card = boundChannelAgentDetail(
      detail.itemId,
      appendCardDelta(detail, patch)
    ).card;
    if (patch.delta.status === 'completed') {
      finalizeDetail(detail, 'complete', detail.card, 'explicit');
    } else if (patch.delta.status === 'failed') {
      finalizeDetail(detail, 'failed', detail.card, 'explicit');
    } else if (patch.delta.status === 'cancelled') {
      finalizeDetail(detail, 'interrupted', detail.card, 'explicit');
    } else {
      const updated = store.updateAgentDetail(
        detail.messageId,
        boundChannelAgentDetail(detail.itemId, detail.card)
      );
      if (updated) hub.updateStreamBroadcast(updated);
      reportRetention();
    }
    return true;
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
      admitted: 0,
      limitNoted: false,
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
      turnAttributions.delete(turnId);
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
    turnAttributions.delete(turnId);
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
      turnAttributions.delete(id);
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
    const agentAttribution = attributionForTurn(patch.turnId);
    const started = store.beginStream({
      channelId,
      sender,
      source: { runtimeId: patch.sessionId, turnId: patch.turnId, itemId },
      text,
      ...(parts.length > 0 ? { parts } : {}),
      ...(agentAttribution ? { agentAttribution } : {}),
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
      store.upsertMember({
        channelId,
        kind: 'agent',
        id: sender.id,
        // A durable reply is this profile writing its own way in (#1455).
        invitedBy: CHANNEL_MEMBERSHIP_SELF_INVITER,
      });
    } catch (err) {
      logger.warn('channel bridge image member upsert failed:', err);
    }
    return true;
  }

  function publishImageLimitNote(parentMessageId: string | undefined): void {
    try {
      const message = store.appendComplete({
        channelId,
        kind: 'system',
        sender: { kind: 'system', id: 'system' },
        text: `One or more agent images were omitted after the per-turn limit of ${CHANNEL_BRIDGE_IMAGE_MAX_PER_TURN}.`,
        ...(parentMessageId ? { parentMessageId } : {}),
      });
      hub.broadcastCreated(message);
    } catch (err) {
      logger.warn('channel bridge image limit note failed:', err);
    }
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
      store.upsertMember({
        channelId,
        kind: 'agent',
        id: sender.id,
        // A durable reply is this profile writing its own way in (#1455).
        invitedBy: CHANNEL_MEMBERSHIP_SELF_INVITER,
      });
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
    for (const stream of [...detailStreams.values()]) {
      if (stream.state === 'released') continue;
      if (turnId !== undefined && stream.turnId !== turnId) continue;
      finalizeDetail(stream, status);
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
      // A disconnect can still have image ingestion in flight. Keep those
      // snapshots until their own settlement path emits (or drops) the row.
      for (const id of turnAttributions.keys()) {
        if (!turnImages.has(id)) turnAttributions.delete(id);
      }
      assistantItemAliases.clear();
      detailItemAliases.clear();
      reportRetention();
    } else {
      turnsWithRows.delete(turnId);
      // Delayed image ingest creates its durable image row after the provider
      // terminal boundary. Its model/effort must remain the turn's original
      // snapshot rather than whatever a later control selected meanwhile.
      if (!turnImages.has(turnId)) turnAttributions.delete(turnId);
      for (const [itemId, alias] of assistantItemAliases) {
        if (alias.turnId === turnId) assistantItemAliases.delete(itemId);
      }
      for (const [itemId, streamKey] of detailItemAliases) {
        if (streamKey.startsWith(`${turnId}\u0000`)) {
          detailItemAliases.delete(itemId);
        }
      }
      reportRetention();
    }
  }

  function handlePatch(patch: AgentPatchV2): void {
    switch (patch.type) {
      case 'agent-session-snapshot-v2': {
        applySessionConfig(patch.session.config, true);
        break;
      }
      case 'agent-session-updated-v2': {
        if (patch.config) applySessionConfig(patch.config, false);
        break;
      }
      case 'agent-item-started-v2': {
        if (patch.item.type === 'imageView') {
          // Ingestion is asynchronous, but the provider item marks the turn's
          // durable image-row boundary now. Capture before any later control
          // update can change the current session config.
          attributionForTurn(patch.turnId);
          const state = imageState(patch.turnId);
          const parentMessageId = input.parentMessageIdForTurn?.(patch.turnId);
          if (state.admitted >= CHANNEL_BRIDGE_IMAGE_MAX_PER_TURN) {
            if (!state.limitNoted) {
              state.limitNoted = true;
              publishImageLimitNote(parentMessageId);
            }
            break;
          }
          state.admitted += 1;
          // Reserve the turn synchronously before async file ingest so a fast
          // turn-completed boundary neither logs a false empty-turn warning nor
          // leaves a late turnsWithRows entry retained after completion.
          turnsWithRows.add(patch.turnId);
          state.pending += 1;
          void mirrorAgentImage(patch, parentMessageId);
          break;
        }
        if (handleDetailItem(patch)) break;
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
        if (handleDetailDelta(patch)) break;
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
        if (handleDetailItem(patch)) break;
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
        // Session snapshots and non-card control items are not mirrored.
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
    for (const stream of [...detailStreams.values()]) {
      if (stream.state !== 'released') finalizeDetail(stream, 'truncated');
    }
    streams.clear();
    detailStreams.clear();
    detailItemAliases.clear();
    assistantItemAliases.clear();
    turnsWithRows.clear();
    turnImages.clear();
    recentFinalizedItemKeys.clear();
    reportRetention();
  };
}
