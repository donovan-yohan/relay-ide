// ScopedActorCredential store (#1546).
//
// Persists scoped actor credentials hash-only (never the raw bearer token) in
// the hub config dir beside agent-profiles.db and security-audit.db.
//
// Pattern:
// - A per-store SQLite file (`scoped-actor-credentials.db`) with 0600 mode
// - `schema_version` table with version-gated migrations in transactions
// - Prepared statements and WAL mode
// - Hash-only storage (`secret_hash` = sha256Hex of token secret)
// - Boot rehydration loads active and unexpired revoked rows into ScopedActorCredentialRegistry
// - Expired rows pruned on boot

import * as fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { RelayCapabilityBit } from '../shared/security-policy.js';
import { isRelayCapabilityBit } from '../shared/security-policy.js';
import type {
  ScopedActorCredentialRecord,
  ScopedActorCredentialType,
  ScopedActorCredentialAudience,
  ScopedActorCredentialScope,
  ScopedActorCredentialMetadata,
} from '../shared/scoped-actor-credentials.js';
import { createLogger } from './logger.js';

const logger = createLogger('scoped-actor-credential');

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS scoped_actor_credentials (
  credential_id        TEXT PRIMARY KEY,
  actor_type           TEXT NOT NULL,
  actor_id             TEXT NOT NULL,
  actor_display_name   TEXT,
  issuer_id            TEXT NOT NULL,
  issuer_display_name  TEXT,
  grant_id             TEXT,
  audience             TEXT NOT NULL,
  secret_hash          TEXT NOT NULL,
  capabilities         TEXT NOT NULL,
  scope                TEXT NOT NULL,
  metadata             TEXT,
  issued_at            TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  revoked_at           TEXT,
  revoked_by           TEXT,
  revocation_reason    TEXT,
  correlation_id       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scoped_actor_credentials_expires
  ON scoped_actor_credentials(expires_at);
CREATE INDEX IF NOT EXISTS idx_scoped_actor_credentials_grant
  ON scoped_actor_credentials(grant_id);
CREATE INDEX IF NOT EXISTS idx_scoped_actor_credentials_actor
  ON scoped_actor_credentials(actor_type, actor_id);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
];

const CREDENTIAL_COLUMNS = `credential_id, actor_type, actor_id, actor_display_name,
  issuer_id, issuer_display_name, grant_id, audience, capabilities, scope,
  metadata, issued_at, expires_at, revoked_at, revoked_by, revocation_reason, correlation_id`;

interface ScopedActorCredentialDbRow {
  credential_id: string;
  actor_type: string;
  actor_id: string;
  actor_display_name: string | null;
  issuer_id: string;
  issuer_display_name: string | null;
  grant_id: string | null;
  audience: string;
  capabilities: string;
  scope: string;
  metadata: string | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revocation_reason: string | null;
  correlation_id: string;
}

export interface ScopedActorCredentialRestoreRow extends ScopedActorCredentialRecord {
  secretHash: string;
}

export interface PersistedScopedActorCredentialWriteInput {
  credentialId: string;
  actor: {
    type: ScopedActorCredentialType;
    id: string;
    displayName?: string;
  };
  issuer: {
    id: string;
    displayName?: string;
  };
  grantId?: string;
  audience: ScopedActorCredentialAudience;
  /** `sha256Hex` of the token secret — never the token itself. */
  secretHash: string;
  capabilities: readonly string[];
  scope: ScopedActorCredentialScope;
  metadata?: ScopedActorCredentialMetadata;
  issuedAt: string;
  expiresAt: string;
  correlationId: string;
}

export interface ScopedActorCredentialStore {
  close(): void;
  recordCredential(
    input: PersistedScopedActorCredentialWriteInput
  ): ScopedActorCredentialRecord;
  getCredential(credentialId: string): ScopedActorCredentialRecord | null;
  listCredentials(): ScopedActorCredentialRecord[];
  listRestorableCredentials(now?: Date): ScopedActorCredentialRestoreRow[];
  revokeCredential(
    credentialId: string,
    input: {
      revokedBy: string;
      reason?: string;
      correlationId?: string;
      now?: Date;
    }
  ): ScopedActorCredentialRecord | null;
  revokeCredentialsByGrantId(
    grantId: string,
    input: {
      revokedBy: string;
      reason?: string;
      correlationId?: string;
      now?: Date;
    }
  ): ScopedActorCredentialRecord[];
  pruneExpiredCredentials(now?: Date): number;
}

export class ScopedActorCredentialStoreError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.name = 'ScopedActorCredentialStoreError';
    this.status = status;
    this.code = code;
  }
}

export function initScopedActorCredentialStore(
  configDir: string
): ScopedActorCredentialStore {
  return createScopedActorCredentialStore(
    path.join(configDir, 'scoped-actor-credentials.db')
  );
}

export function createScopedActorCredentialStore(
  dbPath: string
): ScopedActorCredentialStore {
  precreateSecretFile(dbPath);
  const db = new Database(dbPath);
  restrictSecretFileMode(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);

  const selectById = db.prepare(
    `SELECT ${CREDENTIAL_COLUMNS} FROM scoped_actor_credentials WHERE credential_id = ?`
  );
  const selectAll = db.prepare(
    `SELECT ${CREDENTIAL_COLUMNS} FROM scoped_actor_credentials ORDER BY issued_at DESC`
  );
  const selectRestorable = db.prepare(
    `SELECT ${CREDENTIAL_COLUMNS}, secret_hash FROM scoped_actor_credentials WHERE expires_at > ?`
  );
  const selectByGrantId = db.prepare(
    `SELECT ${CREDENTIAL_COLUMNS} FROM scoped_actor_credentials WHERE grant_id = ? AND revoked_at IS NULL`
  );
  const insertCredential = db.prepare(
    `INSERT INTO scoped_actor_credentials (
       credential_id, actor_type, actor_id, actor_display_name, issuer_id,
       issuer_display_name, grant_id, audience, secret_hash, capabilities,
       scope, metadata, issued_at, expires_at, revoked_at, revoked_by,
       revocation_reason, correlation_id
     ) VALUES (
       @credentialId, @actorType, @actorId, @actorDisplayName, @issuerId,
       @issuerDisplayName, @grantId, @audience, @secretHash, @capabilities,
       @scope, @metadata, @issuedAt, @expiresAt, NULL, NULL, NULL, @correlationId
     )`
  );
  const revokeById = db.prepare(
    `UPDATE scoped_actor_credentials
     SET revoked_at = @revokedAt,
         revoked_by = @revokedBy,
         revocation_reason = @reason
     WHERE credential_id = @credentialId AND revoked_at IS NULL`
  );
  const deleteExpired = db.prepare(
    'DELETE FROM scoped_actor_credentials WHERE expires_at <= ?'
  );

  return {
    close() {
      db.close();
    },

    recordCredential(
      input: PersistedScopedActorCredentialWriteInput
    ): ScopedActorCredentialRecord {
      const credentialId = requireNonEmpty(input.credentialId, 'credentialId');
      const secretHash = requireNonEmpty(input.secretHash, 'secretHash');
      if (!/^[0-9a-f]{64}$/.test(secretHash)) {
        throw new ScopedActorCredentialStoreError(
          400,
          'scoped_actor_credential_secret_hash_invalid',
          'credential secret hash must be a sha256 hex digest'
        );
      }

      insertCredential.run({
        credentialId,
        actorType: requireNonEmpty(input.actor.type, 'actor.type'),
        actorId: requireNonEmpty(input.actor.id, 'actor.id'),
        actorDisplayName: input.actor.displayName?.trim() || null,
        issuerId: requireNonEmpty(input.issuer.id, 'issuer.id'),
        issuerDisplayName: input.issuer.displayName?.trim() || null,
        grantId: input.grantId?.trim() || null,
        audience: requireNonEmpty(input.audience, 'audience'),
        secretHash,
        capabilities: JSON.stringify([...input.capabilities]),
        scope: JSON.stringify(input.scope ?? {}),
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        issuedAt: requireNonEmpty(input.issuedAt, 'issuedAt'),
        expiresAt: requireNonEmpty(input.expiresAt, 'expiresAt'),
        correlationId: requireNonEmpty(input.correlationId, 'correlationId'),
      });

      const stored = selectById.get(credentialId) as
        | ScopedActorCredentialDbRow
        | undefined;
      if (!stored) {
        throw new ScopedActorCredentialStoreError(
          500,
          'scoped_actor_credential_write_failed',
          'credential row disappeared immediately after insert'
        );
      }
      return toCredentialRecord(stored);
    },

    getCredential(credentialId: string): ScopedActorCredentialRecord | null {
      const row = selectById.get(credentialId) as
        | ScopedActorCredentialDbRow
        | undefined;
      return row ? toCredentialRecord(row) : null;
    },

    listCredentials(): ScopedActorCredentialRecord[] {
      const rows = selectAll.all() as ScopedActorCredentialDbRow[];
      return rows.map(toCredentialRecord);
    },

    listRestorableCredentials(
      now: Date = new Date()
    ): ScopedActorCredentialRestoreRow[] {
      const rows = selectRestorable.all(now.toISOString()) as Array<
        ScopedActorCredentialDbRow & { secret_hash: string }
      >;
      return rows.map((row) => ({
        ...toCredentialRecord(row),
        secretHash: row.secret_hash,
      }));
    },

    revokeCredential(
      credentialId: string,
      input: {
        revokedBy: string;
        reason?: string;
        correlationId?: string;
        now?: Date;
      }
    ): ScopedActorCredentialRecord | null {
      const revokedAt = (input.now ?? new Date()).toISOString();
      const changed = revokeById.run({
        credentialId,
        revokedAt,
        revokedBy: input.revokedBy,
        reason: input.reason ?? null,
      }).changes;
      if (changed === 0) {
        const existing = selectById.get(credentialId) as
          | ScopedActorCredentialDbRow
          | undefined;
        return existing ? toCredentialRecord(existing) : null;
      }
      const updated = selectById.get(credentialId) as
        | ScopedActorCredentialDbRow
        | undefined;
      return updated ? toCredentialRecord(updated) : null;
    },

    revokeCredentialsByGrantId(
      grantId: string,
      input: {
        revokedBy: string;
        reason?: string;
        correlationId?: string;
        now?: Date;
      }
    ): ScopedActorCredentialRecord[] {
      const live = selectByGrantId.all(grantId) as ScopedActorCredentialDbRow[];
      if (live.length === 0) return [];
      const revokedAt = (input.now ?? new Date()).toISOString();
      const revoked: ScopedActorCredentialRecord[] = [];
      for (const row of live) {
        const changed = revokeById.run({
          credentialId: row.credential_id,
          revokedAt,
          revokedBy: input.revokedBy,
          reason: input.reason ?? null,
        }).changes;
        if (changed === 0) continue;
        revoked.push(
          toCredentialRecord({
            ...row,
            revoked_at: revokedAt,
            revoked_by: input.revokedBy,
            revocation_reason: input.reason ?? null,
          })
        );
      }
      return revoked;
    },

    pruneExpiredCredentials(now: Date = new Date()): number {
      return deleteExpired.run(now.toISOString()).changes;
    },
  };
}

function toCredentialRecord(
  row: ScopedActorCredentialDbRow
): ScopedActorCredentialRecord {
  let capabilities: RelayCapabilityBit[] = [];
  try {
    const parsed: unknown = JSON.parse(row.capabilities);
    if (Array.isArray(parsed)) {
      capabilities = parsed.filter(isRelayCapabilityBit);
    }
  } catch {
    logger.warn(
      'scoped actor credential %s has unreadable capabilities',
      row.credential_id
    );
  }

  let scope: ScopedActorCredentialScope = {};
  try {
    const parsed: unknown = JSON.parse(row.scope);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      scope = parsed as ScopedActorCredentialScope;
    }
  } catch {
    logger.warn(
      'scoped actor credential %s has unreadable scope',
      row.credential_id
    );
  }

  let metadata: ScopedActorCredentialMetadata | undefined = undefined;
  if (row.metadata) {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        metadata = parsed as ScopedActorCredentialMetadata;
      }
    } catch {
      logger.warn(
        'scoped actor credential %s has unreadable metadata',
        row.credential_id
      );
    }
  }

  return {
    id: row.credential_id,
    actor: {
      type: row.actor_type as ScopedActorCredentialType,
      id: row.actor_id,
      ...(row.actor_display_name
        ? { displayName: row.actor_display_name }
        : {}),
    },
    issuer: {
      id: row.issuer_id,
      ...(row.issuer_display_name
        ? { displayName: row.issuer_display_name }
        : {}),
    },
    ...(row.grant_id ? { grantId: row.grant_id } : {}),
    audience: row.audience as ScopedActorCredentialAudience,
    capabilities,
    scope,
    ...(metadata ? { metadata } : {}),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.revoked_by ? { revokedBy: row.revoked_by } : {}),
    ...(row.revocation_reason
      ? { revocationReason: row.revocation_reason }
      : {}),
    correlationId: row.correlation_id,
  };
}

function runMigrations(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)'
  );
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
          db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
            ver
          );
        }
      })();
      currentVersion = ver;
    }
  }
}

function precreateSecretFile(dbPath: string): void {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) return;
  try {
    fs.closeSync(fs.openSync(dbPath, 'wx', 0o600));
  } catch {
    // Already exists or directory error; handled downstream.
  }
}

function restrictSecretFileMode(dbPath: string): void {
  for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(target, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      logger.warn(
        'could not restrict permissions on %s: %s',
        target,
        (err as Error)?.message ?? String(err)
      );
    }
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new ScopedActorCredentialStoreError(
      400,
      'scoped_actor_credential_field_required',
      `${field} is required.`
    );
  }
  return trimmed;
}
