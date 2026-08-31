// AgentProfile store (#1233, epic #1232).
//
// Persists AgentProfile rows — the durable agent-kind Actor identity noun — in
// the hub config dir beside the framework registry, reusing the self-contained
// store pattern of `server/agent-presence-store.ts` / `server/context-packets.ts`:
// a per-store SQLite file, a `schema_version` table with version-gated
// migrations run inside a transaction, an `init*(configDir)` / `create*(dbPath)`
// factory split, a `profile_json` blob column plus denormalized columns for
// queries, and prepared statements.
//
// STRICTLY NON-DESTRUCTIVE: owns its own DB file (`agent-profiles.db`) and creates
// only the new `agent_profiles` table. It never reads or mutates `config.json`,
// any existing store/table, or any live `ChannelSenderRef` / DM row.
//
// ONE-DEFAULT-PER-PROVIDER (enforcement CHOICE: REJECT). Exactly one profile per
// `providerId` may carry `isDefault: true`. `create()` REJECTS a second default
// with a clear typed error (`agent_profile_default_exists`, HTTP 409) rather than
// silently flipping — an intentional default change goes through `setDefault()`,
// which flips atomically in a transaction. A partial UNIQUE index
// (`... WHERE is_default = 1`) enforces the invariant at the DB layer as
// defense-in-depth, so even a raced write cannot land two defaults.
//
// THIN OVERLAY: vendor facts (label/glyph/command/args/model-env) are NOT copied
// onto rows. `seedBuiltIns` writes one built-in default per configured framework
// with an EMPTY `displayName` ('') — the "inherit vendor label from the catalog"
// sentinel — carrying no duplicated vendor prose. Seeding is idempotent via the
// stable primary key `builtInAgentProfileId(providerId)`.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  AGENT_PROFILE_SECRET_KEY,
  builtInAgentProfileId,
  isAgentProfile,
  isValidHermesApiKey,
  type AgentProfile,
  type AgentProfileAvatarRef,
  type AgentProfileRespondTo,
} from '../shared/agent-profile.js';
import { createLogger } from './logger.js';

const logger = createLogger('agent-profile');

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS agent_profiles (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  is_default    INTEGER NOT NULL,
  is_built_in   INTEGER NOT NULL,
  profile_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_provider
  ON agent_profiles(provider_id);
-- One-default-per-provider invariant, enforced at the DB layer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_one_default
  ON agent_profiles(provider_id) WHERE is_default = 1;
`;

// The per-profile gateway key (#1453) is a WRITE-ONLY secret and gets its OWN
// column rather than a field inside `profile_json`. That is the whole redaction
// strategy: every read statement below selects `hermes_api_key IS NOT NULL`, so
// a future read path added by someone who never heard of this field still
// cannot return the secret. Only `getGatewaySecret` names the column's value.
const SCHEMA_V2 = `
ALTER TABLE agent_profiles ADD COLUMN hermes_api_key TEXT;
`;

// Durable per-profile actor credentials (#1455 slice 3). The scoped-actor
// registry is memory-only, so before this table a restart silently invalidated
// every token an operator had planted on another host. This is the persistence
// that makes a profile credential outlive the process that minted it.
//
// NEVER the token. `secret_hash` is the sha256 the registry itself computes at
// issue time, compared exactly like the profile gateway key: a stolen copy of
// this file replays nothing. The column is selected by ONE statement in this
// file (`selectRestorableCredentials`), for the boot rehydrate and nothing else.
//
// A profile holds at most one LIVE credential; the partial unique index is the
// DB-layer statement of that, so even a raced mint cannot leave two. Rotation
// is revoke-then-mint inside one transaction.
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS agent_profile_credentials (
  credential_id TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  display_name  TEXT,
  issuer_id     TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,
  capabilities  TEXT NOT NULL,
  issued_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoked_by    TEXT,
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_profile_credentials_profile
  ON agent_profile_credentials(profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profile_credentials_one_live
  ON agent_profile_credentials(profile_id) WHERE revoked_at IS NULL;
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
];

/**
 * Column list every credential read uses. `secret_hash` is deliberately absent
 * — the same redaction strategy as `PROFILE_COLUMNS`, so a future read path
 * added by someone who never saw this comment still cannot return the digest.
 */
const CREDENTIAL_COLUMNS = `credential_id, profile_id, actor_id, display_name,
   issuer_id, capabilities, issued_at, expires_at, revoked_at, revoked_by,
   last_used_at`;

interface AgentProfileCredentialDbRow {
  credential_id: string;
  profile_id: string;
  actor_id: string;
  display_name: string | null;
  issuer_id: string;
  capabilities: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  last_used_at: string | null;
}

/** Stored credential metadata. Carries no secret and no digest. */
export interface AgentProfileCredentialRow {
  credentialId: string;
  profileId: string;
  actorId: string;
  displayName: string | null;
  issuerId: string;
  capabilities: string[];
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  lastUsedAt: string | null;
}

/** A stored credential plus its digest — the boot-rehydrate shape ONLY. */
export interface AgentProfileCredentialRestoreRow extends AgentProfileCredentialRow {
  secretHash: string;
}

/** Write input for `recordCredential`. */
export interface AgentProfileCredentialWriteInput {
  credentialId: string;
  profileId: string;
  actorId: string;
  displayName?: string | null;
  issuerId: string;
  /** `scopedActorCredentialSecretHash(token)` — never the token. */
  secretHash: string;
  capabilities: readonly string[];
  issuedAt: string;
  expiresAt: string;
}

/**
 * Column list every profile read uses. `has_hermes_api_key` is deliberately a
 * derived boolean, never the value.
 */
const PROFILE_COLUMNS = `id, provider_id, is_default, is_built_in, profile_json,
   created_at, updated_at, hermes_api_key IS NOT NULL AS has_hermes_api_key`;

interface AgentProfileRow {
  id: string;
  provider_id: string;
  is_default: number;
  is_built_in: number;
  profile_json: string;
  created_at: string;
  updated_at: string;
  /** 1 when a gateway key is stored. The key itself is never selected here. */
  has_hermes_api_key: number;
}

/** Framework subset needed to seed a built-in default profile. */
export interface SeedFramework {
  id: string;
}

/** Write input for `create`. `id` is optional (stably generated when absent). */
export interface AgentProfileCreateInput {
  id?: string;
  providerId: string;
  displayName?: string;
  avatar?: AgentProfileAvatarRef | null;
  systemPrompt?: string;
  model?: string;
  provider?: string;
  effort?: string;
  envVars?: Record<string, string>;
  /** Hermes multiplex profile binding; see `AgentProfile.hermesProfile`. */
  hermesProfile?: string;
  /**
   * Per-profile Hermes gateway key (#1453). WRITE-ONLY: it is stored in its own
   * column and never comes back on any `AgentProfile` — only
   * `AgentProfileStore.getGatewaySecret` can read it.
   */
  hermesApiKey?: string;
  namePool?: string[];
  respondTo?: AgentProfileRespondTo;
  respondToAllowlist?: string[];
  isDefault?: boolean;
  isBuiltIn?: boolean;
}

/**
 * Mutable overlay fields for an existing profile. Every field is optional so
 * callers can make a true PATCH; `null` clears optional vendor-dependent
 * overlays. `isBuiltIn` is store-managed and may not be changed.
 */
export interface AgentProfileUpdateInput {
  providerId?: string;
  displayName?: string;
  avatar?: AgentProfileAvatarRef | null;
  systemPrompt?: string | null;
  model?: string | null;
  provider?: string | null;
  effort?: string | null;
  envVars?: Record<string, string> | null;
  /** Hermes multiplex profile binding; `null` clears it. */
  hermesProfile?: string | null;
  /**
   * Per-profile Hermes gateway key; `null` clears it, an OMITTED field leaves
   * the stored key untouched. WRITE-ONLY — see `AgentProfileCreateInput`.
   */
  hermesApiKey?: string | null;
  namePool?: string[] | null;
  respondTo?: AgentProfileRespondTo | null;
  respondToAllowlist?: string[] | null;
  isDefault?: boolean;
  isBuiltIn?: boolean;
}

export interface AgentProfileStore {
  close(): void;
  /**
   * Insert a new profile. REJECTS a second `isDefault` for the same providerId
   * with `agent_profile_default_exists` (409). Use `setDefault` to change which
   * profile is default.
   */
  create(input: AgentProfileCreateInput): AgentProfile;
  /**
   * Update a profile atomically while keeping the JSON blob and denormalized
   * identity/default columns in lockstep. A default cannot be cleared or moved
   * to another provider because that would leave its old provider defaultless.
   */
  update(id: string, patch: AgentProfileUpdateInput): AgentProfile;
  get(id: string): AgentProfile | null;
  list(filter?: { providerId?: string }): AgentProfile[];
  getDefaultForProvider(providerId: string): AgentProfile | null;
  /**
   * The profile's write-only gateway secret, or `null`. THE ONLY read path for
   * it. Deliberately provider-neutral here: which adapter `extra` key the value
   * is forwarded as is one `PROVIDER_DESCRIPTORS` row
   * (`agentProfileGatewaySecretKey`), so this store holds no provider name and
   * the channel binder needs no `providerId === 'hermes'` branch.
   *
   * Callers must treat the result as secret: never log it, never put it in an
   * error message, never return it on an HTTP response.
   */
  getGatewaySecret(profileId: string): string | null;
  /** Atomically make `profileId` the sole default for its providerId. */
  setDefault(profileId: string): AgentProfile;
  /** Refuses to delete the built-in default profile for a provider (409). */
  delete(id: string): boolean;
  /**
   * Seed/repair exactly one `isBuiltIn`+`isDefault` profile per configured
   * framework. Idempotent when a default already exists (no duplicate, no flip);
   * self-healing when a provider has a survivor row but zero defaults (promotes
   * the survivor at the stable built-in PK, or inserts a built-in default,
   * atomically). Returns the number of NEW built-in default rows inserted —
   * in-place promotions/repairs are not counted.
   */
  seedBuiltIns(frameworks: readonly SeedFramework[]): number;

  // ── Durable per-profile actor credentials (#1455 slice 3) ─────────────────

  /**
   * Persist a freshly minted credential, revoking whatever live credential the
   * profile already held IN THE SAME TRANSACTION. Rotation is revoke + mint, so
   * the window in which a profile has two usable credentials is zero: either
   * both writes land or neither does.
   *
   * Returns the rows revoked on the way in, so the caller can revoke the same
   * ids in the in-memory registry and the two views cannot diverge.
   */
  recordCredential(input: AgentProfileCredentialWriteInput): {
    stored: AgentProfileCredentialRow;
    revoked: AgentProfileCredentialRow[];
  };
  /**
   * Revoke the profile's live credential. `null` when it holds none — a
   * revoke with nothing to revoke is a 404, not a silent success.
   */
  revokeCredential(
    profileId: string,
    revokedBy: string
  ): AgentProfileCredentialRow | null;
  /**
   * Revoke every live credential for `profileId`, e.g. because the profile is
   * being deleted. The unique index means this is at most one row today; it is
   * written as a sweep so a future multi-credential profile cannot leak one.
   */
  revokeCredentialsForProfile(
    profileId: string,
    revokedBy: string
  ): AgentProfileCredentialRow[];
  /**
   * The credential a status read should show: the profile's live one, else its
   * most recently issued row (so a revoked credential still explains itself).
   */
  getCredentialStatus(profileId: string): AgentProfileCredentialRow | null;
  /** Credential by id, for the request-path last-used stamp. */
  getCredentialById(credentialId: string): AgentProfileCredentialRow | null;
  /**
   * Every credential still worth restoring into the registry at boot: rows that
   * have not expired, revoked ones included, so a replayed token is denied as
   * `revoked` rather than as an unknown id. THE ONLY read path for the digest.
   */
  listRestorableCredentials(now?: Date): AgentProfileCredentialRestoreRow[];
  /** Drop rows past their expiry — dead material either way. Returns the count. */
  pruneExpiredCredentials(now?: Date): number;
  /** Stamp last-used. Callers debounce; this store does not. */
  touchCredential(credentialId: string, at: string): void;
}

export class AgentProfileStoreError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.name = 'AgentProfileStoreError';
    this.status = status;
    this.code = code;
  }
}

/** Boot entry point: opens (and migrates) the store DB under `configDir`. */
export function initAgentProfileStore(configDir: string): AgentProfileStore {
  return createAgentProfileStore(path.join(configDir, 'agent-profiles.db'));
}

/** Factory taking an explicit DB path. Used directly by unit tests. */
export function createAgentProfileStore(dbPath: string): AgentProfileStore {
  precreateSecretFile(dbPath);
  const db = new Database(dbPath);
  // The DB now holds a bearer secret. SQLite copies the main file's mode onto
  // the -wal/-shm sidecars it creates, so tighten BEFORE enabling WAL. Config
  // dir only, best effort: a filesystem that refuses chmod (or a pre-existing
  // DB owned by another user) must not stop the hub from booting.
  restrictSecretFileMode(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);

  const selectById = db.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM agent_profiles WHERE id = ?`
  );
  const selectDefaultForProvider = db.prepare(
    `SELECT ${PROFILE_COLUMNS}
     FROM agent_profiles WHERE provider_id = ? AND is_default = 1`
  );
  // The one statement in this file that selects the secret's VALUE.
  const selectGatewaySecret = db.prepare(
    'SELECT hermes_api_key FROM agent_profiles WHERE id = ?'
  );
  const updateGatewaySecret = db.prepare(
    'UPDATE agent_profiles SET hermes_api_key = ?, updated_at = ? WHERE id = ?'
  );
  const insert = db.prepare(
    `INSERT INTO agent_profiles (
       id, provider_id, is_default, is_built_in, profile_json, created_at,
       updated_at, hermes_api_key
     ) VALUES (
       @id, @providerId, @isDefault, @isBuiltIn, @profileJson, @createdAt,
       @updatedAt, @hermesApiKey
     )`
  );
  const clearDefault = db.prepare(
    `UPDATE agent_profiles SET is_default = 0, profile_json = ?, updated_at = ?
     WHERE id = ?`
  );
  const setDefaultRow = db.prepare(
    `UPDATE agent_profiles SET is_default = 1, profile_json = ?, updated_at = ?
     WHERE id = ?`
  );
  const updateRow = db.prepare(
    `UPDATE agent_profiles
       SET provider_id = @providerId,
           is_default = @isDefault,
           is_built_in = @isBuiltIn,
           profile_json = @profileJson,
           updated_at = @updatedAt
     WHERE id = @id`
  );
  // Self-heal a zero-default vendor: force a survivor at the stable built-in PK
  // to be the built-in default. Sets is_built_in = 1 (not just is_default) so a
  // demoted user row promoted here honors the isDefault+isBuiltIn contract.
  const promoteBuiltInDefault = db.prepare(
    `UPDATE agent_profiles
       SET is_default = 1, is_built_in = 1, profile_json = ?, updated_at = ?
     WHERE id = ?`
  );
  const deleteById = db.prepare('DELETE FROM agent_profiles WHERE id = ?');

  // ── Credential statements (#1455 slice 3) ─────────────────────────────────
  const insertCredential = db.prepare(
    `INSERT INTO agent_profile_credentials (
       credential_id, profile_id, actor_id, display_name, issuer_id,
       secret_hash, capabilities, issued_at, expires_at, revoked_at,
       revoked_by, last_used_at
     ) VALUES (
       @credentialId, @profileId, @actorId, @displayName, @issuerId,
       @secretHash, @capabilities, @issuedAt, @expiresAt, NULL, NULL, NULL
     )`
  );
  const selectLiveCredentials = db.prepare(
    `SELECT ${CREDENTIAL_COLUMNS} FROM agent_profile_credentials
     WHERE profile_id = ? AND revoked_at IS NULL`
  );
  const selectNewestCredential = db.prepare(
    `SELECT ${CREDENTIAL_COLUMNS} FROM agent_profile_credentials
     WHERE profile_id = ? ORDER BY revoked_at IS NULL DESC, issued_at DESC
     LIMIT 1`
  );
  const selectCredentialById = db.prepare(
    `SELECT ${CREDENTIAL_COLUMNS} FROM agent_profile_credentials
     WHERE credential_id = ?`
  );
  const revokeCredentialById = db.prepare(
    `UPDATE agent_profile_credentials
     SET revoked_at = @revokedAt, revoked_by = @revokedBy
     WHERE credential_id = @credentialId AND revoked_at IS NULL`
  );
  // The one statement in this file that selects a credential digest's value.
  const selectRestorableCredentials = db.prepare(
    `SELECT ${CREDENTIAL_COLUMNS}, secret_hash FROM agent_profile_credentials
     WHERE expires_at > ?`
  );
  const deleteExpiredCredentials = db.prepare(
    'DELETE FROM agent_profile_credentials WHERE expires_at <= ?'
  );
  const touchCredentialStmt = db.prepare(
    `UPDATE agent_profile_credentials SET last_used_at = @at
     WHERE credential_id = @credentialId`
  );

  function persist(row: {
    id: string;
    providerId: string;
    isDefault: number;
    isBuiltIn: number;
    profile: AgentProfile;
    createdAt: string;
    updatedAt: string;
    hermesApiKey: string | null;
  }): void {
    try {
      insert.run({
        id: row.id,
        providerId: row.providerId,
        isDefault: row.isDefault,
        isBuiltIn: row.isBuiltIn,
        profileJson: toStoredJson(row.profile),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        hermesApiKey: row.hermesApiKey,
      });
    } catch (err) {
      rethrowConstraint(err, row.providerId);
    }
  }

  return {
    close() {
      db.close();
    },

    create(input: AgentProfileCreateInput): AgentProfile {
      const providerId = requireNonEmpty(input.providerId, 'providerId');
      const isDefault = input.isDefault ?? false;
      const id =
        readTrimmed(input.id) ?? generateProfileId(providerId, isDefault);

      if (isDefault && selectDefaultForProvider.get(providerId)) {
        // Enforcement CHOICE: REJECT a second default (use setDefault to flip).
        // Checked before the id-collision guard so a second default is always
        // reported as such, even when the generated default id also collides.
        throw new AgentProfileStoreError(
          409,
          'agent_profile_default_exists',
          `Provider "${providerId}" already has a default profile; use setDefault to change it.`
        );
      }
      if (selectById.get(id)) {
        throw new AgentProfileStoreError(
          409,
          'agent_profile_id_exists',
          `Agent profile "${id}" already exists.`
        );
      }

      const profile = buildProfile(id, providerId, isDefault, input);
      const hermesApiKey = normalizeGatewaySecret(input.hermesApiKey);
      const nowIso = new Date().toISOString();
      persist({
        id,
        providerId,
        isDefault: isDefault ? 1 : 0,
        isBuiltIn: profile.isBuiltIn ? 1 : 0,
        profile,
        createdAt: nowIso,
        updatedAt: nowIso,
        hermesApiKey,
      });
      const written = getById(id);
      if (!written) {
        throw new AgentProfileStoreError(500, 'agent_profile_write_failed');
      }
      return written;
    },

    update(id: string, patch: AgentProfileUpdateInput): AgentProfile {
      const current = getById(id);
      if (!current) {
        throw new AgentProfileStoreError(404, 'agent_profile_not_found');
      }
      if (
        hasOwn(patch, 'isBuiltIn') &&
        patch.isBuiltIn !== undefined &&
        patch.isBuiltIn !== current.isBuiltIn
      ) {
        throw new AgentProfileStoreError(
          400,
          'agent_profile_is_built_in_immutable',
          'isBuiltIn is managed by the store and cannot be changed.'
        );
      }

      const providerId = hasOwn(patch, 'providerId')
        ? requireNonEmpty(patch.providerId, 'providerId')
        : current.providerId;
      if (current.isBuiltIn && providerId !== current.providerId) {
        throw new AgentProfileStoreError(
          400,
          'agent_profile_builtin_provider_change_forbidden',
          'Built-in profiles cannot change providerId.'
        );
      }
      const isDefault = hasOwn(patch, 'isDefault')
        ? patch.isDefault
        : current.isDefault;
      if (typeof isDefault !== 'boolean') {
        throw new AgentProfileStoreError(400, 'agent_profile_invalid');
      }
      if (current.isDefault && !isDefault) {
        throw new AgentProfileStoreError(
          409,
          'agent_profile_last_default',
          'A provider must retain a default profile.'
        );
      }
      if (current.isDefault && providerId !== current.providerId) {
        throw new AgentProfileStoreError(
          409,
          'agent_profile_default_provider_change_forbidden',
          'Move a non-default profile, or set another default first.'
        );
      }

      const profile = applyProfilePatch(current, patch, providerId, isDefault);
      if (!isAgentProfile(profile)) {
        throw new AgentProfileStoreError(400, 'agent_profile_invalid');
      }
      // An OMITTED `hermesApiKey` leaves the stored key alone; an explicit
      // `null` clears it. `undefined` counts as omitted even when the property
      // is present, because the field's declared type is `string | null` and a
      // caller spreading an optional variable in means "untouched", not "wipe".
      // Rejecting a malformed key before the transaction keeps a bad secret
      // from ever reaching the column.
      const setsSecret =
        hasOwn(patch, 'hermesApiKey') && patch.hermesApiKey !== undefined;
      // The secret authenticates against the OLD provider's gateway, so a
      // provider change clears it unless this same patch supplies a new one.
      // This invariant lives HERE, beside the column it protects, rather than
      // in the router: a non-HTTP caller must not be able to carry credential
      // material across a provider change.
      const providerChanged = providerId !== current.providerId;
      const patchesSecret = setsSecret || providerChanged;
      const nextSecret = setsSecret
        ? normalizeGatewaySecret(patch.hermesApiKey)
        : null;
      const nowIso = new Date().toISOString();
      const write = db.transaction(() => {
        // A false→true flip is the one sanctioned way update() changes a
        // provider's default. Clear its current default first, then write the
        // target row, so JSON and denormalized flags agree at every commit.
        if (profile.isDefault && !current.isDefault) {
          const previous = selectDefaultForProvider.get(profile.providerId) as
            | AgentProfileRow
            | undefined;
          if (previous && previous.id !== id) {
            const previousProfile = rowToProfileSafe(previous);
            if (previousProfile) {
              clearDefault.run(
                toStoredJson({ ...previousProfile, isDefault: false }),
                nowIso,
                previous.id
              );
            }
          }
        }
        try {
          updateRow.run({
            id,
            providerId: profile.providerId,
            isDefault: profile.isDefault ? 1 : 0,
            isBuiltIn: profile.isBuiltIn ? 1 : 0,
            profileJson: toStoredJson(profile),
            updatedAt: nowIso,
          });
        } catch (err) {
          rethrowConstraint(err, profile.providerId);
        }
        if (patchesSecret) updateGatewaySecret.run(nextSecret, nowIso, id);
      });
      write();
      const written = getById(id);
      if (!written) {
        throw new AgentProfileStoreError(500, 'agent_profile_write_failed');
      }
      return written;
    },

    get(id: string): AgentProfile | null {
      return getById(id);
    },

    list(filter: { providerId?: string } = {}): AgentProfile[] {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.providerId) {
        clauses.push('provider_id = ?');
        params.push(filter.providerId);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const stmt = db.prepare(
        `SELECT ${PROFILE_COLUMNS}
         FROM agent_profiles${where}
         ORDER BY provider_id ASC, is_default DESC, id ASC`
      );
      return (stmt.all(...params) as AgentProfileRow[])
        .map(rowToProfileSafe)
        .filter((p): p is AgentProfile => p !== null);
    },

    getDefaultForProvider(providerId: string): AgentProfile | null {
      const row = selectDefaultForProvider.get(providerId) as
        | AgentProfileRow
        | undefined;
      return row ? rowToProfileSafe(row) : null;
    },

    getGatewaySecret(profileId: string): string | null {
      const row = selectGatewaySecret.get(profileId) as
        | { hermes_api_key: string | null }
        | undefined;
      const stored = row?.hermes_api_key ?? null;
      // A stored value that no longer passes the guard (hand-edited DB, or a
      // tightened pattern) is dropped rather than handed to an HTTP header.
      return stored !== null && isValidHermesApiKey(stored) ? stored : null;
    },

    setDefault(profileId: string): AgentProfile {
      const target = getById(profileId);
      if (!target) {
        throw new AgentProfileStoreError(404, 'agent_profile_not_found');
      }
      if (target.isDefault) return target;
      const nowIso = new Date().toISOString();
      const flip = db.transaction(() => {
        const current = selectDefaultForProvider.get(target.providerId) as
          | AgentProfileRow
          | undefined;
        if (current) {
          const currentProfile = rowToProfileSafe(current);
          if (currentProfile) {
            clearDefault.run(
              toStoredJson({ ...currentProfile, isDefault: false }),
              nowIso,
              current.id
            );
          }
        }
        setDefaultRow.run(
          toStoredJson({ ...target, isDefault: true }),
          nowIso,
          profileId
        );
      });
      flip();
      const written = getById(profileId);
      if (!written) {
        throw new AgentProfileStoreError(500, 'agent_profile_write_failed');
      }
      return written;
    },

    delete(id: string): boolean {
      const profile = getById(id);
      if (profile?.isBuiltIn && profile.isDefault) {
        throw new AgentProfileStoreError(
          409,
          'agent_profile_builtin_default_delete_forbidden',
          'The built-in default profile cannot be deleted.'
        );
      }
      // #1455 slice 3: a deleted profile must not leave a usable credential
      // behind. The row is REVOKED rather than deleted, in the same
      // transaction as the profile: the boot rehydrate then restores it as
      // revoked, so a token planted on a Hermes host is answered with a typed
      // `revoked` refusal instead of an unexplained unknown-credential 401.
      const removeProfile = db.transaction((profileId: string): boolean => {
        revokeLiveCredentials(profileId, 'agent-profile-deleted');
        return deleteById.run(profileId).changes > 0;
      });
      return removeProfile(id);
    },

    // ── Durable per-profile actor credentials (#1455 slice 3) ───────────────

    recordCredential(input: AgentProfileCredentialWriteInput): {
      stored: AgentProfileCredentialRow;
      revoked: AgentProfileCredentialRow[];
    } {
      const profileId = requireNonEmpty(input.profileId, 'profileId');
      const credentialId = requireNonEmpty(input.credentialId, 'credentialId');
      const secretHash = requireNonEmpty(input.secretHash, 'secretHash');
      if (!/^[0-9a-f]{64}$/.test(secretHash)) {
        throw new AgentProfileStoreError(
          400,
          'agent_profile_credential_secret_hash_invalid',
          'credential secret hash must be a sha256 hex digest'
        );
      }
      const mint = db.transaction(() => {
        const revoked = revokeLiveCredentials(profileId, 'rotated');
        insertCredential.run({
          credentialId,
          profileId,
          actorId: requireNonEmpty(input.actorId, 'actorId'),
          displayName: readTrimmed(input.displayName) ?? null,
          issuerId: requireNonEmpty(input.issuerId, 'issuerId'),
          secretHash,
          capabilities: JSON.stringify([...input.capabilities]),
          issuedAt: requireNonEmpty(input.issuedAt, 'issuedAt'),
          expiresAt: requireNonEmpty(input.expiresAt, 'expiresAt'),
        });
        const stored = selectCredentialById.get(credentialId) as
          | AgentProfileCredentialDbRow
          | undefined;
        if (!stored) {
          throw new AgentProfileStoreError(
            500,
            'agent_profile_credential_write_failed',
            'credential row disappeared immediately after insert'
          );
        }
        return { stored: toCredentialRow(stored), revoked };
      });
      return mint();
    },

    revokeCredential(
      profileId: string,
      revokedBy: string
    ): AgentProfileCredentialRow | null {
      const revoked = revokeLiveCredentials(profileId, revokedBy);
      return revoked[0] ?? null;
    },

    revokeCredentialsForProfile(
      profileId: string,
      revokedBy: string
    ): AgentProfileCredentialRow[] {
      return revokeLiveCredentials(profileId, revokedBy);
    },

    getCredentialStatus(profileId: string): AgentProfileCredentialRow | null {
      const row = selectNewestCredential.get(profileId) as
        | AgentProfileCredentialDbRow
        | undefined;
      return row ? toCredentialRow(row) : null;
    },

    getCredentialById(credentialId: string): AgentProfileCredentialRow | null {
      const row = selectCredentialById.get(credentialId) as
        | AgentProfileCredentialDbRow
        | undefined;
      return row ? toCredentialRow(row) : null;
    },

    listRestorableCredentials(
      now: Date = new Date()
    ): AgentProfileCredentialRestoreRow[] {
      const rows = selectRestorableCredentials.all(now.toISOString()) as Array<
        AgentProfileCredentialDbRow & { secret_hash: string }
      >;
      return rows.map((row) => ({
        ...toCredentialRow(row),
        secretHash: row.secret_hash,
      }));
    },

    pruneExpiredCredentials(now: Date = new Date()): number {
      return deleteExpiredCredentials.run(now.toISOString()).changes;
    },

    touchCredential(credentialId: string, at: string): void {
      touchCredentialStmt.run({ credentialId, at });
    },

    seedBuiltIns(frameworks: readonly SeedFramework[]): number {
      let inserted = 0;
      const seed = db.transaction(() => {
        const nowIso = new Date().toISOString();
        for (const framework of frameworks) {
          const providerId = readTrimmed(framework.id);
          if (!providerId) continue;

          // Idempotent: a default (built-in OR user-chosen) already exists —
          // leave it untouched so re-seeding never duplicates or flips a live
          // default. This also keeps seeding non-destructive of a user's choice.
          if (selectDefaultForProvider.get(providerId)) continue;

          // Self-healing: the provider has NO default (e.g. its default row was
          // demoted or deleted, leaving a survivor at is_default = 0). Restore
          // exactly one built-in default atomically inside this transaction,
          // consistent with setDefault's flip. Because the pre-check above proved
          // no default exists, promoting/inserting cannot collide with the
          // partial one-default-per-provider unique index.
          const id = builtInAgentProfileId(providerId);
          const existing = selectById.get(id) as AgentProfileRow | undefined;
          if (existing) {
            // A survivor lives at the stable built-in PK but is not the default:
            // promote it in place (never a duplicate row), preserving any overlay
            // content while forcing the built-in-default flags on.
            const survivor = rowToProfileSafe(existing);
            const healed: AgentProfile = survivor
              ? { ...survivor, isDefault: true, isBuiltIn: true }
              : {
                  id,
                  providerId,
                  displayName: '',
                  avatar: null,
                  isDefault: true,
                  isBuiltIn: true,
                };
            promoteBuiltInDefault.run(toStoredJson(healed), nowIso, id);
            // A heal is not a NEW row; the return count tracks inserts only.
            continue;
          }

          // No row at the stable built-in PK — insert the thin built-in default.
          // Thin overlay: empty displayName = "inherit vendor label from catalog".
          const profile: AgentProfile = {
            id,
            providerId,
            displayName: '',
            avatar: null,
            isDefault: true,
            isBuiltIn: true,
          };
          inserted += insert.run({
            id,
            providerId,
            isDefault: 1,
            isBuiltIn: 1,
            profileJson: toStoredJson(profile),
            createdAt: nowIso,
            updatedAt: nowIso,
            hermesApiKey: null,
          }).changes;
        }
      });
      seed();
      return inserted;
    },
  };

  function getById(id: string): AgentProfile | null {
    const row = selectById.get(id) as AgentProfileRow | undefined;
    return row ? rowToProfileSafe(row) : null;
  }

  /**
   * Tombstone every live credential a profile holds and return what was
   * revoked. Shared by explicit revoke, rotation, and profile deletion so all
   * three write the same row shape and none can forget the `revoked_by` audit.
   */
  function revokeLiveCredentials(
    profileId: string,
    revokedBy: string
  ): AgentProfileCredentialRow[] {
    const live = selectLiveCredentials.all(
      profileId
    ) as AgentProfileCredentialDbRow[];
    if (live.length === 0) return [];
    const revokedAt = new Date().toISOString();
    const revoked: AgentProfileCredentialRow[] = [];
    for (const row of live) {
      const changed = revokeCredentialById.run({
        credentialId: row.credential_id,
        revokedAt,
        revokedBy,
      }).changes;
      if (changed === 0) continue;
      revoked.push(
        toCredentialRow({
          ...row,
          revoked_at: revokedAt,
          revoked_by: revokedBy,
        })
      );
    }
    return revoked;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Map a credential DB row to its public shape. Never reads `secret_hash`. */
function toCredentialRow(
  row: AgentProfileCredentialDbRow
): AgentProfileCredentialRow {
  let capabilities: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.capabilities);
    if (Array.isArray(parsed)) {
      capabilities = parsed.filter(
        (value): value is string => typeof value === 'string'
      );
    }
  } catch {
    // A corrupt capability blob must not take the whole store down: the row
    // still authenticates through the registry, whose own copy is the one that
    // authorizes. Report an empty list rather than throwing on a status read.
    logger.warn(
      'agent profile credential %s has an unreadable capability list',
      row.credential_id
    );
  }
  return {
    credentialId: row.credential_id,
    profileId: row.profile_id,
    actorId: row.actor_id,
    displayName: row.display_name,
    issuerId: row.issuer_id,
    capabilities,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Serialize a profile for the `profile_json` blob. Strips the derived
 * `hermesApiKeySet` marker so the blob can never claim a secret state that
 * disagrees with the column, and asserts the secret itself is absent.
 */
function toStoredJson(profile: AgentProfile): string {
  const record: Record<string, unknown> = { ...profile };
  delete record['hermesApiKeySet'];
  delete record[AGENT_PROFILE_SECRET_KEY];
  return JSON.stringify(record);
}

/**
 * Validate a write of the gateway secret. `null` and an all-whitespace string
 * clear it; a malformed key is a typed 400 whose message never echoes the
 * value.
 *
 * The HTTP boundary is deliberately STRICTER: `agent-profile-router.ts` rejects
 * `''` with a 400, exactly as it does for `hermesProfile`, so an emptied editor
 * field can never be mistaken for "clear the key". This function is lenient
 * only so a direct store caller cannot store whitespace as a bearer token.
 */
function normalizeGatewaySecret(
  value: string | null | undefined
): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isValidHermesApiKey(trimmed)) {
    throw new AgentProfileStoreError(
      400,
      'agent_profile_gateway_secret_invalid',
      'hermesApiKey must be printable, space-free ASCII (max 4096 characters).'
    );
  }
  return trimmed;
}

/**
 * Best-effort 0600 on the store DB and any WAL sidecars. The hub's own secrets
 * (pinHash, GitHub token, VAPID private key) live in a config-dir `config.json`
 * written at the process umask, so this is a tightening of that precedent, not
 * a weakening of it — and it is best-effort because failing to chmod must never
 * stop the hub from booting.
 */
function restrictSecretFileMode(dbPath: string): void {
  for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(target, 0o600);
    } catch (err) {
      // A sidecar that does not exist yet is the normal case and says nothing.
      // Anything else means the bearer key may be sitting in a world-readable
      // file, and silence there is the wrong answer — the config dir itself is
      // created without an explicit mode, so this chmod is the only thing
      // narrowing the DB.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      logger.warn(
        'could not restrict permissions on %s: %s',
        target,
        (err as Error)?.message ?? String(err)
      );
    }
  }
}

/**
 * Create the DB file at 0600 BEFORE better-sqlite3 opens it, so it never exists
 * at `0666 & ~umask` even briefly. No-op for SQLite's non-file paths and for a
 * file that already exists (`wx` fails with EEXIST, and the chmod after open
 * narrows that case).
 */
function precreateSecretFile(dbPath: string): void {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) return;
  try {
    fs.closeSync(fs.openSync(dbPath, 'wx', 0o600));
  } catch {
    // Already exists, or the directory is not writable — the open below and
    // `restrictSecretFileMode` handle both.
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  const trimmed = readTrimmed(value);
  if (!trimmed) {
    throw new AgentProfileStoreError(
      400,
      'agent_profile_field_required',
      `${field} is required.`
    );
  }
  return trimmed;
}

function readTrimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function optionalString(value: string | null | undefined): string | undefined {
  return readTrimmed(value);
}

function stringRecord(
  value: Record<string, string> | null | undefined
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return Object.keys(result).length ? result : undefined;
}

function stringList(value: string[] | null | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.trim().length > 0
  );
  return result.length ? result : undefined;
}

/** Apply only fields explicitly present in the PATCH, preserving every other overlay. */
function applyProfilePatch(
  current: AgentProfile,
  patch: AgentProfileUpdateInput,
  providerId: string,
  isDefault: boolean
): AgentProfile {
  const profile: AgentProfile = {
    ...current,
    providerId,
    isDefault,
  };
  // A gateway binding names a profile on the OLD provider's gateway, so it
  // cannot follow a provider change any more than the secret beside it can.
  // An explicit `hermesProfile` in the same patch still wins, below.
  if (providerId !== current.providerId) delete profile.hermesProfile;
  if (hasOwn(patch, 'displayName')) {
    profile.displayName =
      typeof patch.displayName === 'string' ? patch.displayName : '';
  }
  if (hasOwn(patch, 'avatar')) profile.avatar = patch.avatar ?? null;

  const optionalFields: Array<
    readonly [
      'systemPrompt' | 'model' | 'provider' | 'effort' | 'hermesProfile',
      string | null | undefined,
    ]
  > = [
    ['systemPrompt', patch.systemPrompt],
    ['model', patch.model],
    ['provider', patch.provider],
    ['effort', patch.effort],
    ['hermesProfile', patch.hermesProfile],
  ];
  for (const [field, value] of optionalFields) {
    if (!hasOwn(patch, field)) continue;
    const normalized = optionalString(value);
    if (normalized) profile[field] = normalized;
    else delete profile[field];
  }
  if (hasOwn(patch, 'envVars')) {
    const normalized = stringRecord(patch.envVars);
    if (normalized) profile.envVars = normalized;
    else delete profile.envVars;
  }
  if (hasOwn(patch, 'namePool')) {
    const normalized = stringList(patch.namePool);
    if (normalized) profile.namePool = normalized;
    else delete profile.namePool;
  }
  if (hasOwn(patch, 'respondTo')) {
    if (patch.respondTo) profile.respondTo = patch.respondTo;
    else delete profile.respondTo;
  }
  if (hasOwn(patch, 'respondToAllowlist')) {
    const normalized = stringList(patch.respondToAllowlist);
    if (normalized) profile.respondToAllowlist = normalized;
    else delete profile.respondToAllowlist;
  }
  return profile;
}

function generateProfileId(providerId: string, isDefault: boolean): string {
  if (isDefault) return builtInAgentProfileId(providerId);
  return `agent-profile:${providerId}:${crypto.randomUUID()}`;
}

function buildProfile(
  id: string,
  providerId: string,
  isDefault: boolean,
  input: AgentProfileCreateInput
): AgentProfile {
  const profile: AgentProfile = {
    id,
    providerId,
    displayName: typeof input.displayName === 'string' ? input.displayName : '',
    avatar: input.avatar ?? null,
    isDefault,
    isBuiltIn: input.isBuiltIn ?? false,
  };
  const systemPrompt = readTrimmed(input.systemPrompt);
  if (systemPrompt) profile.systemPrompt = systemPrompt;
  const model = readTrimmed(input.model);
  if (model) profile.model = model;
  const provider = readTrimmed(input.provider);
  if (provider) profile.provider = provider;
  const effort = readTrimmed(input.effort);
  if (effort) profile.effort = effort;
  const hermesProfile = readTrimmed(input.hermesProfile);
  if (hermesProfile) profile.hermesProfile = hermesProfile;
  if (input.envVars && typeof input.envVars === 'object') {
    const envVars: Record<string, string> = {};
    for (const [key, val] of Object.entries(input.envVars)) {
      if (typeof val === 'string') envVars[key] = val;
    }
    if (Object.keys(envVars).length) profile.envVars = envVars;
  }
  if (Array.isArray(input.namePool)) {
    const namePool = input.namePool.filter(
      (n): n is string => typeof n === 'string' && n.trim().length > 0
    );
    if (namePool.length) profile.namePool = namePool;
  }
  if (input.respondTo) profile.respondTo = input.respondTo;
  if (Array.isArray(input.respondToAllowlist)) {
    const allow = input.respondToAllowlist.filter(
      (n): n is string => typeof n === 'string' && n.trim().length > 0
    );
    if (allow.length) profile.respondToAllowlist = allow;
  }
  if (!isAgentProfile(profile)) {
    throw new AgentProfileStoreError(400, 'agent_profile_invalid');
  }
  return profile;
}

/**
 * Map a UNIQUE-constraint failure onto a typed store error. Exported for tests:
 * the create() pre-check makes the partial-index branch reachable only under a
 * cross-process race, so it is exercised directly with the real SQLite messages.
 */
export function rethrowConstraint(err: unknown, providerId: string): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed: agent_profiles\./i.test(message)) {
    // SQLite names the COLUMN, not the index, in a UNIQUE violation message:
    //   two-defaults (partial unique index) -> "...agent_profiles.provider_id"
    //   id collision (primary key)          -> "...agent_profiles.id"
    // Distinguish on the column token so a raced second default maps to the
    // right code instead of being mis-reported as an id collision.
    if (/agent_profiles\.provider_id\b/i.test(message)) {
      throw new AgentProfileStoreError(
        409,
        'agent_profile_default_exists',
        `Provider "${providerId}" already has a default profile; use setDefault to change it.`
      );
    }
    throw new AgentProfileStoreError(409, 'agent_profile_id_exists');
  }
  throw err;
}

function rowToProfileSafe(row: AgentProfileRow): AgentProfile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.profile_json) as unknown;
  } catch {
    logger.warn('dropped agent profile %s: corrupt profile_json', row.id);
    return null;
  }
  // A blob is not allowed to carry the secret, but a legacy or hand-edited row
  // that does is CLEANED rather than dropped: dropping it would make the
  // profile vanish from the UI, and the point here is that the value never
  // leaves the store, not that the row is unusable.
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    AGENT_PROFILE_SECRET_KEY in (parsed as Record<string, unknown>)
  ) {
    delete (parsed as Record<string, unknown>)[AGENT_PROFILE_SECRET_KEY];
    logger.warn('stripped secret field from agent profile blob %s', row.id);
  }
  if (!isAgentProfile(parsed)) {
    logger.warn('dropped agent profile %s: failed validation', row.id);
    return null;
  }
  // Denormalized columns are the query source of truth; reconcile the blob so a
  // tampered blob can never disagree with its row on identity/default state.
  // `hermesApiKeySet` is derived from the column on every read for the same
  // reason: the blob never gets to assert secret state.
  const profile: AgentProfile = {
    ...parsed,
    id: row.id,
    providerId: row.provider_id,
    isDefault: row.is_default === 1,
    isBuiltIn: row.is_built_in === 1,
  };
  if (row.has_hermes_api_key === 1) profile.hermesApiKeySet = true;
  else delete profile.hermesApiKeySet;
  return profile;
}

// ── Migration runner (mirrors agent-presence-store.ts / context-packets.ts) ────
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
