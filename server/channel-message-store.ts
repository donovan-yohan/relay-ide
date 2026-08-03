import * as crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createLogger } from './logger.js';

import {
  CHANNEL_CHAT_PROTOCOL_VERSION,
  CHANNEL_AGENT_DETAIL_MAX_BYTES,
  CHANNEL_EDITED_AT_META_KEY,
  CHANNEL_MESSAGE_BODY_MAX_BYTES,
  CHANNEL_MESSAGE_MAX_IMAGE_PARTS,
  isChannelMessagePart,
  isChannelAgentDetail,
  parseMentions,
  type ChannelAgentDetail,
  type ChannelBodyFormat,
  type ChannelMemberRef,
  type ChannelMention,
  type ChannelMessage,
  type ChannelMessageId,
  type ChannelMessageKind,
  type ChannelMessagePart,
  type ChannelMessageSource,
  type ChannelMessageStatus,
  type ChannelTruncationReason,
  type ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';

// Durable channel conversation store (#1165). Owns `channel-chat.db` in the
// config dir with its own `schema_version` runner (same pattern as
// work-context-messages.ts / ia-store.ts). `work_context_messages` is NOT
// evolved — it is agent-mail (#945) with audience/redaction semantics and
// random-UUID tiebreak ordering; wrong substrate for a seq-ordered chat log.
//
// Store invariants (documented here so future features do not regress them):
//  * Any unread arithmetic must COUNT by seq range — never assume contiguity
//    survives future features.
//  * Catch-up is ALWAYS DB-backed (the durable seq log is the replay buffer);
//    there is no in-memory event ring.
//  * Edits/deletes must NEVER be implemented as row deletion — that would break
//    gap-free seq. `editMessage` (#1308 slice 1 item 3) is the sanctioned shape:
//    the SAME row keeps its id/seq/createdAt and only its body/meta change, so
//    every seq cursor, catch-up window, and thread parent stays valid.

const SCHEMA_VERSION = 5;
const logger = createLogger('channel-message-store');
export const CHANNEL_HISTORY_DEFAULT_LIMIT = 50;
export const CHANNEL_HISTORY_MAX_LIMIT = 200;
const CHANNEL_SUMMARY_PREVIEW_MAX_CHARS = 200;
/**
 * Body window scanned for the summary's mention signal when the row carries no
 * persisted `meta.mentions` (bridge-authored agent rows never do — the binder
 * parses mentions for fan-out without writing them back). Deliberately far
 * beyond `CHANNEL_SUMMARY_PREVIEW_MAX_CHARS` so a long agent status update that
 * ends in `@operator` still lights the mention lane, and still bounded so the
 * list route never regex-scans 200 × 256KB of body text.
 */
const CHANNEL_SUMMARY_MENTION_SCAN_MAX_CHARS = 8_000;
/**
 * Threads carried on a channel-list row by default (#1287 slice 5 item 18). The
 * rail shows the newest-active few and a count for the rest — enough to make
 * threads navigable without turning a 200-row list payload into a transcript.
 */
export const CHANNEL_THREAD_SUMMARY_LIMIT = 3;
const CHANNEL_THREAD_SUMMARY_MAX_LIMIT = 20;

export type ChannelThreadHistoryQueryMode = 'default' | 'after' | 'before';

function replyCountSql(rootAlias: string): string {
  // Detail cards (meta.agentDetail) carry a thread_id so cold-resume can render
  // them inside the thread, but they are not conversational replies — exclude
  // them from the root's reply count.
  return `(SELECT COUNT(*)
             FROM channel_messages replies
            WHERE replies.thread_id = ${rootAlias}.id
              AND json_extract(replies.meta_json, '$.agentDetail') IS NULL)`;
}

/** Production query builder exported so query-plan tests exercise exact SQL. */
export function buildChannelThreadHistorySql(
  mode: ChannelThreadHistoryQueryMode
): string {
  const seqClause =
    mode === 'after'
      ? 'AND seq > @afterSeq'
      : mode === 'before'
        ? 'AND seq < @beforeSeq'
        : '';
  const order = mode === 'after' ? 'ASC' : 'DESC';
  return `SELECT m.*,
                  ${replyCountSql('m')} AS reply_count
           FROM (
             SELECT root.* FROM channel_messages root
              WHERE root.id = @rootMessageId
                AND root.channel_id = @channelId ${seqClause}
             UNION ALL
             SELECT thread_reply.*
               FROM channel_messages thread_reply INDEXED BY idx_chm_thread
              WHERE thread_reply.thread_id = @rootMessageId
                AND thread_reply.channel_id = @channelId ${seqClause}
           ) m
           ORDER BY m.seq ${order} LIMIT @limit`;
}

/**
 * Production query builder for the channel-list thread aggregate (#1287 slice 5
 * item 18), exported for the same reason `buildChannelThreadHistorySql` is: this
 * runs once per channel on every `GET /channels`, so a query-plan test EXPLAINs
 * the exact SQL rather than a hand-copied approximation that can silently drift
 * into a full-table walk.
 *
 * `COUNT(*) OVER ()` sits in the OUTER select, over the joined result. Inside
 * the aggregate it counted GROUPS — including any whose root row the inner join
 * then dropped (a deleted root, or a `thread_id` pointing outside this channel),
 * so the rail could render "5 threads" for a channel that has four. Window
 * functions are evaluated before `LIMIT`, so the outer count still spans every
 * live thread and not just the capped page.
 *
 * `CROSS JOIN` is the join-order hint, not a cartesian product: SQLite never
 * reorders across one. The `root.channel_id` predicate the correctness fix
 * added is enough on its own to tempt the planner into driving from `root`
 * (`SEARCH root USING INDEX idx_chm_channel_seq (channel_id=?)` plus an
 * AUTOMATIC COVERING INDEX built over `agg` every execution), which walks every
 * message in the channel instead of the handful of thread roots and makes this
 * scale with messages-per-channel. Pinning the order keeps the `SCAN agg` ->
 * primary-key probe of `root` shape the query-plan test locks in.
 */
export function buildChannelThreadSummarySql(): string {
  return `SELECT root.id             AS root_id,
                root.body_text      AS root_body,
                root.sender_id      AS root_sender_id,
                root.sender_kind    AS root_sender_kind,
                root.sender_display AS root_sender_display,
                root.meta_json      AS root_meta_json,
                agg.reply_count     AS reply_count,
                agg.last_reply_at   AS last_reply_at,
                COUNT(*) OVER ()    AS thread_total
           FROM (
             SELECT thread_id,
                    COUNT(*)        AS reply_count,
                    MAX(created_at) AS last_reply_at,
                    MAX(seq)        AS last_reply_seq
               FROM channel_messages
              WHERE channel_id = @channelId
                AND thread_id IS NOT NULL
                AND json_extract(meta_json, '$.agentDetail') IS NULL
              GROUP BY thread_id
           ) agg
           CROSS JOIN channel_messages root
             ON root.id = agg.thread_id AND root.channel_id = @channelId
          ORDER BY agg.last_reply_seq DESC
          LIMIT @limit`;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS channel_messages (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'message'
                      CHECK (kind IN ('message','system')),
  status            TEXT NOT NULL DEFAULT 'complete'
                      CHECK (status IN ('streaming','complete','truncated','interrupted','failed')),
  sender_kind       TEXT NOT NULL CHECK (sender_kind IN ('human','agent','system')),
  sender_id         TEXT NOT NULL,
  sender_display    TEXT,
  thread_id         TEXT,
  parent_message_id TEXT,
  body_text         TEXT NOT NULL DEFAULT '',
  body_format       TEXT NOT NULL DEFAULT 'markdown',
  meta_json         TEXT,
  source_runtime_id TEXT,
  source_turn_id    TEXT,
  source_item_id    TEXT,
  client_message_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  UNIQUE (channel_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_chm_channel_seq
  ON channel_messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_chm_thread
  ON channel_messages(thread_id, seq) WHERE thread_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chm_source_dedupe
  ON channel_messages(source_runtime_id, source_turn_id, source_item_id)
  WHERE source_runtime_id IS NOT NULL
    AND source_turn_id IS NOT NULL
    AND source_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chm_client_dedupe
  ON channel_messages(channel_id, sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id    TEXT NOT NULL,
  member_kind   TEXT NOT NULL CHECK (member_kind IN ('human','agent')),
  member_id     TEXT NOT NULL,
  joined_at     TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (channel_id, member_kind, member_id)
);

CREATE TABLE IF NOT EXISTS channel_agent_bindings (
  channel_id            TEXT NOT NULL,
  profile_actor_id      TEXT NOT NULL,
  agent_framework       TEXT NOT NULL,
  runtime_id            TEXT,
  provider_session_json TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (channel_id, profile_actor_id)
);
`;

interface ChannelMessageRow {
  id: string;
  channel_id: string;
  seq: number;
  kind: string;
  status: string;
  sender_kind: string;
  sender_id: string;
  sender_display: string | null;
  thread_id: string | null;
  parent_message_id: string | null;
  body_text: string;
  body_format: string;
  meta_json: string | null;
  source_runtime_id: string | null;
  source_turn_id: string | null;
  source_item_id: string | null;
  client_message_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  reply_count?: number;
}

/** Projection of the thread aggregate join (#1287 slice 5 item 18). */
interface ThreadSummaryRow {
  root_id: string;
  root_body: string;
  root_sender_id: string;
  root_sender_kind: string;
  root_sender_display: string | null;
  root_meta_json: string | null;
  reply_count: number;
  last_reply_at: string;
  thread_total: number;
}

interface MemberRow {
  channel_id: string;
  member_kind: string;
  member_id: string;
  joined_at: string;
  metadata_json: string;
}

interface BindingRow {
  channel_id: string;
  profile_actor_id: string;
  agent_framework: string;
  runtime_id: string | null;
  provider_session_json: string;
  created_at: string;
  updated_at: string;
}

export interface ChannelMessageMeta {
  mentions?: ChannelMention[];
  parts?: ChannelMessagePart[];
  truncationReason?: ChannelTruncationReason;
  /** Legacy UI marker reserved exclusively for the 256KB size limit. */
  truncated?: boolean;
  agentDetail?: ChannelAgentDetail;
  /** Internal lifecycle marker; stripped before rows cross the wire. */
  agentDetailTerminalAuthority?: 'provisional' | 'explicit';
  [key: string]: unknown;
}

export interface AppendCompleteInput {
  channelId: string;
  kind?: ChannelMessageKind;
  sender: ChannelSenderRef;
  text: string;
  format?: ChannelBodyFormat;
  parentMessageId?: string;
  clientMessageId?: string;
  mentions?: ChannelMention[];
  parts?: ChannelMessagePart[];
  meta?: ChannelMessageMeta;
  /** Server-derived backing runtime for authenticated agent posts. */
  source?: Pick<ChannelMessageSource, 'runtimeId'>;
}

export interface BeginStreamInput {
  channelId: string;
  sender: ChannelSenderRef;
  source: { runtimeId: string; turnId?: string; itemId?: string };
  text?: string;
  parentMessageId?: string;
  mentions?: ChannelMention[];
  parts?: ChannelMessagePart[];
  agentDetail?: ChannelAgentDetail;
}

export interface FinalizeStreamInput {
  text: string;
  status: Extract<
    ChannelMessageStatus,
    'complete' | 'truncated' | 'interrupted' | 'failed'
  >;
  truncationReason?: ChannelTruncationReason;
  /** Legacy alias for `truncationReason: 'size-limit'`. */
  truncated?: boolean;
  agentDetail?: ChannelAgentDetail;
  /** Detail rows distinguish turn/restart fallback from item-level terminal. */
  agentDetailTerminalAuthority?: 'provisional' | 'explicit';
}

export interface EditMessageInput {
  /** Channel scope — an id from another channel is a 404, never a cross-edit. */
  channelId: string;
  messageId: string;
  /**
   * Server-derived editor identity (never body-supplied). Must equal the row's
   * own `sender_id`: single-operator today, but ownership is enforced
   * structurally so a future second identity cannot silently inherit edit rights.
   */
  editorId: string;
  /** Replacement body. Empty text is rejected — deleting is a separate action. */
  text: string;
  /** Re-parsed from the new text by the caller; replaces the stored refs. */
  mentions?: ChannelMention[];
}

export interface ResolveProvisionalAgentDetailTerminalResult {
  message: ChannelMessage | null;
  transitioned: boolean;
}

export interface ChannelSummary {
  channelId: string;
  latestSeq: number;
  messageCount: number;
  lastMessage: {
    id: ChannelMessageId;
    seq: number;
    preview: string;
    senderId: string;
    senderKind: ChannelSenderKindLoose;
    /**
     * Persisted `sender_display`. Sidebar/rail snippets label the sender from
     * this (falling back to `providerId`) — NEVER by stripping `senderId`, which
     * is a profile Actor id (`agent-profile:<vendor>:default`), not a name.
     */
    senderDisplayName?: string;
    /** Vendor framework id for agent rows; the authoritative label fallback. */
    providerId?: string;
    /**
     * Mention refs for the previewed row. Persisted `meta.mentions` when the
     * write path resolved them (#1236 contact-set resolution included);
     * otherwise parsed server-side from a bounded window of the FULL body, so a
     * mention past the 200-char preview cut-off is still visible to clients.
     */
    mentions?: ChannelMention[];
    status: ChannelMessageStatus;
    createdAt: string;
  } | null;
}

type ChannelSenderKindLoose = ChannelSenderRef['kind'];

/**
 * One live thread inside a channel, as the rail renders it (#1287 slice 5 item
 * 18). Deliberately root-shaped rather than reply-shaped: the rail's row is "the
 * conversation this thread hangs off", and the reply signal is the count plus
 * the newest reply's stamp.
 */
export interface ChannelThreadSummary {
  rootMessageId: ChannelMessageId;
  /**
   * Conversational replies only — the same exclusion `replyCountSql` applies, so
   * a rail row and the in-timeline "N replies" chip can never disagree.
   */
  replyCount: number;
  /** `created_at` of the newest reply; the rail's thread stamp. */
  lastReplyAt: string;
  /** Bounded preview of the thread ROOT's body. */
  preview: string;
  rootSenderId: string;
  rootSenderKind: ChannelSenderKindLoose;
  /** Persisted `sender_display` — never derived by splitting `rootSenderId`. */
  rootSenderDisplayName?: string;
  /** Vendor framework id for an agent root; the authoritative label fallback. */
  providerId?: string;
}

export interface ChannelThreadSummaryPage {
  /** Newest-active threads first, capped by the caller's limit. */
  threads: ChannelThreadSummary[];
  /**
   * Total live threads in the channel; `threads` is only the newest slice.
   * Counted over the same joined result the page comes from, so a thread whose
   * root row is gone is absent from BOTH — the rail can never render a count
   * larger than the number of threads that actually exist.
   */
  threadCount: number;
}

export interface ChannelHistoryFilter {
  beforeSeq?: number;
  afterSeq?: number;
  limit?: number;
  threadId?: string;
}

export interface ChannelBinding {
  channelId: string;
  /** Durable AgentProfile actor identity; binding/session ownership key. */
  profileActorId: string;
  /** Provider/framework spawn selector retained independently of the profile. */
  agentFramework: string;
  runtimeId: string | null;
  providerSession: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StaleStreamSweepResult {
  channelId: string;
  truncatedIds: ChannelMessageId[];
  systemMessage: ChannelMessage;
}

export class ChannelMessageStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ChannelMessageStoreError';
  }
}

export interface ChannelMessageStore {
  close(): void;
  appendComplete(input: AppendCompleteInput): ChannelMessage;
  beginStream(input: BeginStreamInput): ChannelMessage;
  updateStreamText(id: string, text: string): ChannelMessage | null;
  updateAgentDetail(
    id: string,
    detail: ChannelAgentDetail
  ): ChannelMessage | null;
  resolveProvisionalAgentDetailTerminal(
    id: string,
    input: Pick<FinalizeStreamInput, 'text' | 'status'> & {
      agentDetail: ChannelAgentDetail;
    }
  ): ResolveProvisionalAgentDetailTerminalResult;
  finalizeStream(id: string, input: FinalizeStreamInput): ChannelMessage | null;
  /**
   * Operator edit of their OWN human row (#1308 slice 1 item 3). In-place by
   * design: id, seq, createdAt, thread links and client dedupe key all survive,
   * so nothing that indexes the timeline by seq has to move. Throws
   * `ChannelMessageStoreError` 404 (absent / other channel) or 409 (not an
   * editable row, or not this editor's row) rather than returning null, so the
   * route can map both without inventing its own vocabulary.
   */
  editMessage(input: EditMessageInput): ChannelMessage;
  getMessage(id: string): ChannelMessage | null;
  findByClientMessage(
    channelId: string,
    senderId: string,
    clientMessageId: string
  ): ChannelMessage | null;
  history(channelId: string, filter?: ChannelHistoryFilter): ChannelMessage[];
  /** Root-inclusive history for one canonical thread. */
  threadHistory(
    channelId: string,
    rootMessageId: string,
    filter?: ChannelHistoryFilter
  ): ChannelMessage[];
  /**
   * Rows a reconnecting client may still hold as a stale copy: rows at or below
   * the reconnect cursor that mutate IN PLACE (no new seq), in their CURRENT
   * state, nearest the cursor first. Two such classes exist —
   *  - agent-origin rows (source triple set), whose stream finalizes
   *    streaming → complete/truncated/interrupted/failed, and
   *  - edited rows (#1308 slice 1 item 3), whose body changed under a seq the
   *    client already consumed.
   * `history({ afterSeq })` never re-sends either, so both must ride catch-up or
   * a disconnected device keeps rendering pre-edit text / a stuck stream.
   * Bounded by `limit`.
   */
  listResyncRows(
    channelId: string,
    uptoSeq: number,
    limit: number
  ): ChannelMessage[];
  latestSeq(channelId: string): number;
  listChannelSummaries(): ChannelSummary[];
  getChannelSummary(channelId: string): ChannelSummary | null;
  /**
   * Live threads in one channel, newest-active first (#1287 slice 5 item 18).
   * One channel-scoped aggregate — the same order of work the summary's own
   * `COUNT(*)` already does — so the channel list can carry thread rows without
   * a second route or a per-thread fetch.
   */
  listChannelThreadSummaries(
    channelId: string,
    limit?: number
  ): ChannelThreadSummaryPage;
  upsertMember(input: {
    channelId: string;
    kind: 'human' | 'agent';
    id: string;
    metadata?: Record<string, unknown>;
  }): ChannelMemberRef;
  listMembers(channelId: string): ChannelMemberRef[];
  findDmChannel(memberIdA: string, memberIdB: string): string | null;
  getBinding(channelId: string, profileActorId: string): ChannelBinding | null;
  upsertBinding(input: {
    channelId: string;
    profileActorId: string;
    agentFramework: string;
    runtimeId?: string | null;
    providerSession?: Record<string, unknown>;
  }): ChannelBinding;
  sweepStaleStreaming(): StaleStreamSweepResult[];
  sweepOrphans(persistedTopicIds: Set<string>): {
    channelsDeleted: string[];
    messagesDeleted: number;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function createMessageId(): ChannelMessageId {
  return `chm:${crypto.randomUUID()}`;
}

function assertBodySize(text: string): void {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > CHANNEL_MESSAGE_BODY_MAX_BYTES) {
    throw new ChannelMessageStoreError(
      413,
      'channel_message_body_too_large',
      'channel message body exceeds 256KB cap',
      { bytes, maxBytes: CHANNEL_MESSAGE_BODY_MAX_BYTES }
    );
  }
}

function assertMessageParts(parts: ChannelMessagePart[] | undefined): void {
  if (!parts) return;
  if (
    parts.length > CHANNEL_MESSAGE_MAX_IMAGE_PARTS ||
    !parts.every(isChannelMessagePart)
  ) {
    throw new ChannelMessageStoreError(
      400,
      'channel_message_parts_invalid',
      `channel message accepts at most ${CHANNEL_MESSAGE_MAX_IMAGE_PARTS} valid image parts`
    );
  }
}

function assertAgentDetail(detail: ChannelAgentDetail | undefined): void {
  if (detail === undefined) return;
  if (
    !isChannelAgentDetail(detail) ||
    Buffer.byteLength(JSON.stringify(detail), 'utf8') >
      CHANNEL_AGENT_DETAIL_MAX_BYTES
  ) {
    throw new ChannelMessageStoreError(
      413,
      'channel_agent_detail_too_large',
      'channel agent detail is invalid or exceeds the 256KB cap'
    );
  }
}

function assertMessagePayloadSize(
  text: string,
  detail: ChannelAgentDetail | undefined
): void {
  assertBodySize(text);
  assertAgentDetail(detail);
  const bytes =
    Buffer.byteLength(text, 'utf8') +
    (detail === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(detail), 'utf8'));
  if (bytes > CHANNEL_MESSAGE_BODY_MAX_BYTES) {
    throw new ChannelMessageStoreError(
      413,
      'channel_message_payload_too_large',
      'combined channel message body and agent detail exceed the 256KB cap',
      { bytes, maxBytes: CHANNEL_MESSAGE_BODY_MAX_BYTES }
    );
  }
}

function cleanLimit(
  limit: unknown,
  maxLimit = CHANNEL_HISTORY_MAX_LIMIT
): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return CHANNEL_HISTORY_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(maxLimit, Math.floor(limit)));
}

function parseMeta(raw: string | null): ChannelMessageMeta | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as ChannelMessageMeta)
      : undefined;
  } catch {
    return undefined;
  }
}

function rowToMessage(row: ChannelMessageRow): ChannelMessage {
  const meta = parseMeta(row.meta_json);
  const sender: ChannelSenderRef = {
    kind: row.sender_kind as ChannelSenderRef['kind'],
    id: row.sender_id,
    ...(row.sender_display ? { displayName: row.sender_display } : {}),
  };
  const providerId =
    typeof meta?.['providerId'] === 'string'
      ? (meta['providerId'] as string)
      : undefined;
  if (providerId) sender.providerId = providerId;
  if (row.source_runtime_id) sender.runtimeId = row.source_runtime_id;

  const message: ChannelMessage = {
    schemaVersion: CHANNEL_CHAT_PROTOCOL_VERSION,
    id: row.id as ChannelMessageId,
    channelId: row.channel_id,
    seq: row.seq,
    kind: row.kind as ChannelMessageKind,
    status: row.status as ChannelMessageStatus,
    sender,
    body: {
      text: row.body_text,
      format: (row.body_format as ChannelBodyFormat) ?? 'markdown',
    },
    threadId: (row.thread_id as ChannelMessageId | null) ?? null,
    parentMessageId: (row.parent_message_id as ChannelMessageId | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.reply_count !== undefined) message.replyCount = row.reply_count;
  if (meta?.mentions && Array.isArray(meta.mentions)) {
    message.mentions = meta.mentions;
  }
  if (
    Array.isArray(meta?.parts) &&
    meta.parts.length > 0 &&
    meta.parts.every(isChannelMessagePart)
  ) {
    message.parts = meta.parts;
  }
  if (isChannelAgentDetail(meta?.agentDetail)) {
    message.agentDetail = meta.agentDetail;
  }
  // Surface app-level meta (e.g. #1167 approval payloads) while keeping the
  // internal routing keys off the wire — providerId rides `sender.providerId`,
  // mentions/truncated have dedicated fields above.
  if (meta) {
    const {
      providerId: _pid,
      mentions: _m,
      parts: _parts,
      agentDetail: _agentDetail,
      agentDetailTerminalAuthority: _agentDetailTerminalAuthority,
      truncated: _t,
      ...rest
    } = meta;
    if (Object.keys(rest).length > 0) message.meta = rest;
  }
  if (row.source_runtime_id) {
    message.source = {
      runtimeId: row.source_runtime_id,
      ...(row.source_turn_id ? { turnId: row.source_turn_id } : {}),
      ...(row.source_item_id ? { itemId: row.source_item_id } : {}),
    };
  }
  if (meta?.truncated === true) message.truncated = true;
  if (row.client_message_id) message.clientMessageId = row.client_message_id;
  if (row.completed_at) message.completedAt = row.completed_at;
  return message;
}

function buildMeta(input: {
  mentions?: ChannelMention[];
  parts?: ChannelMessagePart[];
  truncated?: boolean;
  providerId?: string;
  extra?: ChannelMessageMeta;
}): string | null {
  assertMessageParts(input.extra?.parts);
  assertAgentDetail(input.extra?.agentDetail);
  assertMessageParts(input.parts);
  const meta: ChannelMessageMeta = { ...(input.extra ?? {}) };
  if (input.mentions && input.mentions.length > 0)
    meta.mentions = input.mentions;
  if (input.parts && input.parts.length > 0) meta.parts = input.parts;
  if (input.truncated) meta.truncated = true;
  if (input.providerId) meta['providerId'] = input.providerId;
  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
}

interface LegacyClaudeEchoAliasCandidate {
  keeper_id: string;
  duplicate_id: string;
  channel_id: string;
  keeper_item_id: string;
  duplicate_item_id: string;
  keeper_created_at: string;
  duplicate_created_at: string;
  keeper_completed_at: string;
  duplicate_completed_at: string;
}

function legacyClaudeItemBase(
  itemId: string,
  suffix: '-1' | '-0'
): string | null {
  return itemId.endsWith(suffix) ? itemId.slice(0, -suffix.length) : null;
}

/**
 * Heal only the exact pre-v2 Claude stream/echo alias observed in dogfood:
 * adjacent `...-1` then `...-0` rows whose timestamps fit the bounded dogfood
 * signature (the echo was created within 500ms and both terminal timestamps
 * were within 5ms), and whose durable content/structure are otherwise
 * identical. This is deliberately narrower than same-body/turn dedupe because
 * a turn may contain legitimate, identical assistant items.
 *
 * Deleted aliases are migration-only exceptions to the append-only runtime
 * contract. References are repointed to the earliest durable id, affected
 * channels are resequenced in-place, and persisted agent-delivery cursors are
 * translated before resequencing. Browser-local read cursors cannot be
 * translated here; full-snapshot head clamping remains their recovery lane.
 */
function healLegacyClaudeEchoAliases(db: Database.Database): number {
  const candidates = db
    .prepare(
      `SELECT keeper.id AS keeper_id,
              duplicate.id AS duplicate_id,
              keeper.channel_id AS channel_id,
              keeper.source_item_id AS keeper_item_id,
              duplicate.source_item_id AS duplicate_item_id,
              keeper.created_at AS keeper_created_at,
              duplicate.created_at AS duplicate_created_at,
              keeper.completed_at AS keeper_completed_at,
              duplicate.completed_at AS duplicate_completed_at
         FROM channel_messages keeper
         JOIN channel_messages duplicate
           ON duplicate.channel_id = keeper.channel_id
          AND duplicate.seq = keeper.seq + 1
          AND duplicate.source_session_id = keeper.source_session_id
          AND duplicate.source_turn_id = keeper.source_turn_id
          AND duplicate.sender_kind = keeper.sender_kind
          AND duplicate.sender_id = keeper.sender_id
          AND duplicate.sender_display IS keeper.sender_display
          AND duplicate.kind = keeper.kind
          AND duplicate.status = keeper.status
          AND duplicate.thread_id IS keeper.thread_id
          AND duplicate.parent_message_id IS keeper.parent_message_id
          AND duplicate.body_text = keeper.body_text
          AND duplicate.body_format = keeper.body_format
          AND duplicate.meta_json IS keeper.meta_json
        WHERE keeper.sender_kind = 'agent'
          AND keeper.sender_id = 'agent:claude'
          AND keeper.kind = 'message'
          AND keeper.status = 'complete'
          AND keeper.completed_at IS NOT NULL
          AND duplicate.completed_at IS NOT NULL
          AND keeper.source_session_id IS NOT NULL
          AND keeper.source_turn_id IS NOT NULL
          AND keeper.source_item_id GLOB '*-1'
          AND duplicate.source_item_id GLOB '*-0'`
    )
    .all() as LegacyClaudeEchoAliasCandidate[];

  const affectedChannels = new Set<string>();
  const duplicateIds = new Set<string>();
  const reparentThread = db.prepare(
    'UPDATE channel_messages SET thread_id = ? WHERE thread_id = ?'
  );
  const reparentDirect = db.prepare(
    'UPDATE channel_messages SET parent_message_id = ? WHERE parent_message_id = ?'
  );
  const deleteDuplicate = db.prepare(
    'DELETE FROM channel_messages WHERE id = ?'
  );

  for (const candidate of candidates) {
    const keeperBase = legacyClaudeItemBase(candidate.keeper_item_id, '-1');
    const duplicateBase = legacyClaudeItemBase(
      candidate.duplicate_item_id,
      '-0'
    );
    const keeperAt = Date.parse(candidate.keeper_created_at);
    const duplicateAt = Date.parse(candidate.duplicate_created_at);
    const keeperCompletedAt = Date.parse(candidate.keeper_completed_at);
    const duplicateCompletedAt = Date.parse(candidate.duplicate_completed_at);
    if (
      keeperBase === null ||
      duplicateBase === null ||
      keeperBase !== duplicateBase ||
      !Number.isFinite(keeperAt) ||
      !Number.isFinite(duplicateAt) ||
      !Number.isFinite(keeperCompletedAt) ||
      !Number.isFinite(duplicateCompletedAt) ||
      duplicateAt < keeperAt ||
      duplicateAt - keeperAt > 500 ||
      Math.abs(duplicateCompletedAt - keeperCompletedAt) > 5 ||
      duplicateIds.has(candidate.duplicate_id)
    ) {
      continue;
    }

    reparentThread.run(candidate.keeper_id, candidate.duplicate_id);
    reparentDirect.run(candidate.keeper_id, candidate.duplicate_id);
    deleteDuplicate.run(candidate.duplicate_id);
    duplicateIds.add(candidate.duplicate_id);
    affectedChannels.add(candidate.channel_id);
  }

  const selectBindings = db.prepare(
    `SELECT channel_id, agent_framework, provider_session_json
       FROM channel_agent_bindings WHERE channel_id = ?`
  );
  const translateSeq = db.prepare(
    `SELECT COUNT(*) AS count FROM channel_messages
      WHERE channel_id = ? AND seq <= ?`
  );
  const updateBinding = db.prepare(
    `UPDATE channel_agent_bindings SET provider_session_json = ?
      WHERE channel_id = ? AND agent_framework = ?`
  );
  const selectOrderedIds = db.prepare(
    'SELECT id FROM channel_messages WHERE channel_id = ? ORDER BY seq ASC'
  );
  const setSeq = db.prepare(
    'UPDATE channel_messages SET seq = ? WHERE channel_id = ? AND id = ?'
  );

  for (const channelId of affectedChannels) {
    const bindings = selectBindings.all(channelId) as Array<{
      channel_id: string;
      agent_framework: string;
      provider_session_json: string;
    }>;
    for (const binding of bindings) {
      try {
        const providerSession = JSON.parse(
          binding.provider_session_json
        ) as Record<string, unknown>;
        const cursor = providerSession['lastDeliveredSeq'];
        if (typeof cursor !== 'number' || !Number.isFinite(cursor)) continue;
        const translated = translateSeq.get(channelId, cursor) as {
          count: number;
        };
        updateBinding.run(
          JSON.stringify({
            ...providerSession,
            lastDeliveredSeq: translated.count,
          }),
          channelId,
          binding.agent_framework
        );
      } catch {
        // Invalid legacy provider state is preserved byte-for-byte; migration
        // must not turn an unrelated malformed binding into DB unavailability.
      }
    }

    const ordered = selectOrderedIds.all(channelId) as Array<{ id: string }>;
    // The negative lane avoids transient UNIQUE(channel_id, seq) collisions
    // while retaining exact order and durable message ids.
    for (const [index, row] of ordered.entries()) {
      setSeq.run(-(index + 1), channelId, row.id);
    }
    for (const [index, row] of ordered.entries()) {
      setSeq.run(index + 1, channelId, row.id);
    }
  }

  return duplicateIds.size;
}

function runMigrations(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)'
  );
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  const current = row?.version ?? 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `channel-chat.db schema ${current} is newer than supported ${SCHEMA_VERSION}`
    );
  }
  if (current < 1) {
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    })();
    return;
  }
  if (current < 2) {
    const healed = db.transaction(() => {
      // SQLite cannot widen a CHECK constraint in place. Rebuild only the
      // message table, preserving every durable row and its sequence/source
      // identity, then recreate its indexes against the replacement table.
      db.exec(`
        CREATE TABLE channel_messages_v2 (
          id                TEXT PRIMARY KEY,
          channel_id        TEXT NOT NULL,
          seq               INTEGER NOT NULL,
          kind              TEXT NOT NULL DEFAULT 'message'
                              CHECK (kind IN ('message','system')),
          status            TEXT NOT NULL DEFAULT 'complete'
                              CHECK (status IN ('streaming','complete','truncated','interrupted','failed')),
          sender_kind       TEXT NOT NULL CHECK (sender_kind IN ('human','agent','system')),
          sender_id         TEXT NOT NULL,
          sender_display    TEXT,
          thread_id         TEXT,
          parent_message_id TEXT,
          body_text         TEXT NOT NULL DEFAULT '',
          body_format       TEXT NOT NULL DEFAULT 'markdown',
          meta_json         TEXT,
          source_session_id TEXT,
          source_turn_id    TEXT,
          source_item_id    TEXT,
          client_message_id TEXT,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          completed_at      TEXT,
          UNIQUE (channel_id, seq)
        );
        INSERT INTO channel_messages_v2 (
          id, channel_id, seq, kind, status, sender_kind, sender_id, sender_display,
          thread_id, parent_message_id, body_text, body_format, meta_json,
          source_session_id, source_turn_id, source_item_id, client_message_id,
          created_at, updated_at, completed_at
        )
        SELECT
          id, channel_id, seq, kind, status, sender_kind, sender_id, sender_display,
          thread_id, parent_message_id, body_text, body_format, meta_json,
          source_session_id, source_turn_id, source_item_id, client_message_id,
          created_at, updated_at, completed_at
        FROM channel_messages;
        DROP TABLE channel_messages;
        ALTER TABLE channel_messages_v2 RENAME TO channel_messages;
      `);

      const healedCount = healLegacyClaudeEchoAliases(db);

      db.exec(`
        CREATE INDEX idx_chm_channel_seq
          ON channel_messages(channel_id, seq);
        CREATE INDEX idx_chm_thread
          ON channel_messages(thread_id, seq) WHERE thread_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_chm_source_dedupe
          ON channel_messages(source_session_id, source_turn_id, source_item_id)
          WHERE source_session_id IS NOT NULL
            AND source_turn_id IS NOT NULL
            AND source_item_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_chm_client_dedupe
          ON channel_messages(channel_id, sender_id, client_message_id)
          WHERE client_message_id IS NOT NULL;
      `);
      db.prepare('UPDATE schema_version SET version = 2').run();
      return healedCount;
    })();
    if (healed > 0) {
      logger.info(
        'channel schema v2 healed %d historical Claude echo duplicate row(s)',
        healed
      );
    }
  }
  if (current < 3) {
    db.transaction(() => {
      // Bindings used to be keyed by framework, which made two profiles of one
      // provider overwrite and reuse one another. Rebuild the small table so the
      // durable Actor id is the primary key. Every legacy row is deterministically
      // backfilled to that provider's built-in/default profile; the transaction
      // makes this fail-safe and an already-complete v3 reopen a no-op.
      db.exec(`
        CREATE TABLE channel_agent_bindings_v3 (
          channel_id            TEXT NOT NULL,
          profile_actor_id      TEXT NOT NULL,
          agent_framework       TEXT NOT NULL,
          session_id            TEXT,
          provider_session_json TEXT NOT NULL DEFAULT '{}',
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL,
          PRIMARY KEY (channel_id, profile_actor_id)
        );
        INSERT INTO channel_agent_bindings_v3
          (channel_id, profile_actor_id, agent_framework, session_id,
           provider_session_json, created_at, updated_at)
        SELECT channel_id,
               'agent-profile:' || agent_framework || ':default',
               agent_framework,
               session_id,
               provider_session_json,
               created_at,
               updated_at
          FROM channel_agent_bindings;
        DROP TABLE channel_agent_bindings;
        ALTER TABLE channel_agent_bindings_v3 RENAME TO channel_agent_bindings;
      `);
      db.prepare('UPDATE schema_version SET version = 3').run();
    })();
  }
  if (current < 4) {
    db.transaction(() => {
      db.exec(
        'ALTER TABLE channel_agent_bindings RENAME COLUMN session_id TO runtime_id'
      );
      db.prepare('UPDATE schema_version SET version = 4').run();
    })();
  }
  if (current < 5) {
    db.transaction(() => {
      db.exec(
        'ALTER TABLE channel_messages RENAME COLUMN source_session_id TO source_runtime_id'
      );
      db.prepare('UPDATE schema_version SET version = 5').run();
    })();
  }
}

export function initChannelMessageStore(
  configDir: string
): ChannelMessageStore {
  return createChannelMessageStore(path.join(configDir, 'channel-chat.db'));
}

export function createChannelMessageStore(dbPath: string): ChannelMessageStore {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }

  // Point reads can be emitted directly on the WS lane (stream finalization and
  // catch-up replacement), so they must carry the same derived replyCount as a
  // timeline history row. Otherwise a replace-by-id reducer can erase a count
  // that was already visible to the client.
  const selectById = db.prepare(
    `SELECT m.*,
            ${replyCountSql('m')} AS reply_count
     FROM channel_messages m WHERE m.id = ?`
  );
  const selectBySource = db.prepare(
    `SELECT m.*, ${replyCountSql('m')} AS reply_count
       FROM channel_messages m
      WHERE m.source_runtime_id IS @runtimeId
        AND m.source_turn_id IS @turnId
        AND m.source_item_id IS @itemId`
  );
  const selectByClientId = db.prepare(
    `SELECT m.*, ${replyCountSql('m')} AS reply_count
       FROM channel_messages m
      WHERE m.channel_id = @channelId AND m.sender_id = @senderId
        AND m.client_message_id = @clientMessageId`
  );

  // Single atomic INSERT: seq is allocated inside the same statement via
  // SELECT COALESCE(MAX(seq),0)+1. SQLite takes the write lock for the whole
  // statement (incl. the subquery), so concurrent inserts serialize correctly;
  // UNIQUE(channel_id, seq) is the loud backstop for any residual race
  // (dev/prod config-dir overlap) — a constraint failure, never a silent reorder.
  const insertMessageSql = `INSERT INTO channel_messages (
       id, channel_id, seq, kind, status, sender_kind, sender_id, sender_display,
       thread_id, parent_message_id, body_text, body_format, meta_json,
       source_runtime_id, source_turn_id, source_item_id, client_message_id,
       created_at, updated_at, completed_at
     ) VALUES (
       @id, @channelId,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM channel_messages WHERE channel_id = @channelId),
       @kind, @status, @senderKind, @senderId, @senderDisplay,
       @threadId, @parentMessageId, @bodyText, @bodyFormat, @metaJson,
       @sourceRuntimeId, @sourceTurnId, @sourceItemId, @clientMessageId,
       @createdAt, @updatedAt, @completedAt
     )`;
  const insertMessage = db.prepare(insertMessageSql);
  const insertSourceMessage = db.prepare(
    `${insertMessageSql}
     ON CONFLICT(source_runtime_id, source_turn_id, source_item_id)
       WHERE source_runtime_id IS NOT NULL
         AND source_turn_id IS NOT NULL
         AND source_item_id IS NOT NULL
     DO NOTHING`
  );

  function insertRow(params: Record<string, unknown>): ChannelMessageRow {
    try {
      insertMessage.run(params);
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new ChannelMessageStoreError(
          409,
          'channel_message_seq_conflict',
          'channel message seq/uniqueness conflict',
          { id: params['id'] }
        );
      }
      throw error;
    }
    return selectById.get(params['id']) as ChannelMessageRow;
  }

  function insertSourceRow(params: Record<string, unknown>): ChannelMessageRow {
    try {
      const result = insertSourceMessage.run(params);
      if (result.changes > 0) {
        return selectById.get(params['id']) as ChannelMessageRow;
      }
      const existing = selectBySource.get({
        runtimeId: params['sourceRuntimeId'],
        turnId: params['sourceTurnId'],
        itemId: params['sourceItemId'],
      }) as ChannelMessageRow | undefined;
      if (existing) return existing;
      throw new Error('source-dedupe insert ignored without an existing row');
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new ChannelMessageStoreError(
          409,
          'channel_message_seq_conflict',
          'channel message seq/uniqueness conflict',
          { id: params['id'] }
        );
      }
      throw error;
    }
  }

  function resolveThread(
    channelId: string,
    parentMessageId: string | undefined
  ): string | null {
    if (!parentMessageId) return null;
    const parent = selectById.get(parentMessageId) as
      | ChannelMessageRow
      | undefined;
    if (!parent) {
      throw new ChannelMessageStoreError(
        404,
        'parent_message_not_found',
        'parent message not found',
        { parentMessageId }
      );
    }
    if (parent.channel_id !== channelId) {
      throw new ChannelMessageStoreError(
        409,
        'parent_channel_mismatch',
        'parent message belongs to another channel',
        { parentMessageId, parentChannelId: parent.channel_id, channelId }
      );
    }
    return parent.thread_id ?? parent.id;
  }

  const upsertMemberStmt = db.prepare(
    `INSERT INTO channel_members (channel_id, member_kind, member_id, joined_at, metadata_json)
     VALUES (@channelId, @memberKind, @memberId, @joinedAt, @metadataJson)
     ON CONFLICT(channel_id, member_kind, member_id) DO UPDATE SET
       metadata_json = excluded.metadata_json`
  );
  const listMembersStmt = db.prepare(
    'SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at ASC, member_id ASC'
  );
  // Compiled once: `GET /channels` runs this per channel per list fetch.
  const threadSummaryStmt = db.prepare(buildChannelThreadSummarySql());

  function memberRowToRef(row: MemberRow): ChannelMemberRef {
    return {
      kind: row.member_kind as 'human' | 'agent',
      id: row.member_id,
      joinedAt: row.joined_at,
    };
  }

  function getMessageById(id: string): ChannelMessage | null {
    const row = selectById.get(id) as ChannelMessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  function appendCompleteImpl(input: AppendCompleteInput): ChannelMessage {
    assertMessagePayloadSize(input.text, input.meta?.agentDetail);
    assertMessageParts(input.parts);
    assertMessageParts(input.meta?.parts);
    if (input.clientMessageId) {
      const existing = selectByClientId.get({
        channelId: input.channelId,
        senderId: input.sender.id,
        clientMessageId: input.clientMessageId,
      }) as ChannelMessageRow | undefined;
      if (existing) return rowToMessage(existing);
    }
    const threadId = resolveThread(input.channelId, input.parentMessageId);
    const now = nowIso();
    const id = createMessageId();
    const row = insertRow({
      id,
      channelId: input.channelId,
      kind: input.kind ?? 'message',
      status: 'complete',
      senderKind: input.sender.kind,
      senderId: input.sender.id,
      senderDisplay: input.sender.displayName ?? null,
      threadId,
      parentMessageId: input.parentMessageId ?? null,
      bodyText: input.text,
      bodyFormat: input.format ?? 'markdown',
      metaJson: buildMeta({
        ...(input.mentions ? { mentions: input.mentions } : {}),
        ...(input.parts ? { parts: input.parts } : {}),
        ...(input.sender.providerId
          ? { providerId: input.sender.providerId }
          : {}),
        ...(input.meta ? { extra: input.meta } : {}),
      }),
      sourceRuntimeId: input.source?.runtimeId ?? null,
      sourceTurnId: null,
      sourceItemId: null,
      clientMessageId: input.clientMessageId ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    return rowToMessage(row);
  }

  function getBindingImpl(
    channelId: string,
    profileActorId: string
  ): ChannelBinding | null {
    const select = db.prepare(
      'SELECT * FROM channel_agent_bindings WHERE channel_id = ? AND profile_actor_id = ?'
    );
    const row = select.get(channelId, profileActorId) as BindingRow | undefined;
    return row ? bindingRowToRecord(row) : null;
  }

  return {
    close() {
      db.close();
    },

    appendComplete(input) {
      return appendCompleteImpl(input);
    },

    beginStream(input) {
      // Fast replay path; the INSERT ... ON CONFLICT below is the atomic
      // cross-handle/process backstop when two writers observe a miss together.
      const existing = selectBySource.get({
        runtimeId: input.source.runtimeId,
        turnId: input.source.turnId ?? null,
        itemId: input.source.itemId ?? null,
      }) as ChannelMessageRow | undefined;
      if (existing) return rowToMessage(existing);

      const initialText = input.text ?? '';
      assertMessagePayloadSize(initialText, input.agentDetail);
      assertMessageParts(input.parts);
      const threadId = resolveThread(input.channelId, input.parentMessageId);
      const now = nowIso();
      const id = createMessageId();
      const row = insertSourceRow({
        id,
        channelId: input.channelId,
        kind: 'message',
        status: 'streaming',
        senderKind: input.sender.kind,
        senderId: input.sender.id,
        senderDisplay: input.sender.displayName ?? null,
        threadId,
        parentMessageId: input.parentMessageId ?? null,
        bodyText: initialText,
        bodyFormat: 'markdown',
        metaJson: buildMeta({
          ...(input.mentions ? { mentions: input.mentions } : {}),
          ...(input.parts ? { parts: input.parts } : {}),
          ...(input.agentDetail
            ? { extra: { agentDetail: input.agentDetail } }
            : {}),
          ...(input.sender.providerId
            ? { providerId: input.sender.providerId }
            : {}),
        }),
        sourceRuntimeId: input.source.runtimeId,
        sourceTurnId: input.source.turnId ?? null,
        sourceItemId: input.source.itemId ?? null,
        clientMessageId: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      });
      return rowToMessage(row);
    },

    updateStreamText(id, text) {
      const row = selectById.get(id) as ChannelMessageRow | undefined;
      if (!row) return null;
      assertMessagePayloadSize(text, parseMeta(row.meta_json)?.agentDetail);
      db.prepare(
        'UPDATE channel_messages SET body_text = @text, updated_at = @now WHERE id = @id'
      ).run({ id, text, now: nowIso() });
      return getMessageById(id);
    },

    updateAgentDetail(id, detail) {
      const row = selectById.get(id) as ChannelMessageRow | undefined;
      if (!row) return null;
      assertMessagePayloadSize(row.body_text, detail);
      const meta = parseMeta(row.meta_json) ?? {};
      meta.agentDetail = detail;
      db.prepare(
        `UPDATE channel_messages
         SET meta_json = @metaJson, updated_at = @now
         WHERE id = @id AND status = 'streaming'`
      ).run({
        id,
        metaJson: JSON.stringify(meta),
        now: nowIso(),
      });
      return getMessageById(id);
    },

    resolveProvisionalAgentDetailTerminal(id, input) {
      const row = selectById.get(id) as ChannelMessageRow | undefined;
      if (!row) return { message: null, transitioned: false };
      const currentMeta = parseMeta(row.meta_json) ?? {};
      if (currentMeta.agentDetailTerminalAuthority !== 'provisional') {
        return { message: rowToMessage(row), transitioned: false };
      }
      assertMessagePayloadSize(input.text, input.agentDetail);
      const meta: ChannelMessageMeta = {
        ...currentMeta,
        agentDetail: input.agentDetail,
        agentDetailTerminalAuthority: 'explicit',
      };
      delete meta.truncationReason;
      delete meta.truncated;
      const now = nowIso();
      const result = db
        .prepare(
          `UPDATE channel_messages
           SET body_text = @text, status = @status, meta_json = @metaJson,
               updated_at = @now, completed_at = @now
           WHERE id = @id
             AND status != 'streaming'
             AND json_extract(meta_json, '$.agentDetailTerminalAuthority') = 'provisional'`
        )
        .run({
          id,
          text: input.text,
          status: input.status,
          metaJson: JSON.stringify(meta),
          now,
        });
      return {
        message: getMessageById(id),
        transitioned: result.changes === 1,
      };
    },

    finalizeStream(id, input) {
      const row = selectById.get(id) as ChannelMessageRow | undefined;
      if (!row) return null;
      // Idempotent replay: finalizing an already-final row is a no-op.
      if (row.status !== 'streaming') return rowToMessage(row);
      assertMessagePayloadSize(
        input.text,
        input.agentDetail ?? parseMeta(row.meta_json)?.agentDetail
      );
      const now = nowIso();
      const meta = parseMeta(row.meta_json) ?? {};
      if (input.agentDetail) {
        assertAgentDetail(input.agentDetail);
        meta.agentDetail = input.agentDetail;
      }
      if (input.agentDetailTerminalAuthority) {
        meta.agentDetailTerminalAuthority = input.agentDetailTerminalAuthority;
      }
      const truncationReason =
        input.truncationReason ??
        (input.truncated
          ? 'size-limit'
          : input.status === 'truncated'
            ? 'missing-terminal'
            : undefined);
      if (truncationReason) meta.truncationReason = truncationReason;
      // Existing clients render this boolean as "256kb limit", so lifecycle
      // loss must never set it. The typed reason remains available in meta.
      if (truncationReason === 'size-limit') meta.truncated = true;
      else delete meta.truncated;
      db.prepare(
        `UPDATE channel_messages
         SET body_text = @text, status = @status, meta_json = @metaJson,
             updated_at = @now, completed_at = @now
         WHERE id = @id`
      ).run({
        id,
        text: input.text,
        status: input.status,
        metaJson:
          Object.keys(meta).length > 0 ? JSON.stringify(meta) : row.meta_json,
        now,
      });
      return getMessageById(id);
    },

    editMessage(input) {
      const row = selectById.get(input.messageId) as
        | ChannelMessageRow
        | undefined;
      // Channel mismatch is reported as absence, not as a conflict: the caller
      // proved access to ONE channel, so it must not learn that an id it does
      // not own exists somewhere else.
      if (!row || row.channel_id !== input.channelId) {
        throw new ChannelMessageStoreError(
          404,
          'channel_message_not_found',
          'message not found in this channel',
          { channelId: input.channelId, messageId: input.messageId }
        );
      }
      if (
        row.kind !== 'message' ||
        row.sender_kind !== 'human' ||
        row.status !== 'complete' ||
        row.sender_id !== input.editorId
      ) {
        throw new ChannelMessageStoreError(
          409,
          'channel_message_not_editable',
          'only the operator’s own completed messages can be edited',
          {
            channelId: input.channelId,
            messageId: input.messageId,
            kind: row.kind,
            senderKind: row.sender_kind,
            status: row.status,
          }
        );
      }
      if (input.text.length === 0) {
        throw new ChannelMessageStoreError(
          400,
          'channel_message_body_empty',
          'edited message text must not be empty'
        );
      }
      assertMessagePayloadSize(
        input.text,
        parseMeta(row.meta_json)?.agentDetail
      );
      const now = nowIso();
      const meta = parseMeta(row.meta_json) ?? {};
      // Mentions are a projection of the body, so a stale set would outlive the
      // text that justified it (a removed @claude would keep lighting the
      // sidebar's mention lane). Re-parsed refs are stored; routing is NOT
      // re-run — the edit path never reaches the binder.
      if (input.mentions !== undefined) {
        if (input.mentions.length > 0) meta.mentions = input.mentions;
        else delete meta.mentions;
      }
      meta[CHANNEL_EDITED_AT_META_KEY] = now;
      db.prepare(
        `UPDATE channel_messages
         SET body_text = @text, meta_json = @metaJson, updated_at = @now
         WHERE id = @id`
      ).run({
        id: input.messageId,
        text: input.text,
        metaJson: JSON.stringify(meta),
        now,
      });
      const updated = getMessageById(input.messageId);
      if (!updated) {
        throw new ChannelMessageStoreError(
          404,
          'channel_message_not_found',
          'message not found in this channel',
          { channelId: input.channelId, messageId: input.messageId }
        );
      }
      return updated;
    },

    getMessage(id) {
      return getMessageById(id);
    },

    findByClientMessage(channelId, senderId, clientMessageId) {
      const row = selectByClientId.get({
        channelId,
        senderId,
        clientMessageId,
      }) as ChannelMessageRow | undefined;
      return row ? rowToMessage(row) : null;
    },

    history(channelId, filter = {}) {
      const limit = cleanLimit(filter.limit);
      const clauses = ['m.channel_id = @channelId'];
      const params: Record<string, unknown> = { channelId, limit };
      if (filter.threadId) {
        clauses.push('m.thread_id = @threadId');
        params['threadId'] = filter.threadId;
      }
      if (typeof filter.afterSeq === 'number') {
        clauses.push('m.seq > @afterSeq');
        params['afterSeq'] = filter.afterSeq;
        const rows = db
          .prepare(
            `SELECT m.*,
                    ${replyCountSql('m')} AS reply_count
             FROM channel_messages m WHERE ${clauses.join(' AND ')}
             ORDER BY m.seq ASC LIMIT @limit`
          )
          .all(params) as ChannelMessageRow[];
        return rows.map(rowToMessage);
      }
      if (typeof filter.beforeSeq === 'number') {
        clauses.push('m.seq < @beforeSeq');
        params['beforeSeq'] = filter.beforeSeq;
      }
      // Default + beforeSeq: newest `limit` rows, returned seq-ascending.
      const rows = db
        .prepare(
          `SELECT m.*,
                  ${replyCountSql('m')} AS reply_count
           FROM channel_messages m WHERE ${clauses.join(' AND ')}
           ORDER BY m.seq DESC LIMIT @limit`
        )
        .all(params) as ChannelMessageRow[];
      return rows.reverse().map(rowToMessage);
    },

    threadHistory(channelId, rootMessageId, filter = {}) {
      const root = selectById.get(rootMessageId) as
        | ChannelMessageRow
        | undefined;
      if (!root) {
        throw new ChannelMessageStoreError(
          404,
          'thread_root_not_found',
          'thread root message not found',
          { rootMessageId }
        );
      }
      if (root.channel_id !== channelId) {
        throw new ChannelMessageStoreError(
          409,
          'thread_root_channel_mismatch',
          'thread root message belongs to another channel',
          { rootMessageId, rootChannelId: root.channel_id, channelId }
        );
      }
      if (root.thread_id !== null) {
        throw new ChannelMessageStoreError(
          400,
          'thread_root_required',
          'rootMessageId must identify a thread root',
          { rootMessageId, canonicalRootMessageId: root.thread_id }
        );
      }

      // Router pagination asks for one lookahead row, hence MAX + 1 here while
      // the public page size remains capped at CHANNEL_HISTORY_MAX_LIMIT.
      const limit = cleanLimit(filter.limit, CHANNEL_HISTORY_MAX_LIMIT + 1);
      const params: Record<string, unknown> = {
        channelId,
        rootMessageId,
        limit,
      };
      let queryMode: ChannelThreadHistoryQueryMode = 'default';
      if (typeof filter.afterSeq === 'number') {
        params['afterSeq'] = filter.afterSeq;
        queryMode = 'after';
      } else if (typeof filter.beforeSeq === 'number') {
        params['beforeSeq'] = filter.beforeSeq;
        queryMode = 'before';
      }

      // Keep the root-inclusive contract without an OR predicate. The root is
      // a single primary-key probe and replies are an idx_chm_thread range;
      // thread reads therefore scale with thread size, not channel size.
      const rows = db
        .prepare(buildChannelThreadHistorySql(queryMode))
        .all(params) as ChannelMessageRow[];
      if (queryMode !== 'after') rows.reverse();
      return rows.map(rowToMessage);
    },

    listResyncRows(channelId, uptoSeq, limit) {
      const bounded = Math.max(1, Math.min(1000, Math.floor(limit)));
      const rows = db
        .prepare(
          `SELECT m.*,
                  ${replyCountSql('m')} AS reply_count
             FROM channel_messages m
            WHERE m.channel_id = @channelId AND m.seq <= @uptoSeq
              AND (m.source_runtime_id IS NOT NULL
                   OR json_extract(m.meta_json, '$.${CHANNEL_EDITED_AT_META_KEY}') IS NOT NULL)
            ORDER BY m.seq DESC LIMIT @limit`
        )
        .all({ channelId, uptoSeq, limit: bounded }) as ChannelMessageRow[];
      return rows.reverse().map(rowToMessage);
    },

    latestSeq(channelId) {
      const row = db
        .prepare(
          'SELECT COALESCE(MAX(seq), 0) AS latest FROM channel_messages WHERE channel_id = ?'
        )
        .get(channelId) as { latest: number };
      return row.latest;
    },

    listChannelSummaries() {
      const rows = db
        .prepare(
          `SELECT last.* FROM (
             SELECT channel_id, MAX(seq) AS max_seq
             FROM channel_messages GROUP BY channel_id
           ) agg
           JOIN channel_messages last
             ON last.channel_id = agg.channel_id AND last.seq = agg.max_seq
           ORDER BY last.updated_at DESC`
        )
        .all() as Array<ChannelMessageRow & { cnt?: number }>;
      // Newest prose row per channel — the summary preview reads from this so a
      // turn ending on a detail card (body_text='') does not blank the sidebar.
      const previewRows = new Map<string, ChannelMessageRow>();
      for (const row of db
        .prepare(
          `SELECT prose.* FROM (
             SELECT channel_id, MAX(seq) AS max_seq
             FROM channel_messages
             WHERE json_extract(meta_json, '$.agentDetail') IS NULL
             GROUP BY channel_id
           ) agg
           JOIN channel_messages prose
             ON prose.channel_id = agg.channel_id AND prose.seq = agg.max_seq`
        )
        .all() as ChannelMessageRow[]) {
        previewRows.set(row.channel_id, row);
      }
      // Second pass for counts keyed by channel (kept explicit for clarity).
      const counts = new Map<string, number>();
      for (const c of db
        .prepare(
          `SELECT channel_id, COUNT(*) AS cnt
             FROM channel_messages GROUP BY channel_id`
        )
        .all() as Array<{ channel_id: string; cnt: number }>) {
        counts.set(c.channel_id, c.cnt);
      }
      return rows.map((row) =>
        summaryFromLastRow(
          row.seq,
          previewRows.get(row.channel_id) ?? row,
          counts.get(row.channel_id) ?? 0
        )
      );
    },

    getChannelSummary(channelId) {
      const last = db
        .prepare(
          `SELECT * FROM channel_messages WHERE channel_id = ?
           ORDER BY seq DESC LIMIT 1`
        )
        .get(channelId) as ChannelMessageRow | undefined;
      const count = (
        db
          .prepare(
            `SELECT COUNT(*) AS cnt
               FROM channel_messages WHERE channel_id = ?`
          )
          .get(channelId) as { cnt: number }
      ).cnt;
      if (!last) {
        return { channelId, latestSeq: 0, messageCount: 0, lastMessage: null };
      }
      // Preview from the newest prose row; detail cards persist body_text=''.
      const previewRow =
        (db
          .prepare(
            `SELECT * FROM channel_messages WHERE channel_id = ?
               AND json_extract(meta_json, '$.agentDetail') IS NULL
             ORDER BY seq DESC LIMIT 1`
          )
          .get(channelId) as ChannelMessageRow | undefined) ?? last;
      return summaryFromLastRow(last.seq, previewRow, count);
    },

    listChannelThreadSummaries(
      channelId,
      limit = CHANNEL_THREAD_SUMMARY_LIMIT
    ) {
      const capped = Math.max(
        1,
        Math.min(CHANNEL_THREAD_SUMMARY_MAX_LIMIT, Math.floor(limit))
      );
      // Channel-scoped through idx_chm_channel_seq (see the query-plan test), so
      // this walks the same rows the summary's COUNT(*) already does rather than
      // the whole thread index.
      const rows = threadSummaryStmt.all({
        channelId,
        limit: capped,
      }) as ThreadSummaryRow[];
      return {
        threads: rows.map((row) => {
          const meta = parseMeta(row.root_meta_json);
          const providerId =
            typeof meta?.['providerId'] === 'string'
              ? (meta['providerId'] as string)
              : undefined;
          return {
            rootMessageId: row.root_id as ChannelMessageId,
            replyCount: row.reply_count,
            lastReplyAt: row.last_reply_at,
            preview: row.root_body.slice(0, CHANNEL_SUMMARY_PREVIEW_MAX_CHARS),
            rootSenderId: row.root_sender_id,
            rootSenderKind: row.root_sender_kind as ChannelSenderKindLoose,
            ...(row.root_sender_display
              ? { rootSenderDisplayName: row.root_sender_display }
              : {}),
            ...(providerId ? { providerId } : {}),
          };
        }),
        // Every joined row shares the same window total; zero rows means zero
        // threads with a resolvable root, which is what the page can show.
        threadCount: rows[0]?.thread_total ?? 0,
      };
    },

    upsertMember(input) {
      const joinedAt = nowIso();
      const existing = (
        listMembersStmt.all(input.channelId) as MemberRow[]
      ).find(
        (row) => row.member_kind === input.kind && row.member_id === input.id
      );
      upsertMemberStmt.run({
        channelId: input.channelId,
        memberKind: input.kind,
        memberId: input.id,
        joinedAt: existing?.joined_at ?? joinedAt,
        metadataJson: JSON.stringify(input.metadata ?? {}),
      });
      return {
        kind: input.kind,
        id: input.id,
        joinedAt: existing?.joined_at ?? joinedAt,
      };
    },

    listMembers(channelId) {
      return (listMembersStmt.all(channelId) as MemberRow[]).map(
        memberRowToRef
      );
    },

    findDmChannel(memberIdA, memberIdB) {
      const row = db
        .prepare(
          `SELECT channel_id FROM channel_members
           GROUP BY channel_id
           HAVING COUNT(*) = 2
             AND SUM(CASE WHEN member_id = @a THEN 1 ELSE 0 END) = 1
             AND SUM(CASE WHEN member_id = @b THEN 1 ELSE 0 END) = 1
           LIMIT 1`
        )
        .get({ a: memberIdA, b: memberIdB }) as
        | { channel_id: string }
        | undefined;
      return row?.channel_id ?? null;
    },

    getBinding(channelId, profileActorId) {
      return getBindingImpl(channelId, profileActorId);
    },

    upsertBinding(input) {
      const now = nowIso();
      const profileActorId = input.profileActorId;
      const existing = db
        .prepare(
          'SELECT * FROM channel_agent_bindings WHERE channel_id = ? AND profile_actor_id = ?'
        )
        .get(input.channelId, profileActorId) as BindingRow | undefined;
      const providerSessionJson = JSON.stringify(
        input.providerSession ??
          (existing ? JSON.parse(existing.provider_session_json) : {})
      );
      db.prepare(
        `INSERT INTO channel_agent_bindings
           (channel_id, profile_actor_id, agent_framework, runtime_id, provider_session_json, created_at, updated_at)
         VALUES (@channelId, @profileActorId, @agentFramework, @runtimeId, @providerSessionJson, @createdAt, @updatedAt)
         ON CONFLICT(channel_id, profile_actor_id) DO UPDATE SET
           agent_framework = excluded.agent_framework,
           runtime_id = excluded.runtime_id,
           provider_session_json = excluded.provider_session_json,
           updated_at = excluded.updated_at`
      ).run({
        channelId: input.channelId,
        profileActorId,
        agentFramework: input.agentFramework,
        runtimeId:
          input.runtimeId !== undefined
            ? input.runtimeId
            : (existing?.runtime_id ?? null),
        providerSessionJson,
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
      });
      return getBindingImpl(input.channelId, profileActorId)!;
    },

    sweepStaleStreaming() {
      const channels = db
        .prepare(
          "SELECT DISTINCT channel_id FROM channel_messages WHERE status = 'streaming'"
        )
        .all() as Array<{ channel_id: string }>;
      const results: StaleStreamSweepResult[] = [];
      for (const { channel_id: channelId } of channels) {
        const stale = db
          .prepare(
            "SELECT id, meta_json FROM channel_messages WHERE channel_id = ? AND status = 'streaming'"
          )
          .all(channelId) as Array<{ id: string; meta_json: string | null }>;
        const now = nowIso();
        const finalizeRestart = db.prepare(
          `UPDATE channel_messages
           SET status = 'truncated', meta_json = @metaJson,
               updated_at = @now, completed_at = @now
           WHERE id = @id AND status = 'streaming'`
        );
        db.transaction(() => {
          for (const row of stale) {
            const meta = parseMeta(row.meta_json) ?? {};
            meta.truncationReason = 'restart';
            if (isChannelAgentDetail(meta.agentDetail)) {
              meta.agentDetail = {
                ...meta.agentDetail,
                card: { ...meta.agentDetail.card, status: 'cancelled' },
              };
              meta.agentDetailTerminalAuthority = 'provisional';
            }
            // Never surface restart loss as the legacy 256KB-limit marker.
            delete meta.truncated;
            finalizeRestart.run({
              id: row.id,
              metaJson: JSON.stringify(meta),
              now,
            });
          }
        })();
        const systemMessage = appendCompleteImpl({
          channelId,
          kind: 'system',
          sender: { kind: 'system', id: 'system' },
          text: 'Agent reply truncated because Relay restarted before terminal output.',
        });
        results.push({
          channelId,
          truncatedIds: stale.map((s) => s.id as ChannelMessageId),
          systemMessage,
        });
      }
      return results;
    },

    sweepOrphans(persistedTopicIds) {
      const channelIds = new Set<string>();
      for (const table of [
        'channel_messages',
        'channel_members',
        'channel_agent_bindings',
      ]) {
        for (const row of db
          .prepare(`SELECT DISTINCT channel_id FROM ${table}`)
          .all() as Array<{ channel_id: string }>) {
          channelIds.add(row.channel_id);
        }
      }
      const orphans = [...channelIds].filter(
        (id) => !persistedTopicIds.has(id)
      );
      let messagesDeleted = 0;
      const deleteTx = db.transaction((ids: string[]) => {
        for (const id of ids) {
          messagesDeleted +=
            db
              .prepare('DELETE FROM channel_messages WHERE channel_id = ?')
              .run(id).changes ?? 0;
          db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(
            id
          );
          db.prepare(
            'DELETE FROM channel_agent_bindings WHERE channel_id = ?'
          ).run(id);
        }
      });
      deleteTx(orphans);
      return { channelsDeleted: orphans, messagesDeleted };
    },
  };

  // `latestSeq` stays the true highest seq (drives reconnect head-checks and
  // unread math), while the preview is drawn from `previewRow` — the newest row
  // that carries prose. Detail cards persist body_text='', so previewing off the
  // literal last row blanks the summary whenever a turn ends on a card.
  function summaryFromLastRow(
    latestSeq: number,
    previewRow: ChannelMessageRow,
    messageCount: number
  ): ChannelSummary {
    const meta = parseMeta(previewRow.meta_json);
    const providerId =
      typeof meta?.['providerId'] === 'string'
        ? (meta['providerId'] as string)
        : undefined;
    const mentions = summaryMentions(previewRow, meta);
    return {
      channelId: previewRow.channel_id,
      latestSeq,
      messageCount,
      lastMessage: {
        id: previewRow.id as ChannelMessageId,
        seq: previewRow.seq,
        preview: previewRow.body_text.slice(
          0,
          CHANNEL_SUMMARY_PREVIEW_MAX_CHARS
        ),
        senderId: previewRow.sender_id,
        senderKind: previewRow.sender_kind as ChannelSenderRef['kind'],
        ...(previewRow.sender_display
          ? { senderDisplayName: previewRow.sender_display }
          : {}),
        ...(providerId ? { providerId } : {}),
        ...(mentions.length > 0 ? { mentions } : {}),
        status: previewRow.status as ChannelMessageStatus,
        createdAt: previewRow.created_at,
      },
    };
  }

  /**
   * Mention refs for a summary row. Persisted mentions win — they are the
   * server-resolved set (contact-set resolution a plain re-parse cannot
   * reproduce). Rows written without them (every bridge-authored agent row) get
   * a bounded parse of the full body so a mention past the preview cut-off is
   * not silently lost.
   */
  function summaryMentions(
    previewRow: ChannelMessageRow,
    meta: ChannelMessageMeta | undefined
  ): ChannelMention[] {
    if (Array.isArray(meta?.mentions) && meta.mentions.length > 0) {
      return meta.mentions;
    }
    if (!previewRow.body_text.includes('@')) return [];
    return parseMentions(
      previewRow.body_text.slice(0, CHANNEL_SUMMARY_MENTION_SCAN_MAX_CHARS)
    );
  }
}

function bindingRowToRecord(row: BindingRow): ChannelBinding {
  let providerSession: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.provider_session_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      providerSession = parsed as Record<string, unknown>;
    }
  } catch {
    providerSession = {};
  }
  return {
    channelId: row.channel_id,
    profileActorId: row.profile_actor_id,
    agentFramework: row.agent_framework,
    runtimeId: row.runtime_id,
    providerSession,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
