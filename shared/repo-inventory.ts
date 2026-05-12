import type {
  NodeId,
  RepoIdentity,
  RepoInstanceId,
  WorktreeInstanceId,
} from './identity.js';
import type {
  RepoIdentityWarning,
  ResolvedRemoteIdentity,
} from './repo-identity.js';

export interface RepoInventoryDirtyFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'unknown';
}

export interface RepoInventoryDirtySummary {
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  files: RepoInventoryDirtyFile[];
  truncated: boolean;
}

export interface RepoInventoryDivergenceSummary {
  upstreamRef: string | null;
  aheadCount: number;
  behindCount: number;
  headSha?: string | null;
  generatedAt?: string;
  error?: string;
}

export interface RepoInventoryWorktreeInstance {
  worktreeInstanceId: WorktreeInstanceId;
  localPath: string;
  branchName: string | null;
  displayName?: string;
  lastActivity?: string;
  dirty?: RepoInventoryDirtySummary | null;
  divergence?: RepoInventoryDivergenceSummary | null;
  warnings?: string[];
}

export interface RepoInventoryRepoInstance {
  repoInstanceId: RepoInstanceId;
  nodeId: NodeId;
  localPath: string;
  name: string;
  isGitRepo: boolean;
  defaultBranch: string | null;
  currentBranch: string | null;
  repoIdentity: RepoIdentity | null;
  selectedRemote: ResolvedRemoteIdentity | null;
  remotes: ResolvedRemoteIdentity[];
  repoIdentityWarnings: RepoIdentityWarning[];
  dirty?: RepoInventoryDirtySummary | null;
  divergence?: RepoInventoryDivergenceSummary | null;
  worktrees: RepoInventoryWorktreeInstance[];
  reportedAt: string;
}

export interface RepoInventoryReport {
  nodeId: NodeId;
  generatedAt: string;
  repos: RepoInventoryRepoInstance[];
}

export interface AggregatedRepoInventoryGroup {
  groupId: string;
  repoIdentity: RepoIdentity | null;
  displayName: string;
  selectedRemote: ResolvedRemoteIdentity | null;
  remotes: ResolvedRemoteIdentity[];
  warnings: RepoIdentityWarning[];
  instances: RepoInventoryRepoInstance[];
  identityDebug: {
    groupedBy: 'repoIdentity' | 'repoInstanceId';
    repoIdentity: RepoIdentity | null;
    instanceCount: number;
    nodeIds: NodeId[];
  };
}

export interface AggregatedRepoInventoryResponse {
  generatedAt: string;
  groups: AggregatedRepoInventoryGroup[];
  reports: RepoInventoryReport[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isResolvedRemoteIdentity(value: unknown): value is ResolvedRemoteIdentity {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === 'string' &&
    typeof value.url === 'string' &&
    isStringOrNull(value.identity) &&
    isStringOrNull(value.host) &&
    isStringOrNull(value.path) &&
    isStringOrNull(value.owner) &&
    isStringOrNull(value.repoName)
  );
}

function isRepoInventoryWorktreeInstance(value: unknown): value is RepoInventoryWorktreeInstance {
  if (!isRecord(value)) return false;
  return (
    typeof value.worktreeInstanceId === 'string' &&
    typeof value.localPath === 'string' &&
    isStringOrNull(value.branchName)
  );
}

function isRepoInventoryRepoInstance(value: unknown): value is RepoInventoryRepoInstance {
  if (!isRecord(value)) return false;
  return (
    typeof value.repoInstanceId === 'string' &&
    typeof value.nodeId === 'string' &&
    typeof value.localPath === 'string' &&
    typeof value.name === 'string' &&
    typeof value.isGitRepo === 'boolean' &&
    isStringOrNull(value.defaultBranch) &&
    isStringOrNull(value.currentBranch) &&
    isStringOrNull(value.repoIdentity) &&
    (value.selectedRemote === null || isResolvedRemoteIdentity(value.selectedRemote)) &&
    Array.isArray(value.remotes) &&
    value.remotes.every(isResolvedRemoteIdentity) &&
    Array.isArray(value.repoIdentityWarnings) &&
    value.repoIdentityWarnings.every((warning) => typeof warning === 'string') &&
    Array.isArray(value.worktrees) &&
    value.worktrees.every(isRepoInventoryWorktreeInstance) &&
    typeof value.reportedAt === 'string'
  );
}

export function isRepoInventoryReport(value: unknown): value is RepoInventoryReport {
  if (!isRecord(value)) return false;
  return (
    typeof value.nodeId === 'string' &&
    typeof value.generatedAt === 'string' &&
    Array.isArray(value.repos) &&
    value.repos.every((repo) =>
      isRepoInventoryRepoInstance(repo) && repo.nodeId === value.nodeId
    )
  );
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string | null): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function uniqueWarnings(instances: RepoInventoryRepoInstance[]): RepoIdentityWarning[] {
  return Array.from(
    new Set(instances.flatMap((instance) => instance.repoIdentityWarnings))
  ).sort();
}

function displayNameFor(instances: RepoInventoryRepoInstance[]): string {
  const selectedRemoteName = instances
    .map((instance) => instance.selectedRemote?.repoName)
    .find((name): name is string => Boolean(name));
  return selectedRemoteName ?? instances[0]?.name ?? 'unknown repository';
}

export function aggregateRepoInventoryReports(
  reports: RepoInventoryReport[],
  now: Date = new Date()
): AggregatedRepoInventoryResponse {
  const groupsById = new Map<string, RepoInventoryRepoInstance[]>();

  for (const report of reports) {
    for (const instance of report.repos) {
      const groupId = instance.repoIdentity ?? `unidentified:${instance.repoInstanceId}`;
      const current = groupsById.get(groupId) ?? [];
      current.push(instance);
      groupsById.set(groupId, current);
    }
  }

  const groups = Array.from(groupsById.entries()).map(([groupId, instances]) => {
    const repoIdentity = instances[0]?.repoIdentity ?? null;
    const remotes = uniqueBy(
      instances.flatMap((instance) => instance.remotes),
      (remote) => `${remote.name}:${remote.identity ?? remote.url}`
    );
    const selectedRemote = instances.find((instance) => instance.selectedRemote)?.selectedRemote ?? null;
    const nodeIds = Array.from(new Set(instances.map((instance) => instance.nodeId))).sort();

    return {
      groupId,
      repoIdentity,
      displayName: displayNameFor(instances),
      selectedRemote,
      remotes,
      warnings: uniqueWarnings(instances),
      instances: [...instances].sort((a, b) =>
        a.nodeId === b.nodeId
          ? a.localPath.localeCompare(b.localPath)
          : a.nodeId.localeCompare(b.nodeId)
      ),
      identityDebug: {
        groupedBy: repoIdentity ? 'repoIdentity' : 'repoInstanceId',
        repoIdentity,
        instanceCount: instances.length,
        nodeIds,
      },
    } satisfies AggregatedRepoInventoryGroup;
  });

  groups.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.groupId.localeCompare(b.groupId));

  return {
    generatedAt: now.toISOString(),
    groups,
    reports,
  };
}
