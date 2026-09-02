import * as crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createLogger } from './logger.js';
import {
  AGENT_PROFILE_ID_PREFIX,
  builtInAgentProfileId,
  parseAgentProfileProviderId,
} from '../shared/agent-profile.js';
import type { AgentRole } from '../shared/agent-roster.js';

import {
  CHANNEL_CHAT_PROTOCOL_VERSION,
  CHANNEL_AGENT_DETAIL_MAX_BYTES,
  CHANNEL_AGENT_ATTRIBUTION_MAX_CHARS,
  CHANNEL_DELETED_AT_META_KEY,
  CHANNEL_EDITED_AT_META_KEY,
  CHANNEL_MESSAGE_BODY_MAX_BYTES,
  CHANNEL_MESSAGE_MAX_IMAGE_PARTS,
  CHANNEL_SEARCH_HIGHLIGHT_CLOSE,
  CHANNEL_SEARCH_HIGHLIGHT_OPEN,
  CHANNEL_SEARCH_MAX_RESULTS,
  CHANNEL_SEARCH_MIN_QUERY_CHARS,
  CHANNEL_SEARCH_PREFIX_DOC_BUDGET,
  CHANNEL_SEARCH_PREFIX_TERM_BUDGET,
  CHANNEL_SEARCH_QUERY_MAX_CHARS,
  CHANNEL_SEARCH_SNIPPET_ELLIPSIS,
  CHANNEL_SEARCH_TIME_BUDGET_MS,
  isChannelMessagePart,
  isChannelAgentDetail,
  parseMentions,
  type ChannelAgentDetail,
  type ChannelAgentAttribution,
  type ChannelAsyncRun,
  type ChannelAsyncRunId,
  type ChannelAsyncRunState,
  type ChannelAsyncRunTarget,
  type ChannelAsyncRunTargetState,
  type ChannelAsyncRunApprovalState,
  type ChannelMessageSearchHit,
  type ChannelSearchUnavailableReason,
  type ChannelBodyFormat,
  CHANNEL_MEMBERSHIP_BACKFILL_INVITER,
  CHANNEL_MEMBERSHIP_BINDING_INVITER,
  canonicalChannelMemberId,
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
//    gap-free seq. `editMessage` (#1308 slice 1 item 3) and `deleteMessage`
//    (item 4, a tombstone) are the sanctioned shapes: the SAME row keeps its
//    id/seq/createdAt and only its body/meta change, so every seq cursor,
//    catch-up window, and thread parent stays valid. Nothing in this file may
//    ever issue `DELETE FROM channel_messages` for an operator action.

const SCHEMA_VERSION = 18;
const ASYNC_RUN_SETTLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
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
export const CHANNEL_THREAD_TITLE_MAX_CHARS = 160;
const DEFAULT_THREAD_TITLE = 'untitled conversation';

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

export type ChannelMentionContextScope = 'channel' | 'thread';

/** Raw candidate window per semantic statement: 16× the packet row budget. */
export const MENTION_CONTEXT_CANDIDATE_SCAN_BUDGET = 256;

/**
 * Indexed lookahead that finds the exclusive lower seq bound for a candidate
 * window. One OFFSET read examines at most budget + 1 index entries; each
 * subsequent count/row statement is constrained to at most the newest budget
 * entries (at most `3 * budget + 1` visits across the three statements).
 *
 * Both scopes open the window at the caller's delivery cursor (#1408). A thread
 * probe that started at seq 0 counted every reply ever posted to the thread
 * toward the budget, so `candidateScanTruncated` reported truncation of history
 * the caller had already been delivered.
 */
export function buildChannelMentionContextBoundarySql(
  scope: ChannelMentionContextScope
): string {
  if (scope === 'thread') {
    return `SELECT reply.seq
              FROM channel_messages reply INDEXED BY idx_chm_thread
             WHERE reply.thread_id = @threadRootId
               AND reply.seq > @afterSeq
               AND reply.seq < @triggerSeq
             ORDER BY reply.seq DESC
             LIMIT 1 OFFSET @candidateBudget`;
  }
  return `SELECT channel_row.seq
            FROM channel_messages channel_row INDEXED BY idx_chm_channel_seq
           WHERE channel_row.channel_id = @channelId
             AND channel_row.seq > @afterSeq
             AND channel_row.seq < @triggerSeq
           ORDER BY channel_row.seq DESC
           LIMIT 1 OFFSET @candidateBudget`;
}

/**
 * Exact summary + bounded-row query used by mention delivery (#1358).
 *
 * Both builders deliberately share the same candidate/eligibility predicates.
 * The caller first narrows the range to the newest deterministic candidate
 * budget; counts are exact within that window and carry an explicit truncation
 * bit when older candidates exist. Activity rows cost no JS allocations and
 * cannot make either SQL query scan an unbounded cursor range.
 *
 * Thread scope honours the same `@afterSeq` delivery cursor channel scope does
 * (#1408). The root is structural rather than conversational, so it uses the
 * raw cursor and not the truncation-narrowed `@candidateAfterSeq`: it belongs
 * in the packet whenever the window reaches back past it (the orientation turn),
 * and drops out once the agent has already been delivered it.
 */
function mentionContextCandidateSql(scope: ChannelMentionContextScope): string {
  if (scope === 'thread') {
    return `(
      SELECT root.*
        FROM channel_messages root
       WHERE root.id = @threadRootId
         AND root.channel_id = @channelId
         AND root.seq > @afterSeq
         AND root.seq < @triggerSeq
      UNION ALL
      SELECT reply.*
        FROM channel_messages reply
       WHERE reply.thread_id = @threadRootId
         AND reply.channel_id = @channelId
         AND reply.seq > @candidateAfterSeq
         AND reply.seq < @triggerSeq
    )`;
  }
  return `(SELECT channel_row.*
             FROM channel_messages channel_row
            WHERE channel_row.channel_id = @channelId
              AND channel_row.seq > @candidateAfterSeq
              AND channel_row.seq < @triggerSeq)`;
}

function mentionContextOwnRowSql(
  scope: ChannelMentionContextScope,
  alias = 'm'
): string {
  const rootException =
    scope === 'thread' ? `${alias}.id = @threadRootId OR ` : '';
  return `(${rootException}NOT (
    ${alias}.sender_kind = 'agent'
    AND COALESCE(json_extract(${alias}.meta_json, '$.providerId'), '') = @framework
  ))`;
}

function mentionContextEligibleSql(
  scope: ChannelMentionContextScope,
  alias = 'm'
): string {
  const structuralRoot =
    scope === 'thread' ? `${alias}.id = @threadRootId OR ` : '';
  return `(${structuralRoot}(
    ${alias}.kind = 'message'
    AND ${alias}.sender_kind IN ('human', 'agent')
    AND json_extract(${alias}.meta_json, '$.agentDetail') IS NULL
    AND json_extract(${alias}.meta_json, '$.${CHANNEL_DELETED_AT_META_KEY}') IS NULL
    AND length(trim(${alias}.body_text, char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))) > 0
  ))`;
}

/** Production SQL exported so tests can lock the range-index query plan. */
export function buildChannelMentionContextCountSql(
  scope: ChannelMentionContextScope
): string {
  const eligible = mentionContextEligibleSql(scope);
  return `SELECT COUNT(*) AS total_count,
                 COALESCE(SUM(CASE WHEN ${eligible} THEN 0 ELSE 1 END), 0)
                   AS activity_filtered_count
            FROM ${mentionContextCandidateSql(scope)} m
           WHERE ${mentionContextOwnRowSql(scope)}`;
}

/** Production SQL returning at most the packet's requested prose-row budget. */
export function buildChannelMentionContextRowsSql(
  scope: ChannelMentionContextScope
): string {
  if (scope === 'channel') {
    // Keep this a plain descending range read. The caller reverses sixteen rows
    // in JS; asking SQLite for ascending output through an outer query adds a
    // temp sort to the hot path for no benefit.
    return `SELECT m.*
              FROM channel_messages m
             WHERE m.channel_id = @channelId
               AND m.seq > @candidateAfterSeq
               AND m.seq < @triggerSeq
               AND ${mentionContextOwnRowSql('channel')}
               AND ${mentionContextEligibleSql('channel')}
             ORDER BY m.seq DESC
             LIMIT @limit`;
  }
  // The canonical root is structural regardless of its body/kind. Replies use
  // the ordinary prose predicate and their own PACKET_MAX_ROWS-1 limit, so the
  // root cannot be displaced by a long or activity-heavy thread. The root slot
  // stays reserved either way: `@replyLimit` is `limit - 1` in both modes, so a
  // cursor that has already delivered the root buys 15 replies, not 16.
  return `SELECT root.*
            FROM channel_messages root
           WHERE root.id = @threadRootId
             AND root.channel_id = @channelId
             AND root.seq > @afterSeq
             AND root.seq < @triggerSeq
           UNION ALL
          SELECT newest_reply.*
            FROM (
              SELECT reply.*
                FROM channel_messages reply
               WHERE reply.thread_id = @threadRootId
                 AND reply.channel_id = @channelId
                 AND reply.seq > @candidateAfterSeq
                 AND reply.seq < @triggerSeq
                 AND ${mentionContextOwnRowSql('channel', 'reply')}
                 AND ${mentionContextEligibleSql('channel', 'reply')}
               ORDER BY reply.seq DESC
               LIMIT @replyLimit
            ) newest_reply`;
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
  return `SELECT root.id                         AS root_id,
                  root.body_text                  AS root_body,
                  thread.title                    AS thread_title,
                  root.sender_id                  AS root_sender_id,
                  root.sender_kind                AS root_sender_kind,
                  root.sender_display             AS root_sender_display,
                  root.meta_json                  AS root_meta_json,
                  (SELECT COUNT(*)
                     FROM channel_messages reply INDEXED BY idx_chm_thread
                    WHERE reply.thread_id = thread.root_message_id
                      AND reply.channel_id = thread.channel_id
                      AND json_extract(reply.meta_json, '$.agentDetail') IS NULL)
                                                   AS reply_count,
                  thread.updated_at               AS last_reply_at,
                  COUNT(*) OVER ()                AS thread_total
             FROM channel_threads thread
             CROSS JOIN channel_messages root
               ON root.id = thread.root_message_id
              AND root.channel_id = thread.channel_id
            WHERE thread.channel_id = @channelId
            ORDER BY thread.updated_at DESC, root.seq DESC
            LIMIT @limit`;
}

// ── full-text search index (#1308 slice 2 item 1) ───────────────────────────

/** FTS5 virtual table mirroring the searchable subset of `channel_messages`. */
const CHANNEL_SEARCH_TABLE = 'channel_messages_fts';

/**
 * Trigger names kept in one list so the boot-time integrity check can assert
 * the complete set exists — a partially-dropped set is exactly the state that
 * silently stops indexing while search keeps answering from a stale index.
 */
const CHANNEL_SEARCH_TRIGGERS = [
  'channel_messages_fts_ai',
  'channel_messages_fts_au',
  'channel_messages_fts_ad',
] as const;

/** Terms accepted from one query; a longer query is a paste, not a search. */
const CHANNEL_SEARCH_MAX_TERMS = 12;

/**
 * Per-connection view of the FTS5 TERM index, used only by the pre-flight cost
 * gate (#1316). `fts5vocab` in `row` mode yields one row per distinct term with
 * its document and occurrence counts, and its `xBestIndex` accepts range
 * constraints on `term`, so `term >= p AND term < p⁺` is a b-tree SEEK over the
 * prefix rather than a scan of the dictionary.
 *
 * Declared in `temp.` deliberately. It is a pure read-through onto the index
 * that already exists, so persisting it would add a schema object (and a
 * migration, and a rebuild hazard) for something every connection can derive in
 * microseconds. Being per-connection also means it survives the drop/recreate
 * that `rebuildChannelSearchIndex` performs — fts5vocab resolves its target at
 * query time, not at CREATE time.
 */
const CHANNEL_SEARCH_VOCAB_TABLE = 'temp.relay_channel_search_vocab';

/**
 * Name of the per-row user function that enforces the wall-clock ceiling.
 *
 * Module-local: the name is an implementation detail shared between
 * `registerChannelSearchTick` and the SQL builder, and nothing outside this file
 * should be spelling it. A caller preparing the production SQL on its OWN
 * `better-sqlite3` handle (the query-plan test does) must still install the
 * function first, because SQLite resolves function names at prepare time — but
 * it does that through `registerChannelSearchTick`, which is the exported seam.
 */
const CHANNEL_SEARCH_TICK_FUNCTION = 'relay_channel_search_tick';

/**
 * Thrown out of `searchMessages` when the store refuses or abandons a read.
 *
 * A separate class rather than `ChannelMessageStoreError` because this is not a
 * caller error: the route answers HTTP 200 with the structured
 * `unavailableReason`, exactly as it already does for `query_too_short`. The
 * distinction the client needs is "the index did not (fully) answer", not a
 * failure — printing "no matches" for either of these would assert something
 * about the transcript that was never checked.
 */
export class ChannelSearchRefusedError extends Error {
  readonly reason: 'search_query_too_broad' | 'search_timeout';

  constructor(reason: 'search_query_too_broad' | 'search_timeout') {
    super(`channel search refused: ${reason}`);
    this.name = 'ChannelSearchRefusedError';
    this.reason = reason;
  }
}

/**
 * Install the wall-clock tick on one connection.
 *
 * `deterministic: false` is the LOAD-BEARING option, not documentation: SQLite
 * hoists constant subexpressions out of the row loop, and only the
 * non-deterministic flag keeps this one inside it. The row id is passed as an
 * argument for the same reason belt goes with braces — an expression that reads
 * a column of the driving table cannot be evaluated anywhere but per row, on
 * any SQLite version.
 *
 * `isExpired` is a callback rather than a deadline value because one connection
 * serves every search: better-sqlite3 is synchronous, so no second read can
 * begin while one is inside `.all()`, and the store simply moves the deadline
 * before each call.
 */
export function registerChannelSearchTick(
  db: Database.Database,
  isExpired: () => boolean
): void {
  db.function(
    CHANNEL_SEARCH_TICK_FUNCTION,
    { deterministic: false },
    (_rowid: unknown) => {
      if (isExpired()) throw new ChannelSearchRefusedError('search_timeout');
      return 1;
    }
  );
}

/**
 * The half-open term range the trailing `*` of `raw` will expand over, or null
 * when the query has no prefix term to bound.
 *
 * Mirrors `buildChannelSearchMatchQuery`: only the FINAL term takes `*`, and
 * only once it is at least `CHANNEL_SEARCH_MIN_QUERY_CHARS` code points. The
 * returned bounds are compared against terms as FTS5 STORED them, so the text
 * is folded the way `unicode61 remove_diacritics 2` folds it — lowercased, with
 * combining marks stripped — and reduced to its LAST tokenizer token, because
 * `"foo-bar" *` is the two-token phrase `foo bar` with the prefix on `bar`.
 *
 * The folding is an APPROXIMATION of unicode61's table, and where it diverges
 * the probe costs a DIFFERENT term range than the query expands over — not a
 * conservative subset of it. Measured, on Greek, where two divergences compound:
 * `remove_diacritics 2` KEEPS the tonos (FTS5 stores `ΣΊΣΥΦΟΣ` as `σίσυφοσ`,
 * U+03C3 U+03AF …) while NFD mark-stripping removes it, and `toLowerCase` maps a
 * trailing Σ to FINAL sigma U+03C2 while unicode61 always folds to U+03C3. So
 * `ΣΊΣ` probes `[σις, σισ)` — and the stored term begins `σί`, which sorts BELOW
 * that range (U+03AF < U+03B9). The probe counts zero terms for a prefix that
 * does match. Turkish dotless i and ß are in the same family.
 *
 * Do not read that as a safety guarantee. Disjoint ranges carry no ordering, so
 * a divergence can under-count (measured above) or over-count; what is bounded
 * is the CONSEQUENCE in each direction. Under-counting leaves the read to the
 * doc budget and the wall-clock ceiling, which is the pre-#1316 position for
 * that query and no worse. Over-counting refuses a query the operator then
 * narrows, which is visible and recoverable. Latin-script text — what the
 * budgets were calibrated on, and what the transcript is overwhelmingly made of
 * — folds identically, so this is a correctness note about the edges rather
 * than about the working path.
 *
 * Exported for tests: this is the half of the gate that has to agree with a C
 * tokenizer, so it deserves direct assertions rather than only end-to-end ones.
 */
export function channelSearchPrefixRange(
  raw: string
): { low: string; high: string } | null {
  const terms = collectChannelSearchTerms(raw);
  const last = terms[terms.length - 1];
  if (last === undefined) return null;
  if ([...last].length < CHANNEL_SEARCH_MIN_QUERY_CHARS) return null;
  const folded = last.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const tokens = folded.split(/[^\p{L}\p{N}]+/u).filter((part) => part !== '');
  const low = tokens[tokens.length - 1];
  if (low === undefined) return null;
  const points = [...low];
  const tail = points[points.length - 1]?.codePointAt(0);
  if (tail === undefined) return null;
  // Successor of the last code point, skipping the surrogate block (which is
  // not a scalar value) so `String.fromCodePoint` cannot produce a lone
  // surrogate that would bind as invalid UTF-8.
  let next = tail + 1;
  if (next >= 0xd800 && next <= 0xdfff) next = 0xe000;
  if (next > 0x10ffff) return null;
  return {
    low,
    high: points.slice(0, -1).join('') + String.fromCodePoint(next),
  };
}

/** `snippet()` window, in tokens (FTS5 allows 1..64). */
const CHANNEL_SEARCH_SNIPPET_TOKENS = 20;

/**
 * Rows the index carries, as a SQL predicate over one alias of
 * `channel_messages`. Shared verbatim by the sync triggers and the backfill so
 * the index contents cannot drift from what a rebuild would produce.
 *
 * Excluded, in order of why:
 *  * `kind = 'system'` — hub bookkeeping ("agent restarted", sweep notices).
 *    Searching for prose must not surface the machine's own chatter.
 *  * `status = 'streaming'` — a half-written body would be indexed at whatever
 *    prefix the writer had flushed, then re-indexed on every delta. Streaming
 *    rows enter the index exactly once, through the finalize UPDATE.
 *  * `meta.agentDetail IS NOT NULL` — agent detail cards are tool payloads
 *    (`beginStream` with `text: ''`, finalized with the card in meta), not
 *    conversation. Same predicate `replyCountSql` and the thread aggregate
 *    already use, so "what counts as a real message" has ONE definition here.
 *  * empty `body_text` — nothing to match, and it is also the shape a tombstone
 *    leaves behind.
 *  * `meta.deletedAt IS NOT NULL` — a tombstone is the operator's statement
 *    that this row has no body; an index that still answered for its old text
 *    would be an undelete through the back door.
 *
 * Thread replies are deliberately NOT excluded: a reply is a message, and the
 * deep link the result row produces resolves a reply to its root and opens the
 * thread panel (#1308 slice 1).
 */
function channelSearchIndexablePredicate(alias: string): string {
  return `${alias}.kind = 'message'
      AND ${alias}.status <> 'streaming'
      AND ${alias}.body_text <> ''
      AND json_extract(${alias}.meta_json, '$.agentDetail') IS NULL
      AND json_extract(${alias}.meta_json, '$.${CHANNEL_DELETED_AT_META_KEY}') IS NULL`;
}

/**
 * DDL for the index and its sync triggers.
 *
 * `content='channel_messages'` is the EXTERNAL CONTENT form: FTS5 stores only
 * the inverted index and reads column values back from the source row by
 * rowid, so a 256KB body is never duplicated on disk. `id`/`channel_id` ride
 * along as UNINDEXED columns — they name the hit for `snippet()`-adjacent
 * reads without polluting the term dictionary with opaque `topic:`/`chm:`
 * identifiers, and channel scoping is done by joining back to
 * `channel_messages` (a real index) rather than by matching an id as text.
 *
 * Tokenizer: `unicode61 remove_diacritics 2` (NOT `porter`). Channel bodies are
 * dense with identifiers — file paths, symbol names, branch names, error codes
 * — and the operator is nearly always searching for a literal string they
 * remember seeing. Porter stemming would fold `running`/`runs` together, but it
 * would equally fold `Files`→`file` and mangle identifier fragments, making an
 * exact-token search for code lossy and its misses unexplainable. `unicode61`
 * gives predictable exact-token matching; `remove_diacritics 2` still folds
 * accents so `café` matches `cafe` without touching ASCII identifiers.
 *
 * Sync is TRIGGER-based rather than code-level upsert on purpose: this store
 * has seven distinct write paths into `channel_messages` (append, begin/update/
 * finalize stream, provisional-terminal resolution, edit, delete) plus two
 * sweeps that delete rows outright. A trigger cannot be forgotten by a future
 * eighth path; a call site can. The `'delete'` command form is required by
 * external-content FTS5 — it must be handed the ORIGINAL column values so the
 * matching index entries can be found before the row changed.
 */
const CHANNEL_SEARCH_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS ${CHANNEL_SEARCH_TABLE} USING fts5(
  id UNINDEXED,
  channel_id UNINDEXED,
  body_text,
  content='channel_messages',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS channel_messages_fts_ai
AFTER INSERT ON channel_messages BEGIN
  INSERT INTO ${CHANNEL_SEARCH_TABLE}(rowid, id, channel_id, body_text)
  SELECT new.rowid, new.id, new.channel_id, new.body_text
   WHERE ${channelSearchIndexablePredicate('new')};
END;

CREATE TRIGGER IF NOT EXISTS channel_messages_fts_ad
AFTER DELETE ON channel_messages BEGIN
  INSERT INTO ${CHANNEL_SEARCH_TABLE}(${CHANNEL_SEARCH_TABLE}, rowid, id, channel_id, body_text)
  SELECT 'delete', old.rowid, old.id, old.channel_id, old.body_text
   WHERE ${channelSearchIndexablePredicate('old')};
END;

CREATE TRIGGER IF NOT EXISTS channel_messages_fts_au
AFTER UPDATE ON channel_messages BEGIN
  INSERT INTO ${CHANNEL_SEARCH_TABLE}(${CHANNEL_SEARCH_TABLE}, rowid, id, channel_id, body_text)
  SELECT 'delete', old.rowid, old.id, old.channel_id, old.body_text
   WHERE ${channelSearchIndexablePredicate('old')};
  INSERT INTO ${CHANNEL_SEARCH_TABLE}(rowid, id, channel_id, body_text)
  SELECT new.rowid, new.id, new.channel_id, new.body_text
   WHERE ${channelSearchIndexablePredicate('new')};
END;
`;

/**
 * Split operator text into the terms a MATCH expression may quote.
 *
 * Terms with no letter or digit are dropped. Not because FTS5 would reject them
 * — `MATCH '"***" *'` and `MATCH '"" *'` both execute cleanly and return zero
 * rows — but because such a term can only ever contribute an empty phrase, so
 * running it is a guaranteed-empty index read the caller can answer without a
 * query. Length is counted in CODE POINTS: `[...term].length` so an astral
 * character counts once rather than twice as UTF-16 units.
 */
function collectChannelSearchTerms(raw: string): string[] {
  return raw
    .slice(0, CHANNEL_SEARCH_QUERY_MAX_CHARS)
    .split(/\s+/)
    .map((term) => term.replaceAll('"', ' ').trim())
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .slice(0, CHANNEL_SEARCH_MAX_TERMS);
}

/**
 * Why this query will not be dispatched to the index, or null when it will be.
 *
 * Exported so the route can answer `unavailableReason` from the SAME predicate
 * the store applies, instead of inferring "no usable term" from an empty result
 * array — which is indistinguishable from a genuine miss and made the client
 * print "no matches" for text the index was never asked about.
 */
export function channelSearchUnavailableReason(
  raw: string
): ChannelSearchUnavailableReason | null {
  if (raw.trim().length === 0) return 'empty_query';
  const terms = collectChannelSearchTerms(raw);
  if (terms.length === 0) return 'no_searchable_term';
  if (
    terms.length === 1 &&
    [...(terms[0] ?? '')].length < CHANNEL_SEARCH_MIN_QUERY_CHARS
  ) {
    return 'query_too_short';
  }
  return null;
}

/**
 * Translate operator text into an FTS5 MATCH expression.
 *
 * Every term is emitted as a QUOTED phrase. That is the escaping strategy, not
 * a stylistic choice: inside a phrase the only character with meaning is `"`
 * (doubled to escape), so an operator pasting `NOT`, `a:b`, `foo*` or `(` gets
 * a literal search instead of a syntax error or an accidental operator.
 *
 * The final term takes the `*` prefix operator so a search feels live while the
 * operator is still typing the word — but ONLY once it is at least
 * `CHANNEL_SEARCH_MIN_QUERY_CHARS` code points long, and a query that reduces
 * to one term shorter than that is refused outright (null). A one-character
 * prefix expands to nearly the whole term dictionary, and `bm25()` +
 * `ORDER BY score` must rank every match before `LIMIT` drops it; with
 * synchronous better-sqlite3 on the request path that is a multi-second-to-
 * multi-ten-second freeze of the entire hub event loop, reachable by one
 * keystroke. Longer queries keep every term: `a` is a fine filter next to a
 * real word, since the AND already bounds the match set.
 *
 * A query with no usable term returns null too, and the caller reports it via
 * `channelSearchUnavailableReason` rather than running it.
 *
 * Exported for tests: the escaping contract is the security-relevant half of
 * this feature and deserves direct assertions, not only end-to-end coverage.
 */
export function buildChannelSearchMatchQuery(raw: string): string | null {
  if (channelSearchUnavailableReason(raw) !== null) return null;
  const terms = collectChannelSearchTerms(raw);
  const last = terms.length - 1;
  return terms
    .map((term, index) =>
      index === last && [...term].length >= CHANNEL_SEARCH_MIN_QUERY_CHARS
        ? `"${term}" *`
        : `"${term}"`
    )
    .join(' AND ');
}

/**
 * Production search query, exported for the same reason the thread builders
 * are: a query-plan test can EXPLAIN the exact SQL instead of a hand-copied
 * approximation that drifts into a full-table walk.
 *
 * `CROSS JOIN` is the join-order hint, not a cartesian product (same idiom, and
 * the same reason, as `buildChannelThreadSummarySql`): SQLite never reorders
 * across one. With a plain `JOIN`, the `m.channel_id IN (...)` allowlist is
 * enough to tempt the planner into driving from `channel_messages`
 * (`SEARCH m USING INDEX idx_chm_channel_seq (channel_id=?)`), which walks
 * EVERY message in every visible channel and probes the FTS index per row —
 * turning a term lookup into a full transcript scan that grows with history.
 * Pinning the order keeps the shape the query-plan test locks in: the FTS index
 * drives, and `channel_messages` is probed by rowid, so the allowlist is a
 * filter over matched rows rather than a scan.
 *
 * That rowid is the table's IMPLICIT one — `channel_messages.id` is `TEXT
 * PRIMARY KEY`, so there is no INTEGER PRIMARY KEY alias to make it stable.
 * The external-content index keys every entry by that implicit rowid, which
 * makes it the join key AND the identity contract:
 *   * NEVER `VACUUM` (or `INSERT INTO ... SELECT` rebuild) `channel-chat.db`
 *     without calling `rebuildChannelSearchIndex` afterwards. VACUUM renumbers
 *     implicit rowids; the index would keep pointing at the OLD numbers and
 *     search would answer with other channels' bodies under correct-looking
 *     snippets — silent, and invisible to every existing assertion.
 *   * `channel_messages` must never be declared `WITHOUT ROWID`; that removes
 *     the mapping outright. A migration test asserts both of these.
 *
 * Ranking is bm25 ascending — SQLite returns a more-negative score for a better
 * match — with newest-first as the tiebreak so two equally relevant rows
 * present the recent one first.
 *
 * `relay_channel_search_tick(<fts>.rowid)` is the wall-clock ceiling (#1316).
 * It sits immediately after the MATCH and reads a column of the DRIVING table
 * on purpose: SQLite evaluates a WHERE term in the loop of the last table it
 * references, so this one fires once per FTS-matched row — before the rowid
 * probe into `channel_messages` and before the channel allowlist discards
 * anything — which is the earliest per-row hook the query has. It never filters
 * (it returns 1 or throws), so the query plan is unchanged; the plan test
 * asserts that.
 */
export function buildChannelMessageSearchSql(channelIdCount: number): string {
  const channelClause =
    channelIdCount > 0
      ? `AND m.channel_id IN (${Array.from({ length: channelIdCount }, () => '?').join(', ')})`
      : '';
  return `SELECT m.id            AS id,
                m.channel_id     AS channel_id,
                m.thread_id      AS thread_id,
                m.seq            AS seq,
                m.sender_kind    AS sender_kind,
                m.sender_id      AS sender_id,
                m.sender_display AS sender_display,
                m.meta_json      AS meta_json,
                m.created_at     AS created_at,
                snippet(${CHANNEL_SEARCH_TABLE}, 2, ?, ?, ?, ${CHANNEL_SEARCH_SNIPPET_TOKENS}) AS snippet,
                bm25(${CHANNEL_SEARCH_TABLE}) AS score
           FROM ${CHANNEL_SEARCH_TABLE}
           CROSS JOIN channel_messages m ON m.rowid = ${CHANNEL_SEARCH_TABLE}.rowid
          WHERE ${CHANNEL_SEARCH_TABLE} MATCH ?
            AND ${CHANNEL_SEARCH_TICK_FUNCTION}(${CHANNEL_SEARCH_TABLE}.rowid)
            ${channelClause}
          ORDER BY score ASC, m.seq DESC
          LIMIT ?`;
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
  -- #1455 slice 1: audit of HOW the member joined. Nullable because rows
  -- written before the column existed cannot be attributed; the v17 migration
  -- stamps those 'backfill'.
  invited_by    TEXT,
  -- #1455 slice 2: removal TOMBSTONE, not a delete. backfillMembership is
  -- idempotent and additive (INSERT OR IGNORE), and the bridge/binder write
  -- paths re-upsert on every durable reply — so a deleted row would be
  -- resurrected by the next boot sweep or the next agent turn and removal
  -- would silently not stick. A retained row with removed_at set is a
  -- member that is NOT a member: every read filters it out, and only an
  -- explicit invite re-admits.
  --
  -- Removal is a property of the fold CLASS, not of one row. Rows are stored
  -- verbatim and every write collides only on an exact primary key, so an
  -- implicit writer arriving under the participant's OTHER spelling inherits
  -- the class stamp instead of inserting a live row (see memberFoldKey).
  removed_at    TEXT,
  removed_by    TEXT,
  PRIMARY KEY (channel_id, member_kind, member_id)
);
-- Partial, so it holds only the rare removed rows and costs nothing on a
-- channel that never evicted anyone. It is what makes the backfill's repair
-- probe ("does this database contain ANY tombstone") an indexed lookup rather
-- than a scan of every membership row.
CREATE INDEX IF NOT EXISTS idx_chmem_removed
  ON channel_members(channel_id)
  WHERE removed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_agent_bindings (
  channel_id            TEXT NOT NULL,
  -- Empty is the explicit root-channel scope. SQLite composite primary keys do
  -- not give NULL the conflict semantics this binding identity needs.
  thread_scope_id       TEXT NOT NULL DEFAULT '',
  profile_actor_id      TEXT NOT NULL,
  agent_framework       TEXT NOT NULL,
  runtime_id            TEXT,
  binding_role          TEXT,
  provider_session_json TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (channel_id, thread_scope_id, profile_actor_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chab_sole_orchestrator
  ON channel_agent_bindings(channel_id)
  WHERE binding_role = 'orchestrator' AND thread_scope_id = '';

CREATE TABLE IF NOT EXISTS channel_threads (
  channel_id      TEXT NOT NULL,
  root_message_id TEXT NOT NULL,
  title           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (channel_id, root_message_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_threads_recent
  ON channel_threads(channel_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS channel_completion_callbacks (
  id                    TEXT PRIMARY KEY,
  channel_id            TEXT NOT NULL,
  thread_id             TEXT,
  trigger_message_id    TEXT NOT NULL,
  requester_profile_id  TEXT NOT NULL,
  target_profile_id     TEXT NOT NULL,
  target_runtime_id     TEXT NOT NULL,
  target_turn_id        TEXT NOT NULL,
  -- A child delegation may continue an already-open ancestor edge. This is
  -- relation data, deliberately separate from the one-shot edge lifecycle.
  continuation_parent_callback_id TEXT,
  awaiting_child        INTEGER NOT NULL DEFAULT 0 CHECK (awaiting_child IN (0, 1)),
  pending_child_intents INTEGER NOT NULL DEFAULT 0,
  continuation_completed_at TEXT,
  state                 TEXT NOT NULL
                          CHECK (state IN ('pending','satisfied','delivered','consumed','undeliverable')),
  terminal_reason       TEXT,
  terminal_message_id   TEXT,
  message_disposition   TEXT,
  -- Delivery failure is deliberately separate from the delegatee terminal
  -- reason: no requester accepted this callback, but the delegated turn may
  -- still have completed normally.
  delivery_reason       TEXT,
  created_at            TEXT NOT NULL,
  satisfied_at          TEXT,
  delivered_at          TEXT,
  consumed_at           TEXT,
  undeliverable_at      TEXT,
  updated_at            TEXT NOT NULL,
  UNIQUE(channel_id, target_profile_id, target_turn_id)
);
CREATE INDEX IF NOT EXISTS idx_chcc_recovery
  ON channel_completion_callbacks(state, created_at)
  WHERE state IN ('pending','satisfied','delivered');
CREATE INDEX IF NOT EXISTS idx_chcc_target_turn
ON channel_completion_callbacks(channel_id, target_profile_id, target_turn_id);
CREATE INDEX IF NOT EXISTS idx_chcc_continuation_parent
ON channel_completion_callbacks(continuation_parent_callback_id)
WHERE continuation_parent_callback_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chcc_settled_retention
ON channel_completion_callbacks(state, consumed_at, undeliverable_at)
WHERE state IN ('consumed','undeliverable');

CREATE TABLE IF NOT EXISTS channel_async_runs (
  id                 TEXT PRIMARY KEY,
  channel_id         TEXT NOT NULL,
  thread_id          TEXT,
  request_message_id TEXT NOT NULL UNIQUE,
  requester_id       TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('submitted','working','input-required','auth-required','completed','failed','cancelled','rejected')),
  reason             TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  completed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_char_channel_created
  ON channel_async_runs(channel_id, created_at, id);
CREATE TABLE IF NOT EXISTS channel_async_run_targets (
  run_id             TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('queued','working','input-required','auth-required','completed','failed','cancelled','rejected')),
  reason             TEXT,
  approval_state     TEXT,
  updated_at         TEXT NOT NULL,
  completed_at       TEXT,
  PRIMARY KEY(run_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_chart_run_state
  ON channel_async_run_targets(run_id, state);
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

/** Projection of the FTS join (#1308 slice 2 item 1). */
interface ChannelSearchRow {
  id: string;
  channel_id: string;
  thread_id: string | null;
  seq: number;
  sender_kind: string;
  sender_id: string;
  sender_display: string | null;
  meta_json: string | null;
  created_at: string;
  snippet: string;
  score: number;
}

/** Projection of the thread aggregate join (#1287 slice 5 item 18). */
interface ThreadSummaryRow {
  root_id: string;
  root_body: string;
  thread_title: string;
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
  invited_by: string | null;
  removed_at: string | null;
  removed_by: string | null;
}

/** Projection of a read-state row (#1308 slice 3 item 1). */
interface ChannelReadStateRow {
  channel_id: string;
  last_read_seq: number;
  updated_at: string;
}

function readStateRowToState(row: ChannelReadStateRow): ChannelReadState {
  return {
    channelId: row.channel_id,
    lastReadSeq: row.last_read_seq,
    updatedAt: row.updated_at,
  };
}

interface BindingRow {
  channel_id: string;
  thread_scope_id: string;
  profile_actor_id: string;
  agent_framework: string;
  runtime_id: string | null;
  binding_role: AgentRole | null;
  provider_session_json: string;
  created_at: string;
  updated_at: string;
}

interface CompletionCallbackRow {
  id: string;
  channel_id: string;
  thread_id: string | null;
  trigger_message_id: string;
  requester_profile_id: string;
  target_profile_id: string;
  target_runtime_id: string;
  target_turn_id: string;
  continuation_parent_callback_id: string | null;
  awaiting_child: number;
  pending_child_intents: number;
  continuation_completed_at: string | null;
  state: ChannelCompletionCallbackState;
  terminal_reason: ChannelCompletionCallbackTerminalReason | null;
  terminal_message_id: string | null;
  message_disposition: ChannelCompletionCallbackMessageDisposition | null;
  delivery_reason: ChannelCompletionCallbackDeliveryReason | null;
  created_at: string;
  satisfied_at: string | null;
  delivered_at: string | null;
  consumed_at: string | null;
  undeliverable_at: string | null;
  updated_at: string;
}

interface AsyncRunRow {
  id: string;
  channel_id: string;
  thread_id: string | null;
  request_message_id: string;
  requester_id: string;
  state: ChannelAsyncRunState;
  reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface AsyncRunTargetRow {
  run_id: string;
  target_id: string;
  state: ChannelAsyncRunTargetState;
  reason: string | null;
  approval_state: ChannelAsyncRunApprovalState | null;
  updated_at: string;
  completed_at: string | null;
}

export interface ChannelMessageMeta {
  mentions?: ChannelMention[];
  parts?: ChannelMessagePart[];
  truncationReason?: ChannelTruncationReason;
  /** Legacy UI marker reserved exclusively for the 256KB size limit. */
  truncated?: boolean;
  agentDetail?: ChannelAgentDetail;
  agentAttribution?: ChannelAgentAttribution;
  asyncRun?: { runId: ChannelAsyncRunId; targetId: string };
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

export interface CreateChannelAsyncRunPostInput extends AppendCompleteInput {
  /** Resolved Relay profile actors; provider ids are not persisted publicly. */
  targetIds: readonly string[];
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
  /** Immutable provider config snapshot for an agent-authored row. */
  agentAttribution?: ChannelAgentAttribution;
  /** Durable, public-safe correlation carried from the bound Relay turn. */
  meta?: ChannelMessageMeta;
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

export interface DeleteMessageInput {
  /** Channel scope — an id from another channel is a 404, never a cross-delete. */
  channelId: string;
  messageId: string;
  /**
   * Server-derived deleter identity (never body-supplied). Must equal the row's
   * own `sender_id`, exactly as with `editMessage`.
   */
  deleterId: string;
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
  /** Durable user title; old rows deterministically inherit their root prose. */
  title: string;
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

export interface ChannelMentionContextQuery {
  channelId: string;
  framework: string;
  triggerSeq: number;
  /**
   * Delivery cursor, honoured by BOTH scopes (#1408). For thread scope it is
   * the per-(binding, thread) cursor, so a follow-up turn carries only replies
   * posted since the agent's last accepted turn; the structural root drops out
   * with them. Pass 0 to request the full orientation window (first turn in the
   * thread, or a fresh runtime with no provider resume state).
   */
  afterSeq: number;
  /** Canonical root id for thread scope, otherwise null. */
  threadRootId: string | null;
  /** Total retained row budget, including a structural thread root. */
  limit: number;
}

export interface ChannelMentionContextResult {
  rows: ChannelMessage[];
  /** Exact count inside the bounded candidate window. */
  totalCount: number;
  /** Exact filtered count inside the bounded candidate window. */
  activityFilteredCount: number;
  /** Maximum raw candidates examined by each semantic count/row statement. */
  candidateScanBudget: number;
  /**
   * True when older raw index entries exist outside the bounded window. Thread
   * probes are deliberately conservative and can include corrupt cross-channel
   * entries sharing the same thread id; no such row enters the semantic result.
   */
  candidateScanTruncated: boolean;
  scope: ChannelMentionContextScope;
}

export interface ChannelMessageSearchQuery {
  /** Raw operator text; normalized into an FTS5 expression by the store. */
  query: string;
  /**
   * Channels the caller is allowed to see, resolved from the topic store (a
   * DIFFERENT database, so archive state cannot be filtered in this SQL). An
   * EMPTY array means "no visible channel" and returns nothing — it is never
   * read as "no filter", which would leak an archived channel's bodies.
   */
  channelIds?: readonly string[];
  limit?: number;
}

export interface ChannelBinding {
  channelId: string;
  /** Null is the legacy/root-channel execution scope. */
  threadId: string | null;
  /** Durable AgentProfile actor identity; binding/session ownership key. */
  profileActorId: string;
  /** Provider/framework spawn selector retained independently of the profile. */
  agentFramework: string;
  runtimeId: string | null;
  /** Durable participant role; orchestrator designation survives runtime loss. */
  role: AgentRole | null;
  providerSession: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Durable one-shot state for an upward delegation-completion callback. */
export type ChannelCompletionCallbackState =
  | 'pending'
  | 'satisfied'
  | 'delivered'
  | 'consumed'
  /** Callback delivery cannot ever reach its requester; never retry it. */
  | 'undeliverable';

/** Guarded terminal event that satisfied a delegated routed turn. */
export type ChannelCompletionCallbackTerminalReason =
  | 'completed'
  | 'error'
  | 'interrupt'
  | 'unexpected-disconnect'
  | 'safe-idle'
  /** Force-drained after the inactivity watchdog expired (#1541). */
  | 'watchdog'
  /** Interrupted at the hard turn wall-clock ceiling (#1541). */
  | 'turn-ceiling';

/** Whether Relay could bind the callback to a terminal assistant message. */
export type ChannelCompletionCallbackMessageDisposition =
  | 'final-message'
  | 'no-terminal-message';

/** Safe, Relay-owned reason for a non-delivery terminal disposition. */
export type ChannelCompletionCallbackDeliveryReason =
  | 'requester-profile-unavailable'
  | 'continuation-undeliverable';

/** Keep settled edge identities long enough for late provider patches to no-op. */
const COMPLETION_CALLBACK_CONSUMED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * A durable callback edge is Relay-internal routing state, not a chat row.
 * Its unique target turn makes duplicate and late provider terminal patches a
 * no-op at the persistence boundary.
 */
export interface ChannelCompletionCallbackEdge {
  id: string;
  channelId: string;
  threadId: string | null;
  triggerMessageId: string;
  requesterProfileId: string;
  targetProfileId: string;
  targetRuntimeId: string;
  targetTurnId: string;
  /** Ancestor edge satisfied only after this callback-triggered turn ends. */
  continuationParentCallbackId: string | null;
  /** A delegatee explicitly delegated further before its own return. */
  awaitingChild: boolean;
  /** Child routes announced by this turn that have not resolved yet. */
  pendingChildIntents: number;
  /** The callback recipient completed its upward continuation once. */
  continuationCompletedAt: string | null;
  state: ChannelCompletionCallbackState;
  terminalReason: ChannelCompletionCallbackTerminalReason | null;
  terminalMessageId: string | null;
  messageDisposition: ChannelCompletionCallbackMessageDisposition | null;
  /** Why Relay terminalized delivery without invoking a requester runtime. */
  deliveryReason: ChannelCompletionCallbackDeliveryReason | null;
  createdAt: string;
  satisfiedAt: string | null;
  deliveredAt: string | null;
  consumedAt: string | null;
  undeliverableAt: string | null;
  updatedAt: string;
}

export interface CreateChannelCompletionCallbackInput {
  /** Deterministic identity supplied by the binder for one routed target turn. */
  id: string;
  channelId: string;
  threadId: string | null;
  triggerMessageId: string;
  requesterProfileId: string;
  targetProfileId: string;
  targetRuntimeId: string;
  targetTurnId: string;
  /** The still-pending ancestor edge this child completes into, if any. */
  continuationParentCallbackId?: string | null;
}

export interface SatisfyChannelCompletionCallbackInput {
  channelId: string;
  targetProfileId: string;
  targetTurnId: string;
  terminalReason: ChannelCompletionCallbackTerminalReason;
  terminalMessageId?: string | null;
  messageDisposition: ChannelCompletionCallbackMessageDisposition;
}

export interface CompleteChildContinuationInput {
  callbackId: string;
  terminalReason: ChannelCompletionCallbackTerminalReason;
  terminalMessageId?: string | null;
  messageDisposition: ChannelCompletionCallbackMessageDisposition;
}

export interface SoleOrchestratorDesignationInput {
  channelId: string;
  /** Root/channel scope is null; retained here for the common binding writer. */
  threadId?: string | null;
  profileActorId: string;
  agentFramework: string;
  runtimeId?: string | null;
  providerSession?: Record<string, unknown>;
}

export interface StaleStreamSweepResult {
  channelId: string;
  truncatedIds: ChannelMessageId[];
  systemMessage: ChannelMessage;
}

/**
 * One channel's durable last-read mark (#1308 slice 3 item 1).
 *
 * This is the OPERATOR's own mark and nothing else — Relay is single-operator
 * (#1231), so there is exactly one marker per channel and no reader identity to
 * key it by. It exists so the operator's phone and their desktop agree on what
 * has been seen; it is NOT a read receipt, and no agent or second person ever
 * appears in this table. Unread itself stays CLIENT-derived (marker vs live
 * head seq) — the hub stores the marker, never the verdict.
 */
export interface ChannelReadState {
  channelId: string;
  lastReadSeq: number;
  updatedAt: string;
}

/** Outcome of a mark write: `advanced` is false for an ignored (stale) mark. */
export interface ChannelReadStateWriteResult extends ChannelReadState {
  /**
   * True only when this call actually moved the durable mark. The route uses it
   * to decide whether the cross-device broadcast is worth sending: a mark that
   * did not move gives other devices nothing to converge on.
   */
  advanced: boolean;
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

export function createChannelOrchestratorConflictError(input: {
  channelId: string;
  designatedProfileActorId: string | null;
  requestedProfileActorId: string;
}): ChannelMessageStoreError {
  return new ChannelMessageStoreError(
    409,
    'channel_orchestrator_conflict',
    'channel already has a designated orchestrator',
    {
      channelId: input.channelId,
      designatedProfileActorId: input.designatedProfileActorId ?? 'unknown',
      requestedProfileActorId: input.requestedProfileActorId,
    }
  );
}

export interface ChannelMessageStore {
  close(): void;
  appendComplete(input: AppendCompleteInput): ChannelMessage;
  /** Atomically creates (or replays) one requester post and its public run. */
  appendCompleteWithAsyncRun(input: CreateChannelAsyncRunPostInput): {
    message: ChannelMessage;
    run: ChannelAsyncRun;
    replayed: boolean;
    /** True only when the durable run already existed before this call. */
    runReplayed: boolean;
  };
  getAsyncRun(id: ChannelAsyncRunId): ChannelAsyncRun | null;
  getAsyncRunForRequestMessage(
    messageId: ChannelMessageId
  ): ChannelAsyncRun | null;
  /** Current durable run projections for reconnect snapshots; no provider data. */
  listAsyncRuns(channelId: string, limit?: number): ChannelAsyncRun[];
  /** Startup-only safe disposition; nonterminal runs are never redelivered. */
  recoverAsyncRuns(): ChannelAsyncRun[];
  /** CAS one public target outcome and deterministically derives aggregate state. */
  transitionAsyncRunTarget(input: {
    runId: ChannelAsyncRunId;
    targetId: string;
    state: ChannelAsyncRunTargetState;
    reason?: string;
    approvalState?: ChannelAsyncRunApprovalState;
  }): ChannelAsyncRun | null;
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
  /**
   * Operator deletion of their OWN human row (#1308 slice 1 item 4) as a
   * TOMBSTONE: the row survives with its id, seq, createdAt, thread links and
   * client dedupe key intact and loses only its body, its attachment refs and
   * its mentions. Row removal is forbidden here — it would renumber nothing but
   * would punch a hole in the gap-free seq log every cursor depends on, and it
   * would orphan the replies of a deleted thread parent.
   *
   * Idempotent: deleting an already-deleted row returns the existing tombstone
   * with its original `deletedAt` rather than throwing, so a second device (or a
   * double tap) does not surface a spurious error for a state already reached.
   * Throws 404 (absent / other channel) or 409 (not the operator's own settled
   * prose row).
   */
  deleteMessage(input: DeleteMessageInput): ChannelMessage;
  getMessage(id: string): ChannelMessage | null;
  findByClientMessage(
    channelId: string,
    senderId: string,
    clientMessageId: string
  ): ChannelMessage | null;
  history(channelId: string, filter?: ChannelHistoryFilter): ChannelMessage[];
  /**
   * Exact mention-delivery summary plus newest bounded prose rows. Filtering,
   * counting, and LIMIT all happen in SQLite; callers must not page JS history.
   */
  mentionContext(
    input: ChannelMentionContextQuery
  ): ChannelMentionContextResult;
  /**
   * Ranked full-text search over durable message bodies (#1308 slice 2 item 1).
   *
   * Reads the FTS5 index, never the message table directly, so the searchable
   * set is exactly what the sync triggers admitted: prose rows only — no system
   * bookkeeping, no agent detail cards, no tombstones, no half-written streams.
   * Thread replies ARE included. Returns hits, not `ChannelMessage` rows: a
   * result is a jump target plus an excerpt, and shipping full 256KB bodies for
   * 50 hits would make the response a transcript dump.
   *
   * Throws `ChannelSearchRefusedError` when the cost gate refuses the prefix
   * (`search_query_too_broad`) or the wall-clock ceiling cuts the read off
   * (`search_timeout`) — see #1316. Both are 200-with-a-reason at the route, not
   * errors; what they must never become is an empty array, which would claim
   * the corpus was searched and held nothing.
   */
  searchMessages(input: ChannelMessageSearchQuery): ChannelMessageSearchHit[];
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
   *  - edited and deleted rows (#1308 slice 1 items 3/4), whose body changed
   *    under a seq the client already consumed.
   * `history({ afterSeq })` never re-sends any of them, so all must ride
   * catch-up or a disconnected device keeps rendering pre-edit text, a deleted
   * body, or a stuck stream. Bounded by `limit`.
   */
  listResyncRows(
    channelId: string,
    uptoSeq: number,
    limit: number
  ): ChannelMessage[];
  latestSeq(channelId: string): number;
  /**
   * Every channel the operator has a durable last-read mark for (#1308 slice 3
   * item 1). One call, whole map: a client seeds this ONCE on boot, so a
   * per-channel route would turn a cold start into N round trips on the exact
   * surface (a phone on mobile data) this exists to serve.
   *
   * Marks are returned CLAMPED to the channel's current head seq. A channel can
   * legitimately lose its history under a stable id — a DM deleted and recreated
   * under the same deterministic id restarts its seq low (#1178) — and a stored
   * mark above the head is stale by construction. Left unclamped it would
   * suppress the unread signal for every message the recreated channel goes on
   * to accumulate until its seq climbed back past the stale value. Clamping is
   * exactly what the client's own #1178 repair (`clampChannelStores`) does, so
   * the seed a device receives here already agrees with what it would compute
   * locally, and it happens on READ — no repair pass, no window.
   */
  listReadState(): ChannelReadState[];
  /**
   * Advance the operator's last-read mark for one channel (#1308 slice 3 item 1).
   *
   * MONOTONIC-UP, and that is the whole safety property: devices sync through
   * this table, so a PUT carrying a seq at or below the stored mark is a no-op
   * rather than a write. Without it the laggard device wins every race — the
   * phone that has been asleep on seq 12 posts its mark, and the desktop that
   * just read to seq 400 sees 388 messages turn unread again.
   *
   * The incoming seq is clamped to the channel's head for the same reason
   * `listReadState` clamps: a mark can never legitimately point past the last
   * durable row, and letting one in would broadcast a marker that hides
   * messages other devices have not seen.
   */
  markChannelRead(
    channelId: string,
    lastReadSeq: number
  ): ChannelReadStateWriteResult;
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
  /** Creates an empty, named conversation without allocating an agent runtime. */
  createThread(input: {
    channelId: string;
    title: string;
  }): ChannelThreadSummary;
  /** Renames a durable thread root. Existing unnamed roots are lazily claimed. */
  renameThread(input: {
    channelId: string;
    rootMessageId: string;
    title: string;
  }): ChannelThreadSummary | null;
  getThreadTitle(channelId: string, rootMessageId: string): string | null;
  upsertMember(input: {
    channelId: string;
    kind: 'human' | 'agent';
    id: string;
    metadata?: Record<string, unknown>;
    /**
     * Who admitted this member (#1455 slice 1). First-writer wins: a repeat
     * upsert never rewrites the original attribution, so an agent that keeps
     * posting cannot launder how it got in.
     */
    invitedBy?: string;
  }): ChannelMemberRef;
  /**
   * Explicit admission (#1455 slice 2). The single code path behind BOTH
   * `channels.invite` and the mention auto-add, so the two produce byte-identical
   * audit rows.
   *
   * Idempotent for a live member (the original `invitedBy`/`joinedAt` survive),
   * and the only writer that clears an agent removal tombstone — re-admission
   * restates the audit with the NEW inviter, because the invite that was
   * revoked is not the invite that is in force.
   */
  inviteMember(input: {
    channelId: string;
    kind: 'human' | 'agent';
    id: string;
    /** Server-derived member id of the inviter; never caller-supplied. */
    invitedBy: string;
    metadata?: Record<string, unknown>;
  }): ChannelMemberRef;
  /**
   * Revoke admission (#1455 slice 2). Tombstones every stored spelling of the
   * participant and returns the row as it stood, or `null` when the id names no
   * live member. Authorization policy lives in the route, not here.
   */
  removeMember(input: {
    channelId: string;
    kind: 'human' | 'agent';
    id: string;
    /** Server-derived member id of the remover. */
    removedBy: string;
  }): ChannelMemberRef | null;
  listMembers(channelId: string): ChannelMemberRef[];
  /**
   * The live member row this id resolves to under the same canonical/vendor
   * fold as `isMember`, or `null`. Backs the "may I remove this member"
   * decision, which has to read the stored `invitedBy`.
   */
  getMember(
    channelId: string,
    kind: 'human' | 'agent',
    id: string
  ): ChannelMemberRef | null;
  /**
   * Hub-authoritative membership test (#1455 slice 1). Matches on the
   * canonical id form, so `agent:<profile>` and `<profile>` are one member.
   * A removal tombstone (#1455 slice 2) reads as NOT a member.
   */
  isMember(channelId: string, kind: 'human' | 'agent', id: string): boolean;
  /**
   * Seed membership from durable participation history for any channel missing
   * it. Idempotent, additive-only, and safe to race with the live upsert path,
   * so the boot sweep runs it to repair a binding whose membership mirror was
   * lost (see `enrollBoundMember`). It never rewrites an existing row.
   */
  backfillMembership(options?: {
    /** See `backfillChannelMembership`. Defaults to true (full derivation). */
    includeMessageSenders?: boolean;
  }): { inserted: number };
  findDmChannel(memberIdA: string, memberIdB: string): string | null;
  getBinding(
    channelId: string,
    profileActorId: string,
    threadId?: string | null
  ): ChannelBinding | null;
  /** Returns the one durable designation guaranteed by the partial unique index. */
  getSoleOrchestratorBinding(channelId: string): ChannelBinding | null;
  /**
   * First-writer designation. Repeating the same profile is idempotent; a
   * different profile receives a stable 409 without changing either binding.
   */
  designateSoleOrchestrator(
    input: SoleOrchestratorDesignationInput
  ): ChannelBinding;
  upsertBinding(input: {
    channelId: string;
    threadId?: string | null;
    profileActorId: string;
    agentFramework: string;
    runtimeId?: string | null;
    role?: Exclude<AgentRole, 'orchestrator'> | null;
    providerSession?: Record<string, unknown>;
  }): ChannelBinding;
  /** Idempotently records a downward delegation once its routed target turn exists. */
  createCompletionCallback(
    input: CreateChannelCompletionCallbackInput
  ): ChannelCompletionCallbackEdge;
  /** CAS: only the first guarded terminal event may satisfy a pending edge. */
  satisfyCompletionCallback(
    input: SatisfyChannelCompletionCallbackInput
  ): ChannelCompletionCallbackEdge | null;
  /**
   * Marks an incoming edge as waiting for a child delegation. Its original
   * target turn may terminalize, but the callback remains pending until the
   * child callback re-enters the delegatee and that continuation terminalizes.
   */
  deferCompletionCallbackForChild(input: {
    channelId: string;
    targetProfileId: string;
    targetTurnId: string;
    expectedChildCount: number;
  }): ChannelCompletionCallbackEdge | null;
  /** Adds child route intents while an existing callback continuation delegates again. */
  announceContinuationChildren(
    callbackId: string,
    expectedChildCount: number
  ): ChannelCompletionCallbackEdge | null;
  /**
   * CASes one consumed child callback's recipient continuation, then satisfies
   * its parent only after every persisted child continuation has terminalized.
   */
  completeChildContinuation(
    input: CompleteChildContinuationInput
  ): ChannelCompletionCallbackEdge | null;
  /**
   * If a downstream route could not be created, releases the durable defer so
   * the already-recorded terminal result can still return upward.
   */
  releaseDeferredCompletionCallback(
    id: string
  ): ChannelCompletionCallbackEdge | null;
  getCompletionCallback(id: string): ChannelCompletionCallbackEdge | null;
  /**
   * CAS: claims satisfied work for one live binder. A delivered row is still
   * recovery-visible until the internal callback trigger starts its recipient
   * turn and consumes it.
   */
  claimSatisfiedCompletionCallbacks(
    limit?: number
  ): ChannelCompletionCallbackEdge[];
  /** Return an undeliverable in-memory claim to durable retryable work. */
  releaseDeliveredCompletionCallback(id: string): boolean;
  /**
   * CAS a claimed callback into non-retryable delivery failure. If it belongs
   * to a nested continuation, terminalize its unresolved ancestors too: there
   * is no requester turn that could safely manufacture an upward return.
   */
  terminalizeDeliveredCompletionCallback(input: {
    id: string;
    channelId: string;
    threadId: string | null;
    deliveryReason: ChannelCompletionCallbackDeliveryReason;
  }): ChannelCompletionCallbackEdge | null;
  /** CAS: records that the one typed internal trigger has begun its recipient turn. */
  consumeCompletionCallback(id: string): boolean;
  /**
   * A delegatee's explicit final return consumes its own pending edge before
   * the normal mention path routes that one return upward.
   */
  consumeCompletionCallbacksForExplicitReturn(input: {
    channelId: string;
    targetProfileId: string;
    targetTurnId: string;
    requesterProfileIds: readonly string[];
  }): ChannelCompletionCallbackEdge[];
  /**
   * An ancestor-directed explicit return may arrive on a callback continuation
   * turn whose id differs from the ancestor's original delegated target turn.
   */
  consumeAncestorCompletionCallbackForExplicitReturn(
    id: string
  ): ChannelCompletionCallbackEdge | null;
  /**
   * Restart recovery never promotes raw idle. It re-offers volatile delivered
   * work and terminalizes orphaned pending routed turns as disconnects, using
   * durable terminal message evidence where it exists.
   */
  recoverCompletionCallbacks(): ChannelCompletionCallbackEdge[];
  /** Bounded retention for settled callback idempotency history. */
  pruneConsumedCompletionCallbacks(olderThanMs?: number): number;
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

function isAgentAttribution(value: unknown): value is ChannelAgentAttribution {
  const candidate = value as Record<string, unknown>;
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (candidate.model !== undefined || candidate.effort !== undefined) &&
    (candidate.model === undefined ||
      (typeof candidate.model === 'string' &&
        candidate.model.length <= CHANNEL_AGENT_ATTRIBUTION_MAX_CHARS)) &&
    (candidate.effort === undefined ||
      (typeof candidate.effort === 'string' &&
        candidate.effort.length <= CHANNEL_AGENT_ATTRIBUTION_MAX_CHARS))
  );
}

function assertAgentAttribution(
  attribution: ChannelAgentAttribution | undefined
): void {
  if (attribution === undefined) return;
  if (!isAgentAttribution(attribution)) {
    throw new ChannelMessageStoreError(
      400,
      'channel_agent_attribution_invalid',
      'channel agent attribution is invalid or exceeds the display cap'
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

/**
 * Whether a raw row is a tombstone (#1308 slice 1 item 4). Read straight off the
 * persisted meta so every guard in this file agrees with the SQL predicate the
 * resync/preview queries use.
 */
function isTombstoneRow(row: ChannelMessageRow): boolean {
  const value = parseMeta(row.meta_json)?.[CHANNEL_DELETED_AT_META_KEY];
  return typeof value === 'string' && value.length > 0;
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
  if (isAgentAttribution(meta?.agentAttribution)) {
    message.agentAttribution = meta.agentAttribution;
  }
  if (
    meta?.asyncRun &&
    typeof meta.asyncRun === 'object' &&
    typeof meta.asyncRun.runId === 'string' &&
    typeof meta.asyncRun.targetId === 'string'
  ) {
    message.asyncRun = {
      runId: meta.asyncRun.runId as ChannelAsyncRunId,
      targetId: meta.asyncRun.targetId,
    };
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
      agentAttribution: _agentAttribution,
      agentDetailTerminalAuthority: _agentDetailTerminalAuthority,
      asyncRun: _asyncRun,
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

function searchRowToHit(row: ChannelSearchRow): ChannelMessageSearchHit {
  const meta = parseMeta(row.meta_json);
  const providerId =
    typeof meta?.['providerId'] === 'string'
      ? (meta['providerId'] as string)
      : undefined;
  return {
    messageId: row.id as ChannelMessageId,
    channelId: row.channel_id,
    threadId: (row.thread_id as ChannelMessageId | null) ?? null,
    seq: row.seq,
    snippet: row.snippet,
    senderKind: row.sender_kind as ChannelSenderRef['kind'],
    senderId: row.sender_id,
    ...(row.sender_display ? { senderDisplayName: row.sender_display } : {}),
    ...(providerId ? { providerId } : {}),
    createdAt: row.created_at,
    score: row.score,
  };
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
  assertAgentAttribution(input.extra?.agentAttribution);
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

interface LegacyClaudeEchoHealResult {
  /** Rows the SQL predicate matched, BEFORE the bounded-signature guards. */
  candidates: number;
  /** Duplicate rows actually removed. */
  healed: number;
}

/**
 * Candidate pairs for the pre-v2 Claude stream/echo alias, held as ONE SQL
 * string so the cheap `EXISTS` probe on the boot path and the full pass that
 * follows it can never drift apart. It reads the head schema
 * (`source_runtime_id`, post-v5 rename) because the heal now runs after every
 * numbered migration rather than inside one.
 */
const LEGACY_CLAUDE_ECHO_CANDIDATE_SQL = `SELECT keeper.id AS keeper_id,
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
    AND duplicate.source_runtime_id = keeper.source_runtime_id
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
    AND keeper.source_runtime_id IS NOT NULL
    AND keeper.source_turn_id IS NOT NULL
    AND keeper.source_item_id GLOB '*-1'
    AND duplicate.source_item_id GLOB '*-0'`;

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
 * channels are resequenced in-place, and every persisted seq cursor is
 * translated before resequencing: agent delivery cursors AND the operator's
 * durable last-read marks. A mark left untranslated would slide DOWN with the
 * rows and silently swallow the unread tail — `listReadState`'s head clamp only
 * catches a mark stranded ABOVE the head, never one that moved with the log.
 *
 * Callers must run this AFTER `CHANNEL_READ_STATE_SCHEMA_SQL` (i.e. from
 * `runMigrations`, never from inside a numbered `schema_version` lane) so that
 * table exists to be translated.
 *
 * Returns the candidate count alongside the healed count so the caller can log
 * a ZERO pass. #1209 burned a day of forensics precisely because a pass that
 * healed nothing printed nothing, leaving "the migration ran" and "the
 * migration healed" indistinguishable from the log.
 */
function healLegacyClaudeEchoAliases(
  db: Database.Database
): LegacyClaudeEchoHealResult {
  const candidates = db
    .prepare(LEGACY_CLAUDE_ECHO_CANDIDATE_SQL)
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

  // Selected/updated BY ROWID rather than by (channel_id, agent_framework):
  // v3 re-keyed the table to (channel_id, profile_actor_id), and two profiles of
  // one provider can share a framework in one channel. Keying by rowid
  // translates each binding's own cursor instead of stamping the last computed
  // cursor onto its siblings.
  const selectBindings = db.prepare(
    `SELECT rowid AS binding_rowid, provider_session_json
       FROM channel_agent_bindings WHERE channel_id = ?`
  );
  const translateSeq = db.prepare(
    `SELECT COUNT(*) AS count FROM channel_messages
      WHERE channel_id = ? AND seq <= ?`
  );
  const updateBinding = db.prepare(
    `UPDATE channel_agent_bindings SET provider_session_json = ?
      WHERE rowid = ?`
  );
  // Same `COUNT(*) WHERE seq <= cursor` translation the delivery cursors get,
  // applied to the operator's durable last-read mark (#1308 slice 3 item 1).
  // `updated_at` is deliberately NOT touched: the mark still points at the same
  // durable message, so nothing about WHEN the operator read it changed.
  const translateReadMark = db.prepare(
    `UPDATE ${CHANNEL_READ_STATE_TABLE}
        SET last_read_seq = (
              SELECT COUNT(*) FROM channel_messages
               WHERE channel_messages.channel_id = ?
                 AND channel_messages.seq <=
                     ${CHANNEL_READ_STATE_TABLE}.last_read_seq)
      WHERE ${CHANNEL_READ_STATE_TABLE}.channel_id = ?`
  );
  const selectOrderedIds = db.prepare(
    'SELECT id FROM channel_messages WHERE channel_id = ? ORDER BY seq ASC'
  );
  const setSeq = db.prepare(
    'UPDATE channel_messages SET seq = ? WHERE channel_id = ? AND id = ?'
  );

  for (const channelId of affectedChannels) {
    const bindings = selectBindings.all(channelId) as Array<{
      binding_rowid: number;
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
          binding.binding_rowid
        );
      } catch {
        // Invalid legacy provider state is preserved byte-for-byte; migration
        // must not turn an unrelated malformed binding into DB unavailability.
      }
    }

    translateReadMark.run(channelId, channelId);

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

  return { candidates: candidates.length, healed: duplicateIds.size };
}

/**
 * Source rows scanned per backfill commit. Bounded so a rebuild never holds one
 * write transaction over the whole table: a single unbounded transaction grows
 * the WAL by the size of the entire index and returns SQLITE_BUSY to any other
 * process that opens the db meanwhile (dev and prod hubs sharing a config dir
 * do exactly that), for as long as tokenization takes.
 */
const CHANNEL_SEARCH_BACKFILL_BATCH_ROWS = 5_000;

const CHANNEL_READ_STATE_TABLE = 'channel_read_state';

/**
 * The operator's per-channel last-read marks (#1308 slice 3 item 1).
 *
 * Auxiliary table, created on EVERY open rather than behind a numbered
 * `schema_version` step — the same shape `channel_search_state` uses. A numbered
 * step fires once and can never repair a table dropped afterwards; an
 * unconditional `IF NOT EXISTS` is idempotent, self-healing, and cannot be
 * stranded by a db that has already passed the version it was added at.
 *
 * `channel_id` is the whole primary key because Relay is single-operator
 * (#1231): there is one reader, so there is one row per channel and no reader
 * column to key it by. Adding one later would be the moment this stopped being
 * device sync and became read receipts, which epic #1308 rules out.
 *
 * It deliberately does NOT foreign-key `channel_messages`: a channel's marker
 * outlives an empty transcript (nothing to read is not the same as never read),
 * and orphan rows are collected by `sweepOrphans` against the authoritative
 * topic set in the OTHER database, which no constraint in this one can see.
 */
const CHANNEL_READ_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${CHANNEL_READ_STATE_TABLE} (
  channel_id    TEXT PRIMARY KEY,
  last_read_seq INTEGER NOT NULL,
  updated_at    TEXT NOT NULL
);
`;

const CHANNEL_HEAL_STATE_TABLE = 'channel_heal_state';

/**
 * Ledger of one-shot historical repairs that have already run on this db
 * (#1209).
 *
 * Auxiliary table, created on EVERY open, for the same reason
 * `channel_read_state` and `channel_search_state` are: a numbered
 * `schema_version` step fires exactly once, so a repair welded to one can never
 * run on a db that reached that version WITHOUT it — restored from a stamped
 * copy, rolled forward out of order, or hand-stamped. That is precisely what
 * #1209 hit: the version said the repair had happened and the duplicate rows
 * were still there, with no way back short of editing `schema_version`.
 *
 * A marker row is cheaper than a version bump in both directions. It does not
 * make the db unopenable by an older hub (a numbered bump does — `current >
 * SCHEMA_VERSION` throws), and re-arming a pass is
 * `DELETE FROM channel_heal_state WHERE heal_id = '...'` rather than rewinding
 * a schema version past migrations that must not replay. The row is also the
 * diagnostic: it records what the pass saw and what it removed.
 */
const CHANNEL_HEAL_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${CHANNEL_HEAL_STATE_TABLE} (
  heal_id      TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL,
  candidates   INTEGER NOT NULL,
  healed       INTEGER NOT NULL
);
`;

/** Marker id for the pre-v2 Claude stream/echo alias repair (#1207, #1209). */
const CLAUDE_ECHO_HEAL_ID = 'claude-echo-alias-v1';

/**
 * Durable completeness marker for the index, and the resume cursor for a
 * backfill that did not finish.
 *
 * Batching the backfill into bounded commits (so boot never holds one writer
 * over the whole tokenization pass) made a NEW on-disk state reachable: table +
 * triggers present, index populated only up to some rowid. Presence of the DDL
 * therefore no longer implies a complete index, and the difference is invisible
 * — batches walk rowid ASCENDING, so a truncated backfill is missing the NEWEST
 * messages, which is exactly what an operator searches for. This row is the
 * only thing that can tell the two apart, so it is written INSIDE the same
 * transaction that creates the DDL and empties the index, advanced inside each
 * batch commit, and flipped to `complete` only after the last one.
 *
 * Single row by construction (`CHECK (id = 1)`): there is one index per db, and
 * a second row would be a second, contradictory answer to "is it complete".
 */
const CHANNEL_SEARCH_STATE_TABLE = 'channel_search_state';

const CHANNEL_SEARCH_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${CHANNEL_SEARCH_STATE_TABLE} (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  status                TEXT NOT NULL CHECK (status IN ('building','complete')),
  indexed_through_rowid INTEGER NOT NULL,
  snapshot_max_rowid    INTEGER NOT NULL,
  updated_at            TEXT NOT NULL
);
`;

type ChannelSearchIndexState = {
  status: 'building' | 'complete';
  /** Highest source rowid whose batch has COMMITTED into the index. */
  indexedThroughRowid: number;
  /** Upper bound of the backfill, snapshot when it began. */
  snapshotMaxRowid: number;
};

/** Marker row, or null when it is absent or unreadable (treat as incomplete). */
function readChannelSearchIndexState(
  db: Database.Database
): ChannelSearchIndexState | null {
  const row = db
    .prepare(
      `SELECT status, indexed_through_rowid, snapshot_max_rowid
         FROM ${CHANNEL_SEARCH_STATE_TABLE} WHERE id = 1`
    )
    .get() as
    | {
        status: string;
        indexed_through_rowid: number;
        snapshot_max_rowid: number;
      }
    | undefined;
  if (!row) return null;
  if (row.status !== 'building' && row.status !== 'complete') return null;
  return {
    status: row.status,
    indexedThroughRowid: row.indexed_through_rowid,
    snapshotMaxRowid: row.snapshot_max_rowid,
  };
}

/**
 * Create the index DDL, empty the index, and claim a backfill — atomically.
 *
 * All four steps share one transaction on purpose. `'delete-all'` outside it
 * would let a crash between the truncate and the marker leave an EMPTIED index
 * that the next boot mistakes for a resumable partial one, and would then
 * double-index everything it did keep. Either the whole claim lands (empty
 * index, marker says `building` from rowid 0) or none of it does (no table, so
 * the next boot repairs from scratch).
 *
 * `'delete-all'` rather than FTS5's own `'rebuild'`: `rebuild` re-derives the
 * index from EVERY content row, which would drag system rows, detail cards,
 * tombstones and half-written streams back in. The index is a filtered
 * projection, so the backfill has to apply the same predicate the triggers do.
 *
 * The upper bound is SNAPSHOT here, before the first batch commits. Splitting
 * the backfill into several transactions means the sync triggers are live
 * between them, so a row appended mid-rebuild is already indexed by the insert
 * trigger; without the snapshot a later batch would re-scan it and index it
 * twice. Snapshot below, triggers above, no overlap — and the bound is
 * PERSISTED so a resume keeps the same split instead of re-deriving a newer
 * bound that would overlap the trigger-indexed tail.
 */
function beginChannelSearchBackfill(
  db: Database.Database
): ChannelSearchIndexState {
  return db.transaction((): ChannelSearchIndexState => {
    // A partially-present trigger set is repaired by replacing all three: the
    // `IF NOT EXISTS` creates below would otherwise leave a stale survivor
    // whose body predates whatever change caused the repair.
    for (const trigger of CHANNEL_SEARCH_TRIGGERS) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    db.exec(CHANNEL_SEARCH_SCHEMA_SQL);
    db.prepare(
      `INSERT INTO ${CHANNEL_SEARCH_TABLE}(${CHANNEL_SEARCH_TABLE}) VALUES('delete-all')`
    ).run();
    const snapshotMaxRowid =
      (
        db.prepare('SELECT MAX(rowid) AS hi FROM channel_messages').get() as {
          hi: number | null;
        }
      ).hi ?? 0;
    db.prepare(
      `INSERT INTO ${CHANNEL_SEARCH_STATE_TABLE}
         (id, status, indexed_through_rowid, snapshot_max_rowid, updated_at)
       VALUES (1, 'building', 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = 'building',
         indexed_through_rowid = 0,
         snapshot_max_rowid = excluded.snapshot_max_rowid,
         updated_at = excluded.updated_at`
    ).run(snapshotMaxRowid, new Date().toISOString());
    return { status: 'building', indexedThroughRowid: 0, snapshotMaxRowid };
  })();
}

/**
 * Run (or finish) the claimed backfill from `state.indexedThroughRowid`.
 *
 * Batched over rowid RANGES, not over `LIMIT/OFFSET` of the filtered set: the
 * range bound comes from the source table's own rowid order, so each commit
 * scans a bounded slice regardless of how selective the predicate is, and no
 * row can be skipped or double-indexed by a shifting offset. Callers may pass
 * `onBatch` to make a long rebuild visible in the journal instead of silent.
 *
 * The cursor advances INSIDE the batch transaction. A cursor written after the
 * commit could be lost to a crash in between, and re-running that range would
 * insert every one of its rows into the index a second time — external-content
 * FTS5 has no upsert, so duplicates would surface as duplicate hits that a
 * later `'delete'` only half removes.
 */
function runChannelSearchBackfill(
  db: Database.Database,
  state: ChannelSearchIndexState,
  onBatch?: (progress: { scannedThrough: number; indexed: number }) => void
): number {
  const nextBound = db.prepare(
    `SELECT MAX(rowid) AS hi FROM (
       SELECT rowid FROM channel_messages
        WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?)`
  );
  const insertBatch = db.prepare(
    `INSERT INTO ${CHANNEL_SEARCH_TABLE}(rowid, id, channel_id, body_text)
     SELECT m.rowid, m.id, m.channel_id, m.body_text
       FROM channel_messages m
      WHERE m.rowid > ? AND m.rowid <= ?
        AND ${channelSearchIndexablePredicate('m')}`
  );
  const advanceCursor = db.prepare(
    `UPDATE ${CHANNEL_SEARCH_STATE_TABLE}
        SET indexed_through_rowid = ?, updated_at = ? WHERE id = 1`
  );
  const commitBatch = db.transaction(
    (from: number, through: number): number => {
      const { changes } = insertBatch.run(from, through);
      advanceCursor.run(through, new Date().toISOString());
      return changes;
    }
  );
  let indexed = 0;
  let cursor = state.indexedThroughRowid;
  while (cursor < state.snapshotMaxRowid) {
    const { hi } = nextBound.get(
      cursor,
      state.snapshotMaxRowid,
      CHANNEL_SEARCH_BACKFILL_BATCH_ROWS
    ) as { hi: number | null };
    if (hi === null) break;
    indexed += commitBatch(cursor, hi);
    cursor = hi;
    onBatch?.({ scannedThrough: cursor, indexed });
  }
  db.prepare(
    `UPDATE ${CHANNEL_SEARCH_STATE_TABLE}
        SET status = 'complete', indexed_through_rowid = ?, updated_at = ?
      WHERE id = 1`
  ).run(state.snapshotMaxRowid, new Date().toISOString());
  return indexed;
}

/**
 * Rebuild the search index from `channel_messages`, in place, from scratch.
 *
 * MUST be called after any maintenance that renumbers implicit rowids — see the
 * rowid contract on `buildChannelMessageSearchSql`.
 */
function rebuildChannelSearchIndex(
  db: Database.Database,
  onBatch?: (progress: { scannedThrough: number; indexed: number }) => void
): number {
  return runChannelSearchBackfill(db, beginChannelSearchBackfill(db), onBatch);
}

/**
 * Boot-time integrity check for the search index (#1308 slice 2 item 1).
 *
 * Runs on EVERY open, not once behind a `schema_version` step, because the
 * index is a derived artifact: a numbered migration fires exactly once and can
 * therefore never repair a table or trigger that was dropped afterwards (by an
 * operator poking at the db, by a restored backup taken mid-migration, or by a
 * future rebuild of `channel_messages` — the v2 lane already drops and renames
 * that table, and a DROP takes its triggers with it). Detect-and-rebuild is
 * cheap: two `sqlite_master` lookups on a healthy db, and a full reindex only
 * when something is actually missing.
 *
 * Idempotent by construction — a healthy db returns before touching anything,
 * and the repair path is delete-all + backfill, so running it twice produces
 * the same index as running it once.
 *
 * "Healthy" is table + all three triggers + a marker row that says the last
 * backfill FINISHED. Structure alone is not enough: the backfill commits in
 * bounded batches (below), so `table + triggers + half an index` is reachable
 * whenever the process dies mid-backfill — an OOM kill or a systemd restart on
 * the boot path, which is precisely where this runs. Batches walk rowid
 * ascending, so what a truncated backfill is missing is the NEWEST messages,
 * and nothing about the schema would ever say so.
 *
 * The repair is two phases on purpose. The DDL, the truncate and the `building`
 * marker commit FIRST, as one transaction, so the sync triggers are live for
 * the whole backfill and a row appended mid-rebuild is indexed by them (the
 * backfill's persisted snapshot bound keeps the two from overlapping). The
 * backfill then runs in bounded commits OUTSIDE that transaction — the previous
 * single-transaction form held one writer over the entire tokenization pass
 * (measured ~4s per 50k messages, so ~16s of silent stall on a 200k-message
 * store) with nothing in the journal to explain the pause.
 *
 * An interrupted backfill RESUMES from its cursor rather than restarting: a
 * store big enough for the pass to be interrupted is a store big enough for
 * restart-from-zero to be interrupted again at the same place, so restarting
 * would make a crash-looping hub never converge. Row counts and elapsed time
 * are logged on every path.
 */
function ensureChannelSearchIndex(db: Database.Database): void {
  db.exec(CHANNEL_SEARCH_STATE_SCHEMA_SQL);
  const hasTable = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(CHANNEL_SEARCH_TABLE);
  const triggerCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
          WHERE type = 'trigger'
            AND name IN (${CHANNEL_SEARCH_TRIGGERS.map(() => '?').join(', ')})`
      )
      .get(...CHANNEL_SEARCH_TRIGGERS) as { count: number }
  ).count;
  const structurallyIntact =
    Boolean(hasTable) && triggerCount === CHANNEL_SEARCH_TRIGGERS.length;
  // Only an intact structure can carry a trustworthy marker: if the table or a
  // trigger is gone, whatever the marker claims describes an index that no
  // longer exists (or stopped being maintained), so it is not read at all.
  const marker = structurallyIntact ? readChannelSearchIndexState(db) : null;
  if (marker?.status === 'complete') return;

  const sourceRows = (
    db.prepare('SELECT COUNT(*) AS count FROM channel_messages').get() as {
      count: number;
    }
  ).count;
  const startedAt = Date.now();
  // Resume only when the structure is intact AND a claim exists: a missing
  // marker under an intact structure is a pre-marker db (or a hand-edited one),
  // whose index cannot be trusted to line up with any cursor — rebuild it.
  const resuming = structurallyIntact && marker !== null;
  if (resuming) {
    logger.info(
      'channel search index backfill was interrupted; resuming from rowid %d through %d over %d message row(s)',
      marker.indexedThroughRowid,
      marker.snapshotMaxRowid,
      sourceRows
    );
  } else {
    logger.info(
      'channel search index missing; backfilling over %d message row(s)',
      sourceRows
    );
  }
  // One line per commit only once the store is big enough for the rebuild to be
  // felt; below one batch the start/finish pair already says everything.
  const onBatch =
    sourceRows > CHANNEL_SEARCH_BACKFILL_BATCH_ROWS
      ? (progress: { scannedThrough: number; indexed: number }) =>
          logger.info(
            'channel search backfill: %d row(s) indexed through rowid %d',
            progress.indexed,
            progress.scannedThrough
          )
      : undefined;
  const indexed = resuming
    ? runChannelSearchBackfill(db, marker, onBatch)
    : rebuildChannelSearchIndex(db, onBatch);
  logger.info(
    'channel search index rebuilt over %d message row(s) (%d indexed) in %dms',
    sourceRows,
    indexed,
    Date.now() - startedAt
  );
}

/**
 * Run the pre-v2 Claude echo alias repair once per database (#1207, #1209).
 *
 * Gated on a marker ROW, not on a `schema_version` step. The v2 lane welded the
 * heal to the CHECK-widening rebuild, so it could only ever fire on the single
 * boot that carried a db across the 1 -> 2 boundary; a db that arrived at v2 or
 * later without that exact lane executing its heal could never heal again, and
 * printed nothing to say so. Version numbers describe SHAPE, and the shape was
 * already correct — what was missing was a repair, which is state.
 *
 * The WAL hypothesis in #1209 is refuted (see the migration tests): the old v2
 * lane read the duplicate rows itself when it copied them into
 * `channel_messages_v2`, then healed the renamed table in the SAME transaction
 * on the SAME connection, so any row that survived the rebuild was by
 * definition visible to the heal. A hot, uncheckpointed WAL copy heals
 * normally. (The issue's second suspect — a concurrent writer holding the db —
 * is untested here, but it cannot produce the reported outcome either: rows the
 * rebuild did not see would not be in the table afterwards, and the reported
 * db still had them.)
 *
 * This is a bounded historical repair, not an every-boot sweep. On a db that
 * has already run it the whole cost is one primary-key lookup; on one that has
 * not, an `EXISTS` probe short-circuits on the first matching pair (or scans
 * once, ever, and writes the marker).
 *
 * When there IS work, the FTS index is torn down first and rebuilt afterwards
 * by `ensureChannelSearchIndex`. Healing renumbers `seq` for every row of an
 * affected channel, so leaving the sync triggers live would fire one FTS delete
 * plus one re-insert per row inside this transaction — the exact unbounded
 * tokenization stall the batched backfill exists to avoid — and would hard-fail
 * the boot on a db whose FTS table was dropped while its triggers survived.
 */
function ensureLegacyClaudeEchoHeal(db: Database.Database): void {
  db.exec(CHANNEL_HEAL_STATE_SCHEMA_SQL);
  const done = db
    .prepare(`SELECT 1 FROM ${CHANNEL_HEAL_STATE_TABLE} WHERE heal_id = ?`)
    .get(CLAUDE_ECHO_HEAL_ID);
  if (done) return;
  const hasCandidates = db.prepare(
    `SELECT EXISTS (${LEGACY_CLAUDE_ECHO_CANDIDATE_SQL}) AS present`
  );
  const recordPass = db.prepare(
    `INSERT INTO ${CHANNEL_HEAL_STATE_TABLE}
       (heal_id, completed_at, candidates, healed)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(heal_id) DO UPDATE SET
       completed_at = excluded.completed_at,
       candidates   = excluded.candidates,
       healed       = excluded.healed`
  );
  const result = db.transaction((): LegacyClaudeEchoHealResult => {
    const pending = (hasCandidates.get() as { present: number }).present === 1;
    let pass: LegacyClaudeEchoHealResult = { candidates: 0, healed: 0 };
    if (pending) {
      for (const trigger of CHANNEL_SEARCH_TRIGGERS) {
        db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      }
      db.exec(`DROP TABLE IF EXISTS ${CHANNEL_SEARCH_TABLE}`);
      pass = healLegacyClaudeEchoAliases(db);
    }
    recordPass.run(
      CLAUDE_ECHO_HEAL_ID,
      new Date().toISOString(),
      pass.candidates,
      pass.healed
    );
    return pass;
  })();
  // Logged on every path, including a ZERO pass: this runs at most once per db,
  // so it is one line per db — not boot noise — and it is the difference between
  // "the repair ran" and "the repair healed", which #1209 could not tell apart.
  logger.info(
    'channel Claude echo alias heal: %d candidate pair(s) matched, %d duplicate row(s) removed',
    result.candidates,
    result.healed
  );
}

/**
 * Vendor framework id of a DEFAULT built-in profile Actor id
 * (`agent-profile:<vendor>:default`), or `undefined` for anything else —
 * including a non-default profile of the same vendor, which is its own
 * participant. Used only to fold the two spellings of one built-in agent
 * together for membership matching (#1455 slice 1).
 */
function defaultProfileVendorId(id: string): string | undefined {
  const vendor = parseAgentProfileProviderId(id);
  if (!vendor) return undefined;
  return id === builtInAgentProfileId(vendor) ? vendor : undefined;
}

/**
 * The single value that identifies one PARTICIPANT, collapsing every spelling
 * `memberMatchParams` matches (#1455 slice 2).
 *
 * Membership is decided on a fold, but rows are stored verbatim and every
 * primary-key write collides only on an exact id. Removal therefore has to be a
 * property of the fold CLASS, not of the rows that happened to exist when it
 * ran: otherwise an implicit writer arriving under the participant's OTHER
 * spelling (`deriveSender` stamps `agent:<actor>`, the bridge and binder use
 * the bare profile Actor id) inserts a brand-new LIVE row and silently
 * re-admits an agent that was removed. That is not hypothetical — binding
 * bookkeeping alone re-enrolls on cursor advance, session persist, unbind, and
 * restart.
 */
export function memberFoldKey(kind: 'human' | 'agent', id: string): string {
  // Human ids never fold: `canonicalChannelMemberId` only strips `agent:`.
  if (kind !== 'agent') return id;
  const canonical = canonicalChannelMemberId(id);
  return defaultProfileVendorId(canonical) ?? canonical;
}

/**
 * Derive channel membership from durable participation history (#1455 slice 1).
 *
 * Membership became authoritative AFTER channels already existed, so the table
 * has to be seeded from what the database can still prove about who took part:
 * every non-system sender in `channel_messages`, plus every profile with a
 * durable `channel_agent_bindings` row (a bound agent is a participant even in
 * a channel where it has not yet emitted a durable message — the binder is
 * about to drive its turns there).
 *
 * `INSERT OR IGNORE` makes this idempotent and race-safe: an explicit member
 * row already written by the live path always wins, and running the pass twice
 * inserts nothing the second time. `joined_at` is the FIRST message that
 * participant sent, not `now`, so a backfilled row keeps a truthful ordering.
 *
 * It writes ONLY rows that are missing. It deliberately does not touch
 * `invited_by` on rows that already exist — relabelling a live row `backfill`
 * would destroy exactly the attribution this column was added to keep. The
 * one-time relabel of pre-v17 rows lives in the v17 migration, where it is
 * correct because nothing else has run yet.
 */
export function backfillChannelMembership(
  db: Database.Database,
  options: {
    /**
     * Include the sender-derived half. TRUE for the v17 migration, which is
     * the one moment history has to be reconstructed. FALSE for the boot
     * reconciliation: that pass exists only to repair a binding whose
     * membership mirror was lost, and the sender-derived statement is a linear
     * `channel_messages` scan (no index covers
     * `(channel_id, sender_kind, sender_id)`) — hundreds of milliseconds on a
     * large transcript, paid before the hub listens, to re-derive rows the
     * migration already wrote once.
     */
    includeMessageSenders?: boolean;
  } = {}
): {
  inserted: number;
} {
  const includeMessageSenders = options.includeMessageSenders ?? true;
  const inserter = db.transaction(() => {
    const fromMessages = !includeMessageSenders
      ? 0
      : db
          .prepare(
            `INSERT OR IGNORE INTO channel_members
           (channel_id, member_kind, member_id, joined_at, metadata_json, invited_by)
         SELECT channel_id, sender_kind, sender_id, MIN(created_at), '{}', @inviter
           FROM channel_messages
          WHERE sender_kind IN ('human','agent')
          GROUP BY channel_id, sender_kind, sender_id`
          )
          .run({ inviter: CHANNEL_MEMBERSHIP_BACKFILL_INVITER }).changes;
    const fromBindings = db
      .prepare(
        `INSERT OR IGNORE INTO channel_members
           (channel_id, member_kind, member_id, joined_at, metadata_json, invited_by)
         SELECT channel_id, 'agent', profile_actor_id, MIN(created_at), '{}', @inviter
           FROM channel_agent_bindings
          GROUP BY channel_id, profile_actor_id`
      )
      .run({ inviter: CHANNEL_MEMBERSHIP_BACKFILL_INVITER }).changes;
    // The two statements above insert VERBATIM spellings with `INSERT OR
    // IGNORE`, which collides only on an exact primary key — so a channel that
    // removed a participant can gain a fresh LIVE row for that same
    // participant's other spelling. Restore the class invariant (every row in
    // one fold class shares one removal state) before returning.
    //
    // Scoped to channels that actually contain a tombstone, which is normally
    // none — and `idx_chmem_removed` is a partial index over exactly those
    // rows, so the common path is an empty indexed probe rather than a scan.
    repairRemovedMemberClasses(db);
    return fromMessages + fromBindings;
  });
  return { inserted: inserter() };
}

/**
 * Re-tombstone any live member row whose fold class was removed (#1455 slice 2).
 *
 * The class invariant is that every stored spelling of one participant shares
 * one removal state. `inviteMember` clears a whole class and `removeMember`
 * tombstones a whole class, so only a raw `INSERT` can break it — the two
 * `backfillChannelMembership` statements, which are SQL over history and cannot
 * consult the fold.
 */
function repairRemovedMemberClasses(db: Database.Database): void {
  // The v17 migration calls the backfill BEFORE v18 adds the removal columns,
  // and no tombstone can exist at that point anyway — v17 predates removal.
  const columns = db
    .prepare('PRAGMA table_info(channel_members)')
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'removed_at')) return;
  const rows = db
    .prepare(
      `SELECT channel_id, member_kind, member_id, removed_at, removed_by
         FROM channel_members
        WHERE member_kind = 'agent'
          AND channel_id IN (
            SELECT channel_id FROM channel_members
             WHERE member_kind = 'agent' AND removed_at IS NOT NULL
          )
        ORDER BY removed_at ASC`
    )
    .all() as MemberRow[];
  if (rows.length === 0) return;
  const classes = new Map<string, MemberRow[]>();
  for (const row of rows) {
    const key = `${row.channel_id}\u0000${memberFoldKey('agent', row.member_id)}`;
    const bucket = classes.get(key);
    if (bucket) bucket.push(row);
    else classes.set(key, [row]);
  }
  const tombstone = db.prepare(
    `UPDATE channel_members
        SET removed_at = @removedAt, removed_by = @removedBy
      WHERE channel_id = @channelId
        AND member_kind = 'agent'
        AND member_id = @memberId`
  );
  for (const bucket of classes.values()) {
    // Rows arrive ordered by `removed_at`, so a class carrying more than one
    // tombstone deterministically inherits the EARLIEST — the removal that
    // actually took this participant out of the room.
    const removed = bucket.find((row) => row.removed_at !== null);
    if (!removed) continue;
    for (const row of bucket) {
      if (row.removed_at !== null) continue;
      tombstone.run({
        channelId: row.channel_id,
        memberId: row.member_id,
        removedAt: removed.removed_at,
        removedBy: removed.removed_by,
      });
    }
  }
}

function runMigrations(db: Database.Database): void {
  runSchemaMigrations(db);
  // Repair legacy/hand-built schema-version rows that predate index backstops.
  // Mention-context budgeting is only a work bound when its boundary probe is an
  // indexed range read, so prepare-time `INDEXED BY` must fail neither open nor
  // on an otherwise readable older database.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chm_channel_seq
      ON channel_messages(channel_id, seq);
    CREATE INDEX IF NOT EXISTS idx_chm_thread
      ON channel_messages(thread_id, seq) WHERE thread_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chmem_removed
      ON channel_members(channel_id) WHERE removed_at IS NOT NULL;
  `);
  db.exec(CHANNEL_READ_STATE_SCHEMA_SQL);
  // Order matters both ways: the heal translates `channel_read_state` (created
  // above) and may drop the search index, which `ensureChannelSearchIndex`
  // (below) then rebuilds in bounded batches.
  ensureLegacyClaudeEchoHeal(db);
  ensureChannelSearchIndex(db);
}

function runSchemaMigrations(db: Database.Database): void {
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
    db.transaction(() => {
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

      // The Claude echo alias heal used to live HERE, inside the rebuild. It
      // now runs from `runMigrations` behind its own marker row: welding it to
      // this one-shot lane is what made #1209 unrecoverable, and the rebuild
      // itself has nothing to do with the duplicates.
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
    })();
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
  if (current < 6) {
    db.transaction(() => {
      // Search index (#1308 slice 2 item 1). This step only DROPS whatever an
      // earlier version left behind and records the version — the table, the
      // triggers and the backfill are built by `ensureChannelSearchIndex`,
      // which runs unconditionally on every open so a dropped index is
      // repaired rather than being stranded behind a one-shot migration.
      // Dropping here is what makes an upgrade re-derive the index under the
      // CURRENT tokenizer/predicate instead of inheriting an older shape.
      //
      // Ordering note: this is the LAST numbered step, so it always runs after
      // the v2 lane's `DROP TABLE channel_messages` / rename. The v2 rebuild
      // therefore can never destroy triggers this step created — at v2 time no
      // FTS object exists yet — and a fresh db skips both by jumping straight
      // to SCHEMA_VERSION.
      for (const trigger of CHANNEL_SEARCH_TRIGGERS) {
        db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      }
      db.exec(`DROP TABLE IF EXISTS ${CHANNEL_SEARCH_TABLE}`);
      db.prepare('UPDATE schema_version SET version = 6').run();
    })();
  }
  if (current < 7) {
    db.transaction(() => {
      // The runtime registry is intentionally ephemeral across hub restarts.
      // Persist the participant role on the binding so an orchestrator remains
      // designated even when runtime_id no longer resolves to a live handle.
      const hasBindingRole = (
        db.prepare(`PRAGMA table_info(channel_agent_bindings)`).all() as Array<{
          name: string;
        }>
      ).some((column) => column.name === 'binding_role');
      if (!hasBindingRole) {
        db.exec(
          'ALTER TABLE channel_agent_bindings ADD COLUMN binding_role TEXT'
        );
      }
      db.prepare('UPDATE schema_version SET version = 7').run();
    })();
  }
  if (current < 8) {
    db.transaction(() => {
      const duplicates = db
        .prepare(
          `SELECT channel_id, COUNT(*) AS binding_count
             FROM channel_agent_bindings
            WHERE binding_role = 'orchestrator'
            GROUP BY channel_id
           HAVING COUNT(*) > 1`
        )
        .all() as Array<{ channel_id: string; binding_count: number }>;
      if (duplicates.length > 0) {
        const clear = db.prepare(
          `UPDATE channel_agent_bindings
              SET binding_role = NULL
            WHERE channel_id = ? AND binding_role = 'orchestrator'`
        );
        let clearedBindings = 0;
        for (const duplicate of duplicates) {
          clearedBindings += clear.run(duplicate.channel_id).changes;
        }
        // Neither channel nor profile ids belong in migration telemetry.
        logger.warn(
          'cleared ambiguous legacy orchestrator designations before sole-role migration: channel_count=%d binding_count=%d',
          duplicates.length,
          clearedBindings
        );
      }
      db.exec(`
        DROP INDEX IF EXISTS idx_chab_sole_orchestrator;
        CREATE UNIQUE INDEX idx_chab_sole_orchestrator
          ON channel_agent_bindings(channel_id)
          WHERE binding_role = 'orchestrator';
      `);
      db.prepare('UPDATE schema_version SET version = 8').run();
    })();
  }
  if (current < 9) {
    db.transaction(() => {
      // Completion callbacks are an outbox-like one-shot ledger. It is a
      // separate table rather than message meta because an edge has its own
      // guarded lifecycle and must survive a hub restart even when the target
      // produced no terminal chat row.
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_completion_callbacks (
          id                    TEXT PRIMARY KEY,
          channel_id            TEXT NOT NULL,
          thread_id             TEXT,
          trigger_message_id    TEXT NOT NULL,
          requester_profile_id  TEXT NOT NULL,
          target_profile_id     TEXT NOT NULL,
          target_runtime_id     TEXT NOT NULL,
          target_turn_id        TEXT NOT NULL,
          state                 TEXT NOT NULL
                                  CHECK (state IN ('pending','satisfied','delivered','consumed')),
          terminal_reason       TEXT,
          terminal_message_id   TEXT,
          message_disposition   TEXT,
          created_at            TEXT NOT NULL,
          satisfied_at          TEXT,
          delivered_at          TEXT,
          consumed_at           TEXT,
          updated_at            TEXT NOT NULL,
          UNIQUE(channel_id, target_profile_id, target_turn_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chcc_recovery
          ON channel_completion_callbacks(state, created_at)
          WHERE state IN ('pending','satisfied','delivered');
        CREATE INDEX IF NOT EXISTS idx_chcc_target_turn
          ON channel_completion_callbacks(channel_id, target_profile_id, target_turn_id);
      `);
      db.prepare('UPDATE schema_version SET version = 9').run();
    })();
  }
  if (current < 10) {
    db.transaction(() => {
      // Preserve the one-shot state machine while making ancestry durable.
      // These columns allow A→B→C to return C→B→A without turning B's
      // original terminal patch into a premature callback to A.
      const columns = db
        .prepare(`PRAGMA table_info(channel_completion_callbacks)`)
        .all() as Array<{
        name: string;
      }>;
      if (
        !columns.some(
          (column) => column.name === 'continuation_parent_callback_id'
        )
      ) {
        db.exec(
          'ALTER TABLE channel_completion_callbacks ADD COLUMN continuation_parent_callback_id TEXT'
        );
      }
      if (!columns.some((column) => column.name === 'awaiting_child')) {
        db.exec(
          'ALTER TABLE channel_completion_callbacks ADD COLUMN awaiting_child INTEGER NOT NULL DEFAULT 0'
        );
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chcc_continuation_parent
          ON channel_completion_callbacks(continuation_parent_callback_id)
          WHERE continuation_parent_callback_id IS NOT NULL;
      `);
      db.prepare('UPDATE schema_version SET version = 10').run();
    })();
  }
  if (current < 11) {
    db.transaction(() => {
      const columns = db
        .prepare(`PRAGMA table_info(channel_completion_callbacks)`)
        .all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'pending_child_intents')) {
        db.exec(
          'ALTER TABLE channel_completion_callbacks ADD COLUMN pending_child_intents INTEGER NOT NULL DEFAULT 0'
        );
      }
      if (
        !columns.some((column) => column.name === 'continuation_completed_at')
      ) {
        db.exec(
          'ALTER TABLE channel_completion_callbacks ADD COLUMN continuation_completed_at TEXT'
        );
      }
      db.prepare('UPDATE schema_version SET version = 11').run();
    })();
  }
  if (current < 12) {
    db.transaction(() => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chcc_consumed_retention
          ON channel_completion_callbacks(consumed_at)
          WHERE state = 'consumed';
      `);
      db.prepare('UPDATE schema_version SET version = 12').run();
    })();
  }
  if (current < 13) {
    db.transaction(() => {
      // A root-channel binding was the whole pre-#1386 contract. Preserve every
      // one under the explicit empty scope before making thread identity part of
      // the primary key; NULL would not make ON CONFLICT deterministic in SQLite.
      db.exec(`
        DROP INDEX IF EXISTS idx_chab_sole_orchestrator;
        CREATE TABLE channel_agent_bindings_v13 (
          channel_id            TEXT NOT NULL,
          thread_scope_id       TEXT NOT NULL DEFAULT '',
          profile_actor_id      TEXT NOT NULL,
          agent_framework       TEXT NOT NULL,
          runtime_id            TEXT,
          binding_role          TEXT,
          provider_session_json TEXT NOT NULL DEFAULT '{}',
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL,
          PRIMARY KEY (channel_id, thread_scope_id, profile_actor_id)
        );
        INSERT INTO channel_agent_bindings_v13
          (channel_id, thread_scope_id, profile_actor_id, agent_framework,
           runtime_id, binding_role, provider_session_json, created_at, updated_at)
        SELECT channel_id, '', profile_actor_id, agent_framework,
               runtime_id, binding_role, provider_session_json, created_at, updated_at
          FROM channel_agent_bindings;
        DROP TABLE channel_agent_bindings;
        ALTER TABLE channel_agent_bindings_v13 RENAME TO channel_agent_bindings;
        CREATE UNIQUE INDEX idx_chab_sole_orchestrator
          ON channel_agent_bindings(channel_id)
          WHERE binding_role = 'orchestrator' AND thread_scope_id = '';

        CREATE TABLE IF NOT EXISTS channel_threads (
          channel_id      TEXT NOT NULL,
          root_message_id TEXT NOT NULL,
          title           TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          PRIMARY KEY (channel_id, root_message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_channel_threads_recent
          ON channel_threads(channel_id, updated_at DESC);

        INSERT OR IGNORE INTO channel_threads
          (channel_id, root_message_id, title, created_at, updated_at)
        SELECT root.channel_id,
               root.id,
               COALESCE(NULLIF(TRIM(SUBSTR(root.body_text, 1, 160)), ''),
                        '${DEFAULT_THREAD_TITLE}'),
               root.created_at,
               root.updated_at
          FROM channel_messages root
         WHERE root.thread_id IS NULL
           AND EXISTS (
             SELECT 1 FROM channel_messages reply
              WHERE reply.channel_id = root.channel_id
                AND reply.thread_id = root.id
           );
      `);
      db.prepare('UPDATE schema_version SET version = 13').run();
    })();
  }
  if (current < 14) {
    db.transaction(() => {
      // SQLite CHECK constraints cannot be widened in place. Rebuild the
      // callback ledger atomically so existing recovery rows keep every durable
      // identity and terminal fact while a new non-delivery terminal state is
      // introduced. This is intentionally a state-machine migration, not a
      // reinterpretation of `consumed`: no requester adapter accepted the
      // callback, so claiming it consumed would fabricate an acknowledgement.
      db.exec(`
        DROP INDEX IF EXISTS idx_chcc_recovery;
        DROP INDEX IF EXISTS idx_chcc_target_turn;
        DROP INDEX IF EXISTS idx_chcc_continuation_parent;
        DROP INDEX IF EXISTS idx_chcc_consumed_retention;
        DROP INDEX IF EXISTS idx_chcc_settled_retention;
        CREATE TABLE channel_completion_callbacks_v14 (
          id                    TEXT PRIMARY KEY,
          channel_id            TEXT NOT NULL,
          thread_id             TEXT,
          trigger_message_id    TEXT NOT NULL,
          requester_profile_id  TEXT NOT NULL,
          target_profile_id     TEXT NOT NULL,
          target_runtime_id     TEXT NOT NULL,
          target_turn_id        TEXT NOT NULL,
          continuation_parent_callback_id TEXT,
          awaiting_child        INTEGER NOT NULL DEFAULT 0 CHECK (awaiting_child IN (0, 1)),
          pending_child_intents INTEGER NOT NULL DEFAULT 0,
          continuation_completed_at TEXT,
          state                 TEXT NOT NULL
                                CHECK (state IN ('pending','satisfied','delivered','consumed','undeliverable')),
          terminal_reason       TEXT,
          terminal_message_id   TEXT,
          message_disposition   TEXT,
          delivery_reason       TEXT,
          created_at            TEXT NOT NULL,
          satisfied_at          TEXT,
          delivered_at          TEXT,
          consumed_at           TEXT,
          undeliverable_at      TEXT,
          updated_at            TEXT NOT NULL,
          UNIQUE(channel_id, target_profile_id, target_turn_id)
        );
        INSERT INTO channel_completion_callbacks_v14 (
          id, channel_id, thread_id, trigger_message_id, requester_profile_id,
          target_profile_id, target_runtime_id, target_turn_id,
          continuation_parent_callback_id, awaiting_child, pending_child_intents,
          continuation_completed_at, state, terminal_reason, terminal_message_id,
          message_disposition, delivery_reason, created_at, satisfied_at,
          delivered_at, consumed_at, undeliverable_at, updated_at
        )
        SELECT id, channel_id, thread_id, trigger_message_id, requester_profile_id,
               target_profile_id, target_runtime_id, target_turn_id,
               continuation_parent_callback_id, awaiting_child, pending_child_intents,
               continuation_completed_at, state, terminal_reason, terminal_message_id,
               message_disposition, NULL, created_at, satisfied_at,
               delivered_at, consumed_at, NULL, updated_at
          FROM channel_completion_callbacks;
        DROP TABLE channel_completion_callbacks;
        ALTER TABLE channel_completion_callbacks_v14 RENAME TO channel_completion_callbacks;
        CREATE INDEX idx_chcc_recovery
          ON channel_completion_callbacks(state, created_at)
          WHERE state IN ('pending','satisfied','delivered');
        CREATE INDEX idx_chcc_target_turn
          ON channel_completion_callbacks(channel_id, target_profile_id, target_turn_id);
        CREATE INDEX idx_chcc_continuation_parent
          ON channel_completion_callbacks(continuation_parent_callback_id)
          WHERE continuation_parent_callback_id IS NOT NULL;
        CREATE INDEX idx_chcc_settled_retention
          ON channel_completion_callbacks(state, consumed_at, undeliverable_at)
          WHERE state IN ('consumed','undeliverable');
      `);
      db.prepare('UPDATE schema_version SET version = 14').run();
    })();
  }
  if (current < 15) {
    db.transaction(() => {
      // Run records are a separate durable projection: message sequence remains
      // the subscription cursor, while lifecycle may change in place without
      // inventing provider ids or a second transcript row.
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_async_runs (
          id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_id TEXT,
          request_message_id TEXT NOT NULL UNIQUE, requester_id TEXT NOT NULL,
          state TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_char_channel_thread_created
          ON channel_async_runs(channel_id, thread_id, created_at);
        CREATE TABLE IF NOT EXISTS channel_async_run_targets (
          run_id TEXT NOT NULL, target_id TEXT NOT NULL, state TEXT NOT NULL,
          reason TEXT, approval_state TEXT, updated_at TEXT NOT NULL,
          completed_at TEXT, PRIMARY KEY(run_id, target_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chart_run_state
          ON channel_async_run_targets(run_id, state);
      `);
      db.prepare('UPDATE schema_version SET version = 15').run();
    })();
  }
  if (current < 16) {
    db.transaction(() => {
      // SQLite CHECK constraints and index key order require a rebuild. Keep
      // the v15 rows verbatim while making illegal target states impossible.
      db.exec(`
        DROP INDEX IF EXISTS idx_char_channel_thread_created;
        CREATE TABLE channel_async_runs_v16 (
          id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_id TEXT,
          request_message_id TEXT NOT NULL UNIQUE, requester_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('submitted','working','input-required','auth-required','completed','failed','cancelled','rejected')),
          reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        INSERT INTO channel_async_runs_v16 SELECT * FROM channel_async_runs;
        DROP TABLE channel_async_runs;
        ALTER TABLE channel_async_runs_v16 RENAME TO channel_async_runs;
        CREATE INDEX idx_char_channel_created
          ON channel_async_runs(channel_id, created_at, id);
        CREATE TABLE channel_async_run_targets_v16 (
          run_id TEXT NOT NULL, target_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued','working','input-required','auth-required','completed','failed','cancelled','rejected')),
          reason TEXT, approval_state TEXT, updated_at TEXT NOT NULL,
          completed_at TEXT, PRIMARY KEY(run_id, target_id)
        );
        INSERT INTO channel_async_run_targets_v16 SELECT * FROM channel_async_run_targets;
        DROP TABLE channel_async_run_targets;
        ALTER TABLE channel_async_run_targets_v16 RENAME TO channel_async_run_targets;
        CREATE INDEX idx_chart_run_state
          ON channel_async_run_targets(run_id, state);
      `);
      db.prepare('UPDATE schema_version SET version = 16').run();
    })();
  }
  if (current < 17) {
    db.transaction(() => {
      // #1455 slice 1: membership becomes the hub's authorization record for
      // the actor lane. Adding the column is additive; the backfill in the same
      // transaction is what keeps every channel that already exists working
      // through the flip — without it, the first request after upgrade would
      // reject every agent in every channel.
      const columns = db
        .prepare(`PRAGMA table_info(channel_members)`)
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'invited_by')) {
        db.exec('ALTER TABLE channel_members ADD COLUMN invited_by TEXT');
      }
      backfillChannelMembership(db);
      // One-time, and correct ONLY here: every row predating this migration was
      // written before the column existed, so none of them can be attributed to
      // a real inviter. Leaving them NULL would make "unattributed" and "never
      // audited" indistinguishable for slice 2's invite audit.
      db.prepare(
        `UPDATE channel_members SET invited_by = @inviter WHERE invited_by IS NULL`
      ).run({ inviter: CHANNEL_MEMBERSHIP_BACKFILL_INVITER });
      db.prepare('UPDATE schema_version SET version = 17').run();
    })();
  }
  if (current < 18) {
    db.transaction(() => {
      // #1455 slice 2: `channels.remove-member` needs removal to be a durable
      // FACT, not the absence of a row — `backfillMembership` and the implicit
      // writers would otherwise re-create what was just removed. Purely
      // additive: existing rows read back as live members (both columns NULL).
      const columns = db
        .prepare(`PRAGMA table_info(channel_members)`)
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'removed_at')) {
        db.exec('ALTER TABLE channel_members ADD COLUMN removed_at TEXT');
      }
      if (!columns.some((column) => column.name === 'removed_by')) {
        db.exec('ALTER TABLE channel_members ADD COLUMN removed_by TEXT');
      }
      db.prepare('UPDATE schema_version SET version = 18').run();
    })();
  }
}

export function initChannelMessageStore(
  configDir: string
): ChannelMessageStore {
  const store = createChannelMessageStore(
    path.join(configDir, 'channel-chat.db')
  );
  // Only the hub owner observes a restart. Additional handles must not cancel
  // work which is still live in the owner process.
  store.recoverAsyncRuns();
  return store;
}

export interface ChannelMessageStoreOptions {
  /**
   * Raw timeline candidates examined by one mention-context query. The default
   * is `MENTION_CONTEXT_CANDIDATE_SCAN_BUDGET`; tests may lower it to prove the
   * deterministic degradation path without machine-dependent timing.
   */
  mentionContextCandidateScanBudget?: number;
  /**
   * Wall-clock ceiling for one ranked index read, in milliseconds. Defaults to
   * `CHANNEL_SEARCH_TIME_BUDGET_MS`.
   *
   * Overridable because the ceiling is otherwise only provable by a latency
   * assertion, and a latency assertion is exactly the kind of test a faster CI
   * box deletes silently — the same reasoning that made the minimum-length
   * guard assert on the EXPRESSION rather than on milliseconds. A test sets
   * `0` and gets a deterministic `search_timeout` on the first matched row.
   */
  searchTimeBudgetMs?: number;
  /**
   * State of the pre-flight cost gate. `'auto'` (default) builds the `fts5vocab`
   * view and gates on it; `'unavailable'` reproduces the DEGRADED state the
   * store falls into when that view cannot be built.
   *
   * A state rather than an on/off switch, and present for one reason: failing
   * open is a documented contract, and an undocumented untested fallback is how
   * a guard quietly stops being one. The degraded path is not equivalent to the
   * guarded path — the wall-clock ceiling is a per-row hook, so a zero-row query
   * is unbounded without the pre-flight — so what it actually does deserves an
   * assertion instead of a comment.
   */
  searchCostPreflight?: 'auto' | 'unavailable';
}

export function createChannelMessageStore(
  dbPath: string,
  options: ChannelMessageStoreOptions = {}
): ChannelMessageStore {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const mentionContextCandidateScanBudget =
    options.mentionContextCandidateScanBudget ??
    MENTION_CONTEXT_CANDIDATE_SCAN_BUDGET;
  if (
    !Number.isSafeInteger(mentionContextCandidateScanBudget) ||
    mentionContextCandidateScanBudget < 1 ||
    mentionContextCandidateScanBudget > MENTION_CONTEXT_CANDIDATE_SCAN_BUDGET
  ) {
    throw new RangeError(
      `mentionContextCandidateScanBudget must be an integer from 1 through ${MENTION_CONTEXT_CANDIDATE_SCAN_BUDGET}`
    );
  }

  // ── search cost guards (#1316) ────────────────────────────────────────────
  const searchTimeBudgetMs =
    options.searchTimeBudgetMs ?? CHANNEL_SEARCH_TIME_BUDGET_MS;
  // Deadline for the read currently inside `.all()`. A single mutable value is
  // safe precisely because better-sqlite3 is synchronous: nothing else on this
  // thread can start a second read while one is running, which is the same
  // property that makes the ceiling necessary in the first place.
  let searchDeadline = Number.POSITIVE_INFINITY;
  registerChannelSearchTick(db, () => Date.now() >= searchDeadline);
  // Created AFTER `runMigrations`, so the FTS table it reads through already
  // exists on a fresh db. Failure is not fatal, but it is not harmless either:
  // the pre-flight is the ONLY bound on a prefix that emits no rows (see
  // `CHANNEL_SEARCH_PREFIX_DOC_BUDGET`), so a store running without it is back
  // to pre-#1316 behaviour for that shape. Degraded, and logged as such.
  let searchVocab: Database.Statement | null = null;
  if (options.searchCostPreflight !== 'unavailable') {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${CHANNEL_SEARCH_VOCAB_TABLE}
         USING fts5vocab(main, ${CHANNEL_SEARCH_TABLE}, row)`
      );
      searchVocab = db.prepare(
        `SELECT doc FROM ${CHANNEL_SEARCH_VOCAB_TABLE}
        WHERE term >= ? AND term < ?`
      );
    } catch (error) {
      logger.warn(
        'channel search cost pre-flight unavailable (%s); prefix cost is now bounded only by the wall-clock ceiling, which does not cover zero-row queries',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Refusal telemetry. `CHANNEL_SEARCH_PREFIX_TERM_BUDGET` is an absolute term
  // count measured against one corpus, while prefix expansion grows with
  // vocabulary — so the failure mode of a stale budget is ordinary prefixes
  // silently refusing, on every keystroke of a live search, with no signal that
  // the GUARD rather than the corpus is the cause. Counting refusals and
  // surfacing the rate is what makes that transition visible. Throttled to one
  // line a minute (carrying the count since the last line) so a debounced live
  // search cannot turn the signal into a flood.
  let searchRefusals = 0;
  let searchRefusalsAtLastLog = 0;
  let searchRefusalLoggedAt = 0;
  const SEARCH_REFUSAL_LOG_INTERVAL_MS = 60_000;
  // Latched so a persistent pre-flight fault (a dropped index, a corrupt
  // vocabulary) reports once rather than once per keystroke. The condition is a
  // property of the store, not of the query, so repeating it per call adds
  // volume without adding information.
  let searchPreflightFaultLogged = false;

  /**
   * Refuse a prefix whose expansion this corpus cannot afford, BEFORE reading.
   *
   * Walks the term index over the prefix range and stops at the first budget it
   * blows. Both budgets are also the walk's own bound, so the check costs at
   * most `CHANNEL_SEARCH_PREFIX_TERM_BUDGET` b-tree steps no matter how large
   * the transcript grows (measured ≤6ms at 1025 terms).
   *
   * Fails OPEN on any error. `fts5vocab` reads the index by name at query time,
   * so a mid-rebuild window (`rebuildChannelSearchIndex` drops and recreates
   * the table) surfaces as `no such fts5 table` — and a store that cannot cost
   * a query must still answer it. Note what "open" costs here: the wall-clock
   * ceiling is a per-ROW hook, so it does not cover a query that returns no
   * rows. Failing open is the right call for a transient rebuild window and a
   * real regression if it becomes permanent, which is why it is logged rather
   * than swallowed.
   */
  function refuseOverBroadPrefix(raw: string): void {
    if (!searchVocab) return;
    const range = channelSearchPrefixRange(raw);
    if (!range) return;
    let terms = 0;
    let docs = 0;
    try {
      for (const row of searchVocab.iterate(range.low, range.high) as Iterable<{
        doc: number;
      }>) {
        terms += 1;
        docs += row.doc;
        if (
          terms > CHANNEL_SEARCH_PREFIX_TERM_BUDGET ||
          docs > CHANNEL_SEARCH_PREFIX_DOC_BUDGET
        ) {
          noteSearchRefusal(terms, docs);
          throw new ChannelSearchRefusedError('search_query_too_broad');
        }
      }
    } catch (error) {
      if (error instanceof ChannelSearchRefusedError) throw error;
      if (!searchPreflightFaultLogged) {
        searchPreflightFaultLogged = true;
        logger.warn(
          'channel search cost pre-flight failed (%s); running queries under the wall-clock ceiling alone until this clears (logged once)',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  /**
   * Record an over-broad refusal, logging the SHAPE of the query and never its
   * text — operator search input can carry pasted secrets or ticket bodies, and
   * this path is reachable repeatedly by any capability holder.
   */
  function noteSearchRefusal(terms: number, docs: number): void {
    searchRefusals += 1;
    const now = Date.now();
    if (
      searchRefusalLoggedAt !== 0 &&
      now - searchRefusalLoggedAt < SEARCH_REFUSAL_LOG_INTERVAL_MS
    ) {
      return;
    }
    const sinceLast = searchRefusals - searchRefusalsAtLastLog;
    searchRefusalsAtLastLog = searchRefusals;
    searchRefusalLoggedAt = now;
    logger.warn(
      'channel search refused an over-broad prefix (%d terms / %d docs vs budgets %d/%d); %d refusal(s) since the last line, %d total. A rising rate means the corpus has outgrown CHANNEL_SEARCH_PREFIX_TERM_BUDGET, not that search is broken.',
      terms,
      docs,
      CHANNEL_SEARCH_PREFIX_TERM_BUDGET,
      CHANNEL_SEARCH_PREFIX_DOC_BUDGET,
      sinceLast,
      searchRefusals
    );
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
  const mentionContextStatements = {
    channel: {
      boundary: db.prepare(buildChannelMentionContextBoundarySql('channel')),
      count: db.prepare(buildChannelMentionContextCountSql('channel')),
      rows: db.prepare(buildChannelMentionContextRowsSql('channel')),
    },
    thread: {
      boundary: db.prepare(buildChannelMentionContextBoundarySql('thread')),
      count: db.prepare(buildChannelMentionContextCountSql('thread')),
      rows: db.prepare(buildChannelMentionContextRowsSql('thread')),
    },
  } as const;

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
    `INSERT INTO channel_members (channel_id, member_kind, member_id, joined_at, metadata_json, invited_by)
     VALUES (@channelId, @memberKind, @memberId, @joinedAt, @metadataJson, @invitedBy)
     ON CONFLICT(channel_id, member_kind, member_id) DO UPDATE SET
       metadata_json = excluded.metadata_json,
       -- First-writer wins on the audit field. COALESCE on the STORED value,
       -- so a later upsert can fill in an attribution that was missing but can
       -- never overwrite one that already names an inviter.
       invited_by = COALESCE(channel_members.invited_by, excluded.invited_by),
       -- #1455 slice 2: an implicit "wrote its own way in" upsert must NOT
       -- undo a removal for an AGENT — the channel bridge re-upserts on every
       -- durable reply, so reviving here would let a removed agent with a live
       -- binding readmit itself. A HUMAN is never membership-gated anywhere
       -- (the browser lane does not consult this table), so a human tombstone
       -- can only make the member list lie about who is in the room; its own
       -- write clears it.
       removed_at = CASE WHEN channel_members.member_kind = 'human'
                         THEN NULL ELSE channel_members.removed_at END,
       removed_by = CASE WHEN channel_members.member_kind = 'human'
                         THEN NULL ELSE channel_members.removed_by END`
  );
  const selectMemberExactStmt = db.prepare(
    `SELECT * FROM channel_members
      WHERE channel_id = ? AND member_kind = ? AND member_id = ?`
  );
  // Binding-driven enrollment deliberately leaves `metadata_json` and
  // `joined_at` alone on conflict: it mirrors an execution fact onto an
  // existing member row, it does not re-admit that member.
  const enrollBoundMemberStmt = db.prepare(
    `INSERT INTO channel_members (channel_id, member_kind, member_id, joined_at, metadata_json, invited_by)
     VALUES (@channelId, 'agent', @memberId, @joinedAt, '{}', @invitedBy)
     ON CONFLICT(channel_id, member_kind, member_id) DO UPDATE SET
       invited_by = COALESCE(channel_members.invited_by, excluded.invited_by)`
  );
  // Live members only: a tombstoned row is not a member, and every public read
  // (snapshots, `channels.members`, DM lookup) must agree with `isMember`.
  const listMembersStmt = db.prepare(
    `SELECT * FROM channel_members
      WHERE channel_id = ? AND removed_at IS NULL
      ORDER BY joined_at ASC, member_id ASC`
  );
  // Canonical match: `agent:<profile>` and `<profile>` are the same member (see
  // `canonicalChannelMemberId`). Enumerating both spellings as bound equalities
  // keeps the `(channel_id, member_kind, member_id)` primary key serving the
  // lookup; a `replace()`/`LIKE` predicate on `member_id` would not.
  const isMemberStmt = db.prepare(
    `SELECT 1 FROM channel_members
      WHERE channel_id = @channelId
        AND member_kind = @memberKind
        AND member_id IN (
          @memberId, @canonicalId, @prefixedId,
          @defaultProfileId, @vendorId, @prefixedVendorId
        )
        AND removed_at IS NULL
      LIMIT 1`
  );
  // Every stored spelling of one participant, live AND tombstoned. Invite and
  // remove operate on the whole equivalence class: removing `agent:claude`
  // while `agent-profile:claude:default` stayed live would leave the member in
  // the room under its other name (`isMember` folds both onto one identity).
  const matchMemberRowsStmt = db.prepare(
    `SELECT * FROM channel_members
      WHERE channel_id = @channelId
        AND member_kind = @memberKind
        AND member_id IN (
          @memberId, @canonicalId, @prefixedId,
          @defaultProfileId, @vendorId, @prefixedVendorId
        )
      ORDER BY joined_at ASC, member_id ASC`
  );
  const tombstoneMemberStmt = db.prepare(
    `UPDATE channel_members
        SET removed_at = @removedAt, removed_by = @removedBy
      WHERE channel_id = @channelId
        AND member_kind = @memberKind
        AND member_id = @memberId`
  );
  // Re-admission is a NEW admission: it restates `invited_by` and `joined_at`
  // rather than resurrecting the attribution of the invite that was revoked.
  const readmitMemberStmt = db.prepare(
    `UPDATE channel_members
        SET removed_at = NULL, removed_by = NULL,
            invited_by = @invitedBy, joined_at = @joinedAt
      WHERE channel_id = @channelId
        AND member_kind = @memberKind
        AND member_id = @memberId`
  );
  // Compiled once: `GET /channels` runs this per channel per list fetch.
  const threadSummaryStmt = db.prepare(buildChannelThreadSummarySql());
  const threadSummaryByRootStmt = db.prepare(
    `SELECT root.id                         AS root_id,
            root.body_text                  AS root_body,
            thread.title                    AS thread_title,
            root.sender_id                  AS root_sender_id,
            root.sender_kind                AS root_sender_kind,
            root.sender_display             AS root_sender_display,
            root.meta_json                  AS root_meta_json,
            (SELECT COUNT(*)
               FROM channel_messages reply INDEXED BY idx_chm_thread
              WHERE reply.thread_id = thread.root_message_id
                AND reply.channel_id = thread.channel_id
                AND json_extract(reply.meta_json, '$.agentDetail') IS NULL)
                                             AS reply_count,
            thread.updated_at               AS last_reply_at,
            1                               AS thread_total
       FROM channel_threads thread
       JOIN channel_messages root
         ON root.id = thread.root_message_id
        AND root.channel_id = thread.channel_id
      WHERE thread.channel_id = ? AND thread.root_message_id = ?`
  );

  function threadSummaryFromRow(row: ThreadSummaryRow): ChannelThreadSummary {
    const meta = parseMeta(row.root_meta_json);
    const providerId =
      typeof meta?.['providerId'] === 'string'
        ? (meta['providerId'] as string)
        : undefined;
    return {
      rootMessageId: row.root_id as ChannelMessageId,
      title: row.thread_title,
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
  }

  function listChannelThreadSummariesImpl(
    channelId: string,
    limit = CHANNEL_THREAD_SUMMARY_LIMIT
  ): ChannelThreadSummaryPage {
    const capped = Math.max(
      1,
      Math.min(CHANNEL_THREAD_SUMMARY_MAX_LIMIT, Math.floor(limit))
    );
    const rows = threadSummaryStmt.all({
      channelId,
      limit: capped,
    }) as ThreadSummaryRow[];
    return {
      threads: rows.map(threadSummaryFromRow),
      threadCount: rows[0]?.thread_total ?? 0,
    };
  }
  const selectCompletionCallbackById = db.prepare(
    'SELECT * FROM channel_completion_callbacks WHERE id = ?'
  );
  const selectTerminalCallbackMessage = db.prepare(
    `SELECT id, status
       FROM channel_messages
      WHERE channel_id = @channelId
        AND sender_kind = 'agent'
        AND sender_id = @targetProfileId
        AND source_runtime_id = @targetRuntimeId
        AND source_turn_id = @targetTurnId
        AND kind = 'message'
        AND json_extract(meta_json, '$.agentDetail') IS NULL
        AND status <> 'streaming'
      ORDER BY seq DESC LIMIT 1`
  );

  /**
   * Keep membership in lockstep with bindings (#1455 slice 1). Best-effort:
   * a binding is a durable execution fact and must not fail because its
   * membership mirror could not be written — the read side would simply see
   * the agent as a non-member, which is the safe direction.
   */
  function enrollBoundMember(channelId: string, profileActorId: string): void {
    try {
      // A durable binding is execution bookkeeping, not an admission. If this
      // participant's class was removed, the mirrored row is created ALREADY
      // tombstoned — binding churn (cursor advance, session persist, unbind,
      // restart) must never re-admit an agent an operator evicted.
      //
      // ONE transaction, because the two statements are one fact. The insert
      // would otherwise autocommit on its own and a throw between them (WAL
      // contention across handles is a documented failure mode here) would
      // leave a permanently LIVE row — the exact resurrection this guards.
      // better-sqlite3 nests via SAVEPOINT, so this is safe inside the
      // binding transactions that call it.
      db.transaction(() => {
        const stamp = classRemovalStamp(channelId, 'agent', profileActorId);
        enrollBoundMemberStmt.run({
          channelId,
          memberId: profileActorId,
          joinedAt: nowIso(),
          invitedBy: CHANNEL_MEMBERSHIP_BINDING_INVITER,
        });
        inheritClassRemoval(channelId, 'agent', profileActorId, stamp);
      })();
    } catch (error) {
      logger.warn(
        'channel binding member enrollment failed for %s in %s: %s',
        profileActorId,
        channelId,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Bound parameters for the canonical-and-vendor-folded member lookup, shared
   * by `isMember` and by the invite/remove class match so a member can never be
   * *authorized* under one spelling and *removed* under another.
   */
  function memberMatchParams(
    channelId: string,
    kind: 'human' | 'agent',
    id: string
  ): Record<string, string> {
    // Human ids are never prefix-folded: `canonicalChannelMemberId` only
    // strips `agent:`, and a human id (`human:operator`) is its own canonical
    // form, so every extra binding collapses onto the same value.
    const canonical = kind === 'agent' ? canonicalChannelMemberId(id) : id;
    // A gateway actor named for a VENDOR (`agent:claude`) and that vendor's
    // DEFAULT profile Actor id (`agent-profile:claude:default`) are the same
    // participant — the binder already treats them as one for self-mention
    // suppression (`eligibleProfiles`). Membership must agree in BOTH
    // directions, or an agent enrolled under one spelling is a non-member the
    // moment it arrives under the other. Non-default profiles
    // (`agent-profile:claude:<uuid>`) are deliberately NOT folded: they are
    // distinct participants that happen to share a vendor.
    const vendor =
      kind === 'agent' ? defaultProfileVendorId(canonical) : undefined;
    return {
      channelId,
      memberKind: kind,
      memberId: id,
      canonicalId: canonical,
      prefixedId: kind === 'agent' ? `agent:${canonical}` : id,
      defaultProfileId:
        kind === 'agent' && !canonical.startsWith(AGENT_PROFILE_ID_PREFIX)
          ? builtInAgentProfileId(canonical)
          : id,
      vendorId: vendor ?? id,
      prefixedVendorId: vendor ? `agent:${vendor}` : id,
    };
  }

  /**
   * The removal stamp this participant's fold CLASS currently carries, or
   * `null` when the class is live or absent (#1455 slice 2).
   *
   * An implicit writer inserting a spelling that has no row of its own must
   * inherit that stamp, or it re-admits a removed agent through the back door.
   * Only `inviteMember` clears a class.
   */
  function classRemovalStamp(
    channelId: string,
    kind: 'human' | 'agent',
    id: string
  ): { removedAt: string; removedBy: string | null } | null {
    // Humans do not fold — their class is the exact row — and a human writing
    // its own way in deliberately clears its tombstone (see `upsertMemberStmt`).
    if (kind !== 'agent') return null;
    const rows = matchMemberRowsStmt.all(
      memberMatchParams(channelId, kind, id)
    ) as MemberRow[];
    if (rows.length === 0) return null;
    const removed = rows.find((row) => row.removed_at !== null);
    if (!removed || rows.some((row) => row.removed_at === null)) return null;
    return {
      removedAt: removed.removed_at as string,
      removedBy: removed.removed_by,
    };
  }

  /** Apply an inherited class stamp to a row an implicit writer just created. */
  function inheritClassRemoval(
    channelId: string,
    kind: 'human' | 'agent',
    memberId: string,
    stamp: { removedAt: string; removedBy: string | null } | null
  ): void {
    if (!stamp) return;
    tombstoneMemberStmt.run({
      channelId,
      memberKind: kind,
      memberId,
      removedAt: stamp.removedAt,
      removedBy: stamp.removedBy,
    });
  }

  function memberRowToRef(row: MemberRow): ChannelMemberRef {
    return {
      kind: row.member_kind as 'human' | 'agent',
      id: row.member_id,
      joinedAt: row.joined_at,
      ...(row.invited_by ? { invitedBy: row.invited_by } : {}),
      // Only ever set on a ref handed back by a WRITE. Every list read filters
      // tombstones, so this never reaches the wire from `listMembers`.
      ...(row.removed_at ? { removedAt: row.removed_at } : {}),
    };
  }

  function getMessageById(id: string): ChannelMessage | null {
    const row = selectById.get(id) as ChannelMessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  function threadTitleFromRoot(root: ChannelMessageRow): string {
    const compact = root.body_text.replace(/\s+/g, ' ').trim();
    return (
      compact.slice(0, CHANNEL_THREAD_TITLE_MAX_CHARS) || DEFAULT_THREAD_TITLE
    );
  }

  function normalizeThreadTitle(title: string): string {
    const compact = title.replace(/\s+/g, ' ').trim();
    if (!compact) {
      throw new ChannelMessageStoreError(
        400,
        'channel_thread_title_empty',
        'thread title must not be empty'
      );
    }
    if (compact.length > CHANNEL_THREAD_TITLE_MAX_CHARS) {
      throw new ChannelMessageStoreError(
        400,
        'channel_thread_title_too_long',
        `thread title must not exceed ${CHANNEL_THREAD_TITLE_MAX_CHARS} characters`,
        { max: CHANNEL_THREAD_TITLE_MAX_CHARS }
      );
    }
    return compact;
  }

  /** Claim a legacy root exactly once when it first becomes a real thread. */
  function ensureThreadRecord(channelId: string, rootMessageId: string): void {
    const root = selectById.get(rootMessageId) as ChannelMessageRow | undefined;
    if (!root || root.channel_id !== channelId || root.thread_id !== null) {
      throw new ChannelMessageStoreError(
        404,
        'thread_root_not_found',
        'thread root not found',
        { channelId, rootMessageId }
      );
    }
    db.prepare(
      `INSERT INTO channel_threads
         (channel_id, root_message_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, root_message_id) DO NOTHING`
    ).run(
      channelId,
      rootMessageId,
      threadTitleFromRoot(root),
      root.created_at,
      root.updated_at
    );
  }

  function touchThreadRecord(
    channelId: string,
    rootMessageId: string,
    updatedAt: string
  ): void {
    ensureThreadRecord(channelId, rootMessageId);
    db.prepare(
      `UPDATE channel_threads
          SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
        WHERE channel_id = ? AND root_message_id = ?`
    ).run(updatedAt, updatedAt, channelId, rootMessageId);
  }

  function threadSummaryForRoot(
    channelId: string,
    rootMessageId: string
  ): ChannelThreadSummary | null {
    const row = threadSummaryByRootStmt.get(channelId, rootMessageId) as
      | ThreadSummaryRow
      | undefined;
    return row ? threadSummaryFromRow(row) : null;
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
    if (threadId !== null) touchThreadRecord(input.channelId, threadId, now);
    return rowToMessage(row);
  }

  const selectAsyncRun = db.prepare(
    'SELECT * FROM channel_async_runs WHERE id = ?'
  );
  const selectAsyncRunForRequest = db.prepare(
    'SELECT * FROM channel_async_runs WHERE request_message_id = ?'
  );
  const selectAsyncRunTargets = db.prepare(
    'SELECT * FROM channel_async_run_targets WHERE run_id = ? ORDER BY target_id ASC'
  );

  function asyncRunFromRow(
    row: AsyncRunRow,
    targets = selectAsyncRunTargets.all(row.id) as AsyncRunTargetRow[]
  ): ChannelAsyncRun {
    return {
      id: row.id as ChannelAsyncRunId,
      channelId: row.channel_id,
      threadId: row.thread_id as ChannelMessageId | null,
      requestMessageId: row.request_message_id as ChannelMessageId,
      requesterId: row.requester_id,
      state: row.state,
      ...(row.reason ? { reason: row.reason } : {}),
      targets: targets.map(
        (target): ChannelAsyncRunTarget => ({
          targetId: target.target_id,
          state: target.state,
          ...(target.reason ? { reason: target.reason } : {}),
          ...(target.approval_state
            ? { approvalState: target.approval_state }
            : {}),
          updatedAt: target.updated_at,
          ...(target.completed_at ? { completedAt: target.completed_at } : {}),
        })
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  function aggregateAsyncRunState(
    targets: readonly AsyncRunTargetRow[]
  ): ChannelAsyncRunState {
    if (targets.length === 0) return 'rejected';
    if (
      targets.some(
        (target) =>
          !['completed', 'failed', 'cancelled', 'rejected'].includes(
            target.state
          )
      )
    ) {
      if (targets.some((target) => target.state === 'auth-required'))
        return 'auth-required';
      if (targets.some((target) => target.state === 'input-required'))
        return 'input-required';
      return targets.some((target) => target.state === 'working')
        ? 'working'
        : 'submitted';
    }
    if (targets.every((target) => target.state === 'completed'))
      return 'completed';
    if (targets.every((target) => target.state === 'rejected'))
      return 'rejected';
    if (
      targets.some(
        (target) => target.state === 'failed' || target.state === 'rejected'
      )
    )
      return 'failed';
    return 'cancelled';
  }

  const appendCompleteWithAsyncRunImpl = db.transaction(
    (input: CreateChannelAsyncRunPostInput) => {
      let existing: ChannelMessage | null = null;
      if (input.clientMessageId) {
        const row = selectByClientId.get({
          channelId: input.channelId,
          senderId: input.sender.id,
          clientMessageId: input.clientMessageId,
        }) as ChannelMessageRow | undefined;
        if (row) existing = rowToMessage(row);
      }
      const message = existing ?? appendCompleteImpl(input);
      const known = selectAsyncRunForRequest.get(message.id) as
        | AsyncRunRow
        | undefined;
      if (known) {
        return {
          message,
          run: asyncRunFromRow(known),
          replayed: existing !== null,
          runReplayed: true,
        };
      }
      const now = nowIso();
      const targetIds = [...new Set(input.targetIds)].sort();
      const state: ChannelAsyncRunState =
        targetIds.length === 0 ? 'rejected' : 'submitted';
      const runId = `chrun:${crypto.randomUUID()}` as ChannelAsyncRunId;
      db.prepare(
        `INSERT INTO channel_async_runs
           (id, channel_id, thread_id, request_message_id, requester_id, state, reason, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        message.channelId,
        message.threadId,
        message.id,
        message.sender.id,
        state,
        targetIds.length === 0 ? 'no-eligible-target' : null,
        now,
        now,
        targetIds.length === 0 ? now : null
      );
      const insertTarget = db.prepare(
        `INSERT INTO channel_async_run_targets
           (run_id, target_id, state, reason, approval_state, updated_at, completed_at)
         VALUES (?, ?, ?, NULL, NULL, ?, NULL)`
      );
      for (const targetId of targetIds)
        insertTarget.run(runId, targetId, 'queued', now);
      const row = selectAsyncRun.get(runId) as AsyncRunRow;
      return {
        message,
        run: asyncRunFromRow(row),
        replayed: existing !== null,
        runReplayed: false,
      };
    }
  );

  const transitionAsyncRunTargetImpl = db.transaction(
    (input: {
      runId: ChannelAsyncRunId;
      targetId: string;
      state: ChannelAsyncRunTargetState;
      reason?: string;
      approvalState?: ChannelAsyncRunApprovalState;
    }): ChannelAsyncRun | null => {
      const run = selectAsyncRun.get(input.runId) as AsyncRunRow | undefined;
      if (!run) return null;
      const now = nowIso();
      const terminal = [
        'completed',
        'failed',
        'cancelled',
        'rejected',
      ].includes(input.state);
      const changed = db
        .prepare(
          `UPDATE channel_async_run_targets
            SET state = ?, reason = ?, approval_state = ?, updated_at = ?,
                completed_at = CASE WHEN ? THEN ? ELSE NULL END
          WHERE run_id = ? AND target_id = ?
            AND state NOT IN ('completed','failed','cancelled','rejected')`
        )
        .run(
          input.state,
          input.reason ?? null,
          input.approvalState ?? null,
          now,
          terminal ? 1 : 0,
          terminal ? now : null,
          input.runId,
          input.targetId
        );
      if (changed.changes === 0) return asyncRunFromRow(run);
      const targets = selectAsyncRunTargets.all(
        input.runId
      ) as AsyncRunTargetRow[];
      const state = aggregateAsyncRunState(targets);
      const runTerminal = [
        'completed',
        'failed',
        'cancelled',
        'rejected',
      ].includes(state);
      db.prepare(
        `UPDATE channel_async_runs SET state = ?, updated_at = ?,
          completed_at = CASE WHEN ? THEN ? ELSE NULL END WHERE id = ?`
      ).run(state, now, runTerminal ? 1 : 0, runTerminal ? now : null, run.id);
      return asyncRunFromRow(selectAsyncRun.get(run.id) as AsyncRunRow);
    }
  );

  const recoverAsyncRunsImpl = db.transaction((): ChannelAsyncRun[] => {
    const rows = db
      .prepare(
        `SELECT * FROM channel_async_runs
          WHERE state NOT IN ('completed','failed','cancelled','rejected')`
      )
      .all() as AsyncRunRow[];
    if (rows.length === 0) return [];
    const now = nowIso();
    const cancelTarget = db.prepare(
      `UPDATE channel_async_run_targets
          SET state = 'cancelled', reason = 'server-restarted', updated_at = ?,
              completed_at = ?
        WHERE run_id = ?
          AND state NOT IN ('completed','failed','cancelled','rejected')`
    );
    const updateRun = db.prepare(
      `UPDATE channel_async_runs
          SET state = ?, reason = 'server-restarted', updated_at = ?, completed_at = ?
        WHERE id = ?`
    );
    for (const row of rows) {
      cancelTarget.run(now, now, row.id);
      const targets = selectAsyncRunTargets.all(row.id) as AsyncRunTargetRow[];
      const state = aggregateAsyncRunState(targets);
      updateRun.run(state, now, now, row.id);
    }
    return rows.map((row) =>
      asyncRunFromRow(selectAsyncRun.get(row.id) as AsyncRunRow)
    );
  });

  const pruneSettledAsyncRunsImpl = db.transaction(
    (olderThanMs: number): number => {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const ids = db
        .prepare(
          `SELECT id FROM channel_async_runs
          WHERE state IN ('completed','failed','cancelled','rejected')
            AND completed_at IS NOT NULL AND completed_at < ?`
        )
        .all(cutoff) as Array<{ id: string }>;
      if (ids.length === 0) return 0;
      const deleteTargets = db.prepare(
        'DELETE FROM channel_async_run_targets WHERE run_id = ?'
      );
      const deleteRun = db.prepare(
        'DELETE FROM channel_async_runs WHERE id = ?'
      );
      for (const { id } of ids) {
        deleteTargets.run(id);
        deleteRun.run(id);
      }
      return ids.length;
    }
  );

  function getBindingImpl(
    channelId: string,
    profileActorId: string,
    threadId: string | null = null
  ): ChannelBinding | null {
    const select = db.prepare(
      `SELECT * FROM channel_agent_bindings
        WHERE channel_id = ? AND thread_scope_id = ? AND profile_actor_id = ?`
    );
    const row = select.get(channelId, threadId ?? '', profileActorId) as
      | BindingRow
      | undefined;
    return row ? bindingRowToRecord(row) : null;
  }

  function getSoleOrchestratorBindingImpl(
    channelId: string
  ): ChannelBinding | null {
    const row = db
      .prepare(
        `SELECT * FROM channel_agent_bindings
          WHERE channel_id = ?
            AND thread_scope_id = ''
            AND binding_role = 'orchestrator'`
      )
      .get(channelId) as BindingRow | undefined;
    return row ? bindingRowToRecord(row) : null;
  }

  function writeBindingImpl(
    input: SoleOrchestratorDesignationInput & { role?: AgentRole | null }
  ): ChannelBinding {
    const now = nowIso();
    const existing = db
      .prepare(
        `SELECT * FROM channel_agent_bindings
          WHERE channel_id = ? AND thread_scope_id = ? AND profile_actor_id = ?`
      )
      .get(input.channelId, input.threadId ?? '', input.profileActorId) as
      | BindingRow
      | undefined;
    const providerSessionJson = JSON.stringify(
      input.providerSession ??
        (existing
          ? parseBindingProviderSession(existing.provider_session_json)
          : {})
    );
    db.prepare(
      `INSERT INTO channel_agent_bindings
         (channel_id, thread_scope_id, profile_actor_id, agent_framework, runtime_id, binding_role, provider_session_json, created_at, updated_at)
       VALUES (@channelId, @threadScopeId, @profileActorId, @agentFramework, @runtimeId, @bindingRole, @providerSessionJson, @createdAt, @updatedAt)
       ON CONFLICT(channel_id, thread_scope_id, profile_actor_id) DO UPDATE SET
         agent_framework = excluded.agent_framework,
         runtime_id = excluded.runtime_id,
         binding_role = excluded.binding_role,
         provider_session_json = excluded.provider_session_json,
         updated_at = excluded.updated_at`
    ).run({
      channelId: input.channelId,
      threadScopeId: input.threadId ?? '',
      profileActorId: input.profileActorId,
      agentFramework: input.agentFramework,
      runtimeId:
        input.runtimeId !== undefined
          ? input.runtimeId
          : (existing?.runtime_id ?? null),
      bindingRole:
        input.role !== undefined
          ? input.role
          : (existing?.binding_role ?? null),
      providerSessionJson,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    });
    return getBindingImpl(
      input.channelId,
      input.profileActorId,
      input.threadId ?? null
    )!;
  }

  const createCompletionCallbackImpl = db.transaction(
    (
      input: CreateChannelCompletionCallbackInput
    ): ChannelCompletionCallbackEdge => {
      const timestamp = nowIso();
      const continuationParentCallbackId =
        input.continuationParentCallbackId ?? null;
      if (continuationParentCallbackId) {
        const parent = selectCompletionCallbackById.get(
          continuationParentCallbackId
        ) as CompletionCallbackRow | undefined;
        // A child may only consume an intent announced by the callback turn it
        // is returning to. Rejecting a corrupt/replayed relation rolls back the
        // whole operation, including the child insert and parent's intent.
        if (
          !parent ||
          parent.channel_id !== input.channelId ||
          parent.target_profile_id !== input.requesterProfileId ||
          parent.state !== 'pending' ||
          parent.awaiting_child !== 1 ||
          parent.pending_child_intents < 1
        ) {
          throw new Error('completion callback continuation parent is invalid');
        }
      }
      const findTarget = db.prepare(
        `SELECT * FROM channel_completion_callbacks
          WHERE channel_id = ? AND target_profile_id = ? AND target_turn_id = ?`
      );
      const existing = findTarget.get(
        input.channelId,
        input.targetProfileId,
        input.targetTurnId
      ) as CompletionCallbackRow | undefined;
      if (existing) {
        // Retrying a durable admission is safe; repointing one target turn at a
        // different ancestor is corruption and must not silently steal an intent.
        if (
          existing.requester_profile_id !== input.requesterProfileId ||
          existing.continuation_parent_callback_id !==
            continuationParentCallbackId
        ) {
          throw new Error(
            'completion callback target turn conflicts with relation'
          );
        }
        return completionCallbackRowToRecord(existing);
      }
      const inserted = db
        .prepare(
          `INSERT INTO channel_completion_callbacks
           (id, channel_id, thread_id, trigger_message_id, requester_profile_id,
            target_profile_id, target_runtime_id, target_turn_id,
            continuation_parent_callback_id, state,
            created_at, updated_at)
         VALUES
           (@id, @channelId, @threadId, @triggerMessageId, @requesterProfileId,
            @targetProfileId, @targetRuntimeId, @targetTurnId,
            @continuationParentCallbackId, 'pending',
            @createdAt, @updatedAt)`
        )
        .run({
          ...input,
          continuationParentCallbackId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      if (inserted.changes !== 1) {
        throw new Error('completion callback insert did not persist');
      }
      if (continuationParentCallbackId) {
        // Insert and decrement are deliberately one transaction: a crash or
        // malformed relation can never leave a child without its matching intent.
        const decremented = db
          .prepare(
            `UPDATE channel_completion_callbacks
              SET pending_child_intents = pending_child_intents - 1,
                  updated_at = ?
            WHERE id = ? AND state = 'pending' AND awaiting_child = 1
              AND pending_child_intents > 0`
          )
          .run(timestamp, continuationParentCallbackId);
        if (decremented.changes !== 1) {
          throw new Error(
            'completion callback continuation intent disappeared'
          );
        }
      }
      const row = selectCompletionCallbackById.get(input.id) as
        | CompletionCallbackRow
        | undefined;
      if (!row) throw new Error('completion callback insert did not persist');
      return completionCallbackRowToRecord(row);
    }
  );

  function satisfyCompletionCallbackImpl(
    input: SatisfyChannelCompletionCallbackInput
  ): ChannelCompletionCallbackEdge | null {
    const timestamp = nowIso();
    const result = db
      .prepare(
        `UPDATE channel_completion_callbacks
            SET state = 'satisfied', terminal_reason = @terminalReason,
                terminal_message_id = @terminalMessageId,
                message_disposition = @messageDisposition,
                satisfied_at = @timestamp, updated_at = @timestamp
          WHERE channel_id = @channelId
            AND target_profile_id = @targetProfileId
            AND target_turn_id = @targetTurnId
            AND state = 'pending' AND awaiting_child = 0`
      )
      .run({
        ...input,
        terminalMessageId: input.terminalMessageId ?? null,
        timestamp,
      });
    if (result.changes === 0) {
      // A parent that delegated further still records the terminal evidence of
      // its original turn. `releaseDeferred...` can use it if the child never
      // becomes routable; a real continuation overwrites it atomically later.
      db.prepare(
        `UPDATE channel_completion_callbacks
            SET terminal_reason = @terminalReason,
                terminal_message_id = @terminalMessageId,
                message_disposition = @messageDisposition,
                updated_at = @timestamp
          WHERE channel_id = @channelId
            AND target_profile_id = @targetProfileId
            AND target_turn_id = @targetTurnId
            AND state = 'pending' AND awaiting_child = 1`
      ).run({
        ...input,
        terminalMessageId: input.terminalMessageId ?? null,
        timestamp,
      });
      return null;
    }
    const row = db
      .prepare(
        `SELECT * FROM channel_completion_callbacks
          WHERE channel_id = ? AND target_profile_id = ? AND target_turn_id = ?`
      )
      .get(input.channelId, input.targetProfileId, input.targetTurnId) as
      | CompletionCallbackRow
      | undefined;
    return row ? completionCallbackRowToRecord(row) : null;
  }

  function deferCompletionCallbackForChildImpl(input: {
    channelId: string;
    targetProfileId: string;
    targetTurnId: string;
    expectedChildCount: number;
  }): ChannelCompletionCallbackEdge | null {
    const timestamp = nowIso();
    const result = db
      .prepare(
        `UPDATE channel_completion_callbacks
            SET awaiting_child = 1,
                pending_child_intents = pending_child_intents + @expectedChildCount,
                updated_at = @timestamp
          WHERE channel_id = @channelId
            AND target_profile_id = @targetProfileId
            AND target_turn_id = @targetTurnId
            AND state = 'pending'`
      )
      .run({ ...input, timestamp });
    if (result.changes === 0) return null;
    const row = db
      .prepare(
        `SELECT * FROM channel_completion_callbacks
          WHERE channel_id = ? AND target_profile_id = ? AND target_turn_id = ?`
      )
      .get(input.channelId, input.targetProfileId, input.targetTurnId) as
      | CompletionCallbackRow
      | undefined;
    return row ? completionCallbackRowToRecord(row) : null;
  }

  function announceContinuationChildrenImpl(
    callbackId: string,
    expectedChildCount: number
  ): ChannelCompletionCallbackEdge | null {
    if (expectedChildCount < 1) return null;
    const timestamp = nowIso();
    const result = db
      .prepare(
        `UPDATE channel_completion_callbacks
            SET awaiting_child = 1,
                pending_child_intents = pending_child_intents + ?,
                updated_at = ?
          WHERE id = ? AND state = 'pending'`
      )
      .run(expectedChildCount, timestamp, callbackId);
    if (result.changes === 0) return null;
    const row = selectCompletionCallbackById.get(callbackId) as
      | CompletionCallbackRow
      | undefined;
    return row ? completionCallbackRowToRecord(row) : null;
  }

  const completeChildContinuationImpl = db.transaction(
    (
      input: CompleteChildContinuationInput
    ): ChannelCompletionCallbackEdge | null => {
      const timestamp = nowIso();
      const child = selectCompletionCallbackById.get(input.callbackId) as
        | CompletionCallbackRow
        | undefined;
      if (
        !child ||
        child.state !== 'consumed' ||
        !child.continuation_parent_callback_id ||
        child.continuation_completed_at !== null
      ) {
        return null;
      }
      const marked = db
        .prepare(
          `UPDATE channel_completion_callbacks
              SET continuation_completed_at = ?, updated_at = ?
            WHERE id = ? AND state = 'consumed'
              AND continuation_completed_at IS NULL`
        )
        .run(timestamp, timestamp, input.callbackId);
      if (marked.changes === 0) return null;
      const remaining = db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM channel_completion_callbacks
            WHERE continuation_parent_callback_id = ?
              AND continuation_completed_at IS NULL`
        )
        .get(child.continuation_parent_callback_id) as { count: number };
      if (remaining.count > 0) return null;
      const parentUpdate = db
        .prepare(
          `UPDATE channel_completion_callbacks
              SET state = 'satisfied', awaiting_child = 0,
                  terminal_reason = @terminalReason,
                  terminal_message_id = @terminalMessageId,
                  message_disposition = @messageDisposition,
                  satisfied_at = @timestamp, updated_at = @timestamp
            WHERE id = @callbackId AND state = 'pending' AND awaiting_child = 1
              AND pending_child_intents = 0`
        )
        .run({
          callbackId: child.continuation_parent_callback_id,
          terminalReason: input.terminalReason,
          terminalMessageId: input.terminalMessageId ?? null,
          messageDisposition: input.messageDisposition,
          timestamp,
        });
      if (parentUpdate.changes === 0) return null;
      const parent = selectCompletionCallbackById.get(
        child.continuation_parent_callback_id
      ) as CompletionCallbackRow | undefined;
      return parent ? completionCallbackRowToRecord(parent) : null;
    }
  );

  function releaseDeferredCompletionCallbackImpl(
    id: string
  ): ChannelCompletionCallbackEdge | null {
    const timestamp = nowIso();
    // One route target vanished after the parent announced a fan-out. Decrement
    // only its own durable intent; any sibling child still keeps the parent
    // pending. Once every route failed, use the original terminal evidence.
    db.prepare(
      `UPDATE channel_completion_callbacks
          SET pending_child_intents = MAX(0, pending_child_intents - 1),
              updated_at = ?
        WHERE id = ? AND state = 'pending' AND awaiting_child = 1`
    ).run(timestamp, id);
    const result = db
      .prepare(
        `UPDATE channel_completion_callbacks
            SET awaiting_child = 0,
                state = CASE WHEN terminal_reason IS NULL THEN 'pending' ELSE 'satisfied' END,
                satisfied_at = CASE WHEN terminal_reason IS NULL THEN satisfied_at ELSE @timestamp END,
                updated_at = @timestamp
          WHERE id = @id AND state = 'pending' AND awaiting_child = 1
            AND pending_child_intents = 0
            AND NOT EXISTS (
              SELECT 1 FROM channel_completion_callbacks child
               WHERE child.continuation_parent_callback_id = @id
            )`
      )
      .run({ id, timestamp });
    if (result.changes === 0) return null;
    const row = selectCompletionCallbackById.get(id) as
      | CompletionCallbackRow
      | undefined;
    return row ? completionCallbackRowToRecord(row) : null;
  }

  const claimSatisfiedCompletionCallbacksImpl = db.transaction(
    (limit: number): ChannelCompletionCallbackEdge[] => {
      const candidates = db
        .prepare(
          `SELECT * FROM channel_completion_callbacks
            WHERE state = 'satisfied'
            ORDER BY satisfied_at ASC, created_at ASC, id ASC
            LIMIT ?`
        )
        .all(limit) as CompletionCallbackRow[];
      const claim = db.prepare(
        `UPDATE channel_completion_callbacks
            SET state = 'delivered', delivered_at = ?, updated_at = ?
          WHERE id = ? AND state = 'satisfied'`
      );
      const timestamp = nowIso();
      const claimed: ChannelCompletionCallbackEdge[] = [];
      for (const candidate of candidates) {
        if (claim.run(timestamp, timestamp, candidate.id).changes === 0) {
          continue;
        }
        const row = selectCompletionCallbackById.get(candidate.id) as
          | CompletionCallbackRow
          | undefined;
        if (row) claimed.push(completionCallbackRowToRecord(row));
      }
      return claimed;
    }
  );

  function releaseDeliveredCompletionCallbackImpl(id: string): boolean {
    const timestamp = nowIso();
    return (
      db
        .prepare(
          `UPDATE channel_completion_callbacks
              SET state = 'satisfied', delivered_at = NULL, updated_at = ?
            WHERE id = ? AND state = 'delivered'`
        )
        .run(timestamp, id).changes === 1
    );
  }

  const terminalizeDeliveredCompletionCallbackImpl = db.transaction(
    (input: {
      id: string;
      channelId: string;
      threadId: string | null;
      deliveryReason: ChannelCompletionCallbackDeliveryReason;
    }): ChannelCompletionCallbackEdge | null => {
      const timestamp = nowIso();
      // `delivered` is the binder's durable claim. Limiting the first update to
      // that state is the CAS boundary: a late missing-profile observation can
      // neither overwrite a consumed acceptance nor re-terminalize a retry.
      const terminalized = db
        .prepare(
          `UPDATE channel_completion_callbacks
            SET state = 'undeliverable', delivery_reason = ?,
                  undeliverable_at = ?, updated_at = ?
            WHERE id = ? AND channel_id = ? AND thread_id IS ?
              AND state = 'delivered'`
        )
        .run(
          input.deliveryReason,
          timestamp,
          timestamp,
          input.id,
          input.channelId,
          input.threadId
        );
      if (terminalized.changes === 0) return null;

      const edge = selectCompletionCallbackById.get(input.id) as
        | CompletionCallbackRow
        | undefined;
      if (!edge)
        throw new Error('completion callback terminalization lost row');

      // A nested child is the sole route by which its requester can produce the
      // continuation that wakes each ancestor. Once delivery is impossible,
      // preserve the directional invariant by terminalizing that unresolved
      // upward ancestry too — never manufacture an adapter callback to pretend
      // the absent requester accepted it.
      let parentId = edge.continuation_parent_callback_id;
      const seenAncestorIds = new Set<string>([edge.id]);
      while (parentId && !seenAncestorIds.has(parentId)) {
        seenAncestorIds.add(parentId);
        const parent = selectCompletionCallbackById.get(parentId) as
          | CompletionCallbackRow
          | undefined;
        if (!parent) break;
        db.prepare(
          `UPDATE channel_completion_callbacks
              SET state = 'undeliverable',
                  delivery_reason = 'continuation-undeliverable',
                  undeliverable_at = ?, updated_at = ?
            WHERE id = ? AND state IN ('pending','satisfied','delivered')`
        ).run(timestamp, timestamp, parent.id);
        parentId = parent.continuation_parent_callback_id;
      }
      return completionCallbackRowToRecord(edge);
    }
  );

  const pruneConsumedCompletionCallbacksImpl = db.transaction(
    (olderThanMs: number): number => {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      // Do not sever ancestry while a child is still incomplete, or while this
      // row itself is a child of an unresolved parent. Settled subtrees prune
      // together only after the retention window preserves late-patch no-ops.
      return db
        .prepare(
          `DELETE FROM channel_completion_callbacks AS settled
            WHERE settled.state IN ('consumed','undeliverable')
              AND COALESCE(settled.consumed_at, settled.undeliverable_at) < @cutoff
              AND NOT EXISTS (
                SELECT 1 FROM channel_completion_callbacks child
                 WHERE child.continuation_parent_callback_id = settled.id
                   AND (child.state NOT IN ('consumed','undeliverable')
                        OR (child.state = 'consumed'
                            AND child.continuation_completed_at IS NULL))
              )
              AND NOT EXISTS (
                SELECT 1 FROM channel_completion_callbacks parent
                 WHERE parent.id = settled.continuation_parent_callback_id
                   AND parent.state NOT IN ('consumed','undeliverable')
              )`
        )
        .run({ cutoff }).changes;
    }
  );

  const consumeCompletionCallbacksForExplicitReturnImpl = db.transaction(
    (input: {
      channelId: string;
      targetProfileId: string;
      targetTurnId: string;
      requesterProfileIds: readonly string[];
    }): ChannelCompletionCallbackEdge[] => {
      if (input.requesterProfileIds.length === 0) return [];
      const marks = input.requesterProfileIds.map(() => '?').join(', ');
      const candidates = db
        .prepare(
          `SELECT * FROM channel_completion_callbacks
            WHERE channel_id = ? AND target_profile_id = ? AND target_turn_id = ?
              AND requester_profile_id IN (${marks})
              AND state IN ('pending','satisfied','delivered')`
        )
        .all(
          input.channelId,
          input.targetProfileId,
          input.targetTurnId,
          ...input.requesterProfileIds
        ) as CompletionCallbackRow[];
      const consume = db.prepare(
        `UPDATE channel_completion_callbacks
            SET state = 'consumed', consumed_at = ?, updated_at = ?
          WHERE id = ? AND state IN ('pending','satisfied','delivered')`
      );
      const timestamp = nowIso();
      const consumed: ChannelCompletionCallbackEdge[] = [];
      for (const candidate of candidates) {
        if (consume.run(timestamp, timestamp, candidate.id).changes === 0) {
          continue;
        }
        const row = selectCompletionCallbackById.get(candidate.id) as
          | CompletionCallbackRow
          | undefined;
        if (row) consumed.push(completionCallbackRowToRecord(row));
      }
      return consumed;
    }
  );

  function consumeAncestorCompletionCallbackForExplicitReturnImpl(
    id: string
  ): ChannelCompletionCallbackEdge | null {
    const timestamp = nowIso();
    const result = db
      .prepare(
        `UPDATE channel_completion_callbacks
            SET state = 'consumed', consumed_at = ?, updated_at = ?
          WHERE id = ? AND state IN ('pending','satisfied','delivered')`
      )
      .run(timestamp, timestamp, id);
    if (result.changes === 0) return null;
    const row = selectCompletionCallbackById.get(id) as
      | CompletionCallbackRow
      | undefined;
    return row ? completionCallbackRowToRecord(row) : null;
  }

  const recoverCompletionCallbacksImpl = db.transaction(
    (): ChannelCompletionCallbackEdge[] => {
      const timestamp = nowIso();
      // `delivered` means a callback was in the in-memory FIFO. The process
      // restart discarded that FIFO, so re-offer it; `consumed` is intentionally
      // never reopened because its recipient turn had already started.
      db.prepare(
        `UPDATE channel_completion_callbacks
            SET state = 'satisfied', delivered_at = NULL, updated_at = ?
          WHERE state = 'delivered'`
      ).run(timestamp);
      // A restart between marking B's parent edge and creating C's target turn
      // leaves no child relationship. That is not a live delegation, so release
      // the defer and let B's persisted terminal evidence recover normally.
      db.prepare(
        `UPDATE channel_completion_callbacks
            SET awaiting_child = 0, pending_child_intents = 0, updated_at = ?
          WHERE state = 'pending' AND awaiting_child = 1
            AND NOT EXISTS (
              SELECT 1 FROM channel_completion_callbacks child
               WHERE child.continuation_parent_callback_id = channel_completion_callbacks.id
            )`
      ).run(timestamp);
      const pending = db
        .prepare(
          `SELECT * FROM channel_completion_callbacks
            WHERE state = 'pending' AND awaiting_child = 0
            ORDER BY created_at ASC, id ASC`
        )
        .all() as CompletionCallbackRow[];
      for (const edge of pending) {
        const message = selectTerminalCallbackMessage.get({
          channelId: edge.channel_id,
          targetProfileId: edge.target_profile_id,
          targetRuntimeId: edge.target_runtime_id,
          targetTurnId: edge.target_turn_id,
        }) as { id: string; status: string } | undefined;
        const terminalReason: ChannelCompletionCallbackTerminalReason =
          message?.status === 'complete'
            ? 'completed'
            : message?.status === 'failed'
              ? 'error'
              : message?.status === 'interrupted'
                ? 'interrupt'
                : 'unexpected-disconnect';
        db.prepare(
          `UPDATE channel_completion_callbacks
              SET state = 'satisfied', terminal_reason = ?,
                  terminal_message_id = ?, message_disposition = ?,
                  satisfied_at = ?, updated_at = ?
            WHERE id = ? AND state = 'pending'`
        ).run(
          terminalReason,
          message?.id ?? null,
          message ? 'final-message' : 'no-terminal-message',
          timestamp,
          timestamp,
          edge.id
        );
      }
      return (
        db
          .prepare(
            `SELECT * FROM channel_completion_callbacks
              WHERE state = 'satisfied'
              ORDER BY satisfied_at ASC, created_at ASC, id ASC`
          )
          .all() as CompletionCallbackRow[]
      ).map(completionCallbackRowToRecord);
    }
  );

  const designateSoleOrchestratorTransaction = db.transaction(
    (input: SoleOrchestratorDesignationInput): ChannelBinding => {
      const designated = getSoleOrchestratorBindingImpl(input.channelId);
      if (
        designated !== null &&
        designated.profileActorId !== input.profileActorId
      ) {
        throw createChannelOrchestratorConflictError({
          channelId: input.channelId,
          designatedProfileActorId: designated.profileActorId,
          requestedProfileActorId: input.profileActorId,
        });
      }
      return writeBindingImpl({ ...input, role: 'orchestrator' });
    }
  );

  return {
    close() {
      db.close();
    },

    appendComplete(input) {
      return appendCompleteImpl(input);
    },

    appendCompleteWithAsyncRun(input) {
      return appendCompleteWithAsyncRunImpl(input);
    },

    getAsyncRun(id) {
      const row = selectAsyncRun.get(id) as AsyncRunRow | undefined;
      return row ? asyncRunFromRow(row) : null;
    },

    getAsyncRunForRequestMessage(messageId) {
      const row = selectAsyncRunForRequest.get(messageId) as
        | AsyncRunRow
        | undefined;
      return row ? asyncRunFromRow(row) : null;
    },

    listAsyncRuns(channelId, limit = 100) {
      const rows = db
        .prepare(
          `SELECT * FROM channel_async_runs WHERE channel_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .all(channelId, Math.max(1, Math.floor(limit))) as AsyncRunRow[];
      if (rows.length === 0) return [];
      const targetRows = db
        .prepare(
          `SELECT * FROM channel_async_run_targets
           WHERE run_id IN (${rows.map(() => '?').join(',')})
           ORDER BY run_id ASC, target_id ASC`
        )
        .all(...rows.map((row) => row.id)) as AsyncRunTargetRow[];
      const byRun = new Map<string, AsyncRunTargetRow[]>();
      for (const target of targetRows) {
        const targets = byRun.get(target.run_id) ?? [];
        targets.push(target);
        byRun.set(target.run_id, targets);
      }
      return rows
        .map((row) => asyncRunFromRow(row, byRun.get(row.id) ?? []))
        .reverse();
    },

    recoverAsyncRuns() {
      const recovered = recoverAsyncRunsImpl();
      pruneSettledAsyncRunsImpl(ASYNC_RUN_SETTLED_RETENTION_MS);
      return recovered;
    },

    transitionAsyncRunTarget(input) {
      return transitionAsyncRunTargetImpl(input);
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
      assertAgentAttribution(input.agentAttribution);
      assertMessageParts(input.parts);
      assertMessageParts(input.meta?.parts);
      assertAgentDetail(input.meta?.agentDetail);
      assertAgentAttribution(input.meta?.agentAttribution);
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
          ...(input.meta || input.agentDetail || input.agentAttribution
            ? {
                extra: {
                  ...(input.meta ?? {}),
                  ...(input.agentDetail
                    ? { agentDetail: input.agentDetail }
                    : {}),
                  ...(input.agentAttribution
                    ? { agentAttribution: input.agentAttribution }
                    : {}),
                },
              }
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
      if (threadId !== null) touchThreadRecord(input.channelId, threadId, now);
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
        row.sender_id !== input.editorId ||
        // A tombstone is not an editable row: an edit writes a body, and
        // deletion is the operator's statement that this row has none (#1308
        // item 4). Without this, "edit" would be an undelete.
        isTombstoneRow(row)
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
            ...(isTombstoneRow(row) ? { deleted: true } : {}),
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

    deleteMessage(input) {
      const row = selectById.get(input.messageId) as
        | ChannelMessageRow
        | undefined;
      // Channel mismatch reads as absence, same as `editMessage`: a caller that
      // proved access to ONE channel must not learn that an id it does not own
      // exists somewhere else.
      if (!row || row.channel_id !== input.channelId) {
        throw new ChannelMessageStoreError(
          404,
          'channel_message_not_found',
          'message not found in this channel',
          { channelId: input.channelId, messageId: input.messageId }
        );
      }
      // Idempotent by design — checked BEFORE the ownership gate would matter,
      // and returning the ORIGINAL stamp rather than restamping: two devices
      // racing the same delete must converge on one tombstone, not on whichever
      // arrived last.
      if (isTombstoneRow(row)) return rowToMessage(row);
      if (
        row.kind !== 'message' ||
        row.sender_kind !== 'human' ||
        row.status !== 'complete' ||
        row.sender_id !== input.deleterId
      ) {
        throw new ChannelMessageStoreError(
          409,
          'channel_message_not_deletable',
          'only the operator’s own completed messages can be deleted',
          {
            channelId: input.channelId,
            messageId: input.messageId,
            kind: row.kind,
            senderKind: row.sender_kind,
            status: row.status,
          }
        );
      }
      const now = nowIso();
      const meta = parseMeta(row.meta_json) ?? {};
      // Everything the body implied goes with the body. `mentions` would keep
      // lighting the sidebar's mention lane for text nobody can read; `parts`
      // would keep rendering the attached images the operator just erased; the
      // `editedAt` provenance note is meaningless once there is nothing left to
      // have been edited. What survives is routing/bookkeeping meta that names
      // the row rather than its content.
      delete meta.mentions;
      delete meta.parts;
      delete meta[CHANNEL_EDITED_AT_META_KEY];
      meta[CHANNEL_DELETED_AT_META_KEY] = now;
      // UPDATE, never DELETE. `seq` is the substrate contract: the row keeps its
      // number so catch-up windows, deep links and thread parents stay valid.
      db.prepare(
        `UPDATE channel_messages
         SET body_text = '', meta_json = @metaJson, updated_at = @now
         WHERE id = @id`
      ).run({ id: input.messageId, metaJson: JSON.stringify(meta), now });
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

    mentionContext(input) {
      const scope: ChannelMentionContextScope =
        input.threadRootId === null ? 'channel' : 'thread';
      const limit = cleanLimit(input.limit);
      const baseParams = {
        channelId: input.channelId,
        framework: input.framework,
        triggerSeq: input.triggerSeq,
        afterSeq: input.afterSeq,
        threadRootId: input.threadRootId,
        candidateBudget: mentionContextCandidateScanBudget,
      };
      const statements = mentionContextStatements[scope];
      const boundary = statements.boundary.get(baseParams) as
        | { seq: number }
        | undefined;
      const candidateScanTruncated = boundary !== undefined;
      // Identical in both scopes (#1408): the window opens at the caller's
      // delivery cursor and narrows only when the budget probe found older raw
      // entries inside it. Thread scope used to open at -1, which re-served the
      // whole thread on every turn and made `candidateScanTruncated` describe
      // already-delivered history.
      const candidateAfterSeq = boundary?.seq ?? input.afterSeq;
      const params = {
        ...baseParams,
        candidateAfterSeq,
        limit,
        replyLimit: Math.max(0, limit - 1),
      };
      if (candidateScanTruncated) {
        logger.warn(
          'mention_context_candidate_budget_truncated channel_id=%s scope=%s raw_index_entries_at_least=%d candidate_budget=%d',
          input.channelId,
          scope,
          mentionContextCandidateScanBudget + 1,
          mentionContextCandidateScanBudget
        );
      }
      const count = statements.count.get(params) as {
        total_count: number;
        activity_filtered_count: number;
      };
      const rows = statements.rows.all(params) as ChannelMessageRow[];
      rows.sort((left, right) => left.seq - right.seq);
      return {
        rows: rows.map(rowToMessage),
        totalCount: count.total_count,
        activityFilteredCount: count.activity_filtered_count,
        candidateScanBudget: mentionContextCandidateScanBudget,
        candidateScanTruncated,
        scope,
      };
    },

    searchMessages(input) {
      const match = buildChannelSearchMatchQuery(input.query);
      if (match === null) return [];
      // Distinct + explicit: an empty allowlist is "nothing visible", so it
      // short-circuits instead of falling through to an unscoped search.
      const channelIds =
        input.channelIds === undefined ? null : [...input.channelIds];
      if (channelIds !== null && channelIds.length === 0) return [];
      // Cost gate BEFORE the read (#1316): the cheapest query is the one that
      // never starts, and the doclist-merge setup this refuses is the one part
      // of the read the wall-clock ceiling below cannot interrupt.
      refuseOverBroadPrefix(input.query);
      // `+ 1` is the LOOKAHEAD allowance, not a wider page: a caller paging at
      // the maximum asks for one row past it purely to learn whether more hits
      // existed. Without it, `truncated` could never be true on a full page.
      const limit = cleanLimit(input.limit, CHANNEL_SEARCH_MAX_RESULTS + 1);
      // The deadline is armed around THIS call only, and disarmed in `finally`
      // so a leftover value can never abort an unrelated later read. The
      // ceiling reaches the query through `relay_channel_search_tick`, which
      // throws `ChannelSearchRefusedError('search_timeout')` from inside
      // sqlite; better-sqlite3 propagates the original object, so no error
      // string has to be pattern-matched here.
      searchDeadline = Date.now() + searchTimeBudgetMs;
      let rows: ChannelSearchRow[];
      try {
        rows = db
          .prepare(buildChannelMessageSearchSql(channelIds?.length ?? 0))
          .all(
            CHANNEL_SEARCH_HIGHLIGHT_OPEN,
            CHANNEL_SEARCH_HIGHLIGHT_CLOSE,
            CHANNEL_SEARCH_SNIPPET_ELLIPSIS,
            match,
            ...(channelIds ?? []),
            limit
          ) as ChannelSearchRow[];
      } catch (error) {
        if (error instanceof ChannelSearchRefusedError) {
          // SHAPE, not text. Operator search input is exactly the place a
          // pasted secret or a credential someone is hunting for in the
          // transcript shows up, and this line is reachable repeatedly by any
          // CONTEXT_READ holder. Term count and the prefix length are what
          // diagnose a timeout; the words are not.
          logger.warn(
            'channel search exceeded its %dms budget (%d term(s), %d-char prefix); answering search_timeout',
            searchTimeBudgetMs,
            match.split(' AND ').length,
            channelSearchPrefixRange(input.query)?.low.length ?? 0
          );
        }
        throw error;
      } finally {
        searchDeadline = Number.POSITIVE_INFINITY;
      }
      return rows.map(searchRowToHit);
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
                   OR json_extract(m.meta_json, '$.${CHANNEL_EDITED_AT_META_KEY}') IS NOT NULL
                   OR json_extract(m.meta_json, '$.${CHANNEL_DELETED_AT_META_KEY}') IS NOT NULL)
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

    listReadState() {
      // The clamp is SQL, not post-processing, so the ceiling is computed by the
      // same indexed `MAX(seq)` probe (idx_chm_channel_seq) `latestSeq` uses —
      // one covering-index lookup per marked channel, not a scan.
      const rows = db
        .prepare(
          `SELECT r.channel_id AS channel_id,
                  MIN(
                    r.last_read_seq,
                    COALESCE(
                      (SELECT MAX(m.seq) FROM channel_messages m
                        WHERE m.channel_id = r.channel_id),
                      0
                    )
                  ) AS last_read_seq,
                  r.updated_at AS updated_at
             FROM ${CHANNEL_READ_STATE_TABLE} r
            ORDER BY r.channel_id ASC`
        )
        .all() as ChannelReadStateRow[];
      return rows.map(readStateRowToState);
    },

    markChannelRead(channelId, lastReadSeq) {
      // Non-finite / negative / fractional input is floored to a sane 0 here
      // rather than throwing: the route already rejects malformed bodies, and a
      // store that throws on a read marker would turn a cosmetic sync miss into
      // a failed request on the operator's own reading path.
      const requested = Number.isFinite(lastReadSeq)
        ? Math.max(0, Math.floor(lastReadSeq))
        : 0;
      const write = db.transaction((): ChannelReadStateWriteResult => {
        const head = (
          db
            .prepare(
              'SELECT COALESCE(MAX(seq), 0) AS latest FROM channel_messages WHERE channel_id = ?'
            )
            .get(channelId) as { latest: number }
        ).latest;
        const next = Math.min(requested, head);
        const existing = db
          .prepare(
            `SELECT last_read_seq, updated_at FROM ${CHANNEL_READ_STATE_TABLE}
              WHERE channel_id = ?`
          )
          .get(channelId) as
          | { last_read_seq: number; updated_at: string }
          | undefined;
        // Compare against — and report — the CLAMPED stored mark, not the raw
        // one. A mark stranded above a rewound head would otherwise be echoed
        // straight back to the device that just wrote, contradicting the value
        // `listReadState` hands every other device on its next boot.
        const current = Math.min(existing?.last_read_seq ?? 0, head);
        if (next <= current) {
          return {
            channelId,
            lastReadSeq: current,
            updatedAt: existing?.updated_at ?? nowIso(),
            advanced: false,
          };
        }
        const updatedAt = nowIso();
        db.prepare(
          `INSERT INTO ${CHANNEL_READ_STATE_TABLE}
             (channel_id, last_read_seq, updated_at)
           VALUES (@channelId, @lastReadSeq, @updatedAt)
           ON CONFLICT(channel_id) DO UPDATE SET
             last_read_seq = excluded.last_read_seq,
             updated_at    = excluded.updated_at`
        ).run({ channelId, lastReadSeq: next, updatedAt });
        return { channelId, lastReadSeq: next, updatedAt, advanced: true };
      });
      return write();
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
      // A tombstone (#1308 item 4) is body-less for the same reason and is
      // skipped by the same rule: deleting the last message must not leave the
      // sidebar showing an empty channel.
      const previewRows = new Map<string, ChannelMessageRow>();
      for (const row of db
        .prepare(
          `SELECT prose.* FROM (
             SELECT channel_id, MAX(seq) AS max_seq
             FROM channel_messages
             WHERE json_extract(meta_json, '$.agentDetail') IS NULL
               AND json_extract(meta_json, '$.${CHANNEL_DELETED_AT_META_KEY}') IS NULL
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
      // Preview from the newest prose row; detail cards and tombstones both
      // persist body_text='' and are skipped for the same reason.
      const previewRow =
        (db
          .prepare(
            `SELECT * FROM channel_messages WHERE channel_id = ?
               AND json_extract(meta_json, '$.agentDetail') IS NULL
               AND json_extract(meta_json, '$.${CHANNEL_DELETED_AT_META_KEY}') IS NULL
             ORDER BY seq DESC LIMIT 1`
          )
          .get(channelId) as ChannelMessageRow | undefined) ?? last;
      return summaryFromLastRow(last.seq, previewRow, count);
    },

    listChannelThreadSummaries(
      channelId,
      limit = CHANNEL_THREAD_SUMMARY_LIMIT
    ) {
      return listChannelThreadSummariesImpl(channelId, limit);
    },

    createThread(input) {
      const title = normalizeThreadTitle(input.title);
      const root = appendCompleteImpl({
        channelId: input.channelId,
        kind: 'system',
        sender: { kind: 'system', id: 'system' },
        text: 'conversation created',
        meta: { threadRoot: true },
      });
      const now = nowIso();
      db.prepare(
        `INSERT INTO channel_threads
           (channel_id, root_message_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(input.channelId, root.id, title, now, now);
      const summary = threadSummaryForRoot(input.channelId, root.id);
      if (!summary) throw new Error('created thread was not readable');
      return summary;
    },

    renameThread(input) {
      const title = normalizeThreadTitle(input.title);
      ensureThreadRecord(input.channelId, input.rootMessageId);
      const changed = db
        .prepare(
          `UPDATE channel_threads SET title = ?, updated_at = ?
            WHERE channel_id = ? AND root_message_id = ?`
        )
        .run(title, nowIso(), input.channelId, input.rootMessageId).changes;
      if (changed === 0) return null;
      return threadSummaryForRoot(input.channelId, input.rootMessageId);
    },

    getThreadTitle(channelId, rootMessageId) {
      const row = db
        .prepare(
          `SELECT title FROM channel_threads
            WHERE channel_id = ? AND root_message_id = ?`
        )
        .get(channelId, rootMessageId) as { title: string } | undefined;
      return row?.title ?? null;
    },

    upsertMember(input) {
      const write = db.transaction((): ChannelMemberRef => {
        const joinedAt = nowIso();
        const existing = selectMemberExactStmt.get(
          input.channelId,
          input.kind,
          input.id
        ) as MemberRow | undefined;
        // Writing your own way in is not an admission, so a NEW spelling of a
        // participant whose class was removed is created already tombstoned.
        // An existing row keeps whatever state it has (the SQL revives a HUMAN
        // and only a human), so this only ever governs the insert.
        const stamp = existing
          ? null
          : classRemovalStamp(input.channelId, input.kind, input.id);
        upsertMemberStmt.run({
          channelId: input.channelId,
          memberKind: input.kind,
          memberId: input.id,
          joinedAt: existing?.joined_at ?? joinedAt,
          metadataJson: JSON.stringify(input.metadata ?? {}),
          invitedBy: input.invitedBy ?? null,
        });
        inheritClassRemoval(input.channelId, input.kind, input.id, stamp);
        // Read the row back rather than reconstructing it: the caller must not
        // be handed a live-looking ref for a row `isMember` calls a non-member.
        const row = selectMemberExactStmt.get(
          input.channelId,
          input.kind,
          input.id
        ) as MemberRow | undefined;
        if (row) return memberRowToRef(row);
        const invitedBy = existing?.invited_by ?? input.invitedBy ?? null;
        return {
          kind: input.kind,
          id: input.id,
          joinedAt: existing?.joined_at ?? joinedAt,
          ...(invitedBy ? { invitedBy } : {}),
        };
      });
      return write();
    },

    listMembers(channelId) {
      return (listMembersStmt.all(channelId) as MemberRow[]).map(
        memberRowToRef
      );
    },

    isMember(channelId, kind, id) {
      return (
        isMemberStmt.get(memberMatchParams(channelId, kind, id)) !== undefined
      );
    },

    getMember(channelId, kind, id) {
      const rows = matchMemberRowsStmt.all(
        memberMatchParams(channelId, kind, id)
      ) as MemberRow[];
      const live = rows.find((row) => row.removed_at === null);
      return live ? memberRowToRef(live) : null;
    },

    inviteMember(input) {
      const invite = db.transaction((): ChannelMemberRef => {
        const rows = matchMemberRowsStmt.all(
          memberMatchParams(input.channelId, input.kind, input.id)
        ) as MemberRow[];
        const live = rows.find((row) => row.removed_at === null);
        // Already in the room: inviting again is a no-op that preserves the
        // ORIGINAL attribution. First-writer wins here exactly as it does on
        // `upsertMember`, so a member cannot relabel how it got in by inviting
        // itself a second time.
        if (live) return memberRowToRef(live);
        const joinedAt = nowIso();
        if (rows.length > 0) {
          // Re-admitting a removed participant. Every stored spelling of it is
          // readmitted together, or the row that stayed tombstoned would keep
          // answering "removed" to a `getMember` that resolved the other one.
          for (const row of rows) {
            readmitMemberStmt.run({
              channelId: input.channelId,
              memberKind: row.member_kind,
              memberId: row.member_id,
              invitedBy: input.invitedBy,
              joinedAt,
            });
          }
          const readmitted = matchMemberRowsStmt.all(
            memberMatchParams(input.channelId, input.kind, input.id)
          ) as MemberRow[];
          const row = readmitted.find((entry) => entry.removed_at === null);
          if (row) return memberRowToRef(row);
        }
        upsertMemberStmt.run({
          channelId: input.channelId,
          memberKind: input.kind,
          memberId: input.id,
          joinedAt,
          metadataJson: JSON.stringify(input.metadata ?? {}),
          invitedBy: input.invitedBy,
        });
        return {
          kind: input.kind,
          id: input.id,
          joinedAt,
          invitedBy: input.invitedBy,
        };
      });
      return invite();
    },

    removeMember(input) {
      const remove = db.transaction((): ChannelMemberRef | null => {
        const rows = matchMemberRowsStmt.all(
          memberMatchParams(input.channelId, input.kind, input.id)
        ) as MemberRow[];
        const live = rows.filter((row) => row.removed_at === null);
        if (live.length === 0) return null;
        const removedAt = nowIso();
        for (const row of live) {
          tombstoneMemberStmt.run({
            channelId: input.channelId,
            memberKind: row.member_kind,
            memberId: row.member_id,
            removedAt,
            removedBy: input.removedBy,
          });
        }
        const first = live[0] as MemberRow;
        return memberRowToRef(first);
      });
      return remove();
    },

    backfillMembership(options) {
      return backfillChannelMembership(db, options ?? {});
    },

    findDmChannel(memberIdA, memberIdB) {
      const row = db
        .prepare(
          // Tombstoned rows are not participants, so a DM whose member was
          // removed must not still resolve as that pair (#1455 slice 2).
          `SELECT channel_id FROM channel_members
            WHERE removed_at IS NULL
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

    getBinding(channelId, profileActorId, threadId = null) {
      return getBindingImpl(channelId, profileActorId, threadId);
    },

    getSoleOrchestratorBinding(channelId) {
      return getSoleOrchestratorBindingImpl(channelId);
    },

    designateSoleOrchestrator(input) {
      const designate = (): ChannelBinding => {
        const binding = designateSoleOrchestratorTransaction.immediate(input);
        enrollBoundMember(input.channelId, input.profileActorId);
        return binding;
      };
      try {
        // IMMEDIATE takes the write reservation before the conflict read, so
        // separate store handles cannot both observe an empty designation.
        return designate();
      } catch (error) {
        if (error instanceof ChannelMessageStoreError) throw error;
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          String(error.code).startsWith('SQLITE_CONSTRAINT')
        ) {
          const designated = getSoleOrchestratorBindingImpl(input.channelId);
          throw createChannelOrchestratorConflictError({
            channelId: input.channelId,
            designatedProfileActorId: designated?.profileActorId ?? null,
            requestedProfileActorId: input.profileActorId,
          });
        }
        throw error;
      }
    },

    upsertBinding(input) {
      // Untyped callers must not bypass the channel-level invariant.
      if ((input as { role?: AgentRole | null }).role === 'orchestrator') {
        throw new ChannelMessageStoreError(
          400,
          'orchestrator_requires_sole_designation',
          'use designateSoleOrchestrator to assign the orchestrator role'
        );
      }
      const binding = writeBindingImpl(input);
      enrollBoundMember(input.channelId, input.profileActorId);
      return binding;
    },

    createCompletionCallback(input) {
      return createCompletionCallbackImpl(input);
    },

    satisfyCompletionCallback(input) {
      return satisfyCompletionCallbackImpl(input);
    },

    deferCompletionCallbackForChild(input) {
      return deferCompletionCallbackForChildImpl(input);
    },

    announceContinuationChildren(callbackId, expectedChildCount) {
      return announceContinuationChildrenImpl(callbackId, expectedChildCount);
    },

    completeChildContinuation(input) {
      return completeChildContinuationImpl(input);
    },

    releaseDeferredCompletionCallback(id) {
      return releaseDeferredCompletionCallbackImpl(id);
    },

    getCompletionCallback(id) {
      const row = selectCompletionCallbackById.get(id) as
        | CompletionCallbackRow
        | undefined;
      return row ? completionCallbackRowToRecord(row) : null;
    },

    claimSatisfiedCompletionCallbacks(limit = 100) {
      const bounded = Math.max(1, Math.min(1_000, Math.floor(limit)));
      return claimSatisfiedCompletionCallbacksImpl(bounded);
    },

    releaseDeliveredCompletionCallback(id) {
      return releaseDeliveredCompletionCallbackImpl(id);
    },

    terminalizeDeliveredCompletionCallback(input) {
      return terminalizeDeliveredCompletionCallbackImpl(input);
    },

    consumeCompletionCallback(id) {
      const timestamp = nowIso();
      return (
        db
          .prepare(
            `UPDATE channel_completion_callbacks
                SET state = 'consumed', consumed_at = ?, updated_at = ?
              WHERE id = ? AND state = 'delivered'`
          )
          .run(timestamp, timestamp, id).changes > 0
      );
    },

    consumeCompletionCallbacksForExplicitReturn(input) {
      return consumeCompletionCallbacksForExplicitReturnImpl(input);
    },

    consumeAncestorCompletionCallbackForExplicitReturn(id) {
      return consumeAncestorCompletionCallbackForExplicitReturnImpl(id);
    },

    recoverCompletionCallbacks() {
      const recovered = recoverCompletionCallbacksImpl();
      pruneConsumedCompletionCallbacksImpl(
        COMPLETION_CALLBACK_CONSUMED_RETENTION_MS
      );
      return recovered;
    },

    pruneConsumedCompletionCallbacks(
      olderThanMs = COMPLETION_CALLBACK_CONSUMED_RETENTION_MS
    ) {
      return pruneConsumedCompletionCallbacksImpl(
        Math.max(0, Math.floor(olderThanMs))
      );
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
        'channel_completion_callbacks',
        'channel_async_runs',
        // Read marks are swept for the same reason bindings are: a channel the
        // topic store no longer knows about is gone, and its marker would
        // otherwise be resurrected verbatim by a channel later created under the
        // same deterministic id (DMs are keyed by member pair, #1178) — where a
        // stale-high mark hides the new conversation's messages on every device
        // at once. Listing the table here also means a channel whose ONLY
        // remaining row is a read mark is still recognised as an orphan.
        CHANNEL_READ_STATE_TABLE,
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
          db.prepare(
            'DELETE FROM channel_completion_callbacks WHERE channel_id = ?'
          ).run(id);
          db.prepare(
            `DELETE FROM channel_async_run_targets
              WHERE run_id IN (SELECT id FROM channel_async_runs WHERE channel_id = ?)`
          ).run(id);
          db.prepare('DELETE FROM channel_async_runs WHERE channel_id = ?').run(
            id
          );
          db.prepare(
            `DELETE FROM ${CHANNEL_READ_STATE_TABLE} WHERE channel_id = ?`
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

function parseBindingProviderSession(
  providerSessionJson: string
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(providerSessionJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function bindingRowToRecord(row: BindingRow): ChannelBinding {
  const providerSession = parseBindingProviderSession(
    row.provider_session_json
  );
  return {
    channelId: row.channel_id,
    threadId: row.thread_scope_id || null,
    profileActorId: row.profile_actor_id,
    agentFramework: row.agent_framework,
    runtimeId: row.runtime_id,
    role: row.binding_role,
    providerSession,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function completionCallbackRowToRecord(
  row: CompletionCallbackRow
): ChannelCompletionCallbackEdge {
  return {
    id: row.id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    triggerMessageId: row.trigger_message_id,
    requesterProfileId: row.requester_profile_id,
    targetProfileId: row.target_profile_id,
    targetRuntimeId: row.target_runtime_id,
    targetTurnId: row.target_turn_id,
    continuationParentCallbackId: row.continuation_parent_callback_id,
    awaitingChild: row.awaiting_child === 1,
    pendingChildIntents: row.pending_child_intents,
    continuationCompletedAt: row.continuation_completed_at,
    state: row.state,
    terminalReason: row.terminal_reason,
    terminalMessageId: row.terminal_message_id,
    messageDisposition: row.message_disposition,
    deliveryReason: row.delivery_reason,
    createdAt: row.created_at,
    satisfiedAt: row.satisfied_at,
    deliveredAt: row.delivered_at,
    consumedAt: row.consumed_at,
    undeliverableAt: row.undeliverable_at,
    updatedAt: row.updated_at,
  };
}
