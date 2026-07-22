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
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  builtInAgentProfileId,
  isAgentProfile,
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

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
];

interface AgentProfileRow {
  id: string;
  provider_id: string;
  is_default: number;
  is_built_in: number;
  profile_json: string;
  created_at: string;
  updated_at: string;
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
  namePool?: string[];
  respondTo?: AgentProfileRespondTo;
  respondToAllowlist?: string[];
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
  get(id: string): AgentProfile | null;
  list(filter?: { providerId?: string }): AgentProfile[];
  getDefaultForProvider(providerId: string): AgentProfile | null;
  /** Atomically make `profileId` the sole default for its providerId. */
  setDefault(profileId: string): AgentProfile;
  delete(id: string): boolean;
  /**
   * Seed exactly one `isBuiltIn`+`isDefault` profile per configured framework.
   * Idempotent: re-running neither duplicates nor flips existing rows.
   * Returns the number of NEW built-in default rows inserted.
   */
  seedBuiltIns(frameworks: readonly SeedFramework[]): number;
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
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);

  const selectById = db.prepare(
    `SELECT id, provider_id, is_default, is_built_in, profile_json, created_at, updated_at
     FROM agent_profiles WHERE id = ?`
  );
  const selectDefaultForProvider = db.prepare(
    `SELECT id, provider_id, is_default, is_built_in, profile_json, created_at, updated_at
     FROM agent_profiles WHERE provider_id = ? AND is_default = 1`
  );
  const insert = db.prepare(
    `INSERT INTO agent_profiles (
       id, provider_id, is_default, is_built_in, profile_json, created_at, updated_at
     ) VALUES (
       @id, @providerId, @isDefault, @isBuiltIn, @profileJson, @createdAt, @updatedAt
     )`
  );
  const insertIgnore = db.prepare(
    `INSERT OR IGNORE INTO agent_profiles (
       id, provider_id, is_default, is_built_in, profile_json, created_at, updated_at
     ) VALUES (
       @id, @providerId, @isDefault, @isBuiltIn, @profileJson, @createdAt, @updatedAt
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
  const deleteById = db.prepare('DELETE FROM agent_profiles WHERE id = ?');

  function persist(row: {
    id: string;
    providerId: string;
    isDefault: number;
    isBuiltIn: number;
    profile: AgentProfile;
    createdAt: string;
    updatedAt: string;
  }): void {
    try {
      insert.run({
        id: row.id,
        providerId: row.providerId,
        isDefault: row.isDefault,
        isBuiltIn: row.isBuiltIn,
        profileJson: JSON.stringify(row.profile),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
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
      const nowIso = new Date().toISOString();
      persist({
        id,
        providerId,
        isDefault: isDefault ? 1 : 0,
        isBuiltIn: profile.isBuiltIn ? 1 : 0,
        profile,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
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
        `SELECT id, provider_id, is_default, is_built_in, profile_json, created_at, updated_at
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
              JSON.stringify({ ...currentProfile, isDefault: false }),
              nowIso,
              current.id
            );
          }
        }
        setDefaultRow.run(
          JSON.stringify({ ...target, isDefault: true }),
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
      return deleteById.run(id).changes > 0;
    },

    seedBuiltIns(frameworks: readonly SeedFramework[]): number {
      let inserted = 0;
      const seed = db.transaction(() => {
        const nowIso = new Date().toISOString();
        for (const framework of frameworks) {
          const providerId = readTrimmed(framework.id);
          if (!providerId) continue;
          const id = builtInAgentProfileId(providerId);
          // Thin overlay: empty displayName = "inherit vendor label from catalog".
          const profile: AgentProfile = {
            id,
            providerId,
            displayName: '',
            avatar: null,
            isDefault: true,
            isBuiltIn: true,
          };
          // Idempotent by stable PK: OR IGNORE never duplicates or flips an
          // existing row (built-in or user-created). If some other profile is
          // already the vendor default, the partial unique index would reject a
          // second default — so pre-check and skip to stay non-destructive.
          if (selectDefaultForProvider.get(providerId)) continue;
          const changes = insertIgnore.run({
            id,
            providerId,
            isDefault: 1,
            isBuiltIn: 1,
            profileJson: JSON.stringify(profile),
            createdAt: nowIso,
            updatedAt: nowIso,
          }).changes;
          inserted += changes;
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
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function rethrowConstraint(err: unknown, providerId: string): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed: agent_profiles\b/i.test(message)) {
    if (/idx_agent_profiles_one_default/i.test(message)) {
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
  if (!isAgentProfile(parsed)) {
    logger.warn('dropped agent profile %s: failed validation', row.id);
    return null;
  }
  // Denormalized columns are the query source of truth; reconcile the blob so a
  // tampered blob can never disagree with its row on identity/default state.
  return {
    ...parsed,
    id: row.id,
    providerId: row.provider_id,
    isDefault: row.is_default === 1,
    isBuiltIn: row.is_built_in === 1,
  };
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
