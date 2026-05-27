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
//   SessionSummary[]    → Tab COUNTS grouped under (nodeId, worktreePath ?? cwd).
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

export interface ViewTreeTab {
  /** Count only — leaves are not interactive rows. */
  count: number;
}

export interface ViewTreeBench {
  id: BenchId;
  /** Anchored cwd/worktree path. */
  path: string;
  /** Last path segment, for the `.session-name` label. */
  label: string;
  /** Branch name — present ONLY for git benches; omit element otherwise. */
  branch: string | null;
  /** Whether this bench's host is a git repo (drives `.secondary-branch`). */
  isGit: boolean;
  /** Tab count grouped under this bench-equivalent. */
  tab: ViewTreeTab;
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
  /** Tab count at the instance root (sessions anchored to the repo, no worktree). */
  rootTab: ViewTreeTab;
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
  /** Tab count grouped under (nodeId, cwd). */
  tab: ViewTreeTab;
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

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const seg = trimmed.split('/').pop();
  return seg && seg.length > 0 ? seg : path;
}

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
  };
  project.instancesByNode.set(nodeId, instance);
  return instance;
}

function ensureBench(
  project: MutableProject,
  instance: MutableInstance,
  path: string,
  branch: string | null
): ViewTreeBench {
  const existing = instance.benchesByPath.get(path);
  if (existing) {
    // Fill in a branch we learn later (e.g. from a session) on a git bench.
    if (existing.isGit && !existing.branch && branch) existing.branch = branch;
    return existing;
  }
  const bench: ViewTreeBench = {
    id: createBenchId(instance.id, path),
    path,
    label: basename(path),
    // Branch element is rendered ONLY for git projects — omit by construction
    // for directory projects so identity/branch leakage is impossible.
    isGit: project.isGit,
    branch: project.isGit ? (branch ?? null) : null,
    tab: { count: 0 },
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
    ensureBench(project, instance, wt.path, wt.branchName || null);
  }

  // ── Sessions → Tab counts + free lane ─────────────────────────────────────
  const freeByKey = new Map<string, ViewTreeFreeEntry>();
  for (const session of input.sessions) {
    const nodeId = nodeIdOf(session);

    // Free/remote no-anchor sessions (no repoPath): SEPARATE top-level lane.
    // Carry NO branch and NO repo identity by construction (leak guard C2).
    if (!session.repoPath) {
      const cwd = session.worktreePath ?? session.cwd;
      const key = `${nodeId} ${cwd}`;
      const existing = freeByKey.get(key);
      if (existing) {
        existing.tab.count += 1;
        continue;
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
        tab: { count: 1 },
      });
      continue;
    }

    // Anchored session: find its project + instance and bump a tab count under
    // its bench-equivalent (worktreePath ?? repoPath/cwd).
    const projectId = projectIdByRepoPath.get(session.repoPath);
    if (!projectId) {
      // repoPath set but no matching repo row — treat as free-lane to avoid
      // inventing a project. Still carries no branch/identity.
      const cwd = session.worktreePath ?? session.cwd;
      const key = `${nodeId} ${cwd}`;
      const existing = freeByKey.get(key);
      if (existing) {
        existing.tab.count += 1;
        continue;
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
        tab: { count: 1 },
      });
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
        session.branchName || null
      );
      bench.tab.count += 1;
    } else {
      // Anchored at the repo root → instance root tab count.
      instance.rootTabCount += 1;
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
      .map((inst) => ({
        id: inst.id,
        nodeId: inst.nodeId,
        hostLabel: inst.hostLabel,
        isLocal: inst.isLocal,
        status: inst.status,
        rootTab: { count: inst.rootTabCount },
        benches: [...inst.benchesByPath.values()].sort((a, b) =>
          a.path.localeCompare(b.path)
        ),
      }));
    return {
      id: project.id,
      identity: project.identity,
      kind: project.kind,
      label: project.label,
      colorSeed: project.colorSeed,
      instances,
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
      for (const repoPath of ws.repos) {
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

  const freeLane = [...freeByKey.values()].sort((a, b) =>
    a.key.localeCompare(b.key)
  );

  return { workspaces, ungroupedProjects, freeLane };
}
