import * as crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  CHANNEL_CHAT_PROTOCOL_VERSION,
  CHANNEL_MESSAGE_BODY_MAX_BYTES,
  type ChannelBodyFormat,
  type ChannelMemberRef,
  type ChannelMention,
  type ChannelMessage,
  type ChannelMessageId,
  type ChannelMessageKind,
  type ChannelMessageStatus,
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
//  * Edits/deletes are out of scope for slice 2 and must NEVER be implemented as
//    row deletion — that would break gap-free seq. Future mutation lands as new
//    events over retained rows.

const SCHEMA_VERSION = 1;
export const CHANNEL_HISTORY_DEFAULT_LIMIT = 50;
export const CHANNEL_HISTORY_MAX_LIMIT = 200;
const CHANNEL_SUMMARY_PREVIEW_MAX_CHARS = 200;

export type ChannelThreadHistoryQueryMode = 'default' | 'after' | 'before';

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
                  (SELECT COUNT(*) FROM channel_messages replies
                   WHERE replies.thread_id = m.id) AS reply_count
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

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS channel_messages (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'message'
                      CHECK (kind IN ('message','system')),
  status            TEXT NOT NULL DEFAULT 'complete'
                      CHECK (status IN ('streaming','complete','interrupted','failed')),
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
CREATE INDEX IF NOT EXISTS idx_chm_channel_seq
  ON channel_messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_chm_thread
  ON channel_messages(thread_id, seq) WHERE thread_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chm_source_dedupe
  ON channel_messages(source_session_id, source_turn_id, source_item_id)
  WHERE source_session_id IS NOT NULL;
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
  agent_framework       TEXT NOT NULL,
  session_id            TEXT,
  provider_session_json TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (channel_id, agent_framework)
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
  source_session_id: string | null;
  source_turn_id: string | null;
  source_item_id: string | null;
  client_message_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  reply_count?: number;
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
  agent_framework: string;
  session_id: string | null;
  provider_session_json: string;
  created_at: string;
  updated_at: string;
}

export interface ChannelMessageMeta {
  mentions?: ChannelMention[];
  truncated?: boolean;
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
  meta?: ChannelMessageMeta;
}

export interface BeginStreamInput {
  channelId: string;
  sender: ChannelSenderRef;
  source: { sessionId: string; turnId?: string; itemId?: string };
  text?: string;
  parentMessageId?: string;
  mentions?: ChannelMention[];
}

export interface FinalizeStreamInput {
  text: string;
  status: Extract<ChannelMessageStatus, 'complete' | 'interrupted' | 'failed'>;
  truncated?: boolean;
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
    status: ChannelMessageStatus;
    createdAt: string;
  } | null;
}

type ChannelSenderKindLoose = ChannelSenderRef['kind'];

export interface ChannelHistoryFilter {
  beforeSeq?: number;
  afterSeq?: number;
  limit?: number;
  threadId?: string;
}

export interface ChannelBinding {
  channelId: string;
  agentFramework: string;
  sessionId: string | null;
  providerSession: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StaleStreamSweepResult {
  channelId: string;
  interruptedIds: ChannelMessageId[];
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
  finalizeStream(id: string, input: FinalizeStreamInput): ChannelMessage | null;
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
   * Rows a reconnecting client may still hold as stale `streaming` copies:
   * agent-origin rows (source triple set) at or below the reconnect cursor, in
   * their CURRENT state, nearest the cursor first. Only agent streams mutate in
   * place (streaming → complete/interrupted/failed without a new seq), so this is
   * the exact set catch-up must re-send to heal a stream that finalized while the
   * client was disconnected. Bounded by `limit`.
   */
  listResyncRows(
    channelId: string,
    uptoSeq: number,
    limit: number
  ): ChannelMessage[];
  latestSeq(channelId: string): number;
  listChannelSummaries(): ChannelSummary[];
  getChannelSummary(channelId: string): ChannelSummary | null;
  upsertMember(input: {
    channelId: string;
    kind: 'human' | 'agent';
    id: string;
    metadata?: Record<string, unknown>;
  }): ChannelMemberRef;
  listMembers(channelId: string): ChannelMemberRef[];
  findDmChannel(memberIdA: string, memberIdB: string): string | null;
  getBinding(channelId: string, agentFramework: string): ChannelBinding | null;
  upsertBinding(input: {
    channelId: string;
    agentFramework: string;
    sessionId?: string | null;
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
  if (row.source_session_id) sender.sessionId = row.source_session_id;

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
  // Surface app-level meta (e.g. #1167 approval payloads) while keeping the
  // internal routing keys off the wire — providerId rides `sender.providerId`,
  // mentions/truncated have dedicated fields above.
  if (meta) {
    const { providerId: _pid, mentions: _m, truncated: _t, ...rest } = meta;
    if (Object.keys(rest).length > 0) message.meta = rest;
  }
  if (row.source_session_id) {
    message.source = {
      sessionId: row.source_session_id,
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
  truncated?: boolean;
  providerId?: string;
  extra?: ChannelMessageMeta;
}): string | null {
  const meta: ChannelMessageMeta = { ...(input.extra ?? {}) };
  if (input.mentions && input.mentions.length > 0)
    meta.mentions = input.mentions;
  if (input.truncated) meta.truncated = true;
  if (input.providerId) meta['providerId'] = input.providerId;
  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
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
            (SELECT COUNT(*) FROM channel_messages replies
             WHERE replies.thread_id = m.id) AS reply_count
     FROM channel_messages m WHERE m.id = ?`
  );
  const selectBySource = db.prepare(
    `SELECT * FROM channel_messages
     WHERE source_session_id IS @sessionId
       AND source_turn_id IS @turnId
       AND source_item_id IS @itemId`
  );
  const selectByClientId = db.prepare(
    `SELECT * FROM channel_messages
     WHERE channel_id = @channelId AND sender_id = @senderId
       AND client_message_id = @clientMessageId`
  );

  // Single atomic INSERT: seq is allocated inside the same statement via
  // SELECT COALESCE(MAX(seq),0)+1. SQLite takes the write lock for the whole
  // statement (incl. the subquery), so concurrent inserts serialize correctly;
  // UNIQUE(channel_id, seq) is the loud backstop for any residual race
  // (dev/prod config-dir overlap) — a constraint failure, never a silent reorder.
  const insertMessage = db.prepare(
    `INSERT INTO channel_messages (
       id, channel_id, seq, kind, status, sender_kind, sender_id, sender_display,
       thread_id, parent_message_id, body_text, body_format, meta_json,
       source_session_id, source_turn_id, source_item_id, client_message_id,
       created_at, updated_at, completed_at
     ) VALUES (
       @id, @channelId,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM channel_messages WHERE channel_id = @channelId),
       @kind, @status, @senderKind, @senderId, @senderDisplay,
       @threadId, @parentMessageId, @bodyText, @bodyFormat, @metaJson,
       @sourceSessionId, @sourceTurnId, @sourceItemId, @clientMessageId,
       @createdAt, @updatedAt, @completedAt
     )`
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
    assertBodySize(input.text);
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
        ...(input.sender.providerId
          ? { providerId: input.sender.providerId }
          : {}),
        ...(input.meta ? { extra: input.meta } : {}),
      }),
      sourceSessionId: null,
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
    agentFramework: string
  ): ChannelBinding | null {
    const row = db
      .prepare(
        'SELECT * FROM channel_agent_bindings WHERE channel_id = ? AND agent_framework = ?'
      )
      .get(channelId, agentFramework) as BindingRow | undefined;
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
      // Idempotent: single-process synchronous check-then-insert is race-free;
      // idx_chm_source_dedupe is the loud backstop for any cross-process retry.
      const existing = selectBySource.get({
        sessionId: input.source.sessionId,
        turnId: input.source.turnId ?? null,
        itemId: input.source.itemId ?? null,
      }) as ChannelMessageRow | undefined;
      if (existing) return rowToMessage(existing);

      const initialText = input.text ?? '';
      assertBodySize(initialText);
      const threadId = resolveThread(input.channelId, input.parentMessageId);
      const now = nowIso();
      const id = createMessageId();
      const row = insertRow({
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
          ...(input.sender.providerId
            ? { providerId: input.sender.providerId }
            : {}),
        }),
        sourceSessionId: input.source.sessionId,
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
      assertBodySize(text);
      const row = selectById.get(id) as ChannelMessageRow | undefined;
      if (!row) return null;
      db.prepare(
        'UPDATE channel_messages SET body_text = @text, updated_at = @now WHERE id = @id'
      ).run({ id, text, now: nowIso() });
      return getMessageById(id);
    },

    finalizeStream(id, input) {
      const row = selectById.get(id) as ChannelMessageRow | undefined;
      if (!row) return null;
      // Idempotent replay: finalizing an already-final row is a no-op.
      if (row.status !== 'streaming') return rowToMessage(row);
      assertBodySize(input.text);
      const now = nowIso();
      const meta = parseMeta(row.meta_json) ?? {};
      if (input.truncated) meta.truncated = true;
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
                    (SELECT COUNT(*) FROM channel_messages replies
                     WHERE replies.thread_id = m.id) AS reply_count
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
                  (SELECT COUNT(*) FROM channel_messages replies
                   WHERE replies.thread_id = m.id) AS reply_count
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
                  (SELECT COUNT(*) FROM channel_messages replies
                   WHERE replies.thread_id = m.id) AS reply_count
             FROM channel_messages m
            WHERE m.channel_id = @channelId AND m.seq <= @uptoSeq
              AND m.source_session_id IS NOT NULL
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
             SELECT channel_id, MAX(seq) AS max_seq, COUNT(*) AS cnt
             FROM channel_messages GROUP BY channel_id
           ) agg
           JOIN channel_messages last
             ON last.channel_id = agg.channel_id AND last.seq = agg.max_seq
           ORDER BY last.updated_at DESC`
        )
        .all() as Array<ChannelMessageRow & { cnt?: number }>;
      // Second pass for counts keyed by channel (kept explicit for clarity).
      const counts = new Map<string, number>();
      for (const c of db
        .prepare(
          'SELECT channel_id, COUNT(*) AS cnt FROM channel_messages GROUP BY channel_id'
        )
        .all() as Array<{ channel_id: string; cnt: number }>) {
        counts.set(c.channel_id, c.cnt);
      }
      return rows.map((row) =>
        summaryFromLastRow(row, counts.get(row.channel_id) ?? 0)
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
            'SELECT COUNT(*) AS cnt FROM channel_messages WHERE channel_id = ?'
          )
          .get(channelId) as { cnt: number }
      ).cnt;
      if (!last) {
        return { channelId, latestSeq: 0, messageCount: 0, lastMessage: null };
      }
      return summaryFromLastRow(last, count);
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

    getBinding(channelId, agentFramework) {
      return getBindingImpl(channelId, agentFramework);
    },

    upsertBinding(input) {
      const now = nowIso();
      const existing = db
        .prepare(
          'SELECT * FROM channel_agent_bindings WHERE channel_id = ? AND agent_framework = ?'
        )
        .get(input.channelId, input.agentFramework) as BindingRow | undefined;
      const providerSessionJson = JSON.stringify(
        input.providerSession ??
          (existing ? JSON.parse(existing.provider_session_json) : {})
      );
      db.prepare(
        `INSERT INTO channel_agent_bindings
           (channel_id, agent_framework, session_id, provider_session_json, created_at, updated_at)
         VALUES (@channelId, @agentFramework, @sessionId, @providerSessionJson, @createdAt, @updatedAt)
         ON CONFLICT(channel_id, agent_framework) DO UPDATE SET
           session_id = excluded.session_id,
           provider_session_json = excluded.provider_session_json,
           updated_at = excluded.updated_at`
      ).run({
        channelId: input.channelId,
        agentFramework: input.agentFramework,
        sessionId:
          input.sessionId !== undefined
            ? input.sessionId
            : (existing?.session_id ?? null),
        providerSessionJson,
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
      });
      return getBindingImpl(input.channelId, input.agentFramework)!;
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
            "SELECT id FROM channel_messages WHERE channel_id = ? AND status = 'streaming'"
          )
          .all(channelId) as Array<{ id: string }>;
        const now = nowIso();
        db.prepare(
          `UPDATE channel_messages
           SET status = 'interrupted', updated_at = @now, completed_at = @now
           WHERE channel_id = @channelId AND status = 'streaming'`
        ).run({ channelId, now });
        const systemMessage = appendCompleteImpl({
          channelId,
          kind: 'system',
          sender: { kind: 'system', id: 'system' },
          text: 'Agent reply interrupted by restart.',
        });
        results.push({
          channelId,
          interruptedIds: stale.map((s) => s.id as ChannelMessageId),
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

  function summaryFromLastRow(
    row: ChannelMessageRow,
    messageCount: number
  ): ChannelSummary {
    return {
      channelId: row.channel_id,
      latestSeq: row.seq,
      messageCount,
      lastMessage: {
        id: row.id as ChannelMessageId,
        seq: row.seq,
        preview: row.body_text.slice(0, CHANNEL_SUMMARY_PREVIEW_MAX_CHARS),
        senderId: row.sender_id,
        senderKind: row.sender_kind as ChannelSenderRef['kind'],
        status: row.status as ChannelMessageStatus,
        createdAt: row.created_at,
      },
    };
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
    agentFramework: row.agent_framework,
    sessionId: row.session_id,
    providerSession,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
