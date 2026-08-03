// Channel conversation core wire protocol (#1165, epic #1163).
//
// `ChannelEventV1` is a NEW, purpose-built multi-sender envelope. It deliberately
// does NOT extend `AgentPatchV2` (shared/agent-chat-protocol-v2.ts), whose reducer
// is structurally single-agent (singular `live.activeTurnId`); grafting sender
// attribution onto it would corrupt every adapter. A channel is a durable,
// multi-party timeline: humans and agents post into one seq-ordered log. Two
// agents streaming at once are two independent `streaming` rows with distinct ids
// and distinct (already-assigned) seqs — cross-sender corruption is structurally
// impossible because no reducer field is shared between senders.

import type { AgentDetailCardV2 } from './agent-chat-protocol-v2.js';
import {
  computeMentionDisambiguators,
  normalizeMentionToken,
  resolveProfileForMention,
  type AgentProfileContact,
} from './agent-profile.js';

export const CHANNEL_CHAT_PROTOCOL_VERSION = 1 as const;
export const CHANNEL_MESSAGE_MAX_IMAGE_PARTS = 4;
export const CHANNEL_IMAGE_ALT_MAX_LENGTH = 500;

/** 256KB per-message body cap, parity with WORK_CONTEXT_MESSAGE_PAYLOAD_MAX_BYTES. */
export const CHANNEL_MESSAGE_BODY_MAX_BYTES = 256 * 1024;
/** Card metadata shares the message-row budget and is bounded independently. */
export const CHANNEL_AGENT_DETAIL_MAX_BYTES = 256 * 1024;

export type ChannelMessageId = `chm:${string}`;
export type ChannelAttachmentId = `cha:${string}`;

export type ChannelImageMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

/** Sender-neutral durable image reference. Raw bytes never enter the message row. */
export interface ChannelImagePart {
  type: 'image';
  id: ChannelAttachmentId;
  mime: ChannelImageMime;
  w: number;
  h: number;
  bytes: number;
  alt?: string;
}

export type ChannelMessagePart = ChannelImagePart;

export type ChannelSenderKind = 'human' | 'agent' | 'system';
export type ChannelMessageKind = 'message' | 'system';
export type ChannelMessageStatus =
  | 'streaming'
  | 'complete'
  | 'truncated'
  | 'interrupted'
  | 'failed';
export type ChannelTruncationReason =
  | 'size-limit'
  | 'missing-terminal'
  | 'restart';
export type ChannelBodyFormat = 'markdown' | 'text';

export interface ChannelSenderRef {
  kind: ChannelSenderKind;
  /**
   * Actor identity slot. `'human:<actorId>'` | `'system'` | for agents the
   * profile Actor id (`agent-profile:<vendor>:default` for a vendor's built-in
   * default; `agent-profile:<vendor>:<uuid>` for a custom profile) — NOT
   * `agent:<framework>` (#1234). Read `providerId` for the vendor, never by
   * stripping this id.
   */
  id: string;
  displayName?: string;
  /** agent framework/vendor id (claude/codex/hermes/opencode) */
  providerId?: string;
  /** Private backing channel runtime; never a public Relay session id. */
  runtimeId?: string;
}

export interface ChannelMemberRef {
  kind: 'human' | 'agent';
  id: string;
  joinedAt: string;
}

export interface ChannelMention {
  raw: string;
  providerId?: string;
  /**
   * Resolved profile Actor id (`AgentProfile.id`) when `parseMentions` is given
   * a contact set (#1236). Additive + optional: rows parsed without a contact
   * set — every current server caller — leave this absent, and `providerId`
   * stays populated for the legacy vendor-alias path.
   */
  profileId?: string;
}

export interface ChannelMessageSource {
  /** Private channel runtime that emitted this provider item. */
  runtimeId: string;
  turnId?: string;
  itemId?: string;
}

/**
 * One provider-neutral agent operation attached to one durable channel row.
 * `itemId` is the adapter-stable entity key used for in-place updates.
 */
export interface ChannelAgentDetail {
  itemId: string;
  card: AgentDetailCardV2;
}

export interface ChannelMessage {
  schemaVersion: 1;
  id: ChannelMessageId;
  channelId: string;
  seq: number;
  kind: ChannelMessageKind;
  status: ChannelMessageStatus;
  sender: ChannelSenderRef;
  body: { text: string; format: ChannelBodyFormat };
  /** Typed parts persisted as content-addressed refs inside `meta_json.parts`. */
  parts?: ChannelMessagePart[];
  threadId: ChannelMessageId | null;
  parentMessageId: ChannelMessageId | null;
  /** Number of replies whose canonical thread root is this message. */
  replyCount?: number;
  mentions?: ChannelMention[];
  source?: ChannelMessageSource;
  /** Present on agent activity rows; prose rows leave this absent. */
  agentDetail?: ChannelAgentDetail;
  /**
   * Opaque row metadata surfaced to clients (#1167). System rows carry actionable
   * payloads here — e.g. an approval request `{ approvalRequestId, agentId,
   * runtimeId }` the timeline renders approve/deny controls for. Additive and
   * optional: rows without meta are unaffected.
   */
  meta?: Record<string, unknown>;
  truncated?: boolean;
  clientMessageId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ChannelInFlightRef {
  messageId: ChannelMessageId;
  deltaIndex: number;
}

// ── retry contract (#1308 slice 1 item 2) ───────────────────────────────────

/**
 * Prefix of the binder-issued turn identity. A routed turn is named after the
 * (trigger message, profile) pair it was raised for — that is what makes the
 * turn deterministic across a redeliver — so the trigger id is recoverable from
 * any durable row the turn produced. Retry is built on exactly that: it never
 * re-posts the human message, it re-routes the original one.
 */
export const CHANNEL_TURN_ID_PREFIX = 'chturn-';

/** Deterministic turn identity for one routed (trigger, profile) pair. */
export function channelTurnId(
  triggerMessageId: ChannelMessageId,
  profileActorId: string
): string {
  return `${CHANNEL_TURN_ID_PREFIX}${triggerMessageId}-${profileActorId}`;
}

/**
 * Inverse of `channelTurnId`. Parsed by anchoring on the known prefix AND the
 * known profile suffix rather than by splitting on `-`: both message ids and
 * profile actor ids embed UUIDs, so no separator is unambiguous. Returns null
 * for any turn id the binder did not mint (providers are free to label their
 * own items — Hermes emits `turn-0` — and those rows simply cannot be retried).
 */
export function triggerMessageIdFromTurnId(
  turnId: string,
  profileActorId: string
): ChannelMessageId | null {
  const suffix = `-${profileActorId}`;
  if (!turnId.startsWith(CHANNEL_TURN_ID_PREFIX)) return null;
  if (!turnId.endsWith(suffix) || turnId.length <= suffix.length) return null;
  const id = turnId.slice(
    CHANNEL_TURN_ID_PREFIX.length,
    turnId.length - suffix.length
  );
  return id.startsWith('chm:') && id.length > 'chm:'.length
    ? (id as ChannelMessageId)
    : null;
}

/**
 * Terminal statuses whose turn did NOT deliver a complete reply, so re-running
 * it is a coherent operator request.
 *
 * All three are included deliberately. `failed` is a send/agent error;
 * `interrupted` is produced both by the operator's ■ AND by a runtime dying
 * mid-stream (`handleRuntimeEnd` → bridge finalize), which is a lost turn the
 * operator never chose; `truncated` covers a missing terminal item or a hub
 * restart as well as the 256KB cap. Retry stays a click — never automatic — so
 * the operator, not the system, decides whether re-running is worth the tokens.
 */
export const CHANNEL_RETRYABLE_STATUSES: readonly ChannelMessageStatus[] = [
  'failed',
  'interrupted',
  'truncated',
];

/** `meta` key on the system row that supersedes a retried agent row. */
export const CHANNEL_RETRY_OF_META_KEY = 'retryOfMessageId';

export interface ChannelRetryTarget {
  /** The ORIGINAL human/agent message the failed turn was raised for. */
  triggerMessageId: ChannelMessageId;
  /** Profile actor id that owned the failed turn; the retry re-uses it. */
  profileActorId: string;
}

/**
 * Whether a row can be retried, and against what. Shared so the client's
 * affordance and the server's route agree by construction: an unresolvable row
 * never grows a retry button AND is rejected by the route.
 */
export function channelRetryTarget(
  message: ChannelMessage
): ChannelRetryTarget | null {
  if (message.kind !== 'message') return null;
  if (message.sender.kind !== 'agent') return null;
  if (!CHANNEL_RETRYABLE_STATUSES.includes(message.status)) return null;
  const turnId = message.source?.turnId;
  if (!turnId) return null;
  const profileActorId = message.sender.id;
  const triggerMessageId = triggerMessageIdFromTurnId(turnId, profileActorId);
  if (!triggerMessageId || triggerMessageId === message.id) return null;
  return { triggerMessageId, profileActorId };
}

/** Agent row a system row supersedes, when it is a retry marker. */
export function retriedMessageIdFromSystemRow(
  message: ChannelMessage
): ChannelMessageId | null {
  if (message.kind !== 'system') return null;
  const value = message.meta?.[CHANNEL_RETRY_OF_META_KEY];
  return typeof value === 'string' && value.startsWith('chm:')
    ? (value as ChannelMessageId)
    : null;
}

// ── edit contract (#1308 slice 1 item 3) ────────────────────────────────────

/**
 * `meta` key stamped when the operator edits their own row. Presence of the key
 * IS the edited marker — there is no separate boolean, so a row can never claim
 * to be edited without carrying when it happened.
 */
export const CHANNEL_EDITED_AT_META_KEY = 'editedAt';

/** ISO stamp of the last edit, or null for a row that was never edited. */
export function channelMessageEditedAt(message: ChannelMessage): string | null {
  const value = message.meta?.[CHANNEL_EDITED_AT_META_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Whether the operator may edit this row. Human-authored prose rows only in this
 * slice: an agent row is a durable record of what a provider actually said, and
 * a system row is the hub's own bookkeeping — editing either would make the
 * transcript lie. `complete` excludes an in-flight stream (a human row is never
 * streaming today, so this is a structural guard, not a live case). A tombstone
 * is excluded too — an edit of a deleted row would resurrect a body the operator
 * erased (#1308 item 4).
 *
 * Shared so the client's affordance and the server's route agree by
 * construction: a row that grows no edit button is also rejected by the route.
 */
export function channelMessageEditable(message: ChannelMessage): boolean {
  return (
    message.kind === 'message' &&
    message.sender.kind === 'human' &&
    message.status === 'complete' &&
    !isChannelMessageDeleted(message)
  );
}

// ── delete contract (#1308 slice 1 item 4) ──────────────────────────────────

/**
 * `meta` key stamped when the operator deletes their own row. A deletion is a
 * TOMBSTONE, never a row removal: `channel_messages.seq` is the substrate's
 * gap-free log, and every catch-up cursor, deep link and thread parent is a
 * promise that a seq once issued keeps naming the same row forever.
 *
 * The mark lives in `meta` rather than in `status` on purpose. `status` carries
 * a SQL CHECK constraint, so a `deleted` status would need the constraint
 * widened plus a table-rebuild migration (`SCHEMA_VERSION` bump, the v2 rebuild
 * lane) — schema churn buying nothing, since a tombstone is orthogonal to the
 * streaming lifecycle `status` describes: a deleted row is still `complete`, it
 * simply no longer has a body. Presence of the key IS the marker, so a row can
 * never claim to be deleted without carrying when it happened.
 */
export const CHANNEL_DELETED_AT_META_KEY = 'deletedAt';

/** ISO stamp of the deletion, or null for a row that is not a tombstone. */
export function channelMessageDeletedAt(
  message: ChannelMessage
): string | null {
  const value = message.meta?.[CHANNEL_DELETED_AT_META_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Whether this row is a tombstone — body wiped, id/seq/links retained. */
export function isChannelMessageDeleted(message: ChannelMessage): boolean {
  return channelMessageDeletedAt(message) !== null;
}

/**
 * Whether the operator may delete this row. Identical to the edit predicate
 * today — both are "the operator's own settled prose row" — and kept as its own
 * name because the two affordances answer different questions and are free to
 * diverge (a future retention rule could forbid deleting a row an agent already
 * consumed without touching who may fix a typo).
 */
export function channelMessageDeletable(message: ChannelMessage): boolean {
  return channelMessageEditable(message);
}

/**
 * Shape check for a row arriving as a tombstone. Deliberately NOT
 * `channelMessageDeletable` — that predicate answers "may this be deleted",
 * which is false for an already-deleted row, so the wire needs its own
 * post-condition: an operator prose row, marked deleted, with no body left.
 */
export function isChannelMessageTombstone(message: ChannelMessage): boolean {
  return (
    message.kind === 'message' &&
    message.sender.kind === 'human' &&
    isChannelMessageDeleted(message) &&
    message.body.text.length === 0
  );
}

// ── message search contract (#1308 slice 2 item 1) ──────────────────────────

/**
 * Snippet highlight sentinels.
 *
 * SQLite's `snippet()` wraps every matched term in a caller-supplied pair of
 * strings. We deliberately do NOT emit markup (`<mark>`, `<b>`, …): the snippet
 * is derived from an arbitrary operator/agent message body, so any tag we
 * injected would have to be sanitized again on the client, and a body that
 * already contains that tag would be indistinguishable from our own marker.
 *
 * Instead the delimiters are two Unicode Private Use Area code points. PUA has
 * no assigned meaning, is never produced by a keyboard or by a model writing
 * prose or code, survives JSON transport unchanged, and carries no HTML
 * semantics — so `parseChannelSearchSnippet` can split on them and the renderer
 * emits plain text nodes plus its own highlight element. (A body that literally
 * contained U+E000 would confuse the split; that is accepted, it is not
 * reachable from any real authoring path.)
 */
export const CHANNEL_SEARCH_HIGHLIGHT_OPEN = '\uE000';
export const CHANNEL_SEARCH_HIGHLIGHT_CLOSE = '\uE001';

/** Ellipsis `snippet()` uses when the match is not at a body boundary. */
export const CHANNEL_SEARCH_SNIPPET_ELLIPSIS = '…';

/** Hard cap on returned hits — search is a jump affordance, not a transcript. */
export const CHANNEL_SEARCH_MAX_RESULTS = 50;

/** Query text beyond this is truncated before it reaches the index. */
export const CHANNEL_SEARCH_QUERY_MAX_CHARS = 256;

export interface ChannelSearchSnippetSegment {
  text: string;
  /** true when this run was a matched term and should be emphasized. */
  highlight: boolean;
}

/**
 * Split a server snippet into plain/highlighted runs. Shared so the renderer
 * and the contract test agree on the delimiter by construction rather than by
 * two copies of the same string literal.
 */
export function parseChannelSearchSnippet(
  snippet: string
): ChannelSearchSnippetSegment[] {
  const segments: ChannelSearchSnippetSegment[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const open = rest.indexOf(CHANNEL_SEARCH_HIGHLIGHT_OPEN);
    if (open === -1) break;
    const close = rest.indexOf(CHANNEL_SEARCH_HIGHLIGHT_CLOSE, open + 1);
    if (close === -1) break;
    if (open > 0)
      segments.push({ text: rest.slice(0, open), highlight: false });
    const inner = rest.slice(open + 1, close);
    if (inner.length > 0) segments.push({ text: inner, highlight: true });
    rest = rest.slice(close + 1);
  }
  if (rest.length > 0) segments.push({ text: rest, highlight: false });
  return segments;
}

/**
 * One indexed message match. Deliberately jump-shaped: `channelId` +
 * `messageId` is exactly what the #1308 slice 1 deep link
 * (`/channel/<segment>#msg-<messageId>`) consumes, so a result row reuses the
 * shipped bounded-history walk and jump highlight instead of a second
 * scroll-to-message path.
 */
export interface ChannelMessageSearchHit {
  messageId: ChannelMessageId;
  channelId: string;
  /** Canonical thread root when the hit is a reply, else null. */
  threadId: ChannelMessageId | null;
  seq: number;
  /** Highlighted excerpt; split with `parseChannelSearchSnippet`. */
  snippet: string;
  senderKind: ChannelSenderKind;
  senderId: string;
  /**
   * Persisted `sender_display`. Never derive a label by splitting `senderId` —
   * it is a profile Actor id (`agent-profile:<vendor>:default`), not a name.
   */
  senderDisplayName?: string;
  /** Vendor framework id for agent rows; the authoritative label fallback. */
  providerId?: string;
  createdAt: string;
  /** Raw bm25 relevance (more negative is a better match); results are sorted. */
  score: number;
}

/** A hit decorated with the channel identity the router resolves. */
export interface ChannelMessageSearchResult extends ChannelMessageSearchHit {
  channelTitle: string;
  archived: boolean;
}

export interface ChannelMessageSearchResponse {
  /** Echo of the accepted query text (already length-capped and trimmed). */
  query: string;
  results: ChannelMessageSearchResult[];
  /** true when more hits existed than the cap returned. */
  truncated: boolean;
  /** Set when the query could not be run at all, e.g. it held no searchable term. */
  unavailableReason?: 'empty_query';
}

interface ChannelEventBaseV1 {
  channelId: string;
  timestamp: string;
}

export interface ChannelSnapshotEventV1 extends ChannelEventBaseV1 {
  type: 'channel-snapshot-v1';
  /** full: replace state; catchup: merge by seq/id */
  mode: 'full' | 'catchup';
  /** seq-ascending; streaming rows carry accumulated in-memory text */
  messages: ChannelMessage[];
  members: ChannelMemberRef[];
  latestSeq: number;
  inFlight: ChannelInFlightRef[];
  /** true when a full snapshot did not reach seq 1 */
  truncated: boolean;
}

export interface ChannelMessageCreatedEventV1 extends ChannelEventBaseV1 {
  type: 'channel-message-created-v1';
  /** status 'complete' (post) or 'streaming' (stream open) */
  message: ChannelMessage;
}

export interface ChannelMessageDeltaEventV1 extends ChannelEventBaseV1 {
  type: 'channel-message-delta-v1';
  messageId: ChannelMessageId;
  /** server-assigned 0,1,2,... per message, per coalesced flush */
  deltaIndex: number;
  delta: { text: string };
}

export interface ChannelMessageUpdatedEventV1 extends ChannelEventBaseV1 {
  type: 'channel-message-updated-v1';
  /** Authoritative full streaming row; clients replace the entity by id. */
  message: ChannelMessage;
}

export interface ChannelMessageCompletedEventV1 extends ChannelEventBaseV1 {
  type: 'channel-message-completed-v1';
  /** authoritative full row; status complete|truncated|interrupted|failed */
  message: ChannelMessage;
}

/**
 * Operator edit of an already-durable row (#1308 slice 1 item 3).
 *
 * A separate variant rather than a reuse of `channel-message-updated-v1`: that
 * event is contractually a STREAMING row refresh (its validator rejects any
 * other status and its reducer ignores a non-streaming target), which is exactly
 * the shape an edit is not. Widening it would have made every streaming-row
 * guard in the reducer conditional; this stays additive and leaves the streaming
 * lane untouched.
 */
export interface ChannelMessageEditedEventV1 extends ChannelEventBaseV1 {
  type: 'channel-message-edited-v1';
  /** Authoritative full row; same id/seq, new body, `meta.editedAt` stamped. */
  message: ChannelMessage;
}

/**
 * Operator deletion of an already-durable row (#1308 slice 1 item 4).
 *
 * Its own variant for the same reason the edit event is: the payload is a row
 * that must REPLACE a held one in place, and neither the streaming-only
 * `channel-message-updated-v1` nor the terminal-transition
 * `channel-message-completed-v1` can carry that without loosening a guard the
 * streaming lane depends on. Kept separate from the edit event too, so a client
 * can tell "the operator fixed a typo" from "the operator erased this" without
 * inspecting `meta` — the two render as different rows.
 */
export interface ChannelMessageDeletedEventV1 extends ChannelEventBaseV1 {
  type: 'channel-message-deleted-v1';
  /** Authoritative tombstone; same id/seq/thread links, empty body. */
  message: ChannelMessage;
}

export interface ChannelResyncRequiredEventV1 extends ChannelEventBaseV1 {
  type: 'channel-resync-required-v1';
  latestSeq: number;
}

export type ChannelEventV1 =
  | ChannelSnapshotEventV1
  | ChannelMessageCreatedEventV1
  | ChannelMessageDeltaEventV1
  | ChannelMessageUpdatedEventV1
  | ChannelMessageCompletedEventV1
  | ChannelMessageEditedEventV1
  | ChannelMessageDeletedEventV1
  | ChannelResyncRequiredEventV1;

// ── runtime validators ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SENDER_KINDS = new Set<string>(['human', 'agent', 'system']);
const MESSAGE_KINDS = new Set<string>(['message', 'system']);
const MESSAGE_STATUSES = new Set<string>([
  'streaming',
  'complete',
  'truncated',
  'interrupted',
  'failed',
]);
const BODY_FORMATS = new Set<string>(['markdown', 'text']);
const IMAGE_MIMES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export function isChannelMessagePart(
  value: unknown
): value is ChannelMessagePart {
  return (
    isRecord(value) &&
    value.type === 'image' &&
    typeof value.id === 'string' &&
    value.id.startsWith('cha:') &&
    typeof value.mime === 'string' &&
    IMAGE_MIMES.has(value.mime) &&
    typeof value.w === 'number' &&
    Number.isSafeInteger(value.w) &&
    value.w > 0 &&
    typeof value.h === 'number' &&
    Number.isSafeInteger(value.h) &&
    value.h > 0 &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    (value.alt === undefined ||
      (typeof value.alt === 'string' &&
        value.alt.length <= CHANNEL_IMAGE_ALT_MAX_LENGTH))
  );
}

function isSenderRef(value: unknown): value is ChannelSenderRef {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    SENDER_KINDS.has(value.kind) &&
    typeof value.id === 'string' &&
    (value.displayName === undefined ||
      typeof value.displayName === 'string') &&
    (value.providerId === undefined || typeof value.providerId === 'string') &&
    (value.sessionId === undefined || typeof value.sessionId === 'string')
  );
}

const AGENT_DETAIL_KINDS = new Set<string>([
  'message',
  'thought',
  'tool_call',
  'output',
  'diff',
]);
const AGENT_DETAIL_STATUSES = new Set<string>([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export function isChannelAgentDetail(
  value: unknown
): value is ChannelAgentDetail {
  if (!isRecord(value) || typeof value.itemId !== 'string') return false;
  const card = value.card;
  if (!isRecord(card)) return false;
  return (
    typeof card.kind === 'string' &&
    AGENT_DETAIL_KINDS.has(card.kind) &&
    typeof card.title === 'string' &&
    typeof card.status === 'string' &&
    AGENT_DETAIL_STATUSES.has(card.status) &&
    (card.content === undefined || typeof card.content === 'string') &&
    (card.language === undefined || typeof card.language === 'string') &&
    (card.command === undefined || typeof card.command === 'string') &&
    (card.path === undefined || typeof card.path === 'string') &&
    (card.additions === undefined ||
      (typeof card.additions === 'number' &&
        Number.isSafeInteger(card.additions) &&
        card.additions >= 0)) &&
    (card.deletions === undefined ||
      (typeof card.deletions === 'number' &&
        Number.isSafeInteger(card.deletions) &&
        card.deletions >= 0)) &&
    (card.sizeBytes === undefined ||
      (typeof card.sizeBytes === 'number' &&
        Number.isSafeInteger(card.sizeBytes) &&
        card.sizeBytes >= 0))
  );
}

function isMemberRef(value: unknown): value is ChannelMemberRef {
  return (
    isRecord(value) &&
    (value.kind === 'human' || value.kind === 'agent') &&
    typeof value.id === 'string' &&
    typeof value.joinedAt === 'string'
  );
}

export function isChannelMessage(value: unknown): value is ChannelMessage {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== CHANNEL_CHAT_PROTOCOL_VERSION) return false;
  if (typeof value.id !== 'string' || !value.id.startsWith('chm:'))
    return false;
  if (typeof value.channelId !== 'string') return false;
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq))
    return false;
  if (typeof value.kind !== 'string' || !MESSAGE_KINDS.has(value.kind))
    return false;
  if (typeof value.status !== 'string' || !MESSAGE_STATUSES.has(value.status))
    return false;
  if (!isSenderRef(value.sender)) return false;
  if (
    !isRecord(value.body) ||
    typeof value.body.text !== 'string' ||
    typeof value.body.format !== 'string' ||
    !BODY_FORMATS.has(value.body.format)
  ) {
    return false;
  }
  if (
    value.parts !== undefined &&
    (!Array.isArray(value.parts) ||
      value.parts.length > CHANNEL_MESSAGE_MAX_IMAGE_PARTS ||
      !value.parts.every(isChannelMessagePart))
  ) {
    return false;
  }
  if (
    value.agentDetail !== undefined &&
    !isChannelAgentDetail(value.agentDetail)
  ) {
    return false;
  }
  if (value.threadId !== null && typeof value.threadId !== 'string')
    return false;
  if (
    value.parentMessageId !== null &&
    typeof value.parentMessageId !== 'string'
  )
    return false;
  if (
    value.replyCount !== undefined &&
    (typeof value.replyCount !== 'number' ||
      !Number.isSafeInteger(value.replyCount) ||
      value.replyCount < 0)
  )
    return false;
  if (
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  )
    return false;
  return true;
}

function isMessageArray(value: unknown): value is ChannelMessage[] {
  return Array.isArray(value) && value.every(isChannelMessage);
}

function isInFlightArray(value: unknown): value is ChannelInFlightRef[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.messageId === 'string' &&
        typeof entry.deltaIndex === 'number'
    )
  );
}

export function isChannelEventV1(value: unknown): value is ChannelEventV1 {
  if (!isRecord(value)) return false;
  if (typeof value.type !== 'string') return false;
  if (typeof value.channelId !== 'string') return false;
  if (typeof value.timestamp !== 'string') return false;
  switch (value.type) {
    case 'channel-snapshot-v1':
      return (
        (value.mode === 'full' || value.mode === 'catchup') &&
        isMessageArray(value.messages) &&
        Array.isArray(value.members) &&
        value.members.every(isMemberRef) &&
        typeof value.latestSeq === 'number' &&
        isInFlightArray(value.inFlight) &&
        typeof value.truncated === 'boolean'
      );
    case 'channel-message-created-v1':
      return isChannelMessage(value.message);
    case 'channel-message-delta-v1':
      return (
        typeof value.messageId === 'string' &&
        typeof value.deltaIndex === 'number' &&
        isRecord(value.delta) &&
        typeof value.delta.text === 'string'
      );
    case 'channel-message-updated-v1':
      return (
        isChannelMessage(value.message) && value.message.status === 'streaming'
      );
    case 'channel-message-completed-v1':
      return isChannelMessage(value.message);
    case 'channel-message-edited-v1':
      // Same predicate the route enforces: only an editable row can arrive as
      // an edit, so a malformed or agent-authored payload is dropped at the
      // wire rather than replacing a durable row in the reducer.
      return (
        isChannelMessage(value.message) && channelMessageEditable(value.message)
      );
    case 'channel-message-deleted-v1':
      // Post-condition of the route, not its precondition: the payload must be
      // an operator prose row that is marked deleted AND carries no body left.
      // A "deletion" still holding text would be a leak of the thing the
      // operator asked to erase, so it is dropped at the wire.
      return (
        isChannelMessage(value.message) &&
        isChannelMessageTombstone(value.message)
      );
    case 'channel-resync-required-v1':
      return typeof value.latestSeq === 'number';
    default:
      return false;
  }
}

// ── pure reducer ────────────────────────────────────────────────────────────

export interface ChannelReducerState {
  channelId: string;
  /** seq-ordered */
  messages: ChannelMessage[];
  byId: Record<string, ChannelMessage>;
  lastSeq: number;
  /** last applied deltaIndex per streaming message */
  inFlightDelta: Record<string, number>;
  /** streams that received an out-of-order delta; drop further deltas until completed heals */
  quarantined: Record<string, true>;
  /** self-diagnosis flag: the client re-syncs via afterSeq/sinceSeq when set */
  needsCatchup: boolean;
}

export function initialChannelReducerState(
  channelId: string
): ChannelReducerState {
  return {
    channelId,
    messages: [],
    byId: {},
    lastSeq: 0,
    inFlightDelta: {},
    quarantined: {},
    needsCatchup: false,
  };
}

function sortedInsert(
  messages: ChannelMessage[],
  message: ChannelMessage
): ChannelMessage[] {
  const next = messages.filter((existing) => existing.id !== message.id);
  let index = next.findIndex((existing) => existing.seq > message.seq);
  if (index === -1) index = next.length;
  next.splice(index, 0, message);
  return next;
}

function rebuildById(
  messages: ChannelMessage[]
): Record<string, ChannelMessage> {
  const byId: Record<string, ChannelMessage> = {};
  for (const message of messages) byId[message.id] = message;
  return byId;
}

function inFlightFromRefs(
  inFlight: ChannelInFlightRef[]
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const ref of inFlight) map[ref.messageId] = ref.deltaIndex;
  return map;
}

/**
 * Pure reducer for `ChannelEventV1`. It is self-diagnosing: it can never silently
 * render a corrupted timeline. On any gap or unknown-id surprise it sets
 * `needsCatchup` (drives the client to `channels.history?afterSeq=lastSeq` or a
 * reconnect with `sinceSeq=lastSeq`) instead of guessing. Deterministic under
 * replay: applying the same event stream twice yields the same state.
 */
export function applyChannelEventV1(
  state: ChannelReducerState,
  event: ChannelEventV1
): ChannelReducerState {
  switch (event.type) {
    case 'channel-snapshot-v1': {
      if (event.mode === 'full') {
        const messages = [...event.messages].sort((a, b) => a.seq - b.seq);
        return {
          channelId: state.channelId,
          messages,
          byId: rebuildById(messages),
          lastSeq: event.latestSeq,
          inFlightDelta: inFlightFromRefs(event.inFlight),
          quarantined: {},
          needsCatchup: false,
        };
      }
      // catchup: merge ascending
      let messages = state.messages;
      for (const message of [...event.messages].sort((a, b) => a.seq - b.seq)) {
        if (state.byId[message.id] || message.seq > state.lastSeq) {
          messages = sortedInsert(messages, message);
        }
      }
      return {
        ...state,
        messages,
        byId: rebuildById(messages),
        lastSeq: Math.max(state.lastSeq, event.latestSeq),
        inFlightDelta: inFlightFromRefs(event.inFlight),
        quarantined: {},
        needsCatchup: false,
      };
    }

    case 'channel-message-created-v1': {
      const message = event.message;
      if (state.byId[message.id]) return state; // idempotent replay
      if (message.seq <= state.lastSeq) return state; // idempotent replay
      if (message.seq > state.lastSeq + 1) {
        return { ...state, needsCatchup: true }; // gap — do not apply
      }
      const messages = sortedInsert(state.messages, message);
      return {
        ...state,
        messages,
        byId: rebuildById(messages),
        lastSeq: message.seq,
      };
    }

    case 'channel-message-delta-v1': {
      const existing = state.byId[event.messageId];
      if (!existing) return { ...state, needsCatchup: true };
      if (existing.status !== 'streaming') return state; // late delta after finalize
      if (state.quarantined[event.messageId]) return state; // dropped until completed heals
      const expected = (state.inFlightDelta[event.messageId] ?? -1) + 1;
      if (event.deltaIndex !== expected) {
        // out-of-order — quarantine THIS message only
        return {
          ...state,
          quarantined: { ...state.quarantined, [event.messageId]: true },
        };
      }
      const updated: ChannelMessage = {
        ...existing,
        body: { ...existing.body, text: existing.body.text + event.delta.text },
      };
      const messages = state.messages.map((message) =>
        message.id === updated.id ? updated : message
      );
      return {
        ...state,
        messages,
        byId: { ...state.byId, [updated.id]: updated },
        inFlightDelta: {
          ...state.inFlightDelta,
          [event.messageId]: event.deltaIndex,
        },
      };
    }

    case 'channel-message-updated-v1': {
      const message = event.message;
      const existing = state.byId[message.id];
      if (!existing) return { ...state, needsCatchup: true };
      if (existing.status !== 'streaming' || message.status !== 'streaming') {
        return state;
      }
      if (message.seq !== existing.seq) {
        return { ...state, needsCatchup: true };
      }
      const messages = state.messages.map((row) =>
        row.id === message.id ? message : row
      );
      return {
        ...state,
        messages,
        byId: { ...state.byId, [message.id]: message },
      };
    }

    case 'channel-message-completed-v1': {
      const message = event.message;
      if (!state.byId[message.id]) return { ...state, needsCatchup: true };
      const messages = state.messages.map((existing) =>
        existing.id === message.id ? message : existing
      );
      const inFlightDelta = { ...state.inFlightDelta };
      delete inFlightDelta[message.id];
      const quarantined = { ...state.quarantined };
      delete quarantined[message.id];
      return {
        ...state,
        messages,
        byId: { ...state.byId, [message.id]: message },
        inFlightDelta,
        quarantined,
      };
    }

    case 'channel-message-edited-v1': {
      const message = event.message;
      const existing = state.byId[message.id];
      // Deliberately NOT a catch-up trigger, unlike every other unknown-id case.
      // An edit adds no seq and closes no gap: an id the client does not hold is
      // simply a row outside its loaded window (the operator edited something
      // older on another device). Re-syncing would show the out-of-sync banner
      // for a timeline that is perfectly in sync, and the edited body arrives
      // anyway the moment that page is scrolled back into view.
      if (!existing) return state;
      // Guards, not corrections: an edit must never resurrect, re-number, or
      // overwrite a live stream. Any of these means the row on the wire is not
      // the row this client holds, so the safe move is to keep what is durable.
      if (existing.status === 'streaming') return state;
      if (message.seq !== existing.seq) return { ...state, needsCatchup: true };
      const messages = state.messages.map((row) =>
        row.id === message.id ? message : row
      );
      return {
        ...state,
        messages,
        byId: { ...state.byId, [message.id]: message },
      };
    }

    case 'channel-message-deleted-v1': {
      const message = event.message;
      const existing = state.byId[message.id];
      // Same three guards as the edit lane, for the same reasons: an unknown id
      // is a row outside the loaded window (no seq moved, so nothing is missing
      // — demanding a resync would raise the out-of-sync banner on a healthy
      // timeline); a live stream is never a tombstone target; and a seq surprise
      // means the row on the wire is not the row held here.
      if (!existing) return state;
      if (existing.status === 'streaming') return state;
      if (message.seq !== existing.seq) return { ...state, needsCatchup: true };
      // Replaced in place, never spliced out. The array keeps its length and
      // order, so grouping, the unread divider's index and every scroll anchor
      // survive a deletion untouched — and a deleted thread parent stays where
      // its replies point.
      const messages = state.messages.map((row) =>
        row.id === message.id ? message : row
      );
      return {
        ...state,
        messages,
        byId: { ...state.byId, [message.id]: message },
      };
    }

    case 'channel-resync-required-v1':
      return { ...state, needsCatchup: true };

    default:
      return state;
  }
}

/**
 * Merge a page of history (`channels.history` REST response) into an existing
 * reducer state. Pure + additive: dedupes by id via `sortedInsert` (so a
 * re-merge of overlapping pages is idempotent), keeps `messages` seq-ascending,
 * and never lowers `lastSeq` (older pages carry lower seqs; `lastSeq` stays the
 * max). Used by the reverse-infinite-scroll `loadOlder()` path in
 * `useChannelChatSocket`, which reads history via REST rather than the socket.
 */
export function mergeHistoryPage(
  state: ChannelReducerState,
  page: ChannelMessage[]
): ChannelReducerState {
  if (page.length === 0) return state;
  let messages = state.messages;
  for (const message of [...page].sort((a, b) => a.seq - b.seq)) {
    messages = sortedInsert(messages, message);
  }
  const highestSeq = messages.length
    ? messages[messages.length - 1]!.seq
    : state.lastSeq;
  return {
    ...state,
    messages,
    byId: rebuildById(messages),
    lastSeq: Math.max(state.lastSeq, highestSeq),
  };
}

// ── mention parser (stored, not routed in slice 2) ──────────────────────────

/**
 * Extract `@mention` tokens from message text, skipping code fences, inline code,
 * and email-like `local@domain` spans. Returns both the raw token and, when the
 * name matches a known framework provider id (case-insensitive), the resolved
 * `providerId`. Both are persisted so alias policy (`@Claude` vs `@claude`,
 * custom providers) can change later without a data migration. #1167 inherits
 * this hardened tokenizer.
 *
 * When a profile `contacts` set is supplied (#1236) each mention additionally
 * resolves to a profile Actor id: multi-word display names match
 * LONGEST-MATCH-FIRST, `@<vendor>` resolves to that vendor's default profile,
 * and a trailing `#<token>` disambiguates same-name collisions. Resolution
 * delegates to the keystone `resolveProfileForMention` (vendor alias + tiebreak
 * are NOT reimplemented here). Callers that pass no contacts — every current
 * server caller — keep the exact single-token behavior above.
 */
export function parseMentions(
  text: string,
  knownProviderIds: readonly string[] = [],
  contacts?: readonly AgentProfileContact[]
): ChannelMention[] {
  const known = new Map<string, string>();
  for (const id of knownProviderIds) known.set(id.toLowerCase(), id);

  const masked = maskCodeSpans(text);
  if (contacts && contacts.length > 0) {
    return parseMentionsWithContacts(text, masked, known, contacts);
  }

  const mentionPattern = /(^|[^A-Za-z0-9_.])@([A-Za-z][A-Za-z0-9_-]*)/g;
  const seen = new Set<string>();
  const mentions: ChannelMention[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(masked)) !== null) {
    const name = match[2];
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const providerId = known.get(key);
    mentions.push({
      raw: `@${name}`,
      ...(providerId ? { providerId } : {}),
    });
  }
  return mentions;
}

/** Word count of a normalized display name (empty name → 0). */
function nameWordCount(displayName: string): number {
  const norm = normalizeMentionToken(displayName);
  return norm ? norm.split(' ').length : 0;
}

/**
 * Profile-aware mention scan. Reads a greedy run of words after each `@`, then
 * resolves LONGEST-EXACT-FIRST: for k words down to 1 it asks
 * `resolveProfileForMention` for the k-word phrase and keeps the match only when
 * the resolved name consumes exactly k words (a shorter name matched by prefix
 * is rejected so trailing prose is never swallowed). A `#<token>` immediately
 * following the consumed name selects a specific member of a same-name group.
 */
function parseMentionsWithContacts(
  text: string,
  masked: string,
  known: Map<string, string>,
  contacts: readonly AgentProfileContact[]
): ChannelMention[] {
  const disambTokens = computeMentionDisambiguators(contacts);
  const maxWords = Math.min(
    8,
    Math.max(1, ...contacts.map((c) => nameWordCount(c.displayName)))
  );
  const boundary = /(^|[^A-Za-z0-9_.])@/g;
  const firstWord = /^[A-Za-z][A-Za-z0-9_-]*/;
  const contWord = /^ ([A-Za-z0-9_-]+)/;
  const disambPattern = /^#([A-Za-z0-9]+)/;

  const seen = new Set<string>();
  const mentions: ChannelMention[] = [];
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(masked)) !== null) {
    const atIndex = match.index + match[0].length - 1;
    let cursor = atIndex + 1;
    const first = firstWord.exec(masked.slice(cursor));
    if (!first) continue;

    const words: Array<{ text: string; end: number }> = [
      { text: first[0], end: cursor + first[0].length },
    ];
    cursor += first[0].length;
    while (words.length < maxWords) {
      const cont = contWord.exec(masked.slice(cursor));
      if (!cont) break;
      cursor += cont[0].length;
      words.push({ text: cont[1]!, end: cursor });
    }

    let disamb: string | null = null;
    let disambEnd = -1;
    const dm = disambPattern.exec(masked.slice(cursor));
    if (dm) {
      disamb = dm[1]!.toLowerCase();
      disambEnd = cursor + dm[0].length;
    }

    // Longest-exact-first resolution over the greedy word run.
    let winner: AgentProfileContact | null = null;
    let consumed = 0;
    for (let k = words.length; k >= 1; k--) {
      const candidate = words
        .slice(0, k)
        .map((w) => w.text)
        .join(' ');
      const resolved = resolveProfileForMention(candidate, contacts);
      if (!resolved) continue;
      const matchedLen = nameWordCount(resolved.displayName) || 1;
      if (matchedLen !== k) continue; // prefix-matched a shorter name — back off
      winner = resolved;
      consumed = k;
      break;
    }

    let rawEnd: number;
    let providerId: string | undefined;
    let profileId: string | undefined;
    if (winner) {
      consumed = consumed || 1;
      rawEnd = words[consumed - 1]!.end;
      providerId = winner.providerId;
      profileId = winner.id;
      // A `#token` right after the consumed name picks a same-name collision peer.
      if (disamb && consumed === words.length && disambEnd > 0) {
        const nameNorm = normalizeMentionToken(
          words
            .slice(0, consumed)
            .map((w) => w.text)
            .join(' ')
        );
        const target = contacts.find(
          (c) =>
            normalizeMentionToken(c.displayName) === nameNorm &&
            disambTokens.get(c.id) === disamb
        );
        if (target) {
          providerId = target.providerId;
          profileId = target.id;
          rawEnd = disambEnd;
        }
      }
    } else {
      // Unresolved: keep the single leading token, provider-tagged if known.
      rawEnd = words[0]!.end;
      providerId = known.get(words[0]!.text.toLowerCase());
      profileId = undefined;
    }

    const raw = text.slice(atIndex, rawEnd);
    const dedupeKey = profileId ?? raw.toLowerCase();
    boundary.lastIndex = rawEnd;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    mentions.push({
      raw,
      ...(providerId ? { providerId } : {}),
      ...(profileId ? { profileId } : {}),
    });
  }
  return mentions;
}

/** Replace fenced + inline code spans with equal-length spaces so mention offsets stay aligned. */
function maskCodeSpans(text: string): string {
  const maskRun = (source: string, pattern: RegExp): string =>
    source.replace(pattern, (span) => ' '.repeat(span.length));
  let masked = maskRun(text, /```[\s\S]*?```/g);
  masked = maskRun(masked, /`[^`]*`/g);
  return masked;
}
