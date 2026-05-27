// Context-packet + session-inbox SQLite store (#758, ADR-019).
//
// Stores the CLI/API-first anchored-context primitive behind the hub gateway,
// reusing the self-contained store pattern of `server/work-contexts.ts` and
// `server/ia-store.ts`: per-store SQLite file, a `schema_version` table with a
// version-gated migration run inside a transaction, an `init*(configDir)` /
// `create*(dbPath)` factory split, blob `*_json` columns plus denormalized
// columns for federation queries, and prepared parameterized statements.
//
// STRICTLY NON-DESTRUCTIVE: owns its own DB file (`context-packets.db`) and
// creates only new tables (`context_packets`, `inbox_messages`,
// `inbox_message_packets`). It never reads or mutates `config.json` or any
// existing store/table.
//
// Ref-only privacy posture (inherited from the WorkContext store): packets
// carry pointers + a bounded `quote`/`note`, never raw file bytes. `AnchorState`
// (`stale`) is DERIVED at read time by #766 and is NEVER stored here.

import * as crypto from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createLogger } from './logger.js';
import {
  createContextPacketId,
  createInboxMessageId,
  parseContextPacket,
  parseSessionInboxMessage,
  validateInboxTransition,
  type ContextPacket,
  type ContextPacketId,
  type SessionInboxMessage,
  type SessionInboxMessageId,
  type SessionInboxMessageState,
} from '../shared/context-packet.js';
import type { GlobalSessionId } from '../shared/identity.js';
import type { WorkContextId } from '../shared/work-context.js';

const logger = createLogger('context-packets');

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS context_packets (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  packet_json  TEXT NOT NULL,
  node_id      TEXT,
  workspace_id TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_packets_created_at
  ON context_packets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_packets_node
  ON context_packets(node_id);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id                     TEXT PRIMARY KEY,
  target_session_id      TEXT,
  target_work_context_id TEXT,
  message_json           TEXT NOT NULL,
  state                  TEXT NOT NULL,
  created_by             TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  delivered_at           TEXT,
  acknowledged_at        TEXT,
  resolved_at            TEXT,
  updated_at             TEXT NOT NULL,
  CHECK (target_session_id IS NOT NULL OR target_work_context_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_session
  ON inbox_messages(target_session_id, state);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_work_context
  ON inbox_messages(target_work_context_id, state);

CREATE TABLE IF NOT EXISTS inbox_message_packets (
  message_id        TEXT NOT NULL,
  context_packet_id TEXT NOT NULL,
  ordinal           INTEGER NOT NULL,
  PRIMARY KEY (message_id, context_packet_id),
  FOREIGN KEY (message_id) REFERENCES inbox_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (context_packet_id) REFERENCES context_packets(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_inbox_message_packets_packet
  ON inbox_message_packets(context_packet_id);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
];

interface ContextPacketRow {
  id: string;
  kind: string;
  packet_json: string;
  node_id: string | null;
  workspace_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface InboxMessageRow {
  id: string;
  target_session_id: string | null;
  target_work_context_id: string | null;
  message_json: string;
  state: string;
  created_by: string;
  created_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  updated_at: string;
}

// ── Public input shapes ──────────────────────────────────────────────────────

/**
 * Create input for a context packet. The store mints the `id` (server-owned
 * randomness) and `createdAt` unless `packet` carries a fully-formed envelope.
 * `createdBy` is required: every packet is attributable.
 */
export interface ContextPacketCreateInput {
  /** A fully-formed packet to persist as-is (validated through `parseContextPacket`). */
  packet?: ContextPacket;
  /** Mint a packet from these fields when `packet` is omitted. */
  kind?: ContextPacket['kind'];
  anchor?: ContextPacket['anchor'];
  fileRef?: ContextPacket['fileRef'];
  note?: ContextPacket['note'];
  binding?: ContextPacket['binding'];
  createdBy?: string;
  /** Override the minted id (must be a `cp:` id); tests/imports only. */
  id?: ContextPacketId;
}

/** Create input for an inbox message. Mints `id`, `createdAt`, `state=queued`. */
export interface InboxMessageCreateInput {
  message?: SessionInboxMessage;
  targetSessionId?: GlobalSessionId;
  targetWorkContextId?: WorkContextId;
  contextPacketIds?: ContextPacketId[];
  text?: string;
  createdBy?: string;
  id?: SessionInboxMessageId;
}

/** Filter for `listInboxMessages`. All clauses are ANDed. */
export interface InboxMessageListFilter {
  targetSessionId?: GlobalSessionId;
  targetWorkContextId?: WorkContextId;
  state?: SessionInboxMessageState;
}

/**
 * Filter for `listContextPackets`. All clauses are ANDed. `nodeId`/`workspaceId`
 * match the denormalized federation-query columns (derived from the packet's
 * binding/anchor/fileRef at write time); `limit` caps the result set.
 */
export interface ContextPacketListFilter {
  nodeId?: string;
  workspaceId?: string;
  limit?: number;
}

export interface ContextPacketStore {
  close(): void;

  // ── Context packets ──────────────────────────────────────────────────────
  createContextPacket(input: ContextPacketCreateInput): ContextPacket;
  getContextPacket(id: ContextPacketId): ContextPacket | null;
  listContextPackets(filter?: ContextPacketListFilter): ContextPacket[];
  /** Delete a packet. RESTRICTed if any live inbox message references it. */
  deleteContextPacket(id: ContextPacketId): boolean;

  // ── Inbox messages ─────────────────────────────────────────────────────────
  createInboxMessage(input: InboxMessageCreateInput): SessionInboxMessage;
  getInboxMessage(id: SessionInboxMessageId): SessionInboxMessage | null;
  listInboxMessages(filter?: InboxMessageListFilter): SessionInboxMessage[];
  /**
   * Transition an inbox message to `to`. Idempotent (`from === to` is a no-op
   * success) and rejects transitions out of terminal states (ADR-019 C2).
   */
  transitionInboxMessage(
    id: SessionInboxMessageId,
    to: SessionInboxMessageState
  ): SessionInboxMessage;
  deleteInboxMessage(id: SessionInboxMessageId): boolean;
}

export class ContextPacketStoreError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.name = 'ContextPacketStoreError';
    this.status = status;
    this.code = code;
  }
}

/** Boot entry point: opens (and migrates) the store DB under `configDir`. */
export function initContextPacketStore(configDir: string): ContextPacketStore {
  return createContextPacketStore(path.join(configDir, 'context-packets.db'));
}

/** Factory taking an explicit DB path. Used directly by unit tests. */
export function createContextPacketStore(dbPath: string): ContextPacketStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // FK enforcement is required for the join's ON DELETE CASCADE/RESTRICT.
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  // ── Context packet statements ──────────────────────────────────────────────
  const selectPacket = db.prepare(
    `SELECT id, kind, packet_json, node_id, workspace_id, created_by, created_at, updated_at
     FROM context_packets WHERE id = ?`
  );
  const insertPacket = db.prepare(
    `INSERT INTO context_packets (
       id, kind, packet_json, node_id, workspace_id, created_by, created_at, updated_at
     ) VALUES (
       @id, @kind, @packetJson, @nodeId, @workspaceId, @createdBy, @createdAt, @updatedAt
     )`
  );
  const deletePacketStmt = db.prepare('DELETE FROM context_packets WHERE id = ?');

  // ── Inbox message statements ───────────────────────────────────────────────
  const selectMessage = db.prepare(
    `SELECT id, target_session_id, target_work_context_id, message_json, state,
            created_by, created_at, delivered_at, acknowledged_at, resolved_at, updated_at
     FROM inbox_messages WHERE id = ?`
  );
  const insertMessage = db.prepare(
    `INSERT INTO inbox_messages (
       id, target_session_id, target_work_context_id, message_json, state,
       created_by, created_at, delivered_at, acknowledged_at, resolved_at, updated_at
     ) VALUES (
       @id, @targetSessionId, @targetWorkContextId, @messageJson, @state,
       @createdBy, @createdAt, @deliveredAt, @acknowledgedAt, @resolvedAt, @updatedAt
     )`
  );
  const updateMessageState = db.prepare(
    `UPDATE inbox_messages SET
       message_json    = @messageJson,
       state           = @state,
       delivered_at    = @deliveredAt,
       acknowledged_at = @acknowledgedAt,
       resolved_at     = @resolvedAt,
       updated_at      = @updatedAt
     WHERE id = @id`
  );
  const insertMessagePacket = db.prepare(
    `INSERT INTO inbox_message_packets (message_id, context_packet_id, ordinal)
     VALUES (?, ?, ?)`
  );
  const deleteMessageStmt = db.prepare('DELETE FROM inbox_messages WHERE id = ?');

  function getPacketById(id: ContextPacketId): ContextPacket | null {
    const row = selectPacket.get(id) as ContextPacketRow | undefined;
    return row ? rowToPacketSafe(row) : null;
  }

  function getMessageById(id: SessionInboxMessageId): SessionInboxMessage | null {
    const row = selectMessage.get(id) as InboxMessageRow | undefined;
    return row ? rowToMessageSafe(row) : null;
  }

  function mustGetMessage(id: SessionInboxMessageId): SessionInboxMessage {
    const message = getMessageById(id);
    if (!message) {
      throw new ContextPacketStoreError(404, 'inbox_message_not_found');
    }
    return message;
  }

  return {
    close() {
      db.close();
    },

    createContextPacket(input: ContextPacketCreateInput) {
      const now = new Date().toISOString();
      const packet = buildPacketFromInput(input, now);
      const denorm = denormalizePacket(packet);
      insertPacket.run({
        id: packet.id,
        kind: packet.kind,
        packetJson: JSON.stringify(packet),
        nodeId: denorm.nodeId,
        workspaceId: denorm.workspaceId,
        createdBy: packet.createdBy,
        createdAt: packet.createdAt,
        updatedAt: now,
      });
      const written = getPacketById(packet.id);
      if (!written) {
        throw new ContextPacketStoreError(500, 'context_packet_write_failed');
      }
      return written;
    },

    getContextPacket: getPacketById,

    listContextPackets(filter: ContextPacketListFilter = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.nodeId !== undefined) {
        clauses.push('node_id = ?');
        params.push(filter.nodeId);
      }
      if (filter.workspaceId !== undefined) {
        clauses.push('workspace_id = ?');
        params.push(filter.workspaceId);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      // LIMIT is bound rather than interpolated; clamp to a positive integer.
      const limit =
        filter.limit !== undefined && Number.isFinite(filter.limit)
          ? Math.max(1, Math.trunc(filter.limit))
          : undefined;
      const limitClause = limit !== undefined ? ' LIMIT ?' : '';
      const stmt = db.prepare(
        `SELECT id, kind, packet_json, node_id, workspace_id, created_by, created_at, updated_at
         FROM context_packets${where}
         ORDER BY created_at DESC, id ASC${limitClause}`
      );
      const args = limit !== undefined ? [...params, limit] : params;
      return (stmt.all(...args) as ContextPacketRow[])
        .map(rowToPacketSafe)
        .filter((p): p is ContextPacket => p !== null);
    },

    deleteContextPacket(id: ContextPacketId) {
      try {
        const info = deletePacketStmt.run(id);
        return info.changes > 0;
      } catch (err) {
        // ON DELETE RESTRICT on the join FK surfaces as a FK constraint error
        // when a live message still references the packet.
        if (isForeignKeyConstraintError(err)) {
          throw new ContextPacketStoreError(
            409,
            'context_packet_referenced'
          );
        }
        throw err;
      }
    },

    createInboxMessage(input: InboxMessageCreateInput) {
      const now = new Date().toISOString();
      const message = buildMessageFromInput(input, now);
      // Verify every referenced packet exists (the join FK would reject an
      // orphan insert anyway, but a typed 400 is friendlier than a raw FK error).
      for (const packetId of message.contextPacketIds) {
        if (!getPacketById(packetId)) {
          throw new ContextPacketStoreError(400, 'context_packet_not_found');
        }
      }
      db.transaction(() => {
        insertMessage.run(messageToRowParams(message, now));
        message.contextPacketIds.forEach((packetId, ordinal) => {
          insertMessagePacket.run(message.id, packetId, ordinal);
        });
      })();
      const written = getMessageById(message.id);
      if (!written) {
        throw new ContextPacketStoreError(500, 'inbox_message_write_failed');
      }
      return written;
    },

    getInboxMessage: getMessageById,

    listInboxMessages(filter: InboxMessageListFilter = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.targetSessionId !== undefined) {
        clauses.push('target_session_id = ?');
        params.push(filter.targetSessionId);
      }
      if (filter.targetWorkContextId !== undefined) {
        clauses.push('target_work_context_id = ?');
        params.push(filter.targetWorkContextId);
      }
      if (filter.state !== undefined) {
        clauses.push('state = ?');
        params.push(filter.state);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const stmt = db.prepare(
        `SELECT id, target_session_id, target_work_context_id, message_json, state,
                created_by, created_at, delivered_at, acknowledged_at, resolved_at, updated_at
         FROM inbox_messages${where}
         ORDER BY created_at ASC, id ASC`
      );
      return (stmt.all(...params) as InboxMessageRow[])
        .map(rowToMessageSafe)
        .filter((m): m is SessionInboxMessage => m !== null);
    },

    transitionInboxMessage(
      id: SessionInboxMessageId,
      to: SessionInboxMessageState
    ) {
      const existing = mustGetMessage(id);
      const validation = validateInboxTransition(existing.state, to);
      if (!validation.ok) {
        // Terminal-state guard + illegal-jump guard (ADR-019 C2).
        throw new ContextPacketStoreError(
          409,
          `inbox_transition_${validation.reason}`
        );
      }
      const now = new Date().toISOString();
      // Idempotent re-touch (from === to): refresh `updated_at` so a PULL
      // `inbox.list` re-delivering a row is observable, but DO NOT overwrite the
      // first-observed transition timestamp.
      const next = applyTransition(existing, to, now, validation.idempotent);
      updateMessageState.run({
        id: next.id,
        messageJson: JSON.stringify(next),
        state: next.state,
        deliveredAt: next.deliveredAt ?? null,
        acknowledgedAt: next.acknowledgedAt ?? null,
        resolvedAt: next.resolvedAt ?? null,
        updatedAt: now,
      });
      const written = getMessageById(id);
      if (!written) {
        throw new ContextPacketStoreError(500, 'inbox_message_write_failed');
      }
      return written;
    },

    deleteInboxMessage(id: SessionInboxMessageId) {
      // ON DELETE CASCADE drops the join rows; referenced packets survive.
      const info = deleteMessageStmt.run(id);
      return info.changes > 0;
    },
  };

  // ── Row → domain mapping (closure-free helpers below use module scope) ──────
  function rowToPacketSafe(row: ContextPacketRow): ContextPacket | null {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.packet_json) as unknown;
    } catch {
      // Corrupt column (external tampering) — fail soft.
      logger.warn('dropped context packet %s: corrupt packet_json', row.id);
      return null;
    }
    const packet = parseContextPacket(parsedJson);
    if (!packet) {
      logger.warn('dropped context packet %s: failed validation', row.id);
      return null;
    }
    return packet;
  }

  function rowToMessageSafe(row: InboxMessageRow): SessionInboxMessage | null {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.message_json) as unknown;
    } catch {
      logger.warn('dropped inbox message %s: corrupt message_json', row.id);
      return null;
    }
    const message = parseSessionInboxMessage(parsedJson);
    if (!message) {
      logger.warn('dropped inbox message %s: failed validation', row.id);
      return null;
    }
    // The denormalized `state` column is the source of truth for transitions;
    // reconcile the blob to it so a partially-written blob can't drift the
    // lifecycle (the blob is rewritten on every transition, so this is belt+braces).
    const stateCol = row.state as SessionInboxMessageState;
    if (message.state !== stateCol) {
      return { ...message, state: stateCol };
    }
    return message;
  }
}

// ── Migration runner ─────────────────────────────────────────────────────────
// Idempotent: a fresh DB and an already-migrated DB both end at the latest
// MIGRATIONS version with no error. Safe on an existing DB that already has a
// `schema_version` row (CREATE ... IF NOT EXISTS + version gate). Mirrors the
// runner in ia-store.ts / work-contexts.ts. Bump by appending a {version, sql}.
function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined;
  const hadRow = row !== undefined;
  let currentVersion = row?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      const ver = migration.version;
      db.transaction(() => {
        db.exec(migration.sql);
        if (hadRow || currentVersion > 0) {
          db.prepare('UPDATE schema_version SET version = ?').run(ver);
        } else {
          db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(ver);
        }
      })();
      currentVersion = ver;
    }
  }
}

// ── Build / normalize helpers ──────────────────────────────────────────────

function buildPacketFromInput(
  input: ContextPacketCreateInput,
  now: string
): ContextPacket {
  if (input.packet) {
    const parsed = parseContextPacket(input.packet);
    if (!parsed) {
      throw new ContextPacketStoreError(400, 'invalid_context_packet');
    }
    return parsed;
  }
  if (!input.kind) {
    throw new ContextPacketStoreError(400, 'context_packet_kind_required');
  }
  if (typeof input.createdBy !== 'string' || input.createdBy.length === 0) {
    throw new ContextPacketStoreError(400, 'context_packet_created_by_required');
  }
  const draft: ContextPacket = {
    id: input.id ?? mintPacketId(),
    kind: input.kind,
    createdBy: input.createdBy,
    createdAt: now,
    ...(input.anchor ? { anchor: input.anchor } : {}),
    ...(input.fileRef ? { fileRef: input.fileRef } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.binding ? { binding: input.binding } : {}),
  };
  // Validate through the shared parser so kind-specific shape rules
  // (file-anchor needs anchor, note needs body, etc.) are enforced once.
  const parsed = parseContextPacket(draft);
  if (!parsed) {
    throw new ContextPacketStoreError(400, 'invalid_context_packet');
  }
  return parsed;
}

function buildMessageFromInput(
  input: InboxMessageCreateInput,
  now: string
): SessionInboxMessage {
  if (input.message) {
    const parsed = parseSessionInboxMessage(input.message);
    if (!parsed) {
      throw new ContextPacketStoreError(400, 'invalid_inbox_message');
    }
    return parsed;
  }
  if (typeof input.createdBy !== 'string' || input.createdBy.length === 0) {
    throw new ContextPacketStoreError(400, 'inbox_message_created_by_required');
  }
  if (!input.targetSessionId && !input.targetWorkContextId) {
    throw new ContextPacketStoreError(400, 'inbox_message_target_required');
  }
  const draft: SessionInboxMessage = {
    id: input.id ?? mintMessageId(),
    contextPacketIds: [...(input.contextPacketIds ?? [])],
    state: 'queued',
    createdBy: input.createdBy,
    createdAt: now,
    ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
    ...(input.targetWorkContextId
      ? { targetWorkContextId: input.targetWorkContextId }
      : {}),
    ...(input.text ? { text: input.text } : {}),
  };
  const parsed = parseSessionInboxMessage(draft);
  if (!parsed) {
    throw new ContextPacketStoreError(400, 'invalid_inbox_message');
  }
  return parsed;
}

/**
 * Apply a validated transition. Sets the first-observed transition timestamp
 * (idempotent re-touches do not overwrite it). The lifecycle timestamps map:
 *   delivered → deliveredAt, acknowledged → acknowledgedAt,
 *   resolved → resolvedAt, ignored → ignoredAt (blob only; no column).
 */
function applyTransition(
  message: SessionInboxMessage,
  to: SessionInboxMessageState,
  now: string,
  idempotent: boolean
): SessionInboxMessage {
  if (idempotent) {
    // No-op success: state unchanged, timestamps preserved.
    return message;
  }
  const next: SessionInboxMessage = { ...message, state: to };
  switch (to) {
    case 'delivered':
      if (!next.deliveredAt) next.deliveredAt = now;
      break;
    case 'acknowledged':
      // A queued→acknowledged skip still records delivery (it was pulled).
      if (!next.deliveredAt) next.deliveredAt = now;
      if (!next.acknowledgedAt) next.acknowledgedAt = now;
      break;
    case 'resolved':
      if (!next.resolvedAt) next.resolvedAt = now;
      break;
    case 'ignored':
      if (!next.ignoredAt) next.ignoredAt = now;
      break;
    default:
      break;
  }
  return next;
}

function messageToRowParams(
  message: SessionInboxMessage,
  now: string
): Record<string, string | null> {
  return {
    id: message.id,
    targetSessionId: message.targetSessionId ?? null,
    targetWorkContextId: message.targetWorkContextId ?? null,
    messageJson: JSON.stringify(message),
    state: message.state,
    createdBy: message.createdBy,
    createdAt: message.createdAt,
    deliveredAt: message.deliveredAt ?? null,
    acknowledgedAt: message.acknowledgedAt ?? null,
    resolvedAt: message.resolvedAt ?? null,
    updatedAt: now,
  };
}

/**
 * Pull the federation-query denormalized columns out of a packet's binding +
 * anchor. `node_id` prefers the binding, falling back to the anchor's
 * `FileResourceRef.nodeId` (anchored packets always carry a node).
 */
function denormalizePacket(packet: ContextPacket): {
  nodeId: string | null;
  workspaceId: string | null;
} {
  const nodeId =
    packet.binding?.nodeId ?? packet.anchor?.ref.nodeId ?? packet.fileRef?.nodeId ?? null;
  const workspaceId = packet.binding?.workspaceId ?? null;
  return { nodeId, workspaceId };
}

function mintPacketId(): ContextPacketId {
  return createContextPacketId(crypto.randomBytes(8).toString('hex'));
}

function mintMessageId(): SessionInboxMessageId {
  return createInboxMessageId(crypto.randomBytes(8).toString('hex'));
}

function isForeignKeyConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  // better-sqlite3 surfaces ON DELETE RESTRICT failures with the extended code
  // SQLITE_CONSTRAINT_TRIGGER (the RESTRICT action runs as a trigger) and FK
  // violations as SQLITE_CONSTRAINT_FOREIGNKEY; older builds use the base code.
  return (
    typeof code === 'string' &&
    (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
      code === 'SQLITE_CONSTRAINT_TRIGGER' ||
      code === 'SQLITE_CONSTRAINT')
  );
}
