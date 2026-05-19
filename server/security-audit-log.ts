import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  normalizeSecurityAuditEntry,
  verifySecurityAuditEntryHash,
  type NormalizedSecurityAuditEntry,
  type SecurityAuditEntryInput,
} from '../shared/security-audit.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS security_audit_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  peer_json TEXT NOT NULL,
  node_json TEXT NOT NULL,
  session_id TEXT,
  intent_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  required_bits_json TEXT NOT NULL,
  granted_bits_json TEXT NOT NULL,
  denied_bits_json TEXT NOT NULL,
  acl_ref TEXT,
  policy_version TEXT,
  correlation_id TEXT NOT NULL,
  prev_hash TEXT,
  entry_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_security_audit_event_id ON security_audit_log(event_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_correlation ON security_audit_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_occurred_at ON security_audit_log(occurred_at);
CREATE TABLE IF NOT EXISTS security_audit_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  latest_sequence INTEGER NOT NULL,
  latest_hash TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TRIGGER IF NOT EXISTS security_audit_no_update
BEFORE UPDATE ON security_audit_log
BEGIN
  SELECT RAISE(ABORT, 'security audit log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS security_audit_no_delete
BEFORE DELETE ON security_audit_log
BEGIN
  SELECT RAISE(ABORT, 'security audit log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS security_audit_checkpoint_after_insert
AFTER INSERT ON security_audit_log
BEGIN
  UPDATE security_audit_checkpoint
  SET latest_sequence = NEW.sequence,
      latest_hash = NEW.entry_hash,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = 1
    AND latest_sequence = NEW.sequence - 1
    AND (
      latest_hash = NEW.prev_hash
      OR (latest_hash IS NULL AND NEW.prev_hash IS NULL)
    );
END;
`;

interface AuditCheckpointRow {
  latest_sequence: number;
  latest_hash: string | null;
}

interface AuditRow {
  sequence: number;
  event_id: string;
  occurred_at: string;
  schema_version: number;
  event_type: string;
  decision: string;
  reason_code: string;
  peer_json: string;
  node_json: string;
  session_id: string | null;
  intent_json: string;
  scope_hash: string;
  params_hash: string;
  required_bits_json: string;
  granted_bits_json: string;
  denied_bits_json: string;
  acl_ref: string | null;
  policy_version: string | null;
  correlation_id: string;
  prev_hash: string | null;
  entry_hash: string;
}

export interface SecurityAuditVerificationBreak {
  sequence: number;
  eventId?: string;
  reason:
    | 'storage_corrupt'
    | 'malformed_row'
    | 'sequence_gap'
    | 'prev_hash_mismatch'
    | 'entry_hash_mismatch'
    | 'tail_checkpoint_mismatch';
  expected?: string | number | null;
  actual?: string | number | null;
}

export interface SecurityAuditVerificationResult {
  ok: boolean;
  entriesVerified: number;
  lastHash: string | null;
  break?: SecurityAuditVerificationBreak;
}

export class SecurityAuditLog {
  private readonly db: Database.Database;
  private readonly closeOnDispose: boolean;

  constructor(dbPathOrHandle: string | Database.Database) {
    if (typeof dbPathOrHandle === 'string') {
      fs.mkdirSync(path.dirname(dbPathOrHandle), { recursive: true });
      this.db = new Database(dbPathOrHandle);
      this.closeOnDispose = true;
    } else {
      this.db = dbPathOrHandle;
      this.closeOnDispose = false;
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    ensureSecurityAuditCheckpoint(this.db);
  }

  listBefore(
    beforeSequence: number | null,
    limit: number
  ): { rows: NormalizedSecurityAuditEntry[]; nextBeforeSequence: number | null } {
    const cappedLimit = Math.max(1, Math.min(!limit ? 50 : limit, 200));
    let rawRows: AuditRow[];
    if (beforeSequence === null || beforeSequence === 0) {
      rawRows = this.db
        .prepare('SELECT * FROM security_audit_log ORDER BY sequence DESC LIMIT ?')
        .all(cappedLimit) as AuditRow[];
    } else {
      if (!Number.isFinite(beforeSequence) || beforeSequence < 0) {
        throw new Error(
          `listBefore: beforeSequence must be a non-negative finite number or null, got ${beforeSequence}`
        );
      }
      rawRows = this.db
        .prepare(
          'SELECT * FROM security_audit_log WHERE sequence < ? ORDER BY sequence DESC LIMIT ?'
        )
        .all(beforeSequence, cappedLimit) as AuditRow[];
    }
    const rows: NormalizedSecurityAuditEntry[] = [];
    for (const row of rawRows) {
      const entry = rowToEntry(row);
      if (entry) rows.push(entry);
    }
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
    const nextBeforeSequence = lastRow ? lastRow.sequence : null;
    return { rows, nextBeforeSequence };
  }

  head(): { latestSequence: number; latestHash: string | null } {
    const checkpoint = this.db
      .prepare(
        'SELECT latest_sequence, latest_hash FROM security_audit_checkpoint WHERE id = 1'
      )
      .get() as AuditCheckpointRow | undefined;
    if (!checkpoint) return { latestSequence: 0, latestHash: null };
    return {
      latestSequence: checkpoint.latest_sequence,
      latestHash: checkpoint.latest_hash,
    };
  }

  append(input: SecurityAuditEntryInput): NormalizedSecurityAuditEntry {
    return this.db.transaction(() => {
      const last = this.db
        .prepare(
          'SELECT sequence, entry_hash FROM security_audit_log ORDER BY sequence DESC LIMIT 1'
        )
        .get() as { sequence: number; entry_hash: string } | undefined;
      assertCheckpointMatchesTail(this.db, last);
      const entry = normalizeSecurityAuditEntry(input, {
        sequence: last ? last.sequence + 1 : 1,
        prevHash: last?.entry_hash ?? null,
      });
      this.db
        .prepare(
          `INSERT INTO security_audit_log (
            sequence, event_id, occurred_at, schema_version, event_type, decision,
            reason_code, peer_json, node_json, session_id, intent_json, scope_hash,
            params_hash, required_bits_json, granted_bits_json, denied_bits_json,
            acl_ref, policy_version, correlation_id, prev_hash, entry_hash
          ) VALUES (
            @sequence, @eventId, @timestamp, @schemaVersion, @eventType, @decision,
            @reasonCode, @peerJson, @nodeJson, @sessionId, @intentJson, @scopeHash,
            @paramsHash, @requiredBitsJson, @grantedBitsJson, @deniedBitsJson,
            @aclRef, @policyVersion, @correlationId, @prevHash, @entryHash
          )`
        )
        .run({
          sequence: entry.sequence,
          eventId: entry.eventId,
          timestamp: entry.timestamp,
          schemaVersion: entry.schemaVersion,
          eventType: entry.eventType,
          decision: entry.decision,
          reasonCode: entry.reasonCode,
          peerJson: JSON.stringify(entry.peer),
          nodeJson: JSON.stringify(entry.node),
          sessionId: entry.sessionId ?? null,
          intentJson: JSON.stringify(entry.intent),
          scopeHash: entry.scopeHash,
          paramsHash: entry.paramsHash,
          requiredBitsJson: JSON.stringify(entry.requiredBits),
          grantedBitsJson: JSON.stringify(entry.grantedBits),
          deniedBitsJson: JSON.stringify(entry.deniedBits),
          aclRef: entry.aclRef ?? null,
          policyVersion: entry.policyVersion ?? null,
          correlationId: entry.correlationId,
          prevHash: entry.prevHash,
          entryHash: entry.entryHash,
        });
      return entry;
    })();
  }

  verify(): SecurityAuditVerificationResult {
    return verifySecurityAuditDatabase(this.db);
  }

  close(): void {
    if (this.closeOnDispose) this.db.close();
  }
}

export function createSecurityAuditLog(dbPath: string): SecurityAuditLog {
  return new SecurityAuditLog(dbPath);
}

export function verifySecurityAuditLog(
  dbPath: string
): SecurityAuditVerificationResult {
  if (!fs.existsSync(dbPath)) {
    return { ok: true, entriesVerified: 0, lastHash: null };
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return verifySecurityAuditDatabase(db);
  } catch (error) {
    return storageCorruptBreak(error);
  } finally {
    db?.close();
  }
}

function verifySecurityAuditDatabase(
  db: Database.Database
): SecurityAuditVerificationResult {
  try {
    const integrity = db.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') return storageCorruptBreak(integrity);
    const checkpoint = db
      .prepare(
        'SELECT latest_sequence, latest_hash FROM security_audit_checkpoint WHERE id = 1'
      )
      .get() as AuditCheckpointRow | undefined;
    if (!checkpoint) return storageCorruptBreak('missing audit checkpoint');
    const rows = db
      .prepare('SELECT * FROM security_audit_log ORDER BY sequence ASC')
      .iterate() as IterableIterator<AuditRow>;
    return verifyAuditRows(rows, checkpoint);
  } catch (error) {
    return storageCorruptBreak(error);
  }
}

function verifyAuditRows(
  rows: IterableIterator<AuditRow>,
  checkpoint: AuditCheckpointRow
): SecurityAuditVerificationResult {
  let expectedSequence = 1;
  let prevHash: string | null = null;
  let entriesVerified = 0;
  let next = rows.next();
  try {
    while (!next.done) {
      const row = next.value;
      if (row.sequence !== expectedSequence) {
        return {
          ok: false,
          entriesVerified,
          lastHash: prevHash,
          break: {
            sequence: expectedSequence,
            eventId: row.event_id,
            reason: 'sequence_gap',
            expected: expectedSequence,
            actual: row.sequence,
          },
        };
      }
      const entry = rowToEntry(row);
      if (!entry) {
        return {
          ok: false,
          entriesVerified,
          lastHash: prevHash,
          break: {
            sequence: row.sequence,
            eventId: row.event_id,
            reason: 'malformed_row',
          },
        };
      }
      if (entry.prevHash !== prevHash) {
        return {
          ok: false,
          entriesVerified,
          lastHash: prevHash,
          break: {
            sequence: entry.sequence,
            eventId: entry.eventId,
            reason: 'prev_hash_mismatch',
            expected: prevHash,
            actual: entry.prevHash,
          },
        };
      }
      const hashCheck = verifySecurityAuditEntryHash(entry);
      if (hashCheck.ok === false) {
        return {
          ok: false,
          entriesVerified,
          lastHash: prevHash,
          break: {
            sequence: entry.sequence,
            eventId: entry.eventId,
            reason: 'entry_hash_mismatch',
            expected: hashCheck.expected,
            actual: hashCheck.actual,
          },
        };
      }
      prevHash = entry.entryHash;
      entriesVerified += 1;
      expectedSequence += 1;
      next = rows.next();
    }
  } finally {
    rows.return?.();
  }
  if (checkpoint.latest_sequence !== entriesVerified) {
    return {
      ok: false,
      entriesVerified,
      lastHash: prevHash,
      break: {
        sequence: entriesVerified + 1,
        reason: 'tail_checkpoint_mismatch',
        expected: checkpoint.latest_sequence,
        actual: entriesVerified,
      },
    };
  }
  if (checkpoint.latest_hash !== prevHash) {
    return {
      ok: false,
      entriesVerified,
      lastHash: prevHash,
      break: {
        sequence: entriesVerified,
        reason: 'tail_checkpoint_mismatch',
        expected: checkpoint.latest_hash,
        actual: prevHash,
      },
    };
  }
  return { ok: true, entriesVerified, lastHash: prevHash };
}

function ensureSecurityAuditCheckpoint(db: Database.Database): void {
  const tail = db
    .prepare(
      'SELECT sequence, entry_hash FROM security_audit_log ORDER BY sequence DESC LIMIT 1'
    )
    .get() as { sequence: number; entry_hash: string } | undefined;
  db.prepare(
    `INSERT OR IGNORE INTO security_audit_checkpoint (
      id, latest_sequence, latest_hash
    ) VALUES (1, @latestSequence, @latestHash)`
  ).run({
    latestSequence: tail?.sequence ?? 0,
    latestHash: tail?.entry_hash ?? null,
  });
}

function assertCheckpointMatchesTail(
  db: Database.Database,
  tail: { sequence: number; entry_hash: string } | undefined
): void {
  const checkpoint = db
    .prepare(
      'SELECT latest_sequence, latest_hash FROM security_audit_checkpoint WHERE id = 1'
    )
    .get() as AuditCheckpointRow | undefined;
  if (!checkpoint) {
    throw new Error('security audit checkpoint is missing');
  }
  const tailSequence = tail?.sequence ?? 0;
  const tailHash = tail?.entry_hash ?? null;
  if (
    checkpoint.latest_sequence !== tailSequence ||
    checkpoint.latest_hash !== tailHash
  ) {
    throw new Error(
      `security audit checkpoint mismatch: checkpoint tail ${checkpoint.latest_sequence}/${checkpoint.latest_hash ?? 'null'} does not match current tail ${tailSequence}/${tailHash ?? 'null'}`
    );
  }
}

function rowToEntry(row: AuditRow): NormalizedSecurityAuditEntry | null {
  try {
    return {
      eventId: row.event_id,
      timestamp: row.occurred_at,
      sequence: row.sequence,
      schemaVersion:
        row.schema_version as NormalizedSecurityAuditEntry['schemaVersion'],
      eventType: row.event_type as NormalizedSecurityAuditEntry['eventType'],
      decision: row.decision as NormalizedSecurityAuditEntry['decision'],
      reasonCode: row.reason_code,
      peer: JSON.parse(row.peer_json) as NormalizedSecurityAuditEntry['peer'],
      node: JSON.parse(row.node_json) as NormalizedSecurityAuditEntry['node'],
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      intent: JSON.parse(
        row.intent_json
      ) as NormalizedSecurityAuditEntry['intent'],
      scopeHash: row.scope_hash,
      paramsHash: row.params_hash,
      requiredBits: JSON.parse(
        row.required_bits_json
      ) as NormalizedSecurityAuditEntry['requiredBits'],
      grantedBits: JSON.parse(
        row.granted_bits_json
      ) as NormalizedSecurityAuditEntry['grantedBits'],
      deniedBits: JSON.parse(
        row.denied_bits_json
      ) as NormalizedSecurityAuditEntry['deniedBits'],
      ...(row.acl_ref ? { aclRef: row.acl_ref } : {}),
      ...(row.policy_version ? { policyVersion: row.policy_version } : {}),
      correlationId: row.correlation_id,
      prevHash: row.prev_hash,
      entryHash: row.entry_hash,
    };
  } catch {
    return null;
  }
}

function storageCorruptBreak(error: unknown): SecurityAuditVerificationResult {
  return {
    ok: false,
    entriesVerified: 0,
    lastHash: null,
    break: {
      sequence: 0,
      reason: 'storage_corrupt',
      actual: error instanceof Error ? error.message : String(error),
    },
  };
}
