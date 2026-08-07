import fs from 'node:fs';

import {
  isChannelMessageDeleted,
  type ChannelImagePart,
  type ChannelMessage,
} from '../shared/channel-chat-protocol.js';
import type { ChannelAttachmentStore } from './channel-attachments.js';
import type { Attachment } from './protocol-adapter-v2.js';

// Pure context-packet builder for @-mention routing (#1167, slice 4). No I/O:
// store rows in, prompt string out — fully unit-testable. The binder fetches the
// eligible channel or thread rows and hands them here; this module owns ONLY the
// deterministic string shape (§4 of the spec). It never touches the network, the
// store, or the adapter, so the golden test pins the exact bytes an agent sees.

/** Newest N text context rows retained; older eligible rows collapse to one marker. */
export const PACKET_MAX_ROWS = 16;
/** Per-row body cap before the ellipsis marker (token frugality). */
export const PACKET_ROW_MAX_CHARS = 2000;
/** Whole-packet byte budget — oldest context rows drop until under (never the trigger). */
export const PACKET_MAX_BYTES = 16 * 1024;
/** Provider turns receive at most four images, regardless of retained row count. */
export const PACKET_IMAGE_MAX_COUNT = 4;
/** General raw-image ceiling bounds synchronous adapter encoding work. */
export const PACKET_IMAGE_MAX_RAW_BYTES = 10 * 1024 * 1024;
/**
 * Claude frames images as base64 inside one JSONL stdin frame. Six raw MiB
 * expands to eight MiB, leaving over a MiB below its 9.5MB line ceiling for
 * packet text, JSON syntax, and per-block metadata.
 */
export const CLAUDE_PACKET_IMAGE_MAX_RAW_BYTES = 6 * 1024 * 1024;
/** Transient callback-only metadata; never persisted by the image bridge. */
export const PACKET_IMAGE_DEGRADATION_META_KEY = '__relayImageDegradationNotes';
/** Adapter audit: only these framework lanes consume local image attachments. */
export const PACKET_FRAMEWORK_IMAGE_SUPPORT: Readonly<Record<string, boolean>> =
  Object.freeze({
    claude: true,
    codex: true,
    hermes: true,
    mock: true,
    opencode: false,
  });

const OMITTED_MARKER = '[…earlier messages omitted]';
const ROW_TRUNCATED_SUFFIX = '…[truncated]';
/**
 * Stand-in for a tombstoned thread root (#1308 slice 1 item 4). Deleted rows are
 * dropped from the context window entirely — see `eligible` below — with one
 * exception: a thread root is structural, and a thread packet without its root
 * is not buildable. The root is therefore retained as this marker, so the agent
 * is told the anchor exists and is gone rather than being handed a blank line
 * that reads like an empty message.
 */
const DELETED_ROW_MARKER = '[message deleted]';
const IMAGE_ONLY_ROW_MARKER = '[image-only message]';
const NON_TEXT_ROW_MARKER = '[non-text message]';
const THREAD_SCOPE_MARKER =
  '[Thread scope — only this thread is shown; its root message is always included]';

export interface BuildMentionContextPacketInput {
  /** Human-facing channel title (topic display title), rendered as `#<title>`. */
  channelTitle: string;
  /** Framework id the packet is addressed to (`you are @<framework>`). */
  framework: string;
  /**
   * Prior channel rows, oldest-first; only non-empty human/agent prose is eligible,
   * except that a canonical thread root is always retained structurally. For a
   * channel trigger this is every row
   * with `lastDeliveredSeq < seq < trigger.seq`. For a threaded trigger this is
   * the thread root plus prior replies; the channel delivery cursor is ignored.
   * The agent's own prior rows are skipped HERE (they already live in the reused
   * provider conversation), except that a thread root is always retained.
   */
  rows: ChannelMessage[];
  /** The mention row itself — always rendered in the footer, never dropped. */
  trigger: ChannelMessage;
  /** Cursor: 0 for a first-ever mention (cold session → full orientation window). */
  lastDeliveredSeq: number;
  /**
   * Precomputed counts for the scanned candidate window. They are exact unless
   * `candidateScanTruncated` is true, in which case packet copy labels them as
   * lower bounds. Unit callers may omit this and derive exact counts from rows.
   */
  summary?: {
    totalCount: number;
    activityFilteredCount: number;
    /** Maximum raw candidates examined by each semantic count/row statement. */
    candidateScanBudget?: number;
    /** Counts cover the newest bounded candidate window, not all older history. */
    candidateScanTruncated?: boolean;
    scope: 'channel' | 'thread';
  };
}

/** Stable packet result retained across adapter retry/rebind. */
export interface MentionContextPacketEnvelope {
  content: string;
  framework: string;
  /** Exact context-row selection after row/byte trimming, followed by trigger. */
  retainedMessageIds: string[];
  /** Trigger-first, then newest-context-first sender-neutral image refs. */
  images: Array<{
    part: ChannelImagePart;
    messageId: string;
    trigger: boolean;
  }>;
}

export interface ResolvedMentionContextPacket {
  content: string;
  attachments: Attachment[];
}

function senderLabel(message: ChannelMessage): string {
  return message.sender.displayName ?? message.sender.id;
}

function imageDegradationNotes(message: ChannelMessage): string[] {
  const raw = message.meta?.[PACKET_IMAGE_DEGRADATION_META_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === 'string')
    .slice(0, PACKET_IMAGE_MAX_COUNT)
    .map((value) => value.slice(0, 120));
}

/**
 * Trigger-footer attribution: unambiguously marks whether the mention was
 * authored by a human or another agent (and which one). A bare display name is
 * forgeable/ambiguous — a human named "claude" reads identically to the claude
 * agent — so the receiving agent cannot tell a human mention from an
 * agent-authored one without this tag (§4/§5 attribution promise, #1167 P2).
 */
function triggerAttribution(message: ChannelMessage): string {
  const label = senderLabel(message);
  if (message.sender.kind === 'agent') {
    return `${label} [agent:${message.sender.providerId ?? message.sender.id}]`;
  }
  if (message.sender.kind === 'system') {
    return `${label} [system]`;
  }
  return `${label} [human]`;
}

/** Render one row as `label: text`, agent-tagged, with multi-line bodies indented. */
function renderRow(message: ChannelMessage): string {
  // Non-prose rows reaching this point are canonical thread roots. Render a
  // truthful non-empty structural marker while their attachment refs continue
  // through the envelope's image lane.
  const source = isChannelMessageDeleted(message)
    ? DELETED_ROW_MARKER
    : message.body.text.trim().length > 0
      ? message.body.text
      : (message.parts?.length ?? 0) > 0
        ? IMAGE_ONLY_ROW_MARKER
        : NON_TEXT_ROW_MARKER;
  const truncated =
    source.length > PACKET_ROW_MAX_CHARS
      ? source.slice(0, PACKET_ROW_MAX_CHARS) + ROW_TRUNCATED_SUFFIX
      : source;
  const lines = truncated.split('\n');
  const first = lines[0] ?? '';
  const rest = lines.slice(1);
  const indentRest = (body: string): string =>
    rest.length > 0
      ? body + '\n' + rest.map((l) => `    ${l}`).join('\n')
      : body;

  if (message.kind === 'system' || message.sender.kind === 'system') {
    return indentRest(`[system]: ${first}`);
  }
  const label = senderLabel(message);
  if (message.sender.kind === 'agent') {
    return indentRest(`${label} [agent]: ${first}`);
  }
  return indentRest(`${label}: ${first}`);
}

/** Whether a durable row is human/agent prose suitable for agent context. */
export function isMentionContextProseRow(row: ChannelMessage): boolean {
  return (
    row.kind === 'message' &&
    (row.sender.kind === 'human' || row.sender.kind === 'agent') &&
    row.agentDetail === undefined &&
    !isChannelMessageDeleted(row) &&
    row.body.text.trim().length > 0
  );
}

/** Provider conversation rows already retained by the receiving agent. */
export function isOwnMentionContextRow(
  row: ChannelMessage,
  framework: string
): boolean {
  return row.sender.kind === 'agent' && row.sender.providerId === framework;
}

/**
 * Build the deterministic context packet delivered as the agent's turn content.
 *
 * Shape (§4):
 *   [Relay channel #<title> — you are @<framework>, one participant in a multi-party chat]
 *   N messages since your last turn (M shown, K activity rows filtered).
 *   Recent text messages, oldest first. Lines are "sender: text"; ...   (only with context)
 *   […earlier messages omitted]                                          (only when >N eligible)
 *   <sender>: <text>
 *   ...
 *                                                                        (blank line)
 *   [<trigger sender> mentioned you — reply to this message; your reply is posted to the channel]
 *   <trigger text>
 *
 * A reused session with no interim rows collapses to header + footer only — the
 * provider already holds the conversation, so re-sending it wastes tokens.
 */
export function buildMentionContextPacketEnvelope(
  input: BuildMentionContextPacketInput
): MentionContextPacketEnvelope {
  const header = `[Relay channel #${input.channelTitle} — you are @${input.framework}, one participant in a multi-party chat]`;
  const threadRootId = input.trigger.threadId;

  // Candidate rows are strictly after the delivery cursor and before the
  // trigger, minus the agent's OWN prior prose (already retained by the reused
  // provider conversation). Detail/activity rows are counted, then filtered,
  // so the delivery summary is truthful without spending packet rows on blank
  // tool/thought/status shells (#1358).
  const candidates = input.rows.filter((row) => {
    if (row.seq >= input.trigger.seq) return false;
    if (threadRootId !== null) {
      const isRoot = row.id === threadRootId;
      if (!isRoot && row.threadId !== threadRootId) return false;
      return isRoot || !isOwnMentionContextRow(row, input.framework);
    }
    return (
      row.seq > input.lastDeliveredSeq &&
      !isOwnMentionContextRow(row, input.framework)
    );
  });
  const eligible = candidates.filter((row) => {
    const isRoot = threadRootId !== null && row.id === threadRootId;
    // Every canonical thread root is structural, including deleted, image-only,
    // or otherwise non-text roots. Ordinary blank/activity replies still drop.
    if (isRoot) return true;
    return isMentionContextProseRow(row);
  });
  const activityFilteredCount =
    input.summary?.activityFilteredCount ?? candidates.length - eligible.length;
  const contextTotalCount = input.summary?.totalCount ?? candidates.length;

  let contextRows: ChannelMessage[];
  let omittedEarlier =
    input.summary?.candidateScanTruncated === true ||
    contextTotalCount - activityFilteredCount > eligible.length;
  if (threadRootId !== null) {
    const root = eligible.find((row) => row.id === threadRootId);
    if (!root) {
      throw new Error(`thread context root missing: ${threadRootId}`);
    }
    const replies = eligible.filter((row) => row.id !== threadRootId);
    const replyLimit = Math.max(0, PACKET_MAX_ROWS - 1);
    if (replies.length > replyLimit) omittedEarlier = true;
    contextRows = [root, ...replies.slice(-replyLimit)];
  } else {
    contextRows = eligible;
    if (contextRows.length > PACKET_MAX_ROWS) {
      omittedEarlier = true;
      contextRows = contextRows.slice(contextRows.length - PACKET_MAX_ROWS);
    }
  }

  const triggerLabel = triggerAttribution(input.trigger);
  const triggerText =
    input.trigger.body.text.length > PACKET_ROW_MAX_CHARS
      ? input.trigger.body.text.slice(0, PACKET_ROW_MAX_CHARS) +
        ROW_TRUNCATED_SUFFIX
      : input.trigger.body.text;
  const footer = [
    `[${triggerLabel} mentioned you — reply to this message; your reply is posted to the channel]`,
    triggerText,
    ...imageDegradationNotes(input.trigger).map(
      (label) => `[Relay image attachment unavailable: ${label}]`
    ),
  ].join('\n');

  const assemble = (rows: ChannelMessage[], omitted: boolean): string => {
    const truncated = input.summary?.candidateScanTruncated === true;
    const boundedPrefix = truncated ? 'At least ' : '';
    const scope =
      input.summary?.scope ?? (threadRootId === null ? 'channel' : 'thread');
    const boundedDetails = truncated
      ? `; activity rows filtered: at least ${activityFilteredCount}; newest ${input.summary?.candidateScanBudget ?? 'bounded'} raw ${scope === 'thread' ? 'reply ' : ''}candidates scanned`
      : `, ${activityFilteredCount} activity rows filtered`;
    const summary =
      scope === 'thread'
        ? `${boundedPrefix}${contextTotalCount} prior thread rows (${rows.length} shown${boundedDetails}).`
        : `${boundedPrefix}${contextTotalCount} messages since your last turn (${rows.length} shown${boundedDetails}).`;
    const scopeLines = threadRootId !== null ? [THREAD_SCOPE_MARKER] : [];
    if (rows.length === 0) {
      return [header, summary, ...scopeLines, '', footer].join('\n');
    }
    const contextBlock = [
      summary,
      ...scopeLines,
      'Recent text messages, oldest first. Lines are "sender: text"; agents tagged [agent].',
      ...(threadRootId !== null && omitted
        ? [renderRow(rows[0]!), OMITTED_MARKER, ...rows.slice(1).map(renderRow)]
        : [...(omitted ? [OMITTED_MARKER] : []), ...rows.map(renderRow)]),
    ].join('\n');
    return `${header}\n${contextBlock}\n\n${footer}`;
  };

  // Whole-packet byte budget: drop oldest context rows until under. Thread mode
  // never drops its load-bearing root; the trigger/footer is never dropped in
  // either mode. A root/footer-only packet may exceed the budget — losing either
  // is worse than a slightly oversized packet.
  let packet = assemble(contextRows, omittedEarlier);
  while (
    contextRows.length > (threadRootId !== null ? 1 : 0) &&
    Buffer.byteLength(packet, 'utf8') > PACKET_MAX_BYTES
  ) {
    contextRows =
      threadRootId !== null
        ? [contextRows[0]!, ...contextRows.slice(2)]
        : contextRows.slice(1);
    omittedEarlier = true;
    packet = assemble(contextRows, omittedEarlier);
  }
  const retainedMessages = [...contextRows, input.trigger];
  const images = [
    ...(input.trigger.parts ?? []).map((part) => ({
      part,
      messageId: input.trigger.id,
      trigger: true,
    })),
    ...[...contextRows].reverse().flatMap((message) =>
      (message.parts ?? []).map((part) => ({
        part,
        messageId: message.id,
        trigger: false,
      }))
    ),
  ];
  return {
    content: packet,
    framework: input.framework,
    retainedMessageIds: retainedMessages.map((message) => message.id),
    images,
  };
}

/** Backward-compatible text-only projection used outside the channel binder. */
export function buildMentionContextPacket(
  input: BuildMentionContextPacketInput
): string {
  return buildMentionContextPacketEnvelope(input).content;
}

/**
 * Resolve durable attachment refs to the established adapter local-path lane.
 * Missing records or payloads remain explicit in packet text; they are never
 * silently dropped or fetched from a remote URL.
 */
export function resolveMentionContextPacket(
  packet: MentionContextPacketEnvelope,
  attachmentStore: ChannelAttachmentStore | null | undefined
): ResolvedMentionContextPacket {
  const attachments: Attachment[] = [];
  const notes: string[] = [];
  const rawByteLimit =
    packet.framework === 'claude'
      ? CLAUDE_PACKET_IMAGE_MAX_RAW_BYTES
      : PACKET_IMAGE_MAX_RAW_BYTES;
  let rawBytes = 0;
  const seenAttachmentIds = new Set<string>();
  for (const image of packet.images) {
    const part = image.part;
    // A chained mention may retain the same attachment through more than one
    // row. Delivery is sender-neutral and content-addressed, so the first
    // occurrence in packet priority order wins.
    if (seenAttachmentIds.has(part.id)) continue;
    seenAttachmentIds.add(part.id);
    if (
      PACKET_FRAMEWORK_IMAGE_SUPPORT[packet.framework.toLowerCase()] !== true
    ) {
      notes.push(
        `[image attachment not deliverable to ${packet.framework}: ${part.alt?.trim() || part.id}, ${part.w}x${part.h}]`
      );
      continue;
    }
    const record = attachmentStore?.get(part.id) ?? null;
    let payloadExists = false;
    if (record) {
      try {
        payloadExists = fs.statSync(record.payloadPath).isFile();
      } catch {
        payloadExists = false;
      }
    }
    if (!record || !payloadExists) {
      notes.push(
        `[Relay image attachment unavailable: ${part.alt?.trim() || part.id}]`
      );
      continue;
    }
    if (attachments.length >= PACKET_IMAGE_MAX_COUNT) {
      notes.push(
        `[Relay image attachment omitted: ${part.alt?.trim() || part.id} (packet image count limit)]`
      );
      continue;
    }
    if (rawBytes + record.part.bytes > rawByteLimit) {
      notes.push(
        `[Relay image attachment omitted: ${part.alt?.trim() || part.id} (packet image byte limit)]`
      );
      continue;
    }
    attachments.push({
      type: 'image',
      path: record.payloadPath,
      mimeType: record.part.mime,
    });
    rawBytes += record.part.bytes;
  }
  return {
    content:
      notes.length > 0
        ? `${packet.content}\n\n${notes.join('\n')}`
        : packet.content,
    attachments,
  };
}
