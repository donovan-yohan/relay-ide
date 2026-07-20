// #734 (BE-2, Epic #444 view-spine): SERVER-SIDE, READ-ONLY derive of the
// six-layer IA read model — Project (with ProjectIdentity) → Instance → Bench —
// from the AUTHORITATIVE server-side data: per-node `RepoInventoryReport`s
// (config.repos + worktree scan) joined with hub node status (online/stale/
// offline). This is the server-owned canonical repo/worktree IA tree exposed by
// `GET /hub/ia/tree`. The current frontend navigation does not consume this
// endpoint; it remains driven by TopicSidebarShell and its existing stores.
//
// NON-DESTRUCTIVE: pure read/derive. ZERO persistence, ZERO DB writes, ZERO
// migration, ZERO new tables. No I/O and no clock reads in the pure builder
// (the route supplies the already-collected reports + node statuses + a clock).
//
// Layer mapping (View → Workspace → Project → Instance → Bench → Tab):
//   RepoInventoryRepoInstance      → Project   (git: keyed on REMOTE identity via
//                                     createProjectId; null/non-git → directory
//                                     project keyed on node + localPath). Same
//                                     remote across nodes = ONE Project, N
//                                     Instances.
//   (Project, report.nodeId)       → Instance  (host label: local = `this host`,
//                                     remote = node displayName; online/stale/
//                                     offline join from node status).
//   RepoInventoryWorktreeInstance  → Bench      (createBenchId(instanceId, path);
//                                     branch only on git instances).
//   Workspace { repos: string[] }  → Workspace grouping (repo localPath → project).
//
// Tab COUNTS are intentionally OUT OF SCOPE here: a `RepoInventoryReport` carries
// no session data, and cross-node session aggregation is a separate read model
// (`server/hub-session-aggregator.ts`). This server tree exposes only the
// durable repo/worktree structure; consumers must join session data separately
// when they need Tab counts.

import {
  DEFAULT_LOCAL_NODE_ID,
  type NodeId,
  type RepoIdentity,
} from '../../shared/identity.js';
import {
  createDirectoryProjectId,
  createInstanceId,
  createProjectId,
  type InstanceId,
  type ProjectId,
  type ProjectIdentity,
} from '../../shared/project.js';
import { createBenchId, type BenchId } from '../../shared/bench.js';
import { createWorkspaceId, type WorkspaceId } from '../../shared/workspace.js';
import type { HubNodeStatus } from '../../shared/relay-node-protocol.js';
import type {
  RepoInventoryReport,
  RepoInventoryRepoInstance,
  RepoInventoryWorktreeInstance,
} from '../../shared/repo-inventory.js';

/** Minimal node-status subset the derive needs, joined from the hub registry's
 *  `HubNodeSummary[]`. Kept small so the builder is testable without a full
 *  manifest summary (mirrors `ViewTreeNodeStatus` on the client). */
export interface IaNodeStatus {
  nodeId: NodeId;
  displayName?: string;
  status: HubNodeStatus;
  lastSeenAt?: string;
}

/** Minimal workspace-group subset (legacy `config.workspaces[]`) used only for
 *  grouping projects by their member repo localPaths. */
export interface IaWorkspaceGroupInput {
  id: string;
  name: string;
  order: number;
  /** Configured member repo localPaths. Legacy/malformed entries may omit it. */
  repos?: string[];
}

/** Online/stale/offline presence for an Instance's host. A repo/directory
 *  project always implies a host, so this is never null here (unlike the client
 *  derive, which carries non-host project kinds). */
export type IaInstanceHostStatus = HubNodeStatus;

export type IaProjectKind = 'repo' | 'directory';

export interface IaBench {
  id: BenchId;
  /** Anchored cwd/worktree path (node-local). */
  path: string;
  /** Configured PARENT repo localPath this bench belongs to — the value the
   *  backend validates against `config.repos` for an agent session. `null` for
   *  non-git/directory benches (no agent-capable repo anchor). */
  repoPath: string | null;
  /** Last path segment, for the display label. */
  label: string;
  /** Branch name — present ONLY for git benches; `null` otherwise. */
  branch: string | null;
  /** Whether this bench's project is a git repo. */
  isGit: boolean;
  /** Most-recent worktree activity rolled up here (ISO), `null` when unknown. */
  lastActivity: string | null;
}

export interface IaInstance {
  id: InstanceId;
  nodeId: NodeId;
  /** `this host` for local; node displayName (fallback nodeId) for remote. */
  hostLabel: string;
  isLocal: boolean;
  /** Online/stale/offline presence joined from node status. */
  status: IaInstanceHostStatus;
  /** Node-local checkout path that materializes this instance. */
  localPath: string;
  benches: IaBench[];
  /** Max activity across this instance's benches (ISO), `null` when unknown. */
  lastActivity: string | null;
}

export interface IaProject {
  id: ProjectId;
  identity: ProjectIdentity;
  kind: IaProjectKind;
  /** Display label: repo name / directory basename. */
  label: string;
  instances: IaInstance[];
  /** Max activity across all instances (ISO), `null` when unknown. */
  lastActivity: string | null;
}

export interface IaWorkspaceGroup {
  id: WorkspaceId;
  name: string;
  order: number;
  projects: IaProject[];
}

export interface IaTree {
  /** Workspace-grouped projects (legacy `config.workspaces[].repos`). */
  workspaces: IaWorkspaceGroup[];
  /** Projects not a member of any workspace group. */
  ungroupedProjects: IaProject[];
  /** ISO timestamp the tree was derived (route-supplied clock). */
  generatedAt: string;
}

export interface BuildIaTreeInput {
  /** Per-node authoritative inventory reports (config.repos + worktree scan). */
  reports: RepoInventoryReport[];
  /** Hub node statuses, joined for online/stale/offline + host labels. */
  nodes: IaNodeStatus[];
  /** Optional workspace groups (legacy `config.workspaces`). */
  workspaceGroups?: IaWorkspaceGroupInput[];
  /** Derivation timestamp (deterministic in tests). */
  generatedAt: string;
}

function basename(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  const seg = trimmed.split('/').pop();
  return seg && seg.length > 0 ? seg : value;
}

/** Pick the later of two ISO timestamps. `null` is "no activity known" and
 *  always loses. Lexicographic compare is correct for fixed-offset ISO-8601. */
function maxActivity(
  a: string | null | undefined,
  b: string | null | undefined
): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

/** Repo identity → ProjectIdentity. Git repo with a non-blank remote identity
 *  becomes a `repo`-kind project keyed on the REMOTE (so the same logical repo
 *  on N nodes dedups to ONE project). Non-git OR null/blank identity falls back
 *  to a `directory`-kind project keyed on node + localPath (never the remote),
 *  guaranteeing determinism + no identity leakage onto non-repo entries. */
function projectIdentityFor(repo: RepoInventoryRepoInstance): ProjectIdentity {
  const remote: RepoIdentity | null | undefined = repo.repoIdentity;
  if (repo.isGitRepo && remote && remote.trim().length > 0) {
    return { kind: 'repo', remote };
  }
  return {
    kind: 'directory',
    nodeId: repo.nodeId,
    localPath: repo.localPath,
  };
}

function projectIdFor(identity: ProjectIdentity): ProjectId {
  return identity.kind === 'directory'
    ? createDirectoryProjectId(identity.nodeId, identity.localPath)
    : createProjectId(identity);
}

/**
 * The EXACT repo → ProjectId mapping `buildIaTree` uses internally, exported so
 * the #736 boot migration produces ProjectIds that line up byte-for-byte with
 * the ProjectIds `GET /hub/ia/tree` emits for the same repos. Reusing this is
 * load-bearing: if the migration derived ids any other way, the persisted
 * Workspace `projectIds` would not match the derived projects and the grouping
 * would silently point at nothing.
 *
 * PURE: no I/O, no clock. Same `projectIdentityFor` (git remote → `repo`-kind,
 * non-git/blank → `directory`-kind keyed on node+localPath) then `projectIdFor`.
 */
export function repoInstanceProjectId(
  repo: RepoInventoryRepoInstance
): ProjectId {
  return projectIdFor(projectIdentityFor(repo));
}

function hostLabelFor(
  nodeId: NodeId,
  nodesById: Map<NodeId, IaNodeStatus>
): { hostLabel: string; isLocal: boolean } {
  if (nodeId === DEFAULT_LOCAL_NODE_ID) {
    return { hostLabel: 'this host', isLocal: true };
  }
  const displayName = nodesById.get(nodeId)?.displayName?.trim();
  return { hostLabel: displayName || nodeId, isLocal: false };
}

function statusFor(
  nodeId: NodeId,
  nodesById: Map<NodeId, IaNodeStatus>
): IaInstanceHostStatus {
  const node = nodesById.get(nodeId);
  if (!node) {
    // Local host is implicitly online even when absent from the registry. A
    // remote node we have no status for joins as offline (degrade cleanly,
    // never crash) — mirrors the client derive's C1(c) rule.
    return nodeId === DEFAULT_LOCAL_NODE_ID ? 'online' : 'offline';
  }
  return node.status;
}

interface MutableInstance {
  id: InstanceId;
  nodeId: NodeId;
  hostLabel: string;
  isLocal: boolean;
  status: IaInstanceHostStatus;
  localPath: string;
  benches: IaBench[];
}

interface MutableProject {
  id: ProjectId;
  identity: ProjectIdentity;
  kind: IaProjectKind;
  label: string;
  isGit: boolean;
  /** repo localPaths that map to this project (for workspace-group membership). */
  repoPaths: Set<string>;
  /** keyed by `${nodeId} ${localPath}` — a checkout instance per node+path. */
  instancesByKey: Map<string, MutableInstance>;
}

function benchFor(
  instanceId: InstanceId,
  isGit: boolean,
  repoLocalPath: string,
  worktree: RepoInventoryWorktreeInstance
): IaBench {
  return {
    id: createBenchId(instanceId, worktree.localPath),
    path: worktree.localPath,
    // Only git benches expose a `config.repos`-validated agent anchor; directory
    // benches carry null so identity/branch leakage is impossible.
    repoPath: isGit ? repoLocalPath : null,
    label: basename(worktree.localPath),
    isGit,
    branch: isGit ? (worktree.branchName ?? null) : null,
    lastActivity: worktree.lastActivity ?? null,
  };
}

/**
 * Build the server-side IA read tree. PURE: no I/O, no clock reads, no network.
 * Reports + node statuses + the clock are supplied by the route.
 */
export function buildIaTree(input: BuildIaTreeInput): IaTree {
  const nodesById = new Map<NodeId, IaNodeStatus>(
    input.nodes.map((n) => [n.nodeId, n])
  );

  const projectsById = new Map<ProjectId, MutableProject>();
  // repo localPath → ProjectId, for workspace-group membership.
  const projectIdByRepoPath = new Map<string, ProjectId>();

  for (const report of input.reports) {
    for (const repo of report.repos) {
      const identity = projectIdentityFor(repo);
      const projectId = projectIdFor(identity);
      projectIdByRepoPath.set(repo.localPath, projectId);

      let project = projectsById.get(projectId);
      if (!project) {
        const isGit = identity.kind === 'repo';
        project = {
          id: projectId,
          identity,
          kind: isGit ? 'repo' : 'directory',
          label: repo.name || basename(repo.localPath),
          isGit,
          repoPaths: new Set(),
          instancesByKey: new Map(),
        };
        projectsById.set(projectId, project);
      }
      project.repoPaths.add(repo.localPath);

      // One Instance per (node, checkout path). The same remote on two nodes is
      // ONE project with two instances; two checkouts of the same remote on the
      // SAME node are two instances (distinct localPaths) under one project.
      const instanceKey = `${repo.nodeId} ${repo.localPath}`;
      let instance = project.instancesByKey.get(instanceKey);
      if (!instance) {
        const { hostLabel, isLocal } = hostLabelFor(repo.nodeId, nodesById);
        const instanceId = createInstanceId(project.id, repo.nodeId);
        instance = {
          id: instanceId,
          nodeId: repo.nodeId,
          hostLabel,
          isLocal,
          status: statusFor(repo.nodeId, nodesById),
          localPath: repo.localPath,
          benches: [],
        };
        project.instancesByKey.set(instanceKey, instance);
      }

      // Benches from the repo's worktree instances.
      for (const worktree of repo.worktrees) {
        instance.benches.push(
          benchFor(instance.id, project.isGit, repo.localPath, worktree)
        );
      }
    }
  }

  // ── Finalize: mutable → immutable, stable ordering, recency rollup ──────────
  function finalizeProject(project: MutableProject): IaProject {
    const instances: IaInstance[] = [...project.instancesByKey.values()]
      .sort((a, b) => {
        // Local host first, then host label, then localPath for determinism.
        if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
        return (
          a.hostLabel.localeCompare(b.hostLabel) ||
          a.localPath.localeCompare(b.localPath)
        );
      })
      .map((inst) => {
        const benches = [...inst.benches].sort((a, b) =>
          a.path.localeCompare(b.path)
        );
        const lastActivity = benches.reduce<string | null>(
          (acc, bench) => maxActivity(acc, bench.lastActivity),
          null
        );
        return {
          id: inst.id,
          nodeId: inst.nodeId,
          hostLabel: inst.hostLabel,
          isLocal: inst.isLocal,
          status: inst.status,
          localPath: inst.localPath,
          benches,
          lastActivity,
        };
      });
    const lastActivity = instances.reduce<string | null>(
      (acc, inst) => maxActivity(acc, inst.lastActivity),
      null
    );
    return {
      id: project.id,
      identity: project.identity,
      kind: project.kind,
      label: project.label,
      instances,
      lastActivity,
    };
  }

  const finalizedById = new Map<ProjectId, IaProject>();
  for (const [id, project] of projectsById) {
    finalizedById.set(id, finalizeProject(project));
  }

  // ── Workspace grouping (legacy config.workspaces[].repos → projects) ────────
  const groupedProjectIds = new Set<ProjectId>();
  const workspaces: IaWorkspaceGroup[] = [...(input.workspaceGroups ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((ws) => {
      const seen = new Set<ProjectId>();
      const projects: IaProject[] = [];
      // Legacy/malformed persisted workspaces can omit `repos` — guard exactly
      // like the client derive so we never throw on bad on-disk state.
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

  const ungroupedProjects: IaProject[] = [];
  for (const [id, finalized] of finalizedById) {
    if (!groupedProjectIds.has(id)) ungroupedProjects.push(finalized);
  }
  ungroupedProjects.sort((a, b) => a.label.localeCompare(b.label));

  return { workspaces, ungroupedProjects, generatedAt: input.generatedAt };
}
