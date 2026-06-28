// #736 (Epic #444): one-time, idempotent BOOT migration of the legacy
// `config.workspaces` groupings into the new persisted IA Workspace entities
// (#737 `ia.db` / `ia_workspaces`). Today the six-layer view-spine tree
// client-derives its Workspace grouping from `config.workspaces`, and the new
// IA Workspace CRUD (#733) persists to `ia.db` but nothing populates it from
// legacy data. This migration bridges that gap so the persisted IA model has
// real grouping data carried over from the user's existing config.
//
// ── SAFETY CONTRACT (non-negotiable) ───────────────────────────────────────
// 1. NON-DESTRUCTIVE to legacy. We only READ `config.workspaces` (+ the local
//    `RepoInventoryReport`, itself derived from `config.repos`). We NEVER
//    modify or delete `config.workspaces`/`config.repos`. Legacy config stays
//    intact as the fallback (view-spine default OFF still uses the legacy
//    sidebar). The ONLY writes are to `ia.db` via the injected `IaStore`.
// 2. IDEMPOTENT. Re-running on every boot produces NO duplicates and NO data
//    loss. Two independent guards enforce this:
//      (a) a `migration_state` marker in `ia.db` (`MIGRATION_KEY`): once set,
//          the whole pass short-circuits to a no-op on subsequent boots; and
//      (b) deterministic, marker-prefixed Workspace ids + upsert-IF-ABSENT:
//          even with a missing/corrupt marker, each legacy workspace maps to a
//          STABLE id (`migrated:<legacyId>`), and we only WRITE that id if it
//          does not already exist — so a re-run never clobbers a workspace a
//          user later hand-edited, and never inserts a duplicate.
// 3. globalSessionId PRESERVED. This migration touches workspace GROUPINGS
//    only. It performs zero session/PTY work and cannot affect session
//    resolution or `globalSessionId`.
// 4. EMPTY / MISSING-CONFIG SAFE. No legacy workspaces (or none with resolvable
//    members) → clean no-op, marker still set, boots fine.
// 5. NON-CLOBBER of user-authored IA Workspaces. User-created workspaces (via
//    the #733 CRUD) mint random-UUID ids and never carry the `migrated:`
//    prefix, so a deterministic migrated id can never collide with one. The
//    upsert-if-absent guard additionally protects any workspace at a migrated
//    id from being overwritten on re-run.

import { createLogger } from './logger.js';
import { repoInstanceProjectId } from './features/ia-tree.js';
import type { IaStore } from './ia-store.js';
import type { Config } from './types.js';
import type { ProjectId } from '../shared/project.js';
import type { RepoInventoryReport } from '../shared/repo-inventory.js';
import { createWorkspaceId } from '../shared/workspace.js';

const logger = createLogger('ia-workspace-migration');

/** Marker key recorded in `ia_migration_state` once the migration has run. */
export const MIGRATION_KEY = 'legacy-workspaces->ia-workspaces';
/** Marker value: bumped only if a future re-migration is ever intended. */
const MIGRATION_VERSION = '1';

/** Prefix that distinguishes a migrated Workspace's deterministic local id from
 *  a user-created (random-UUID) one. Load-bearing for non-clobber. */
const MIGRATED_LOCAL_ID_PREFIX = 'migrated:';

/** Minimal legacy workspace shape this migration reads. Mirrors the subset of
 *  `server/types.ts` `Workspace` (`{id, name, repos, order}`) we need; extra
 *  fields are ignored. */
export interface LegacyWorkspaceInput {
  id: string;
  name: string;
  order: number;
  /** Member repo localPaths. Legacy/malformed entries may omit/mistype this. */
  repos?: unknown;
}

export interface MigrateLegacyWorkspacesInput {
  /** The IA persistence handle (#737). `null` → migration is skipped. */
  iaStore: IaStore | null;
  /** Legacy `config.workspaces` (read-only; never mutated). */
  legacyWorkspaces: LegacyWorkspaceInput[] | undefined | null;
  /** The LOCAL node's repo inventory report — same source `GET /hub/ia/tree`
   *  uses for the local node — so derived ProjectIds line up byte-for-byte. */
  localReport: RepoInventoryReport;
  /** Override the marker re-check (testing only). Default true. */
  honorMarker?: boolean;
}

export interface MigrateLegacyWorkspacesResult {
  /** Whether anything beyond marker bookkeeping happened. */
  ran: boolean;
  /** Why a run was skipped, if it was. */
  skippedReason?: 'no-store' | 'already-migrated';
  /** Count of migrated workspaces newly inserted this run. */
  inserted: number;
  /** Count of legacy workspaces skipped because a workspace already exists at
   *  their deterministic migrated id (non-clobber guard fired). */
  skippedExisting: number;
  /** Count of legacy workspaces that resolved to ZERO known projects (their
   *  member repos are not in the local inventory). Still migrated as an empty
   *  grouping so a rename survives; logged for visibility. */
  emptyMembership: number;
}

/** Deterministic IA WorkspaceId for a legacy workspace id. STABLE across boots:
 *  `createWorkspaceId('migrated:' + legacyId)` → `ws:migrated%3A<legacyId>`. */
export function migratedWorkspaceId(
  legacyId: string
): ReturnType<typeof createWorkspaceId> {
  return createWorkspaceId(`${MIGRATED_LOCAL_ID_PREFIX}${legacyId}`);
}

/**
 * Build the repo localPath → ProjectId map exactly as `buildIaTree` does, using
 * the SAME `repoInstanceProjectId` helper the tree route uses. Only the local
 * report is needed: legacy `config.workspaces[].repos` are local-node paths.
 */
function buildProjectIdByRepoPath(
  report: RepoInventoryReport
): Map<string, ProjectId> {
  const byPath = new Map<string, ProjectId>();
  for (const repo of report.repos) {
    byPath.set(repo.localPath, repoInstanceProjectId(repo));
  }
  return byPath;
}

/** Coerce a legacy `repos` field into a clean string[] (tolerates junk). */
function readRepoPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  );
}

/** A normalized, ready-to-upsert plan for one legacy workspace, or `null` when
 *  the legacy entry is too malformed to mint a deterministic id. */
interface MigrationPlan {
  legacyId: string;
  name: string;
  order: number;
  projectIds: ProjectId[];
}

/** Normalize one legacy workspace into a migration plan, mapping member repo
 *  localPaths → ProjectIds via the SAME `repoInstanceProjectId` logic the tree
 *  route uses (dedup repos sharing a git remote, exactly like `buildIaTree`). */
function planFor(
  ws: LegacyWorkspaceInput,
  projectIdByRepoPath: Map<string, ProjectId>
): MigrationPlan | null {
  if (!ws || typeof ws.id !== 'string' || ws.id.trim().length === 0) {
    // Malformed legacy entry (no usable id) — cannot mint a deterministic id.
    return null;
  }
  const name =
    typeof ws.name === 'string' && ws.name.trim().length > 0
      ? ws.name.trim()
      : ws.id;
  const order =
    typeof ws.order === 'number' && Number.isFinite(ws.order) ? ws.order : 0;

  const seen = new Set<ProjectId>();
  const projectIds: ProjectId[] = [];
  for (const repoPath of readRepoPaths(ws.repos)) {
    const projectId = projectIdByRepoPath.get(repoPath);
    if (!projectId) continue; // member repo not in local inventory → drop
    if (seen.has(projectId)) continue; // dedup repos sharing a git remote
    seen.add(projectId);
    projectIds.push(projectId);
  }
  return { legacyId: ws.id, name, order, projectIds };
}

/**
 * Run the legacy → IA Workspace migration. Pure of I/O beyond the injected
 * `IaStore` (which owns `ia.db`); does no git, no config writes, no session
 * work. Safe to call unconditionally at boot — see the SAFETY CONTRACT header.
 */
export function migrateLegacyWorkspaces(
  input: MigrateLegacyWorkspacesInput
): MigrateLegacyWorkspacesResult {
  const empty: MigrateLegacyWorkspacesResult = {
    ran: false,
    inserted: 0,
    skippedExisting: 0,
    emptyMembership: 0,
  };

  const { iaStore } = input;
  if (!iaStore) {
    return { ...empty, skippedReason: 'no-store' };
  }

  const honorMarker = input.honorMarker ?? true;
  if (honorMarker && iaStore.getMigrationState(MIGRATION_KEY) !== null) {
    // Already ran on a prior boot — pure no-op. We DO NOT re-scan legacy config
    // here, so a workspace a user later renamed via #733 CRUD is never touched.
    return { ...empty, skippedReason: 'already-migrated' };
  }

  const legacy = Array.isArray(input.legacyWorkspaces)
    ? input.legacyWorkspaces
    : [];
  const projectIdByRepoPath = buildProjectIdByRepoPath(input.localReport);

  let inserted = 0;
  let skippedExisting = 0;
  let emptyMembership = 0;

  for (const ws of legacy) {
    const plan = planFor(ws, projectIdByRepoPath);
    // Malformed legacy entry (no usable id) — skip without erroring. Legacy
    // config is untouched regardless.
    if (!plan) continue;
    if (plan.projectIds.length === 0) emptyMembership += 1;

    const id = migratedWorkspaceId(plan.legacyId);

    // Upsert-IF-ABSENT: only WRITE when no workspace already exists at this
    // deterministic id. This is the second idempotency/non-clobber guard,
    // independent of the marker: a re-run (or a marker that was lost) never
    // overwrites a migrated workspace the user may have since hand-edited, and
    // never produces a duplicate.
    if (iaStore.getWorkspace(id) !== null) {
      skippedExisting += 1;
      continue;
    }

    try {
      iaStore.upsertWorkspace({
        id,
        name: plan.name,
        order: plan.order,
        projectIds: plan.projectIds,
      });
      inserted += 1;
    } catch (err) {
      // A single bad workspace must not abort the whole migration. Log + skip;
      // legacy config remains the fallback for this group.
      logger.warn(
        'skipped migrating legacy workspace %s: %s',
        plan.legacyId,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Record the marker LAST, so a crash mid-run leaves the marker unset and the
  // next boot retries (the upsert-if-absent guard makes that retry safe).
  iaStore.setMigrationState(MIGRATION_KEY, MIGRATION_VERSION);

  if (inserted > 0 || skippedExisting > 0) {
    logger.info(
      'legacy→IA workspace migration: inserted=%d skippedExisting=%d emptyMembership=%d',
      inserted,
      skippedExisting,
      emptyMembership
    );
  }

  return {
    ran: true,
    inserted,
    skippedExisting,
    emptyMembership,
  };
}

export interface RunBootMigrationDeps {
  iaStore: IaStore | null;
  getConfig: () => Config;
  /** Collects the LOCAL node's repo inventory (same source `GET /hub/ia/tree`
   *  uses). Injected so boot can reuse its already-wired collector. */
  collectLocalRepoInventory: () => Promise<RepoInventoryReport>;
}

/**
 * Boot entry point: collect the local inventory, run the migration, and SWALLOW
 * any failure (log + continue). A migration failure must NEVER crash boot — the
 * legacy `config.workspaces` data stays intact. Kept here (not inline in
 * `index.ts`) so the boot path stays a single awaited statement.
 */
export async function runBootWorkspaceMigration(
  deps: RunBootMigrationDeps
): Promise<void> {
  if (!deps.iaStore) return;
  try {
    const localReport = await deps.collectLocalRepoInventory();
    migrateLegacyWorkspaces({
      iaStore: deps.iaStore,
      legacyWorkspaces: deps.getConfig().workspaces,
      localReport,
    });
  } catch (err) {
    logger.warn(
      'Legacy→IA workspace migration skipped (boot continues, config workspaces intact): %s',
      err instanceof Error ? err.message : err
    );
  }
}
