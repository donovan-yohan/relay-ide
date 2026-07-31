// #1287 slice 2 (workspace identity spine): adding a project must also create
// the `ia_workspaces` row that renders it as a sidebar lane.
//
// The defect this closes: `POST /workspaces/bulk` registered the path in
// `config.repos` / `config.repoSettings` and NOTHING else. `ia_workspaces` was
// written only by the one-shot, marker-guarded boot migration
// (`ia-workspace-migration.ts`) and by an HTTP CRUD with zero frontend callers,
// so after first boot the workspace-group lane was unpopulatable on every
// install — add-project could never produce a lane.
//
// ── SAFETY CONTRACT ────────────────────────────────────────────────────────
// 1. IDEMPOTENT BY LOOKUP, NOT BY MARKER. The workspace id is derived purely
//    from the resolved local path, so re-adding the same repo resolves to the
//    SAME row. Re-add reuses that row instead of erroring or duplicating.
// 2. NON-CLOBBER. An existing row is returned as-is: a user who renamed,
//    recolored, pinned, reordered, or archived their project lane keeps every
//    edit. The single exception is MEMBERSHIP, which is additive only — a
//    missing ProjectId is appended, none are ever removed.
// 3. PATH-KEYED, NOT REMOTE-KEYED. `localId` is `project:<resolvedPath>` rather
//    than the ProjectId, because a ProjectId for a git repo is keyed on the git
//    REMOTE: adding a remote later would change it and mint a second lane for
//    the same directory. The path never changes under us.
// 4. WRITES ONLY `ia.db`. No config writes, no session/PTY work, and — per
//    `docs/LEARNINGS.md` L-20260729-topic-id-title-slug — no topic-id mutation
//    of any kind.

import path from 'node:path';

import { createLogger } from './logger.js';
import { repoInstanceProjectId } from './features/ia-tree.js';
import type { IaStore } from './ia-store.js';
import type { NodeId, RepoIdentity } from '../shared/identity.js';
import { createRepoInstanceId } from '../shared/identity.js';
import type { ProjectId } from '../shared/project.js';
import type { Workspace, WorkspaceId } from '../shared/workspace.js';
import { createWorkspaceId } from '../shared/workspace.js';

const logger = createLogger('project-workspace');

/** Prefix that distinguishes an add-project workspace's deterministic local id
 *  from the hub-seeded local one (`local`) and from a migrated one
 *  (`migrated:<legacyId>`) or a user-created random UUID. */
const PROJECT_LOCAL_ID_PREFIX = 'project:';

/** Deterministic IA WorkspaceId for an added project directory. STABLE for the
 *  lifetime of the path: `ws:project%3A%2Fhome%2Fme%2Frepo`. */
export function projectWorkspaceId(resolvedPath: string): WorkspaceId {
  return createWorkspaceId(`${PROJECT_LOCAL_ID_PREFIX}${resolvedPath}`);
}

/** The subset of an added repo this module needs to derive a ProjectId. */
export interface ProjectWorkspaceRepoRef {
  localPath: string;
  nodeId: NodeId;
  isGitRepo: boolean;
  repoIdentity: RepoIdentity | null;
}

/**
 * Map an added repo to the ProjectId `GET /hub/ia/tree` emits for it, by
 * routing through the SAME `repoInstanceProjectId` helper the tree route and
 * the #736 migration use. Reusing it is load-bearing: any other derivation
 * would persist membership that points at nothing.
 *
 * The fields `repoInstanceProjectId` does not read (branches, remotes,
 * warnings, worktrees, `reportedAt`) are filled with neutral values — the
 * mapping only looks at `isGitRepo`, `repoIdentity`, `nodeId`, and `localPath`,
 * and is documented PURE, so no clock is consulted for the unread stamp.
 */
export function projectIdForRepo(repo: ProjectWorkspaceRepoRef): ProjectId {
  return repoInstanceProjectId({
    repoInstanceId: createRepoInstanceId(repo.nodeId, repo.localPath),
    nodeId: repo.nodeId,
    localPath: repo.localPath,
    name: path.basename(repo.localPath),
    isGitRepo: repo.isGitRepo,
    defaultBranch: null,
    currentBranch: null,
    repoIdentity: repo.repoIdentity,
    selectedRemote: null,
    remotes: [],
    repoIdentityWarnings: [],
    worktrees: [],
    reportedAt: '',
  });
}

/** Display name for a freshly seeded project lane: the directory basename,
 *  falling back to the raw path when a trailing separator leaves it blank. */
export function projectWorkspaceName(resolvedPath: string): string {
  const base = path.basename(resolvedPath).trim();
  return (base || resolvedPath).slice(0, 64) || resolvedPath;
}

/** Next ordering slot: after every known workspace, never negative (the
 *  hub-seeded local lane sits at -1 and must stay first). */
function nextOrder(iaStore: IaStore): number {
  const all = iaStore.listWorkspaces({ includeArchived: true });
  let max = -1;
  for (const ws of all) {
    if (Number.isFinite(ws.order) && ws.order > max) max = ws.order;
  }
  return max + 1;
}

export interface EnsureProjectWorkspaceInput {
  /** The IA persistence handle (#737). `null` → no-op. */
  iaStore: IaStore | null;
  /** Resolved, absolute local path of the added project. */
  resolvedPath: string;
  /** ProjectId to file under this lane. Omitted on paths where deriving it
   *  would cost git work we do not want to pay (e.g. a duplicate re-add). */
  projectId?: ProjectId;
}

export interface EnsureProjectWorkspaceResult {
  workspace: Workspace;
  /** False when an existing row was reused (re-add / duplicate add). */
  created: boolean;
}

/**
 * Create the workspace lane for an added project, or reuse the existing one.
 * Returns `null` only when there is no store. Safe to call on every add,
 * including re-adds of an already-registered path.
 */
export function ensureProjectWorkspace(
  input: EnsureProjectWorkspaceInput
): EnsureProjectWorkspaceResult | null {
  const { iaStore, resolvedPath, projectId } = input;
  if (!iaStore) return null;

  const id = projectWorkspaceId(resolvedPath);
  const existing = iaStore.getWorkspace(id);

  if (existing) {
    // Non-clobber: reuse the row verbatim. The ONE additive exception is
    // membership — a lane whose project is missing (row seeded by a duplicate
    // add, which skips ProjectId derivation) gets it appended.
    if (!projectId || existing.projectIds.includes(projectId)) {
      return { workspace: existing, created: false };
    }
    const workspace = iaStore.upsertWorkspace({
      id,
      name: existing.name,
      order: existing.order,
      projectIds: [...existing.projectIds, projectId],
      status: existing.status,
      pinned: existing.pinned,
      color: existing.color,
      icon: existing.icon,
      defaultRepoPath: existing.defaultRepoPath,
      defaultNodeId: existing.defaultNodeId,
      defaultProvider: existing.defaultProvider,
    });
    return { workspace, created: false };
  }

  const workspace = iaStore.upsertWorkspace({
    id,
    name: projectWorkspaceName(resolvedPath),
    order: nextOrder(iaStore),
    projectIds: projectId ? [projectId] : [],
    defaultRepoPath: resolvedPath,
  });
  return { workspace, created: true };
}

/**
 * `ensureProjectWorkspace` with failures SWALLOWED (log + return null). A
 * degraded IA store must never turn a successful add-project into an HTTP
 * failure — worst case the lane is missing exactly as it was before #1287.
 */
export function ensureProjectWorkspaceBestEffort(
  input: EnsureProjectWorkspaceInput
): EnsureProjectWorkspaceResult | null {
  try {
    return ensureProjectWorkspace(input);
  } catch (err) {
    logger.warn(
      'Project workspace lane not created for %s (add still succeeded): %s',
      input.resolvedPath,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
