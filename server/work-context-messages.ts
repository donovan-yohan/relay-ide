import * as crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  WORK_CONTEXT_MESSAGE_SCHEMA_VERSION,
  normalizeWorkContextMessageCreateInput,
  parseWorkContextMessageEnvelope,
  type WorkContextMessageAudience,
  type WorkContextMessageCreateInput,
  type WorkContextMessageEnvelope,
  type WorkContextMessageId,
  type WorkContextMessageListFilter,
  type WorkContextMessageRefs,
  type WorkContextMessageRedactionMetadata,
  type WorkContextMessageValidationError,
} from '../shared/work-context-message.js';

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_context_messages (
  id                  TEXT PRIMARY KEY,
  work_context_id     TEXT NOT NULL,
  kind                TEXT NOT NULL,
  thread_id           TEXT NOT NULL,
  parent_message_id   TEXT,
  reply_to_message_id TEXT,
  sender_kind         TEXT NOT NULL,
  sender_id           TEXT NOT NULL,
  audience_json       TEXT NOT NULL,
  refs_json           TEXT NOT NULL,
  payload_schema      TEXT,
  summary             TEXT NOT NULL,
  visibility          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  message_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_context_messages_context_created
  ON work_context_messages(work_context_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_context_messages_thread_created
  ON work_context_messages(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_work_context_messages_parent
  ON work_context_messages(parent_message_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_work_context_messages_kind
  ON work_context_messages(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_context_messages_sender
  ON work_context_messages(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_context_messages_payload_schema
  ON work_context_messages(payload_schema, created_at DESC);

CREATE TABLE IF NOT EXISTS work_context_message_refs (
  message_id TEXT NOT NULL,
  ref_kind   TEXT NOT NULL,
  ref_value  TEXT NOT NULL,
  ref_label  TEXT,
  PRIMARY KEY (message_id, ref_kind, ref_value),
  FOREIGN KEY (message_id) REFERENCES work_context_messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_work_context_message_refs_lookup
  ON work_context_message_refs(ref_kind, ref_value, message_id);

CREATE TABLE IF NOT EXISTS work_context_message_audience (
  message_id    TEXT NOT NULL,
  audience_kind TEXT NOT NULL,
  audience_id   TEXT NOT NULL,
  PRIMARY KEY (message_id, audience_kind, audience_id),
  FOREIGN KEY (message_id) REFERENCES work_context_messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_work_context_message_audience_lookup
  ON work_context_message_audience(audience_kind, audience_id, message_id);
`;

interface WorkContextMessageRow {
  id: string;
  work_context_id: string;
  kind: string;
  thread_id: string;
  parent_message_id: string | null;
  reply_to_message_id: string | null;
  sender_kind: string;
  sender_id: string;
  audience_json: string;
  refs_json: string;
  payload_schema: string | null;
  summary: string;
  visibility: string;
  created_at: string;
  updated_at: string;
  message_json: string;
}

interface RefEntry {
  kind: string;
  value: string;
  label?: string;
}

export interface WorkContextMessageStore {
  close(): void;
  append(input: unknown): WorkContextMessageEnvelope;
  get(id: WorkContextMessageId): WorkContextMessageEnvelope | null;
  list(filter?: WorkContextMessageListFilter): WorkContextMessageEnvelope[];
}

export class WorkContextMessageStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'WorkContextMessageStoreError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function createMessageId(): WorkContextMessageId {
  return `wcm:${crypto.randomUUID()}`;
}

function cleanLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function parseRow(row: WorkContextMessageRow | undefined): WorkContextMessageEnvelope | null {
  if (!row) return null;
  try {
    return parseWorkContextMessageEnvelope(JSON.parse(row.message_json));
  } catch (error) {
    throw new WorkContextMessageStoreError(500, 'message_corrupt', 'stored WorkContext message is corrupt', {
      messageId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  const current = row?.version ?? 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(`work-context-messages.db schema ${current} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (current < 1) {
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    })();
  }
}

function addRef(refs: RefEntry[], kind: string, value: string | undefined, label?: string): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  refs.push({ kind, value: trimmed, ...(label ? { label } : {}) });
}

function refsForMessage(message: WorkContextMessageEnvelope): RefEntry[] {
  const out: RefEntry[] = [];
  addRef(out, 'workContextId', message.workContextId);
  addRef(out, 'kind', message.kind);
  addRef(out, 'senderId', message.sender.id);
  addRef(out, 'threadId', message.refs.threadId);
  addRef(out, 'parentMessageId', message.refs.parentMessageId);
  addRef(out, 'replyToMessageId', message.refs.replyToMessageId);
  addRef(out, 'payloadSchema', message.payloadSchema);
  if (message.refs.repo) {
    addRef(out, 'repo.ownerRepo', message.refs.repo.ownerRepo);
    addRef(out, 'repo.remoteUrl', message.refs.repo.remoteUrl);
    addRef(out, 'repo.localPath', message.refs.repo.localPath);
    addRef(out, 'repo.branchName', message.refs.repo.branchName);
    addRef(out, 'repo.headSha', message.refs.repo.headSha);
    addRef(out, 'repo.baseRef', message.refs.repo.baseRef);
  }
  for (const task of message.refs.taskRefs ?? []) {
    addRef(out, `task.${task.kind}`, task.id, task.title);
    addRef(out, 'taskRef', `${task.kind}:${task.id}`, task.title);
  }
  for (const session of message.refs.sessions ?? []) {
    addRef(out, 'sessionId', session.sessionId);
    addRef(out, 'globalSessionId', session.globalSessionId);
    addRef(out, 'nodeId', session.nodeId);
  }
  for (const artifact of [...(message.refs.artifacts ?? []), ...(message.payload.artifactRefs ?? [])]) {
    addRef(out, 'artifactId', artifact.id, artifact.title);
    addRef(out, 'artifactUri', artifact.uri, artifact.title);
  }
  for (const id of message.refs.workflowRunIds ?? []) addRef(out, 'workflowRunId', id);
  for (const external of message.refs.external ?? []) {
    addRef(out, `external.${external.kind}`, external.id, external.label);
    addRef(out, 'external', `${external.kind}:${external.id}`, external.label);
  }
  return out;
}

function audienceRows(audience: WorkContextMessageAudience[]): RefEntry[] {
  const rows: RefEntry[] = [];
  for (const entry of audience) {
    addRef(rows, entry.kind, entry.id ?? '*', entry.displayName);
  }
  return rows;
}

export function initWorkContextMessageStore(configDir: string): WorkContextMessageStore {
  return createWorkContextMessageStore(path.join(configDir, 'work-context-messages.db'));
}

export function createWorkContextMessageStore(dbPath: string): WorkContextMessageStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const selectById = db.prepare(
    `SELECT * FROM work_context_messages WHERE id = ?`
  );
  const insertMessage = db.prepare(
    `INSERT INTO work_context_messages (
      id, work_context_id, kind, thread_id, parent_message_id, reply_to_message_id,
      sender_kind, sender_id, audience_json, refs_json, payload_schema, summary,
      visibility, created_at, updated_at, message_json
    ) VALUES (
      @id, @workContextId, @kind, @threadId, @parentMessageId, @replyToMessageId,
      @senderKind, @senderId, @audienceJson, @refsJson, @payloadSchema, @summary,
      @visibility, @createdAt, @updatedAt, @messageJson
    )`
  );
  const insertRef = db.prepare(
    `INSERT OR IGNORE INTO work_context_message_refs (message_id, ref_kind, ref_value, ref_label)
     VALUES (@messageId, @kind, @value, @label)`
  );
  const insertAudience = db.prepare(
    `INSERT OR IGNORE INTO work_context_message_audience (message_id, audience_kind, audience_id)
     VALUES (@messageId, @kind, @value)`
  );

  const appendTx = db.transaction((message: WorkContextMessageEnvelope) => {
    insertMessage.run({
      id: message.id,
      workContextId: message.workContextId,
      kind: message.kind,
      threadId: message.refs.threadId ?? message.id,
      parentMessageId: message.refs.parentMessageId ?? null,
      replyToMessageId: message.refs.replyToMessageId ?? null,
      senderKind: message.sender.kind,
      senderId: message.sender.id,
      audienceJson: JSON.stringify(message.audience),
      refsJson: JSON.stringify(message.refs),
      payloadSchema: message.payloadSchema ?? null,
      summary: message.summary,
      visibility: message.visibility,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      messageJson: JSON.stringify(message),
    });
    for (const ref of refsForMessage(message)) {
      insertRef.run({ messageId: message.id, kind: ref.kind, value: ref.value, label: ref.label ?? null });
    }
    for (const audience of audienceRows(message.audience)) {
      insertAudience.run({ messageId: message.id, kind: audience.kind, value: audience.value });
    }
  });

  return {
    close() {
      db.close();
    },
    append(rawInput) {
      let input: WorkContextMessageCreateInput & { redaction: WorkContextMessageRedactionMetadata };
      try {
        input = normalizeWorkContextMessageCreateInput(rawInput);
      } catch (error) {
        const err = error as WorkContextMessageValidationError;
        throw new WorkContextMessageStoreError(400, 'message_validation_failed', err.message, err.details);
      }
      const id = createMessageId();
      const parentId = input.refs?.parentMessageId;
      let threadId = id;
      if (parentId) {
        const parent = parseRow(selectById.get(parentId) as WorkContextMessageRow | undefined);
        if (!parent) {
          throw new WorkContextMessageStoreError(404, 'parent_message_not_found', 'parent message not found', {
            parentMessageId: parentId,
          });
        }
        if (parent.workContextId !== input.workContextId) {
          throw new WorkContextMessageStoreError(409, 'parent_work_context_mismatch', 'parent message belongs to another WorkContext', {
            parentMessageId: parentId,
            parentWorkContextId: parent.workContextId,
            workContextId: input.workContextId,
          });
        }
        threadId = parent.refs.threadId ?? parent.id;
      }
      const createdAt = nowIso();
      const refs: WorkContextMessageRefs = {
        ...(input.refs ?? {}),
        threadId,
        ...(parentId ? { parentMessageId: parentId } : {}),
      };
      const message: WorkContextMessageEnvelope = {
        schemaVersion: WORK_CONTEXT_MESSAGE_SCHEMA_VERSION,
        id,
        workContextId: input.workContextId,
        kind: input.kind,
        sender: input.sender,
        audience: input.audience ?? [{ kind: 'work-context' }],
        summary: input.summary,
        refs,
        ...(input.payloadSchema ? { payloadSchema: input.payloadSchema } : {}),
        payload: input.payload ?? { mediaType: 'application/json', encoding: 'json', body: {}, byteCount: 2 },
        visibility: input.visibility ?? 'internal',
        createdAt,
        updatedAt: createdAt,
        redaction: input.redaction,
      };
      try {
        appendTx(message);
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed')) {
          throw new WorkContextMessageStoreError(409, 'message_already_exists', 'message id already exists', {
            messageId: id,
          });
        }
        throw error;
      }
      return message;
    },
    get(id) {
      return parseRow(selectById.get(id) as WorkContextMessageRow | undefined);
    },
    list(filter = {}) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = { limit: cleanLimit(filter.limit) };
      if (filter.workContextId) {
        clauses.push('m.work_context_id = @workContextId');
        params['workContextId'] = filter.workContextId;
      }
      if (filter.kind) {
        clauses.push('m.kind = @kind');
        params['kind'] = filter.kind;
      }
      if (filter.senderId) {
        clauses.push('m.sender_id = @senderId');
        params['senderId'] = filter.senderId;
      }
      if (filter.payloadSchema) {
        clauses.push('m.payload_schema = @payloadSchema');
        params['payloadSchema'] = filter.payloadSchema;
      }
      if (filter.threadId) {
        clauses.push('m.thread_id = @threadId');
        params['threadId'] = filter.threadId;
      }
      if (filter.parentMessageId) {
        clauses.push('m.parent_message_id = @parentMessageId');
        params['parentMessageId'] = filter.parentMessageId;
      }
      if (filter.refKind && filter.refValue) {
        clauses.push(`EXISTS (
          SELECT 1 FROM work_context_message_refs r
          WHERE r.message_id = m.id AND r.ref_kind = @refKind AND r.ref_value = @refValue
        )`);
        params['refKind'] = filter.refKind;
        params['refValue'] = filter.refValue;
      }
      if (filter.audienceKind) {
        clauses.push(`EXISTS (
          SELECT 1 FROM work_context_message_audience a
          WHERE a.message_id = m.id AND a.audience_kind = @audienceKind
          ${filter.audienceId ? 'AND a.audience_id = @audienceId' : ''}
        )`);
        params['audienceKind'] = filter.audienceKind;
        if (filter.audienceId) params['audienceId'] = filter.audienceId;
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT m.* FROM work_context_messages m ${where}
         ORDER BY m.created_at DESC, m.id DESC LIMIT @limit`
      ).all(params) as WorkContextMessageRow[];
      return rows.flatMap((row) => {
        const parsed = parseRow(row);
        return parsed ? [parsed] : [];
      });
    },
  };
}
