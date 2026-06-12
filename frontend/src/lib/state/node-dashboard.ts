import {
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type HubNodeStatus,
  type HubNodeSummary,
  type NodeCapabilityStatus,
} from '../../../../shared/relay-node-protocol.js';
import type { NodeManifestDegradedReason } from '../../../../shared/node-manifest.js';
import type {
  AggregatedRepoInventoryResponse,
  RepoInventoryRepoInstance,
  RepoInventoryWorktreeInstance,
} from '../../../../shared/repo-inventory.js';
import {
  deriveNodeSecurityVisibility,
  type NodeSecurityVisibility,
} from './security-visibility.js';

type CapabilityTone = NodeCapabilityStatus;

export interface HubNodeCapabilityHint {
  key: string;
  label: string;
  status: CapabilityTone;
}

export interface HubNodeDashboardRow {
  nodeId: string;
  displayName: string;
  hostname: string;
  hostLabel: string;
  status: HubNodeStatus;
  statusTone: 'online' | 'stale' | 'offline' | 'revoked' | 'updating';
  routeLabel: string;
  lastSeenLabel: string;
  relayVersion: string;
  /** Canonical helper binary version. Absent on pre-#651 nodes. */
  helperVersion: string | null;
  protocolVersion: string;
  versionWarning: string | null;
  /** Helper-binary skew warning, present when helper version diverges from hub. */
  helperSkewWarning: string | null;
  capabilityHints: HubNodeCapabilityHint[];
  security: NodeSecurityVisibility;
  attachable: boolean;
  workReadiness: string;
  disabledReason: string | null;
  /** Whether File RPC is available on this node. `null` = unknown (pre-#651 node). */
  fileRpcAvailable: boolean | null;
  /** Structured degraded reasons from the manifest. Empty on healthy nodes. */
  degradedReasons: NodeManifestDegradedReason[];
}

export interface NodeRepoLocalityRepo {
  repoInstanceId: string;
  name: string;
  localPath: string;
  currentBranch: string | null;
  defaultBranch: string | null;
  worktrees: NodeRepoLocalityWorktree[];
  reportedAt: string;
}

export interface NodeRepoLocalityWorktree {
  worktreeInstanceId: string;
  localPath: string;
  branchName: string | null;
  displayName: string;
}

export interface NodeRepoLocality {
  nodeId: string;
  generatedAt: string;
  repoCount: number;
  worktreeCount: number;
  repos: NodeRepoLocalityRepo[];
}

interface DeriveOptions {
  now?: Date;
  expectedProtocolVersion?: string;
}

const readinessCapabilities = ['shell', 'tmux', 'git', 'worktrees'] as const;

function formatRelativeTime(iso: string, now: Date): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return 'unknown';
  const seconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function fallbackStatus(
  status: NodeCapabilityStatus | undefined
): NodeCapabilityStatus {
  return status ?? 'unknown';
}

function aggregateAgentStatus(
  agents: Record<string, NodeCapabilityStatus>
): NodeCapabilityStatus {
  const statuses = Object.values(agents);
  if (statuses.length === 0) return 'unknown';
  if (statuses.includes('available')) return 'available';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('unknown')) return 'unknown';
  return 'unavailable';
}

function serviceManagerStatus(kind: string): NodeCapabilityStatus {
  if (kind === 'unsupported') return 'unavailable';
  if (kind === 'manual' || kind === 'wsl-manual') return 'degraded';
  return kind ? 'available' : 'unknown';
}

function fallbackWorktreeDisplayName(localPath: string): string {
  const normalizedPath = localPath.replace(/[\\/]+$/, '');
  return normalizedPath.split(/[\\/]/).pop() || localPath;
}

function localityWorktree(
  worktree: RepoInventoryWorktreeInstance
): NodeRepoLocalityWorktree {
  return {
    worktreeInstanceId: worktree.worktreeInstanceId,
    localPath: worktree.localPath,
    branchName: worktree.branchName,
    displayName: worktree.displayName ?? fallbackWorktreeDisplayName(worktree.localPath),
  };
}

function localityRepo(repo: RepoInventoryRepoInstance): NodeRepoLocalityRepo {
  return {
    repoInstanceId: repo.repoInstanceId,
    name: repo.selectedRemote?.repoName ?? repo.name,
    localPath: repo.localPath,
    currentBranch: repo.currentBranch,
    defaultBranch: repo.defaultBranch,
    worktrees: repo.worktrees.map(localityWorktree),
    reportedAt: repo.reportedAt,
  };
}

export function deriveNodeRepoLocality(
  inventory: AggregatedRepoInventoryResponse | undefined
): Map<string, NodeRepoLocality> {
  const localityByNode = new Map<string, NodeRepoLocality>();
  for (const report of inventory?.reports ?? []) {
    const repos = report.repos.map(localityRepo);
    localityByNode.set(report.nodeId, {
      nodeId: report.nodeId,
      generatedAt: report.generatedAt,
      repoCount: repos.length,
      worktreeCount: repos.reduce(
        (sum, repo) => sum + repo.worktrees.length,
        0
      ),
      repos,
    });
  }
  return localityByNode;
}

export function repoLocalitySummary(locality: NodeRepoLocality): string {
  if (locality.repoCount === 0) return 'no repo locality reported yet';
  const repoLabel =
    locality.repoCount === 1 ? '1 repo' : `${locality.repoCount} repos`;
  const worktreeLabel =
    locality.worktreeCount === 1
      ? '1 worktree'
      : `${locality.worktreeCount} worktrees`;
  return `${repoLabel} · ${worktreeLabel}`;
}

export function repoLocalityMapSummary(
  localityByNode: Map<string, NodeRepoLocality>
): string {
  const totals = Array.from(localityByNode.values()).reduce(
    (acc, locality) => ({
      repoCount: acc.repoCount + locality.repoCount,
      worktreeCount: acc.worktreeCount + locality.worktreeCount,
    }),
    { repoCount: 0, worktreeCount: 0 }
  );
  if (totals.repoCount === 0) return 'no repo locality reported yet';
  const repoLabel =
    totals.repoCount === 1 ? '1 repo' : `${totals.repoCount} repos`;
  const worktreeLabel =
    totals.worktreeCount === 1
      ? '1 worktree'
      : `${totals.worktreeCount} worktrees`;
  return `${repoLabel} · ${worktreeLabel}`;
}

function blockerLabel(
  label: string,
  status: NodeCapabilityStatus
): string | null {
  if (status === 'available') return null;
  return `${label} ${status}`;
}

function disabledReason(
  node: HubNodeSummary,
  capabilityHints: HubNodeCapabilityHint[]
): string | null {
  if (node.status === 'revoked') return 'not attachable: node was revoked';
  if (node.status === 'offline') return 'not attachable: node is offline';
  if (node.status === 'stale') return 'not attachable: heartbeat is stale';
  if (node.status === 'updating')
    return 'not attachable: node is updating — new sessions blocked until update completes';
  if (node.helperSkew?.category === 'major-skew-error')
    return `not attachable: ${node.helperSkew.message}${node.helperSkew.remediationHint ? ` — ${node.helperSkew.remediationHint}` : ''}`;
  if (node.trust?.policy?.revokedAt) return 'work disabled: policy revoked';
  if (node.trust?.policy?.supersededBy)
    return 'work disabled: policy superseded';

  const blockers = readinessCapabilities.flatMap((key) => {
    const hint = capabilityHints.find((candidate) => candidate.key === key);
    const label = hint?.label ?? key;
    const status = hint?.status ?? 'unknown';
    const blocker = blockerLabel(label, status);
    return blocker ? [blocker] : [];
  });

  const agentHint = capabilityHints.find(
    (candidate) => candidate.key === 'agents'
  );
  if (agentHint && agentHint.status !== 'available') {
    const blocker = blockerLabel(agentHint.label, agentHint.status);
    if (blocker) blockers.push(blocker);
  }

  if (blockers.length > 0) return `work disabled: ${blockers.join('; ')}`;
  return null;
}

function capabilityHints(node: HubNodeSummary): HubNodeCapabilityHint[] {
  const core = node.capabilities.core;
  const agents = aggregateAgentStatus(node.capabilities.agents ?? {});
  return [
    { key: 'shell', label: 'shell', status: fallbackStatus(core?.shell) },
    { key: 'tmux', label: 'tmux', status: fallbackStatus(core?.tmux) },
    { key: 'git', label: 'git', status: fallbackStatus(core?.git) },
    {
      key: 'worktrees',
      label: 'worktrees',
      // Worktrees is a repo-feature-layer capability. Per #435 it is no
      // longer carried on the core summary. Until a repo feature
      // decorator publishes it explicitly on `capabilities.worktrees`,
      // derive from `core.git` — historically the worktree capability
      // mirrored git availability and that's still the closest signal.
      status: fallbackStatus(node.capabilities.worktrees ?? core?.git),
    },
    { key: 'agents', label: 'agents', status: agents },
    {
      key: 'browserAutomation',
      label: 'browser',
      status: fallbackStatus(core?.browserAutomation),
    },
    {
      key: 'clipboardImage',
      label: 'clipboard',
      status: fallbackStatus(core?.clipboardImage),
    },
    { key: 'ssh', label: 'ssh', status: fallbackStatus(core?.ssh) },
    {
      key: 'tailscale',
      label: 'tailscale',
      status: fallbackStatus(core?.tailscale),
    },
    {
      key: 'serviceManager',
      label: 'service',
      status: serviceManagerStatus(node.capabilities.serviceManager),
    },
  ];
}

export function deriveHubNodeDashboardRows(
  nodes: HubNodeSummary[],
  options: DeriveOptions = {}
): HubNodeDashboardRow[] {
  const now = options.now ?? new Date();
  const expectedProtocolVersion =
    options.expectedProtocolVersion ?? RELAY_NODE_LINK_PROTOCOL_VERSION;

  return nodes.map((node) => {
    const hints = capabilityHints(node);
    const security = deriveNodeSecurityVisibility(node);
    const reason = disabledReason(node, hints);
    const route = node.connection?.route ?? 'unknown';
    const routeStatus = node.connection?.status ?? node.status;
    const versionWarning =
      node.protocolVersion === expectedProtocolVersion
        ? null
        : `protocol ${node.protocolVersion} != hub ${expectedProtocolVersion}`;

    const helperSkewWarning =
      node.helperSkew && node.helperSkew.category !== 'compatible'
        ? node.helperSkew.message
        : null;

    return {
      nodeId: node.nodeId,
      displayName: node.displayName,
      hostname: node.hostname,
      hostLabel: `${node.hostname} · ${node.platform}/${node.arch}`,
      status: node.status,
      statusTone: node.status,
      routeLabel: `${route} · ${routeStatus}`,
      lastSeenLabel: formatRelativeTime(node.lastSeenAt, now),
      relayVersion: node.relayVersion,
      helperVersion: node.helperVersion ?? null,
      protocolVersion: node.protocolVersion,
      versionWarning,
      helperSkewWarning,
      capabilityHints: hints,
      security,
      attachable: reason === null,
      workReadiness: reason === null ? 'ready to work' : 'blocked',
      disabledReason: reason,
      fileRpcAvailable: node.fileRpcAvailable ?? null,
      degradedReasons: node.degradedReasons ?? [],
    };
  });
}

/**
 * Returns nodes where trust tier is 'prod' and the node is not revoked.
 * Used by ProdTrustBanner to determine whether the hub-wide warning should show.
 */
export function selectProdTierNodes(nodes: HubNodeSummary[]): HubNodeSummary[] {
  return nodes.filter(
    (n) =>
      (n.trust?.tier ?? n.trust?.policy?.trustTier) === 'prod' &&
      n.status !== 'revoked' &&
      !n.trust?.policy?.revokedAt &&
      !n.trust?.policy?.supersededBy
  );
}

export function hubNodeDashboardSummary(
  nodes: HubNodeSummary[],
  options: DeriveOptions = {}
): string {
  const rows = deriveHubNodeDashboardRows(nodes, options);
  const ready = rows.filter((row) => row.attachable).length;
  const offlineOrStale = rows.filter(
    (row) =>
      row.status === 'offline' ||
      row.status === 'stale' ||
      row.status === 'revoked'
  ).length;
  const blockedByCapabilities = rows.filter(
    (row) => !row.attachable && row.disabledReason?.startsWith('work disabled:')
  ).length;
  const policyUnavailable = rows.filter(
    (row) => row.security.policyRef === null
  ).length;
  const prodHighRisk = rows.filter(
    (row) => row.security.trustTier === 'prod' && row.security.tone === 'danger'
  ).length;

  return `${ready}/${rows.length} nodes ready · ${blockedByCapabilities} blocked by capabilities · ${offlineOrStale} offline/stale · ${policyUnavailable} policy unavailable · ${prodHighRisk} prod high-risk`;
}
