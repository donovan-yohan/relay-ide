// #729 (Epic #444 view-spine MVP, Lane B): client-derived, READ-ONLY tree over
// data already in the stores. ZERO new persistence, ZERO new server calls — a
// pure projection of `repos`/`worktrees`/`sessions`/`workspaceGroups` joined
// with the `/nodes` projection. Sibling of `sidebar-items.ts`; the original is
// NOT modified. First production use of the `shared/project.ts`,
// `shared/bench.ts`, `shared/workspace.ts` identity helpers.
//
// Layer mapping (View → Workspace → Project → Instance → Bench → Tab):
//   Repo                → Project   (git: keyed on REMOTE identity; non-git:
//                                     directory-project fallback keyed on
//                                     node + path). Same remote across nodes =
//                                     ONE Project, multiple Instances.
//   (Project, nodeId)   → Instance  (host label: local = `this host`, remote =
//                                     node displayName; online/stale join).
//   WorktreeInfo        → Bench      (createBenchId(instanceId, path)).
//   SessionSummary[]    → Tab LEAVES (+ count) grouped under
//                                     (nodeId, worktreePath ?? cwd). #739 makes
//                                     the leaf layer interactive: individual Tabs
//                                     are selectable rows and per-tab attention
//                                     bubbles up Bench → Instance → Project.
//   Workspace {repos[]} → Workspace grouping (repo paths → projects).
//   repoPath-less sess. → SEPARATE free/remote lane (NOT nested under a repo).

import {
  DEFAULT_LOCAL_NODE_ID,
  type NodeId,
  type RepoIdentity,
} from '../../../../shared/identity.js';
import {
  createDirectoryProjectId,
  createInstanceId,
  createProjectId,
  type InstanceId,
  type ProjectId,
  type ProjectIdentity,
} from '../../../../shared/project.js';
import { createBenchId, type BenchId } from '../../../../shared/bench.js';
import {
  createWorkspaceId,
  type WorkspaceId,
} from '../../../../shared/workspace.js';
import type { HubNodeStatus } from '../../../../shared/relay-node-protocol.js';
import type {
  Repo,
  SessionSummary,
  Workspace,
  WorktreeInfo,
} from '../types.js';
import type { DisplayState } from './display-state.js';
import { isAttentionState } from './display-state.js';
import { highestPriorityState } from './attention.js';
import { scopedSessionKey } from '../session-keys.js';

/** Subset of `HubNodeSummary` the projection needs. Keeps the adapter testable
 *  without constructing a full manifest summary. */
export interface ViewTreeNodeStatus {
  nodeId: NodeId;
  displayName?: string;
  status: HubNodeStatus;
  lastSeenAt?: string;
}

/** Online/stale presence for an Instance's host, joined from `/nodes`.
 *  `null` when the project-type does not imply a host (and the dot is omitted). */
export type InstanceHostStatus = HubNodeStatus | null;

/** #739: an individual Tab (session) leaf — an interactive, selectable row.
 *  `selectKey` is the SAME scoped session key the legacy sidebar selects on
 *  (`scopedSessionKey`), so the leaf click reuses the existing active-session
 *  action verbatim. `state` is the per-tab lifecycle glyph for `SessionIndicator`,
 *  derived purely from the `SessionSummary` (no store reconciliation). */
export interface ViewTreeTabLeaf {
  /** Stable React key + dedup identity (scoped session key). */
  selectKey: string;
  /** Display label: session displayName, else its repo/cwd basename. */
  label: string;
  /** Branch this tab runs on, when known (git benches only). */
  branch: string | null;
  /** Per-tab lifecycle state for the `SessionIndicator` glyph. */
  state: DisplayState;
  /** Whether this tab needs attention (drives the bubble rollup). */
  attention: boolean;
  /** Tab activity (ISO), `null` when unknown. */
  lastActivity: string | null;
}

/** Per-tab attention rolled up to a node of the tree. `state` is the
 *  highest-priority attention state among descendant tabs (null = none in an
 *  attention state); `count` is how many descendant tabs need attention. Mirrors
 *  the legacy `.repo-attention-badge` anatomy (`SessionIndicator` + count). */
export interface ViewTreeAttention {
  /** Highest-priority attention state among descendants, or null when none. */
  state: DisplayState | null;
  /** Number of descendant tabs in an attention state. */
  count: number;
}

export interface ViewTreeTab {
  /** Count of tabs grouped here (kept for the count badge). */
  count: number;
  /** #739: the individual Tabs, as selectable leaves. */
  leaves: ViewTreeTabLeaf[];
}

export interface ViewTreeBench {
  id: BenchId;
  /** Anchored cwd/worktree path. */
  path: string;
  /** Configured PARENT repo path this bench belongs to — the value the backend
   *  validates against `config.repos` for an agent session (#731). Mirrors what
   *  the dialog sends as `environment.repoPath`. `null` for non-git/directory
   *  benches, which have no agent-capable repo anchor. */
  repoPath: string | null;
  /** Last path segment, for the `.session-name` label. */
  label: string;
  /** Branch name — present ONLY for git benches; omit element otherwise. */
  branch: string | null;
  /** Whether this bench's host is a git repo (drives `.secondary-branch`). */
  isGit: boolean;
  /** Tab count + leaves grouped under this bench-equivalent. */
  tab: ViewTreeTab;
  /** #739: per-tab attention rolled up to this bench (highest state + count). */
  attention: ViewTreeAttention;
  /** Most-recent session/worktree activity rolled up here (ISO). `null` when no
   *  recency is known. Drives the `recent` lens; derived during build, NOT a
   *  new fetch. */
  lastActivity: string | null;
}

export interface ViewTreeInstance {
  id: InstanceId;
  nodeId: NodeId;
  /** `this host` for local; node displayName (fallback nodeId) for remote. */
  hostLabel: string;
  isLocal: boolean;
  /** Online/stale presence; null when project-type has no host. */
  status: InstanceHostStatus;
  benches: ViewTreeBench[];
  /** Tab count + leaves at the instance root (sessions anchored to the repo, no
   *  worktree). */
  rootTab: ViewTreeTab;
  /** #739: per-tab attention rolled up across this instance's benches + root
   *  tabs (highest state + total count). */
  attention: ViewTreeAttention;
  /** Max activity across this instance's benches + root sessions (ISO), `null`
   *  when unknown. Rolls up into the project's recency. */
  lastActivity: string | null;
}

export type ViewTreeProjectKind = 'repo' | 'directory';

export interface ViewTreeProject {
  id: ProjectId;
  identity: ProjectIdentity;
  kind: ViewTreeProjectKind;
  /** Display label: repo name / directory basename. */
  label: string;
  /** Color seed (repo/dir name). `.initial-block` color uses this. */
  colorSeed: string;
  instances: ViewTreeInstance[];
  /** #739: per-tab attention rolled up across all of this project's instances
   *  (highest state + total count). Drives the project-level attention badge. */
  attention: ViewTreeAttention;
  /** Max activity across all of this project's instances (ISO), `null` when
   *  unknown. Drives the `recent` lens ordering of projects. */
  lastActivity: string | null;
}

export interface ViewTreeWorkspaceGroup {
  id: WorkspaceId;
  name: string;
  order: number;
  projects: ViewTreeProject[];
}

/** A repoPath-less session, surfaced in the free/remote lane. Carries NO
 *  branch and NO repo-identity fields by construction (leak regression C2). */
export interface ViewTreeFreeEntry {
  /** Stable key for React, derived from node + cwd. NOT a project/instance id. */
  key: string;
  nodeId: NodeId;
  hostLabel: string;
  isLocal: boolean;
  status: InstanceHostStatus;
  /** Anchored cwd for the free session group. */
  cwd: string;
  /** Last cwd segment for the row label. */
  label: string;
  /** Tab count + leaves grouped under (nodeId, cwd). */
  tab: ViewTreeTab;
  /** #739: per-tab attention rolled up for this free group (highest + count). */
  attention: ViewTreeAttention;
  /** Most-recent session activity for this free group (ISO), `null` when
   *  unknown. Drives the `recent` lens ordering of the free lane. */
  lastActivity: string | null;
}

export interface ViewTree {
  /** Workspace-grouped projects (legacy `Workspace.repos[]`). */
  workspaces: ViewTreeWorkspaceGroup[];
  /** Projects not a member of any workspace group. */
  ungroupedProjects: ViewTreeProject[];
  /** repoPath-less sessions, separate top-level lane. */
  freeLane: ViewTreeFreeEntry[];
}

export interface BuildViewTreeInput {
  repos: Repo[];
  worktrees: WorktreeInfo[];
  sessions: SessionSummary[];
  workspaceGroups: Workspace[];
  /** `/nodes` projection (HubNodeSummary[] subset). */
  nodes: ViewTreeNodeStatus[];
}

function nodeIdOf(value: { nodeId?: NodeId } | undefined): NodeId {
  // Local-mode rows omit nodeId; treat as the default local node.
  return value?.nodeId ?? DEFAULT_LOCAL_NODE_ID;
}

/** Pick the later of two ISO timestamps. `null` is "no activity known" and
 *  always loses to a real value. Lexicographic compare is correct for ISO-8601
 *  with a fixed offset (the summaries use UTC `Z`). */
function maxActivity(
  a: string | null | undefined,
  b: string | null | undefined
): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const seg = trimmed.split('/').pop();
  return seg && seg.length > 0 ? seg : path;
}

// ── #739: per-tab lifecycle state + attention rollup (PURE) ───────────────────
// A Tab leaf's glyph is derived straight from its `SessionSummary` — NO store
// reconciliation (the read-only tree owns no seen/unseen memory). This mirrors
// `sidebar-items.ts#sessionToBackendState` + `initialDisplayState` collapsed into
// one mapping so an individual session maps to a `SessionIndicator` state. The
// only divergence from the legacy per-GROUP reconciled state: an idle tab shows
// `seen-idle` (no unseen memory), so the read-only tree never invents an
// attention bubble the sidebar wouldn't also raise on its first paint.

/** Map a single session to its `SessionIndicator` lifecycle state, purely. */
function sessionDisplayState(session: SessionSummary): DisplayState {
  const { agentState, idle, permissionType, createdAt } = session;
  if (agentState === 'permission-prompt') {
    return permissionType === 'question' ? 'needs-answer' : 'permission';
  }
  if (agentState === 'error') return 'error';
  if (agentState === 'processing') return 'running';
  if (agentState === 'initializing') return 'initializing';
  // Brand-new sessions without a defined agentState read as initializing (not
  // running) to avoid flashing an active glyph at 0s — same guard as the sidebar.
  const isVeryNew = createdAt
    ? Date.now() - new Date(createdAt).getTime() < 30_000
    : false;
  if (!agentState && !idle && isVeryNew) return 'initializing';
  if (!agentState && !idle) return 'running';
  // Idle: no unseen memory in the read-only tree → seen-idle (non-attention).
  return 'seen-idle';
}

/** Build the interactive Tab leaf for a session. Label/branch presentation
 *  matches the legacy sidebar (displayName, then cwd basename). */
function tabLeafFor(
  session: SessionSummary,
  isGit: boolean
): ViewTreeTabLeaf {
  const state = sessionDisplayState(session);
  return {
    selectKey: scopedSessionKey(session),
    label: session.displayName || basename(session.cwd),
    // Branch only surfaces for git benches — mirrors the bench-level guard so a
    // directory/free tab never leaks a branch.
    branch: isGit ? (session.branchName || null) : null,
    state,
    attention: isAttentionState(state),
    lastActivity: session.lastActivity || null,
  };
}

/** Roll a flat list of tab leaves up into an attention summary: highest-priority
 *  attention state among them + the count of attention tabs. PURE. */
function rollUpAttention(leaves: ViewTreeTabLeaf[]): ViewTreeAttention {
  const attentionStates = leaves
    .filter((leaf) => leaf.attention)
    .map((leaf) => leaf.state);
  return {
    state: highestPriorityState(attentionStates),
    count: attentionStates.length,
  };
}

/** Combine two already-derived attention summaries (child → parent rollup).
 *  PURE. */
function mergeAttention(
  a: ViewTreeAttention,
  b: ViewTreeAttention
): ViewTreeAttention {
  const states = [a.state, b.state].filter(
    (s): s is DisplayState => s !== null
  );
  return {
    state: highestPriorityState(states),
    count: a.count + b.count,
  };
}

const NO_ATTENTION: ViewTreeAttention = { state: null, count: 0 };

function projectIdentityFor(repo: Repo): ProjectIdentity {
  const isGit = repo.isGitRepo && repo.kind !== 'directory';
  const remote: RepoIdentity | null | undefined = repo.repoIdentity;
  if (isGit && remote && remote.trim().length > 0) {
    return { kind: 'repo', remote };
  }
  // Null/blank repoIdentity OR non-git → directory-project fallback keyed on
  // node + path (NOT remote). Guarantees C1(a) determinism.
  return {
    kind: 'directory',
    nodeId: nodeIdOf(repo),
    localPath: repo.path,
  };
}

function projectIdFor(identity: ProjectIdentity): ProjectId {
  return identity.kind === 'directory'
    ? createDirectoryProjectId(identity.nodeId, identity.localPath)
    : createProjectId(identity);
}

function hostLabelFor(
  nodeId: NodeId,
  nodesById: Map<NodeId, ViewTreeNodeStatus>
): { hostLabel: string; isLocal: boolean } {
  const isLocal = nodeId === DEFAULT_LOCAL_NODE_ID;
  if (isLocal) return { hostLabel: 'this host', isLocal: true };
  const node = nodesById.get(nodeId);
  const displayName = node?.displayName?.trim();
  return { hostLabel: displayName || nodeId, isLocal: false };
}

function statusFor(
  nodeId: NodeId,
  nodesById: Map<NodeId, ViewTreeNodeStatus>
): InstanceHostStatus {
  const node = nodesById.get(nodeId);
  if (!node) {
    // Local host is implicitly online even when absent from `/nodes`. A remote
    // node we have no status for joins as offline (C1(c)).
    return nodeId === DEFAULT_LOCAL_NODE_ID ? 'online' : 'offline';
  }
  return node.status;
}

interface MutableInstance {
  id: InstanceId;
  nodeId: NodeId;
  hostLabel: string;
  isLocal: boolean;
  status: InstanceHostStatus;
  benchesByPath: Map<string, ViewTreeBench>;
  rootTabCount: number;
  /** #739: root-anchored Tab leaves (sessions at the repo root, no worktree). */
  rootLeaves: ViewTreeTabLeaf[];
  /** Rolled-up recency for root sessions (benches carry their own). */
  rootLastActivity: string | null;
}

interface MutableProject {
  id: ProjectId;
  identity: ProjectIdentity;
  kind: ViewTreeProjectKind;
  label: string;
  colorSeed: string;
  isGit: boolean;
  /** repo paths that map to this project (for workspace-group membership). */
  repoPaths: Set<string>;
  instancesByNode: Map<NodeId, MutableInstance>;
}

function ensureInstance(
  project: MutableProject,
  nodeId: NodeId,
  nodesById: Map<NodeId, ViewTreeNodeStatus>
): MutableInstance {
  const existing = project.instancesByNode.get(nodeId);
  if (existing) return existing;
  const { hostLabel, isLocal } = hostLabelFor(nodeId, nodesById);
  const instance: MutableInstance = {
    id: createInstanceId(project.id, nodeId),
    nodeId,
    hostLabel,
    isLocal,
    // A repo/directory project always implies a host, so the dot is shown.
    status: statusFor(nodeId, nodesById),
    benchesByPath: new Map(),
    rootTabCount: 0,
    rootLeaves: [],
    rootLastActivity: null,
  };
  project.instancesByNode.set(nodeId, instance);
  return instance;
}

function ensureBench(
  project: MutableProject,
  instance: MutableInstance,
  path: string,
  /** Configured parent repo path this bench was derived from (worktree's
   *  `repoPath` or session's `repoPath`). Carried so "+ tab" can send the
   *  agent-session `repoPath` the backend validates (#731). */
  repoPath: string,
  branch: string | null,
  activity: string | null
): ViewTreeBench {
  const existing = instance.benchesByPath.get(path);
  if (existing) {
    // Fill in a branch we learn later (e.g. from a session) on a git bench.
    if (existing.isGit && !existing.branch && branch) existing.branch = branch;
    existing.lastActivity = maxActivity(existing.lastActivity, activity);
    return existing;
  }
  const bench: ViewTreeBench = {
    id: createBenchId(instance.id, path),
    path,
    // Only git benches expose an agent-capable repo anchor; directory benches
    // carry `null` so the "+ tab" affordance is withheld (no config.repos
    // entry to validate against).
    repoPath: project.isGit ? repoPath : null,
    label: basename(path),
    // Branch element is rendered ONLY for git projects — omit by construction
    // for directory projects so identity/branch leakage is impossible.
    isGit: project.isGit,
    branch: project.isGit ? (branch ?? null) : null,
    tab: { count: 0, leaves: [] },
    // Attention is rolled up from the bench's leaves at finalize time.
    attention: NO_ATTENTION,
    lastActivity: activity ?? null,
  };
  instance.benchesByPath.set(path, bench);
  return bench;
}

/**
 * Build the read-only view-spine tree. Pure: no I/O, no clock reads, no React.
 */
export function buildViewTree(input: BuildViewTreeInput): ViewTree {
  const nodesById = new Map<NodeId, ViewTreeNodeStatus>(
    input.nodes.map((n) => [n.nodeId, n])
  );

  // ── Projects (dedup by ProjectId across nodes) ────────────────────────────
  const projectsById = new Map<ProjectId, MutableProject>();
  // Map a repo path → its ProjectId for workspace-group membership + session
  // anchoring.
  const projectIdByRepoPath = new Map<string, ProjectId>();

  function ensureProjectForRepo(repo: Repo): MutableProject {
    const identity = projectIdentityFor(repo);
    const id = projectIdFor(identity);
    projectIdByRepoPath.set(repo.path, id);
    const existing = projectsById.get(id);
    if (existing) {
      existing.repoPaths.add(repo.path);
      return existing;
    }
    const isGit = identity.kind === 'repo';
    const project: MutableProject = {
      id,
      identity,
      kind: isGit ? 'repo' : 'directory',
      label: repo.name || basename(repo.path),
      colorSeed: repo.name || basename(repo.path),
      isGit,
      repoPaths: new Set([repo.path]),
      instancesByNode: new Map(),
    };
    projectsById.set(id, project);
    return project;
  }

  for (const repo of input.repos) {
    const project = ensureProjectForRepo(repo);
    // Each repo row materializes one Instance on its node. The repo-root path
    // is itself a bench-equivalent anchor when sessions live there.
    ensureInstance(project, nodeIdOf(repo), nodesById);
  }

  // ── Benches from worktrees ────────────────────────────────────────────────
  for (const wt of input.worktrees) {
    const projectId = projectIdByRepoPath.get(wt.repoPath);
    if (!projectId) continue; // worktree for an unknown repo — skip (no anchor)
    const project = projectsById.get(projectId);
    if (!project) continue;
    const instance = ensureInstance(project, nodeIdOf(wt), nodesById);
    ensureBench(
      project,
      instance,
      wt.path,
      wt.repoPath,
      wt.branchName || null,
      wt.lastActivity || null
    );
  }

  // ── Sessions → Tab counts + free lane ─────────────────────────────────────
  const freeByKey = new Map<string, ViewTreeFreeEntry>();

  /** Add a repoPath-less (or orphaned) session to the free lane, rolling up its
   *  recency + a (branch-less, identity-less) Tab leaf. Shared by the two
   *  no-anchor branches below. */
  function addToFreeLane(
    nodeId: NodeId,
    cwd: string,
    session: SessionSummary
  ) {
    const activity = session.lastActivity || null;
    const key = `${nodeId} ${cwd}`;
    // Free leaves are NON-git by construction → no branch leak (C2).
    const leaf = tabLeafFor(session, false);
    const existing = freeByKey.get(key);
    if (existing) {
      existing.tab.count += 1;
      existing.tab.leaves.push(leaf);
      existing.lastActivity = maxActivity(existing.lastActivity, activity);
      return;
    }
    const { hostLabel, isLocal } = hostLabelFor(nodeId, nodesById);
    freeByKey.set(key, {
      key,
      nodeId,
      hostLabel,
      isLocal,
      status: statusFor(nodeId, nodesById),
      cwd,
      label: basename(cwd),
      tab: { count: 1, leaves: [leaf] },
      // Rolled up from leaves at finalize time.
      attention: NO_ATTENTION,
      lastActivity: activity ?? null,
    });
  }

  for (const session of input.sessions) {
    const nodeId = nodeIdOf(session);
    const activity = session.lastActivity || null;

    // Free/remote no-anchor sessions (no repoPath): SEPARATE top-level lane.
    // Carry NO branch and NO repo identity by construction (leak guard C2).
    if (!session.repoPath) {
      addToFreeLane(nodeId, session.worktreePath ?? session.cwd, session);
      continue;
    }

    // Anchored session: find its project + instance and bump a tab count under
    // its bench-equivalent (worktreePath ?? repoPath/cwd).
    const projectId = projectIdByRepoPath.get(session.repoPath);
    if (!projectId) {
      // repoPath set but no matching repo row — treat as free-lane to avoid
      // inventing a project. Still carries no branch/identity.
      addToFreeLane(nodeId, session.worktreePath ?? session.cwd, session);
      continue;
    }
    const project = projectsById.get(projectId);
    if (!project) continue;
    const instance = ensureInstance(project, nodeId, nodesById);

    if (session.worktreePath) {
      const bench = ensureBench(
        project,
        instance,
        session.worktreePath,
        session.repoPath,
        session.branchName || null,
        activity
      );
      bench.tab.count += 1;
      bench.tab.leaves.push(tabLeafFor(session, project.isGit));
    } else {
      // Anchored at the repo root → instance root tab count + leaf.
      instance.rootLastActivity = maxActivity(
        instance.rootLastActivity,
        activity
      );
      instance.rootTabCount += 1;
      instance.rootLeaves.push(tabLeafFor(session, project.isGit));
    }
  }

  // ── Finalize: mutable → immutable, stable ordering ────────────────────────
  function finalizeProject(project: MutableProject): ViewTreeProject {
    const instances: ViewTreeInstance[] = [...project.instancesByNode.values()]
      .sort((a, b) => {
        // Local host first, then by host label for deterministic order.
        if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
        return a.hostLabel.localeCompare(b.hostLabel);
      })
      .map((inst) => {
        const benches = [...inst.benchesByPath.values()]
          .sort((a, b) => a.path.localeCompare(b.path))
          // #739: roll each bench's leaves up into its attention summary.
          .map((b) => ({ ...b, attention: rollUpAttention(b.tab.leaves) }));
        // Instance recency = max(root sessions, all bench activity).
        const lastActivity = benches.reduce<string | null>(
          (acc, b) => maxActivity(acc, b.lastActivity),
          inst.rootLastActivity
        );
        // #739: instance attention = root tabs ∪ all benches.
        const attention = benches.reduce<ViewTreeAttention>(
          (acc, b) => mergeAttention(acc, b.attention),
          rollUpAttention(inst.rootLeaves)
        );
        return {
          id: inst.id,
          nodeId: inst.nodeId,
          hostLabel: inst.hostLabel,
          isLocal: inst.isLocal,
          status: inst.status,
          rootTab: { count: inst.rootTabCount, leaves: inst.rootLeaves },
          benches,
          attention,
          lastActivity,
        };
      });
    // Project recency = max across all instances.
    const lastActivity = instances.reduce<string | null>(
      (acc, inst) => maxActivity(acc, inst.lastActivity),
      null
    );
    // #739: project attention = merge across all instances.
    const attention = instances.reduce<ViewTreeAttention>(
      (acc, inst) => mergeAttention(acc, inst.attention),
      NO_ATTENTION
    );
    return {
      id: project.id,
      identity: project.identity,
      kind: project.kind,
      label: project.label,
      colorSeed: project.colorSeed,
      instances,
      attention,
      lastActivity,
    };
  }

  const finalizedById = new Map<ProjectId, ViewTreeProject>();
  for (const [id, project] of projectsById) {
    finalizedById.set(id, finalizeProject(project));
  }

  // ── Workspace grouping (legacy Workspace.repos[] → projects) ──────────────
  const groupedProjectIds = new Set<ProjectId>();
  const workspaces: ViewTreeWorkspaceGroup[] = [...input.workspaceGroups]
    .sort((a, b) => a.order - b.order)
    .map((ws) => {
      const seen = new Set<ProjectId>();
      const projects: ViewTreeProject[] = [];
      // Legacy/malformed persisted workspaces can omit `repos`. Guard exactly
      // like the OFF path (`Sidebar.tsx`) so the ON path is equally defensive.
      const repoPaths = Array.isArray(ws.repos) ? ws.repos : [];
      for (const repoPath of repoPaths) {
        const projectId = projectIdByRepoPath.get(repoPath);
        if (!projectId) continue;
        if (seen.has(projectId)) continue; // dedup repos sharing a remote
        seen.add(projectId);
        groupedProjectIds.add(projectId);
        const finalized = finalizedById.get(projectId);
        if (finalized) projects.push(finalized);
      }
      return {
        id: createWorkspaceId(ws.id),
        name: ws.name,
        order: ws.order,
        projects,
      };
    });

  const ungroupedProjects: ViewTreeProject[] = [];
  for (const [id, finalized] of finalizedById) {
    if (!groupedProjectIds.has(id)) ungroupedProjects.push(finalized);
  }
  ungroupedProjects.sort((a, b) => a.label.localeCompare(b.label));

  const freeLane = [...freeByKey.values()]
    // #739: roll each free entry's leaves up into its attention summary.
    .map((entry) => ({ ...entry, attention: rollUpAttention(entry.tab.leaves) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { workspaces, ungroupedProjects, freeLane };
}

// ── #728: persisted Workspace grouping (grouping-of-Projects) ─────────────────
// PURE projection of the persisted six-layer **Workspace** entities (#733 CRUD,
// `shared/workspace.ts`) over the already-derived `ViewTreeProject[]`. This is
// DISTINCT from the legacy `Workspace.repos[]` grouping above (which keys on
// repo paths): persisted Workspaces carry an ordered `projectIds` membership of
// ProjectIds (the SAME ids `buildViewTree` mints on `ViewTreeProject.id`).
//
// Membership rules (no I/O, no fetch):
//   - Workspaces render in `order` asc, then id asc (stable, mirrors the store).
//   - Within a workspace, projects render in the workspace's `projectIds` order;
//     a projectId that no longer resolves to a derived project is skipped (the
//     project may have gone offline / been removed — membership is non-binding).
//   - A project may belong to AT MOST one workspace for render purposes; the
//     FIRST workspace (by order) claiming it wins, so a stale duplicate id in a
//     later workspace does not double-render the project.
//   - Any derived project NOT claimed by a workspace falls back to `ungrouped`,
//     sorted by label for determinism.

/** A persisted-Workspace grouping of derived projects. Mirrors the shape the
 *  legacy `ViewTreeWorkspaceGroup` uses so the renderer treats both uniformly. */
export interface PersistedWorkspaceGroup {
  id: WorkspaceId;
  name: string;
  order: number;
  projects: ViewTreeProject[];
}

/** Minimal persisted-Workspace shape this projection needs (matches the #733
 *  API / `shared/workspace.ts`). Kept structural so callers can pass the API
 *  client's `IaWorkspace` without an import cycle. */
export interface PersistedWorkspaceInput {
  id: WorkspaceId;
  name: string;
  order: number;
  projectIds: string[];
}

export interface GroupedByWorkspace {
  workspaces: PersistedWorkspaceGroup[];
  ungroupedProjects: ViewTreeProject[];
}

/**
 * Group derived projects under their persisted Workspace membership. PURE:
 * never mutates inputs, never fetches. Projects unclaimed by any workspace fall
 * back to `ungroupedProjects` (sorted by label). See the membership rules above.
 */
export function groupProjectsByWorkspace(
  projects: ViewTreeProject[],
  persisted: PersistedWorkspaceInput[]
): GroupedByWorkspace {
  const projectsById = new Map<ProjectId, ViewTreeProject>(
    projects.map((p) => [p.id, p])
  );
  const claimed = new Set<ProjectId>();

  const workspaces: PersistedWorkspaceGroup[] = [...persisted]
    .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
    .map((ws) => {
      const seen = new Set<ProjectId>();
      const grouped: ViewTreeProject[] = [];
      // `projectIds` can be absent/malformed on a legacy/partial record — guard
      // exactly like the legacy grouping path does for `repos`.
      const ids = Array.isArray(ws.projectIds) ? ws.projectIds : [];
      for (const rawId of ids) {
        const id = rawId as ProjectId;
        if (seen.has(id)) continue; // dedup within a workspace
        const project = projectsById.get(id);
        if (!project) continue; // membership references an unknown/absent project
        if (claimed.has(id)) continue; // earlier workspace already owns it
        seen.add(id);
        claimed.add(id);
        grouped.push(project);
      }
      return { id: ws.id, name: ws.name, order: ws.order, projects: grouped };
    });

  const ungroupedProjects = projects
    .filter((p) => !claimed.has(p.id))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { workspaces, ungroupedProjects };
}

// ── S2: Views lenses (#727) ───────────────────────────────────────────────────
// Ad-hoc, ephemeral, PURE-FILTER lenses over the already-derived tree. No
// persistence, no new fetch, no saved Views. `applyLens` is a pure function:
// (ViewTree, ViewLens) → ViewTree. The default lens is `recent`.

export type ViewLens = 'recent' | 'all' | 'this-host';

export const DEFAULT_VIEW_LENS: ViewLens = 'recent';

/** Descending recency comparator. Items with no known activity (`null`) sort
 *  last. `Array.prototype.sort` is stable (ES2019+), so equal/`null` recency
 *  preserves the build's deterministic ordering. */
function byRecencyDesc(
  a: { lastActivity: string | null },
  b: { lastActivity: string | null }
): number {
  if (a.lastActivity === b.lastActivity) return 0;
  if (!a.lastActivity) return 1; // a has no activity → after b
  if (!b.lastActivity) return -1; // b has no activity → after a
  // Both ISO strings: later timestamp first.
  return a.lastActivity < b.lastActivity ? 1 : -1;
}

/** Recursively sort a project's instances + their benches by recency. Returns a
 *  new project object (no mutation of the input tree). */
function sortProjectByRecency(project: ViewTreeProject): ViewTreeProject {
  const instances = [...project.instances]
    .map((inst) => ({
      ...inst,
      benches: [...inst.benches].sort(byRecencyDesc),
    }))
    .sort(byRecencyDesc);
  return { ...project, instances };
}

/** Keep only local-node ("this host") instances on a project. Drops the project
 *  entirely (returns `null`) when no local instance remains. Pure. */
function localOnlyProject(project: ViewTreeProject): ViewTreeProject | null {
  const instances = project.instances.filter((inst) => inst.isLocal);
  if (instances.length === 0) return null;
  return { ...project, instances };
}

/**
 * Apply an ephemeral Views lens to the derived tree. PURE — never mutates the
 * input, never fetches. Returns a structurally-new `ViewTree`.
 *
 * - `all`        → identity (the input tree, unchanged).
 * - `recent`     → projects/instances/benches/free-lane sorted by most-recent
 *                  activity first; stable for equal/unknown recency.
 * - `this-host`  → only local-node instances survive; projects, workspaces, and
 *                  free entries with nothing local drop out.
 */
export function applyLens(tree: ViewTree, lens: ViewLens): ViewTree {
  if (lens === 'all') return tree;

  if (lens === 'this-host') {
    const filterProjects = (projects: ViewTreeProject[]): ViewTreeProject[] =>
      projects
        .map(localOnlyProject)
        .filter((p): p is ViewTreeProject => p !== null);
    return {
      workspaces: tree.workspaces.map((ws) => ({
        ...ws,
        projects: filterProjects(ws.projects),
      })),
      ungroupedProjects: filterProjects(tree.ungroupedProjects),
      freeLane: tree.freeLane.filter((entry) => entry.isLocal),
    };
  }

  // lens === 'recent'
  const sortProjects = (projects: ViewTreeProject[]): ViewTreeProject[] =>
    [...projects].map(sortProjectByRecency).sort(byRecencyDesc);
  return {
    // Workspace groups keep their explicit order, but the projects WITHIN a
    // group reorder by recency.
    workspaces: tree.workspaces.map((ws) => ({
      ...ws,
      projects: sortProjects(ws.projects),
    })),
    ungroupedProjects: sortProjects(tree.ungroupedProjects),
    freeLane: [...tree.freeLane].sort(byRecencyDesc),
  };
}

// ── #773: dedup derived benches vs. persisted bench overlays ──────────────────
// An Instance row renders TWO bench sources: benches DERIVED from worktrees
// (`ViewTreeBench`, keyed on cwd/worktree path) and #735 PERSISTED overlays
// (`/hub/ia/benches`, keyed on `cwd`). A worktree bench and an overlay targeting
// the SAME cwd are the same Bench and must render as ONE row — today they
// double-count. This pure merge keys BOTH by cwd and, on collision, prefers the
// overlay (it carries the user's label + env) while inheriting the derived
// bench's git/branch/tab/recency context.
//
// C1: cwd is the dedup key VERBATIM — never `decodeURIComponent`-ed.

/** Minimal persisted bench-overlay shape this merge needs (matches the #735
 *  `/hub/ia/benches` `IaBench`). Kept structural so callers can pass the API
 *  client's `IaBench` without an import cycle. */
export interface BenchOverlayInput {
  id: string;
  instanceId: string;
  cwd: string;
  label: string | null;
  envOverrides: Record<string, string>;
}

/** A merged bench row: a derived bench, a persisted overlay, or both fused at
 *  the same cwd. Carries the union of fields the renderer needs so it can render
 *  one row per cwd. `overlayId` is set when an overlay backs this row (delete
 *  affordance); `bench` is set when a derived worktree backs it ("+ tab" anchor,
 *  branch, tab count). */
export interface MergedBench {
  /** Stable React key + dedup identity. The cwd this bench is anchored to. */
  cwd: string;
  /** Display label: overlay label (when set) else the derived/basename label. */
  label: string;
  /** Persisted overlay id, when an overlay backs this row (enables delete). */
  overlayId: string | null;
  /** Env overrides from the overlay (empty when overlay-less). */
  envOverrides: Record<string, string>;
  /** Underlying derived bench, when a worktree backs this row. `null` for an
   *  overlay-only bench (no worktree → no "+ tab" anchor, no branch). */
  bench: ViewTreeBench | null;
}

function overlayFallbackLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const seg = trimmed.split(/[\\/]/).pop();
  return seg && seg.length > 0 ? seg : cwd;
}

/**
 * Merge an instance's derived benches with its persisted overlays into ONE row
 * list keyed by cwd. PURE: never mutates inputs, never fetches.
 *
 * Rules:
 *   - Derived benches whose `path` equals an overlay's `cwd` fuse into a single
 *     row. The OVERLAY is preferred: its label (when non-empty) + env win, but
 *     the row keeps the derived `bench` so the renderer still has branch/git,
 *     tab count, and the "+ tab" anchor.
 *   - An overlay with no matching derived bench renders overlay-only (`bench:
 *     null`): no branch, no "+ tab" (no worktree anchor).
 *   - A derived bench with no overlay renders as before (`overlayId: null`).
 *   - Order: derived benches keep their incoming (build/lens) order first; then
 *     overlay-only benches in their incoming order. A fused overlay does NOT
 *     reorder its derived row.
 */
export function mergeInstanceBenches(
  derived: ViewTreeBench[],
  overlays: BenchOverlayInput[]
): MergedBench[] {
  // Index overlays by cwd (last write wins — the store keys benches uniquely by
  // (instanceId, cwd), so collisions are not expected, but be deterministic).
  const overlayByCwd = new Map<string, BenchOverlayInput>();
  for (const overlay of overlays) overlayByCwd.set(overlay.cwd, overlay);

  const merged: MergedBench[] = [];
  const fusedCwds = new Set<string>();

  // Derived benches first, fusing any overlay sharing the cwd.
  for (const bench of derived) {
    const overlay = overlayByCwd.get(bench.path);
    if (overlay) {
      fusedCwds.add(bench.path);
      const overlayLabel =
        overlay.label && overlay.label.length > 0 ? overlay.label : null;
      merged.push({
        cwd: bench.path,
        label: overlayLabel ?? bench.label,
        overlayId: overlay.id,
        envOverrides: overlay.envOverrides,
        bench,
      });
    } else {
      merged.push({
        cwd: bench.path,
        label: bench.label,
        overlayId: null,
        envOverrides: {},
        bench,
      });
    }
  }

  // Overlay-only benches (no derived worktree at that cwd).
  for (const overlay of overlays) {
    if (fusedCwds.has(overlay.cwd)) continue;
    const overlayLabel =
      overlay.label && overlay.label.length > 0 ? overlay.label : null;
    merged.push({
      cwd: overlay.cwd,
      label: overlayLabel ?? overlayFallbackLabel(overlay.cwd),
      overlayId: overlay.id,
      envOverrides: overlay.envOverrides,
      bench: null,
    });
  }

  return merged;
}

/** Group a flat list of persisted bench overlays by their `instanceId`, so a
 *  SINGLE unfiltered `GET /hub/ia/benches` can fan out to per-instance rows
 *  client-side (replacing N per-instance GETs). PURE. */
export function groupBenchOverlaysByInstance(
  overlays: BenchOverlayInput[]
): Map<string, BenchOverlayInput[]> {
  const byInstance = new Map<string, BenchOverlayInput[]>();
  for (const overlay of overlays) {
    const list = byInstance.get(overlay.instanceId);
    if (list) list.push(overlay);
    else byInstance.set(overlay.instanceId, [overlay]);
  }
  return byInstance;
}

// ── S4: "+ tab" anchored to a Bench (#731) ───────────────────────────────────
// PURE resolver of the create payload a "+ tab" affordance hands to the EXISTING
// session-create entrypoint (`createAgentSession` → `createSession`, the #473
// local/remote/free flow). A Bench is anchored to a single (nodeId, worktree);
// the nodeId lives on its owning Instance. The payload MIRRORS the local-git
// branch of `createSessionFromForm` (the dialog) so it satisfies the backend
// `validateSessionCreateRequest` agent contract: `repoPath` MUST be a configured
// repo (`config.repos`) and the worktree becomes the session cwd
// (`cwd = worktreePath ?? repoPath`, server/index.ts).
//
// #740: the payload now also carries the bench's identity (`instanceId` +
// deterministic `benchId`) so the create handler can look up that Bench's
// persisted `envOverrides` overlay and inherit them. Branch, agent, yolo, and
// identity are still NOT inherited — only env overrides.

/** The anchor + repo context a new agent Tab needs. `repoPath` is the configured
 *  parent repo (validated against `config.repos` by the backend); `worktreePath`
 *  is the bench's worktree (becomes the session cwd); `cwd` mirrors the worktree
 *  for callers/consumers that want it explicit. `instanceId`/`benchId` identify
 *  the anchoring Bench so its persisted env overlay can be inherited (#740).
 *  Consumed by the `handleViewSpineCreateTab` path — this helper invents NO new
 *  create logic. */
export interface BenchCreatePayload {
  nodeId: NodeId;
  repoPath: string;
  worktreePath: string;
  cwd: string;
  /** Owning Instance id — used to scope the bench-overlay env lookup (#740). */
  instanceId: InstanceId;
  /** Deterministic BenchId (`createBenchId(instanceId, cwd)`) — matches the
   *  persisted overlay whose `envOverrides` the new Tab inherits (#740). */
  benchId: BenchId;
}

/** Resolve the agent-session create payload a "+ tab" on `bench` (owned by
 *  `instance`) should create against. Pure: no I/O, no React.
 *
 *  Returns `null` for a NON-git/directory bench (`bench.repoPath === null`):
 *  there is no `config.repos`-validated repo anchor, so an agent session cannot
 *  be created and the "+ tab" affordance is withheld. For a git bench the
 *  payload is `{ nodeId, repoPath, worktreePath, cwd }` — exactly what the
 *  dialog's local-git create sends. */
export function benchCreatePayload(
  instance: Pick<ViewTreeInstance, 'id' | 'nodeId'>,
  bench: Pick<ViewTreeBench, 'id' | 'path' | 'repoPath'>
): BenchCreatePayload | null {
  if (!bench.repoPath) return null;
  return {
    nodeId: instance.nodeId,
    repoPath: bench.repoPath,
    worktreePath: bench.path,
    cwd: bench.path,
    // #740: identity so the create handler can inherit this Bench's persisted
    // env overlay. `bench.id` is already `createBenchId(instance.id, bench.path)`.
    instanceId: instance.id,
    benchId: bench.id,
  };
}
