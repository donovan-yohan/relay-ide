// View-spine data model (#444 Lane B): scaffold-only types + identity helpers.
// No wiring yet — Lane A migration, server CRUD, and frontend render in follow-ups.

export type WorkspaceId = string;
export type WorkspaceStatus = 'active' | 'archived';

export interface Workspace {
  id: WorkspaceId;
  name: string;
  status: WorkspaceStatus;
  // Ordering within the workspace bar. Lower comes first. Float so reorder
  // without renumber is feasible — same pattern as Bench/Tab follow-ups will use.
  order: number;
  // Project membership is stored as an ordered list of ProjectIds rather than
  // an embedded Project[] so a Project can be referenced from a View without
  // duplicating Workspace state.
  projectIds: string[];
  // Optional user-authored display/default metadata for the durable workspace
  // rail. These are intentionally nullable/optional so older rows deserialize
  // cleanly and free/non-git workspaces never have to pretend to be repos.
  pinned: boolean;
  color: string | null;
  icon: string | null;
  defaultRepoPath: string | null;
  defaultNodeId: string | null;
  defaultProvider: string | null;
  createdAt: string;
  updatedAt: string;
}

function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

export function createWorkspaceId(localId: string): WorkspaceId {
  if (!hasValue(localId)) throw new Error('localId is required');
  return `ws:${encodeURIComponent(localId)}`;
}

export function parseWorkspaceId(id: WorkspaceId): { localId: string } | null {
  if (!id.startsWith('ws:')) return null;
  try {
    const localId = decodeURIComponent(id.slice('ws:'.length));
    if (!hasValue(localId)) return null;
    return { localId };
  } catch {
    return null;
  }
}

// ── Local workspace identity (#1287 slice 2) ────────────────────────────────
// Every channel must carry a workspaceId that can actually equal a row in
// `ia_workspaces`, whose ids are minted exclusively by `createWorkspaceId`
// (grammar `ws:<localId>`). Before this, channel-create paths stamped free
// strings (`workspace:local` from the composer/DM builders, `ws:derived` from
// the derived read model) that no `ia_workspaces` id can ever equal, so the
// sidebar's workspace lookup was structurally always a miss and 100% of
// channels fell into the orphan lane. The hub now seeds one durable local
// workspace at `LOCAL_WORKSPACE_ID` and every create path normalizes into the
// grammar, falling back to that seed instead of a sentinel.

/** `localId` of the always-present, hub-seeded local workspace. */
export const LOCAL_WORKSPACE_LOCAL_ID = 'local';

/** Durable id of the hub-seeded local workspace. Always a real `ia_workspaces`
 *  row — see `server/local-workspace-seed.ts`. */
export const LOCAL_WORKSPACE_ID: WorkspaceId = createWorkspaceId(
  LOCAL_WORKSPACE_LOCAL_ID
);

/** Display name used when the local workspace is first seeded and the host
 *  name is unavailable. */
export const LOCAL_WORKSPACE_FALLBACK_NAME = 'Local';

/**
 * Legacy placeholder workspace ids written before the local workspace existed.
 * They are NOT `ws:<localId>` ids, so they can never match an `ia_workspaces`
 * row; both normalize to `LOCAL_WORKSPACE_ID`.
 */
export const LEGACY_WORKSPACE_ID_SENTINELS: readonly string[] = [
  'workspace:local',
  'ws:derived',
];

export function isLegacyWorkspaceIdSentinel(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    LEGACY_WORKSPACE_ID_SENTINELS.includes(value.trim())
  );
}

/**
 * True when `value` refers to the local workspace: nullish, a legacy sentinel,
 * or `LOCAL_WORKSPACE_ID` itself. Callers that must keep a derived id STABLE
 * across the sentinel retirement (e.g. DM channel ids) key off this rather than
 * off the raw string, so the pre- and post-migration values collapse together.
 */
export function isLocalWorkspaceRef(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  if (!hasValue(trimmed)) return true;
  return trimmed === LOCAL_WORKSPACE_ID || isLegacyWorkspaceIdSentinel(trimmed);
}

/**
 * Resolve a workspace reference to the id a channel should actually be stamped
 * with.
 *
 * - nullish / blank / legacy sentinel → `LOCAL_WORKSPACE_ID` (a REAL seeded
 *   `ia_workspaces` row), so a default create can never again produce an id the
 *   workspace rail is structurally unable to match;
 * - already `ws:<localId>` → verbatim;
 * - any other legacy free-form ref → verbatim.
 *
 * The last case is deliberate. Rows persisted before this change keep their
 * free-form `workspace_id` (the #1287 backfill retires the SENTINELS only), and
 * `GET /workspace-topics?workspaceId=…` filters on the stored string, so
 * re-encoding a caller-chosen ref here would split new channels away from the
 * existing rows that share it. Such refs stay visible in the sidebar's orphan
 * lane exactly as before — no worse, and no longer the default.
 */
export function normalizeWorkspaceId(
  raw: string | null | undefined
): WorkspaceId {
  if (isLocalWorkspaceRef(raw)) return LOCAL_WORKSPACE_ID;
  return (raw as string).trim();
}

/** True when `id` matches the `ws:<localId>` grammar `ia_workspaces` mints. */
export function isWorkspaceIdGrammar(id: string | null | undefined): boolean {
  return typeof id === 'string' && parseWorkspaceId(id.trim()) !== null;
}
