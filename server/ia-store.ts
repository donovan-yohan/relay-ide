// IA persistence substrate (#737 / BE-5). Stores the genuinely user-authored,
// non-derivable six-layer IA state: Workspace grouping (id/name/order/
// projectIds membership) and Bench overlays (envOverrides + label override +
// non-worktree benches). Project/Instance and git-worktree Bench facts are
// DERIVED from the cross-node inventory by `GET /hub/ia/tree` and are NOT
// persisted here.
//
// STRICTLY NON-DESTRUCTIVE: this module owns its own SQLite file (`ia.db`) and
// creates only new tables. It never reads or mutates `config.json`,
// `config.repos`, `config.workspaces`, or any existing DB/table. Migration of
// legacy state into these tables is out of scope (#736), explicitly gated.
//
// Mirrors the self-contained store pattern of `server/work-contexts.ts`:
// per-store DB file, a `schema_version` table, a version-gated migration run
// inside a transaction, and an `init*(configDir)` / `create*(dbPath)` factory
// split so the store is trivially unit-testable.

import path from 'node:path';

import Database from 'better-sqlite3';

import { createLogger } from './logger.js';
import type { Workspace, WorkspaceId } from '../shared/workspace.js';
import { parseWorkspaceId } from '../shared/workspace.js';
import type { BenchId } from '../shared/bench.js';
import { parseBenchId } from '../shared/bench.js';
import type { InstanceId } from '../shared/project.js';

const logger = createLogger('ia-store');

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS ia_workspaces (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  sort_order   REAL NOT NULL,
  project_ids_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ia_workspaces_order
  ON ia_workspaces(sort_order ASC);

CREATE TABLE IF NOT EXISTS ia_bench_overlays (
  id              TEXT PRIMARY KEY,
  instance_id     TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  label           TEXT,
  env_overrides_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ia_bench_overlays_instance
  ON ia_bench_overlays(instance_id);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
];

interface WorkspaceRow {
  id: string;
  name: string;
  sort_order: number;
  project_ids_json: string;
  created_at: string;
  updated_at: string;
}

interface BenchOverlayRow {
  id: string;
  instance_id: string;
  cwd: string;
  label: string | null;
  env_overrides_json: string;
  created_at: string;
  updated_at: string;
}

/** Input for upserting a Workspace. `id` must be a `shared/workspace` encoded
 *  WorkspaceId (`ws:...`). Timestamps are managed by the store. */
export interface WorkspaceUpsertInput {
  id: WorkspaceId;
  name: string;
  order: number;
  projectIds: string[];
}

/** Persisted Bench overlay: the sparse, user-authored layer on top of the
 *  DERIVED bench. `envOverrides` is the primary reason this exists; `label` is
 *  an optional display override (null = fall back to the derived label). */
export interface BenchOverlayUpsertInput {
  id: BenchId;
  envOverrides: Record<string, string>;
  /** Optional label override. `undefined`/`null` means "use derived label". */
  label?: string | null;
}

/** Persisted Bench overlay row, shaped for consumers. */
export interface BenchOverlay {
  id: BenchId;
  instanceId: InstanceId;
  cwd: string;
  label: string | null;
  envOverrides: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface IaStore {
  close(): void;

  // ── Workspace ────────────────────────────────────────────────────────────
  /** All workspaces, ordered by `order` ascending then id for stability. */
  listWorkspaces(): Workspace[];
  getWorkspace(id: WorkspaceId): Workspace | null;
  /** Insert or update a workspace. Preserves `createdAt` on update. */
  upsertWorkspace(input: WorkspaceUpsertInput): Workspace;
  deleteWorkspace(id: WorkspaceId): boolean;

  // ── Bench overlay ──────────────────────────────────────────────────────
  /** All bench overlays. */
  listBenchOverlays(): BenchOverlay[];
  getBenchOverlay(id: BenchId): BenchOverlay | null;
  /** Insert or update a bench overlay. Preserves `createdAt` on update. */
  upsertBenchOverlay(input: BenchOverlayUpsertInput): BenchOverlay;
  deleteBenchOverlay(id: BenchId): boolean;
}

export class IaStoreError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = 'IaStoreError';
    this.code = code;
  }
}

/** Boot entry point: opens (and migrates) the IA store DB under `configDir`. */
export function initIaStore(configDir: string): IaStore {
  return createIaStore(path.join(configDir, 'ia.db'));
}

/** Factory taking an explicit DB path. Used directly by unit tests. */
export function createIaStore(dbPath: string): IaStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  runMigrations(db);

  const selectWorkspace = db.prepare(
    `SELECT id, name, sort_order, project_ids_json, created_at, updated_at
     FROM ia_workspaces WHERE id = ?`
  );
  const selectAllWorkspaces = db.prepare(
    `SELECT id, name, sort_order, project_ids_json, created_at, updated_at
     FROM ia_workspaces ORDER BY sort_order ASC, id ASC`
  );
  const upsertWorkspaceStmt = db.prepare(
    `INSERT INTO ia_workspaces (
       id, name, sort_order, project_ids_json, created_at, updated_at
     ) VALUES (@id, @name, @order, @projectIdsJson, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name             = excluded.name,
       sort_order       = excluded.sort_order,
       project_ids_json = excluded.project_ids_json,
       updated_at       = excluded.updated_at`
  );
  const deleteWorkspaceStmt = db.prepare(
    'DELETE FROM ia_workspaces WHERE id = ?'
  );

  const selectBenchOverlay = db.prepare(
    `SELECT id, instance_id, cwd, label, env_overrides_json, created_at, updated_at
     FROM ia_bench_overlays WHERE id = ?`
  );
  const selectAllBenchOverlays = db.prepare(
    `SELECT id, instance_id, cwd, label, env_overrides_json, created_at, updated_at
     FROM ia_bench_overlays ORDER BY id ASC`
  );
  const upsertBenchOverlayStmt = db.prepare(
    `INSERT INTO ia_bench_overlays (
       id, instance_id, cwd, label, env_overrides_json, created_at, updated_at
     ) VALUES (
       @id, @instanceId, @cwd, @label, @envOverridesJson, @createdAt, @updatedAt
     )
     ON CONFLICT(id) DO UPDATE SET
       label              = excluded.label,
       env_overrides_json = excluded.env_overrides_json,
       updated_at         = excluded.updated_at`
  );
  const deleteBenchOverlayStmt = db.prepare(
    'DELETE FROM ia_bench_overlays WHERE id = ?'
  );

  function getWorkspaceById(id: WorkspaceId): Workspace | null {
    const row = selectWorkspace.get(id) as WorkspaceRow | undefined;
    return row ? rowToWorkspace(row) : null;
  }

  function getBenchOverlayById(id: BenchId): BenchOverlay | null {
    const row = selectBenchOverlay.get(id) as BenchOverlayRow | undefined;
    return row ? rowToBenchOverlay(row) : null;
  }

  return {
    close() {
      db.close();
    },

    listWorkspaces() {
      return (selectAllWorkspaces.all() as WorkspaceRow[])
        .map(rowToWorkspaceSafe)
        .filter((ws): ws is Workspace => ws !== null);
    },

    getWorkspace: getWorkspaceById,

    upsertWorkspace(input: WorkspaceUpsertInput) {
      if (!parseWorkspaceId(input.id)) {
        throw new IaStoreError('invalid_workspace_id');
      }
      if (typeof input.name !== 'string' || input.name.trim().length === 0) {
        throw new IaStoreError('workspace_name_required');
      }
      if (!Number.isFinite(input.order)) {
        throw new IaStoreError('workspace_order_invalid');
      }
      const projectIds = normalizeProjectIds(input.projectIds);
      const now = new Date().toISOString();
      const existing = getWorkspaceById(input.id);
      const createdAt = existing?.createdAt ?? now;
      upsertWorkspaceStmt.run({
        id: input.id,
        name: input.name,
        order: input.order,
        projectIdsJson: JSON.stringify(projectIds),
        createdAt,
        updatedAt: now,
      });
      const written = getWorkspaceById(input.id);
      if (!written) throw new IaStoreError('workspace_write_failed');
      return written;
    },

    deleteWorkspace(id: WorkspaceId) {
      const info = deleteWorkspaceStmt.run(id);
      return info.changes > 0;
    },

    listBenchOverlays() {
      return (selectAllBenchOverlays.all() as BenchOverlayRow[])
        .map(rowToBenchOverlaySafe)
        .filter((overlay): overlay is BenchOverlay => overlay !== null);
    },

    getBenchOverlay: getBenchOverlayById,

    upsertBenchOverlay(input: BenchOverlayUpsertInput) {
      const parsed = parseBenchId(input.id);
      if (!parsed) {
        throw new IaStoreError('invalid_bench_id');
      }
      const envOverrides = normalizeEnvOverrides(input.envOverrides);
      const label =
        input.label === undefined || input.label === null
          ? null
          : String(input.label);
      const now = new Date().toISOString();
      const existing = getBenchOverlayById(input.id);
      const createdAt = existing?.createdAt ?? now;
      upsertBenchOverlayStmt.run({
        id: input.id,
        instanceId: parsed.instanceId,
        cwd: parsed.cwd,
        label,
        envOverridesJson: JSON.stringify(envOverrides),
        createdAt,
        updatedAt: now,
      });
      const written = getBenchOverlayById(input.id);
      if (!written) throw new IaStoreError('bench_overlay_write_failed');
      return written;
    },

    deleteBenchOverlay(id: BenchId) {
      const info = deleteBenchOverlayStmt.run(id);
      return info.changes > 0;
    },
  };
}

// ── Migration runner ─────────────────────────────────────────────────────
// Idempotent: a fresh DB and an already-migrated DB both end at the latest
// MIGRATIONS version with no error. Safe on an existing DB that has no IA
// tables (CREATE ... IF NOT EXISTS + version gate). Bump by appending a new
// {version, sql} entry to MIGRATIONS. Mirrors the runner in work-contexts.ts.
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

// ── Row mapping ────────────────────────────────────────────────────────────

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    order: row.sort_order,
    projectIds: parseStringArray(row.project_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWorkspaceSafe(row: WorkspaceRow): Workspace | null {
  try {
    return rowToWorkspace(row);
  } catch (err) {
    logger.warn('failed to map workspace row %s: %s', row.id, err);
    return null;
  }
}

function rowToBenchOverlay(row: BenchOverlayRow): BenchOverlay {
  return {
    id: row.id,
    instanceId: row.instance_id,
    cwd: row.cwd,
    label: row.label,
    envOverrides: parseStringRecord(row.env_overrides_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBenchOverlaySafe(row: BenchOverlayRow): BenchOverlay | null {
  try {
    return rowToBenchOverlay(row);
  } catch (err) {
    logger.warn('failed to map bench overlay row %s: %s', row.id, err);
    return null;
  }
}

// ── Input normalization ────────────────────────────────────────────────────

function normalizeProjectIds(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (id): id is string => typeof id === 'string' && id.length > 0
  );
}

function normalizeEnvOverrides(
  value: Record<string, string> | undefined
): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (typeof raw !== 'string') continue;
    out[key] = raw;
  }
  return out;
}

function parseStringArray(json: string): string[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === 'string');
}

function parseStringRecord(json: string): Record<string, string> {
  const parsed = JSON.parse(json) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
