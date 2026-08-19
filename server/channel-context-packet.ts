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
/**
 * Marker for the ordinary follow-up thread turn (#1408): above the delivery
 * cursor the root was delivered on an earlier turn and this packet is
 * replies-only. Promising a root that is not there is worse than saying nothing
 * — an agent that reads "root is always included" takes the first context row
 * for the root and misreads reply 1 as the question it is answering.
 */
const THREAD_SCOPE_MARKER_ROOTLESS =
  '[Thread scope — only this thread is shown; its root was delivered on an earlier turn]';

export interface BuildMentionContextPacketInput {
  /**
   * Durable channel (workspace topic) id, rendered verbatim in the handle line
   * so an agent can address `relay-ide v1 channels post` at the channel it is
   * speaking in. This is a public, channel-visible id: NEVER pass a runtime,
   * provider-session, or turn id here (#1408).
   */
  channelId: string;
  /** Human-facing channel title (topic display title), rendered as `#<title>`. */
  channelTitle: string;
  /**
   * A DM is a channel with exactly one agent profile, so the multi-party
   * framing is false there and costs tokens on every turn. Defaults to the
   * multi-party shape: without a resolvable topic row the caller cannot prove
   * DM-ness, and over-claiming privacy is the worse error.
   */
  channelKind?: 'dm' | 'channel';
  /**
   * `turn` is the ordinary mention delivery. `steer` is a mid-turn instruction
   * injected into a LIVE turn: the provider already holds this conversation and
   * just re-read the header, so a steer packet carries the handle, any interim
   * rows, and the instruction — no header or scope marker, and no counts unless
   * rows were omitted (#1408).
   */
  delivery?: 'turn' | 'steer';
  /** Framework id the packet is addressed to (`you are @<framework>`). */
  framework: string;
  /**
   * Prior channel rows, oldest-first; only non-empty human/agent prose is eligible,
   * except that a canonical thread root is retained structurally inside the
   * orientation window. Both scopes select `lastDeliveredSeq < seq <
   * trigger.seq` (#1408); a threaded trigger additionally keeps only rows of its
   * own thread, and `lastDeliveredSeq` is then the per-(binding, thread) cursor.
   * The agent's own prior rows are skipped HERE (they already live in the reused
   * provider conversation), except for a thread root inside that window.
   */
  rows: ChannelMessage[];
  /** The mention row itself — always rendered in the footer, never dropped. */
  trigger: ChannelMessage;
  /**
   * Cursor: 0 for a first-ever mention (cold session → full orientation window).
   * A thread packet built at cursor 0 MUST be able to resolve its root — that is
   * the orientation invariant, and a missing root throws. Above 0 the root has
   * already been delivered, so a rootless replies-only packet is the correct
   * shape rather than an error.
   */
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
 * Shape (§4, `delivery: 'turn'`):
 *   [Relay channel #<title> — you are @<framework>, one participant in a multi-party chat]
 *   [relay channel-id=<channelId> trigger-seq=<seq>]                      (ALWAYS line 2)
 *   N messages since your last turn (M shown, K activity rows filtered).   (dropped at 0/0/0)
 *   Recent text messages, oldest first. Lines are "sender: text"; ...   (only with context)
 *   […earlier messages omitted]                                          (only when >N eligible)
 *   <sender>: <text>
 *   ...
 *                                                                        (blank line)
 *   [<trigger sender> mentioned you — reply to this message; your reply is posted to the channel]
 *   <trigger text>
 *
 * A DM swaps the header for `[Relay DM #<title> — you are @<framework>]`: one
 * agent, no multi-party framing to pay for.
 *
 * `delivery: 'steer'` drops the header, the counts, and the scope marker — the
 * live turn already read them — leaving the handle line, any interim rows, and
 * a `[… — new instruction for your current turn]` footer. The counts line comes
 * back whenever rows were actually omitted, so a steer never silently swallows
 * interim messages it is about to move the cursor past.
 *
 * A reused session with no interim rows collapses to header + handle + footer
 * only — the provider already holds the conversation, so re-sending it wastes
 * tokens.
 */
export function buildMentionContextPacketEnvelope(
  input: BuildMentionContextPacketInput
): MentionContextPacketEnvelope {
  const steer = input.delivery === 'steer';
  const header =
    input.channelKind === 'dm'
      ? `[Relay DM #${input.channelTitle} — you are @${input.framework}]`
      : `[Relay channel #${input.channelTitle} — you are @${input.framework}, one participant in a multi-party chat]`;
  // Machine-readable, fixed-position handle. It carries the DURABLE channel id
  // and the trigger's channel seq and nothing else: an agent needs an address
  // for `relay-ide v1 channels post`, and a runtime/session id would both leak
  // private execution state and name something that is not a chat destination.
  const handle = `[relay channel-id=${input.channelId} trigger-seq=${input.trigger.seq}]`;
  const threadRootId = input.trigger.threadId;

  // Candidate rows are strictly after the delivery cursor and before the
  // trigger, minus the agent's OWN prior prose (already retained by the reused
  // provider conversation). Detail/activity rows are counted, then filtered,
  // so the delivery summary is truthful without spending packet rows on blank
  // tool/thought/status shells (#1358). Thread scope applies the cursor to the
  // structural root as well (#1408) — the caller's cursor is per-thread, so a
  // root above it has not been delivered and a root below it has.
  const candidates = input.rows.filter((row) => {
    if (row.seq >= input.trigger.seq) return false;
    if (row.seq <= input.lastDeliveredSeq) return false;
    if (threadRootId !== null) {
      const isRoot = row.id === threadRootId;
      if (!isRoot && row.threadId !== threadRootId) return false;
      return isRoot || !isOwnMentionContextRow(row, input.framework);
    }
    return !isOwnMentionContextRow(row, input.framework);
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
  // Load-bearing for row capping, omitted-marker placement, and byte trimming:
  // only a packet that actually carries its root reserves index 0 for it.
  let hasThreadRoot = false;
  let omittedEarlier =
    input.summary?.candidateScanTruncated === true ||
    contextTotalCount - activityFilteredCount > eligible.length;
  if (threadRootId !== null) {
    const root = eligible.find((row) => row.id === threadRootId);
    // Orientation invariant (#1408): at cursor 0 the window reaches the root, so
    // its absence means the caller handed over an unbuildable thread packet and
    // the agent would be oriented by nothing. Above 0 the root is legitimately
    // outside the window — it was delivered on an earlier turn of this thread —
    // and the packet is replies-only.
    if (!root && input.lastDeliveredSeq === 0) {
      throw new Error(`thread context root missing: ${threadRootId}`);
    }
    hasThreadRoot = root !== undefined;
    const replies = eligible.filter((row) => row.id !== threadRootId);
    const replyLimit = Math.max(0, PACKET_MAX_ROWS - 1);
    if (replies.length > replyLimit) omittedEarlier = true;
    const newestReplies = replies.slice(-replyLimit);
    contextRows = root ? [root, ...newestReplies] : newestReplies;
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
    steer
      ? `[${triggerLabel} — new instruction for your current turn]`
      : `[${triggerLabel} mentioned you — reply to this message; your reply is posted to the channel]`,
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
    // Thread scope now windows on the same per-thread cursor channel scope uses
    // (#1408), so above the cursor "prior thread rows" would misdescribe an
    // incremental window as the whole thread.
    const threadSummary =
      input.lastDeliveredSeq > 0
        ? `${boundedPrefix}${contextTotalCount} thread rows since your last turn (${rows.length} shown${boundedDetails}).`
        : `${boundedPrefix}${contextTotalCount} prior thread rows (${rows.length} shown${boundedDetails}).`;
    const summary =
      scope === 'thread'
        ? threadSummary
        : `${boundedPrefix}${contextTotalCount} messages since your last turn (${rows.length} shown${boundedDetails}).`;
    // An all-zero delivery statement says nothing an agent can act on: nothing
    // shown, nothing omitted, nothing filtered, and no bounded scan to
    // disclose. Any non-zero component (including "0 shown, 2 filtered") is
    // real information and still renders.
    const quiet =
      contextTotalCount === 0 &&
      rows.length === 0 &&
      activityFilteredCount === 0 &&
      !truncated;
    // The handle is the one line every packet carries, so its position is
    // fixed: line 2 of a turn packet, line 1 of a steer packet.
    const lead = steer ? [handle] : [header, handle];
    // A steer normally drops the counts because the live turn just read them.
    // It cannot drop them when something WAS omitted: with rows present the
    // omitted marker still signals it, but a truncated or byte-trimmed steer
    // that filtered down to zero rows would otherwise disclose nothing at all
    // — and accepting the steer advances the cursor past those rows for good.
    const summaryLines = quiet || (steer && !omitted) ? [] : [summary];
    const scopeLines =
      !steer && threadRootId !== null
        ? [hasThreadRoot ? THREAD_SCOPE_MARKER : THREAD_SCOPE_MARKER_ROOTLESS]
        : [];
    if (rows.length === 0) {
      return [...lead, ...summaryLines, ...scopeLines, '', footer].join('\n');
    }
    const contextBlock = [
      ...summaryLines,
      ...scopeLines,
      'Recent text messages, oldest first. Lines are "sender: text"; agents tagged [agent].',
      ...(hasThreadRoot && omitted
        ? [renderRow(rows[0]!), OMITTED_MARKER, ...rows.slice(1).map(renderRow)]
        : [...(omitted ? [OMITTED_MARKER] : []), ...rows.map(renderRow)]),
    ].join('\n');
    return `${lead.join('\n')}\n${contextBlock}\n\n${footer}`;
  };

  // Whole-packet byte budget: drop oldest context rows until under. A thread
  // packet that carries its root never drops it; a replies-only one has no such
  // anchor, so it trims from the front exactly like channel scope and may reach
  // zero rows. The trigger/footer is never dropped in any mode. A root/footer-only
  // packet may exceed the budget — losing either is worse than a slightly
  // oversized packet.
  let packet = assemble(contextRows, omittedEarlier);
  while (
    contextRows.length > (hasThreadRoot ? 1 : 0) &&
    Buffer.byteLength(packet, 'utf8') > PACKET_MAX_BYTES
  ) {
    contextRows = hasThreadRoot
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
