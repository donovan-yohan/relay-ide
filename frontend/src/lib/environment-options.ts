// Conversion helpers (#629): adapt the existing hub data sources
// (`AggregatedRepoInventoryResponse` from `/hub/repo-inventory` and
// `HubNodeSummary[]` from `/hub/nodes`) into the canonical
// `EnvironmentOption[]` shape the new picker (#627) consumes.
//
// Scope of this module:
//   - Pure functions only. No I/O, no React, no clock reads beyond what the
//     caller passes in via `generatedAt`. Test in isolation.
//   - Produces stable `EnvironmentOption.id`s composed of
//     `nodeId + repoInstanceId + worktreeInstanceId` so the picker's
//     selection survives re-renders and TanStack Query refetches.
//   - Maps existing block reasons (`nodeAgentBlockReason` /
//     `nodeShellBlockReason`) into typed `EnvironmentDegradedReason`s so the
//     dialog can surface the same "node offline / stale / capability missing"
//     copy without a parallel translation table.
//   - Per the epic #615 acceptance criterion, never silently substitutes a
//     different node when the selected one is stale/offline. This module is a
//     converter: callers decide selection via `pickDefaultEnvironment`.
//
// This file does NOT modify the picker component or `pickDefaultEnvironment`.
// Both are imported as-is from `frontend/src/components/EnvironmentPicker.tsx`
// (#627) and `shared/safe-defaults.ts` (#628).

import type {
  EnvironmentDegradedReason,
  EnvironmentFreshness,
  EnvironmentOption,
} from '../../../shared/environment-option.js';
import type {
  HubNodeSummary,
  NodeCapabilityStatus,
} from '../../../shared/relay-node-protocol.js';
import type {
  AggregatedRepoInventoryGroup,
  AggregatedRepoInventoryResponse,
  RepoInventoryRepoInstance,
  RepoInventoryWorktreeInstance,
} from '../../../shared/repo-inventory.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  type NodeId,
} from '../../../shared/identity.js';
import type { RelayCapabilityBit } from '../../../shared/security-policy.js';
import type { AgentType } from './types.js';

export interface BuildEnvironmentOptionsInput {
  inventory: AggregatedRepoInventoryResponse | null;
  nodes: HubNodeSummary[];
  /** Agent the dialog has selected — controls capability-missing reasons. */
  selectedAgent: AgentType;
  /** 'agent' uses agent + shell + tmux requirement; 'terminal' is shell + tmux only. */
  sessionType: 'agent' | 'terminal';
  /** Fallback when inventory is empty — typically the active workspace. */
  fallbackWorkspace?: {
    name: string;
    path: string;
    isGitRepo?: boolean;
  } | null;
  fallbackWorktreePath?: string | null;
  /** ISO string used as `generatedAt` on each option. Passed in for determinism. */
  generatedAt: string;
}

// Map a `HubNodeSummary` into the picker's degraded reasons + freshness.
// Mirrors `nodeShellBlockReason`/`nodeAgentBlockReason` from
// CustomizeSessionDialog so existing UI copy stays consistent — only the
// transport shape (string → typed union) changes.
function nodeFreshnessAndReasons(
  node: HubNodeSummary | null,
  sessionType: 'agent' | 'terminal',
  selectedAgent: AgentType,
  lastSeenAt: string | undefined
): { freshness: EnvironmentFreshness; reasons: EnvironmentDegradedReason[] } {
  const reasons: EnvironmentDegradedReason[] = [];
  if (!node) {
    return {
      freshness: 'offline',
      reasons: [{ kind: 'node-offline', message: 'node availability unknown' }],
    };
  }
  let freshness: EnvironmentFreshness = 'fresh';
  if (node.status === 'offline' || node.status === 'revoked') {
    freshness = 'offline';
    reasons.push({
      kind: 'node-offline',
      message:
        node.status === 'revoked' ? 'node is revoked' : 'node is offline',
      ...(lastSeenAt ? { lastSeenAt } : {}),
    });
  } else if (node.status === 'stale') {
    freshness = 'stale';
    reasons.push({
      kind: 'node-stale',
      lastSeenAt: lastSeenAt ?? node.lastSeenAt ?? '',
      message: 'heartbeat is stale',
    });
  }

  const versionState = node.version?.state;
  if (versionState === 'incompatible' || versionState === 'version-skew') {
    if (freshness === 'fresh') freshness = 'stale';
    reasons.push({
      kind: 'other',
      message:
        versionState === 'incompatible'
          ? 'node protocol is incompatible'
          : 'node has version skew',
      code: versionState,
    });
  }

  if (capabilityProblem(node.capabilities.core.shell) !== null) {
    if (freshness === 'fresh') freshness = 'stale';
    reasons.push({
      kind: 'capability-missing',
      capability: 'session:create:terminal',
      message: `shell ${node.capabilities.core.shell ?? 'unknown'}`,
    });
  }
  if (capabilityProblem(node.capabilities.core.tmux) !== null) {
    if (freshness === 'fresh') freshness = 'stale';
    reasons.push({
      kind: 'capability-missing',
      capability: 'session:create:terminal',
      message: `tmux ${node.capabilities.core.tmux ?? 'unknown'}`,
    });
  }
  if (sessionType === 'agent') {
    const agentStatus = node.capabilities.agents[selectedAgent];
    if (capabilityProblem(agentStatus) !== null) {
      if (freshness === 'fresh') freshness = 'stale';
      // `displayName` is optional on `HubNodeSummary` — fall back to
      // `nodeId` so the message stays meaningful instead of printing
      // "on undefined" (Gemini PR #647 review).
      reasons.push({
        kind: 'capability-missing',
        capability: 'session:create:agent',
        message: `${selectedAgent} ${agentStatus ?? 'unknown'} on ${node.displayName ?? node.nodeId}`,
      });
    }
  }

  return { freshness, reasons };
}

function capabilityProblem(
  capability: NodeCapabilityStatus | undefined
): string | null {
  if (capability === undefined) return 'unknown';
  if (capability === 'available') return null;
  return capability;
}

function baseCapabilitiesFor(
  node: HubNodeSummary | null,
  sessionType: 'agent' | 'terminal'
): RelayCapabilityBit[] {
  if (!node) return [];
  const caps: RelayCapabilityBit[] = ['session:read'];
  // tmux is mandatory for both terminal and agent PTY sessions (see
  // CLAUDE.md §Key Patterns and `nodeShellBlockReason` /
  // `nodeAgentBlockReason` in CustomizeSessionDialog). A node without it
  // cannot host create-terminal/create-agent regardless of shell status,
  // so the picker must not advertise those capabilities (Gemini PR #647
  // high-priority finding).
  const shellOk = capabilityProblem(node.capabilities.core.shell) === null;
  const tmuxOk = capabilityProblem(node.capabilities.core.tmux) === null;
  if (shellOk && tmuxOk) {
    caps.push('session:create:terminal');
    if (sessionType === 'agent') {
      caps.push('session:create:agent');
    }
  }
  return caps;
}

function syntheticLocalNode(): HubNodeSummary {
  return {
    nodeId: DEFAULT_LOCAL_NODE_ID,
    displayName: 'local',
    hostname: 'local',
    platform: 'local',
    arch: 'unknown',
    relayVersion: 'local',
    protocolVersion: 'local',
    status: 'online',
    connection: { route: 'local', status: 'connected' },
    trust: { state: 'trusted', level: 'privileged-local-user', warning: '' },
    credentialState: 'active',
    version: {
      state: 'compatible',
      nodeProtocolVersion: 'local',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 8, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        tmux: 'available',
        git: 'available',
        browserAutomation: 'available',
        clipboardImage: 'available',
        ssh: 'available',
        tailscale: 'available',
      },
      worktrees: 'available',
      agents: {},
      serviceManager: 'local',
      wsl: false,
    },
    createdAt: '',
    pairedAt: '',
    lastSeenAt: '',
    credentialId: 'local',
  };
}

function nodeSummary(node: HubNodeSummary): EnvironmentOption['node'] {
  return {
    nodeId: node.nodeId,
    kind: node.nodeId === DEFAULT_LOCAL_NODE_ID ? 'local' : 'remote',
    ...(node.displayName ? { displayName: node.displayName } : {}),
    online: node.status === 'online',
  };
}

function optionIdFor(
  nodeId: NodeId,
  repoInstanceId: string | null,
  worktreeInstanceId: string | null
): string {
  const parts = [
    nodeId,
    repoInstanceId ?? '__none__',
    worktreeInstanceId ?? '__none__',
  ];
  return parts.join('|');
}

function emitRepoInstanceOptions(
  instance: RepoInventoryRepoInstance,
  node: HubNodeSummary,
  freshness: EnvironmentFreshness,
  reasons: EnvironmentDegradedReason[],
  caps: RelayCapabilityBit[],
  generatedAt: string
): EnvironmentOption[] {
  const repoSummary = {
    repoInstanceId: instance.repoInstanceId,
    localPath: instance.localPath,
    repoIdentity: instance.repoIdentity,
    name: instance.name,
    currentBranch: instance.currentBranch,
    defaultBranch: instance.defaultBranch,
  };
  const options: EnvironmentOption[] = [];
  // Repo root option
  options.push({
    schemaVersion: 1,
    id: optionIdFor(node.nodeId, instance.repoInstanceId, null),
    node: nodeSummary(node),
    capabilities: caps,
    cwd: instance.localPath,
    cwdMode: instance.isGitRepo ? 'repo' : 'free',
    freshness,
    ...(reasons.length > 0 ? { degradedReasons: reasons } : {}),
    ...(instance.isGitRepo ? { repoInstance: repoSummary } : {}),
    generatedAt,
  });
  // Worktree options
  for (const worktree of instance.worktrees) {
    options.push(
      emitWorktreeOption(
        instance,
        worktree,
        node,
        freshness,
        reasons,
        caps,
        generatedAt,
        repoSummary
      )
    );
  }
  return options;
}

function emitWorktreeOption(
  instance: RepoInventoryRepoInstance,
  worktree: RepoInventoryWorktreeInstance,
  node: HubNodeSummary,
  freshness: EnvironmentFreshness,
  reasons: EnvironmentDegradedReason[],
  caps: RelayCapabilityBit[],
  generatedAt: string,
  repoSummary: NonNullable<EnvironmentOption['repoInstance']>
): EnvironmentOption {
  return {
    schemaVersion: 1,
    id: optionIdFor(
      node.nodeId,
      instance.repoInstanceId,
      worktree.worktreeInstanceId
    ),
    node: nodeSummary(node),
    capabilities: caps,
    cwd: worktree.localPath,
    cwdMode: 'repo',
    freshness,
    ...(reasons.length > 0 ? { degradedReasons: reasons } : {}),
    repoInstance: repoSummary,
    bench: {
      worktreeInstanceId: worktree.worktreeInstanceId,
      localPath: worktree.localPath,
      branchName: worktree.branchName,
      ...(worktree.displayName ? { displayName: worktree.displayName } : {}),
    },
    generatedAt,
  };
}

function fallbackOptions(
  input: BuildEnvironmentOptionsInput,
  syntheticNode: HubNodeSummary,
  generatedAt: string
): EnvironmentOption[] {
  const fallback = input.fallbackWorkspace;
  if (!fallback) return [];
  const { freshness, reasons } = nodeFreshnessAndReasons(
    syntheticNode,
    input.sessionType,
    input.selectedAgent,
    undefined
  );
  const caps = baseCapabilitiesFor(syntheticNode, input.sessionType);
  const isGit = fallback.isGitRepo !== false;
  const id = optionIdFor(syntheticNode.nodeId, fallback.path, null);
  const options: EnvironmentOption[] = [];
  options.push({
    schemaVersion: 1,
    id,
    node: nodeSummary(syntheticNode),
    capabilities: caps,
    cwd: fallback.path,
    cwdMode: isGit ? 'repo' : 'free',
    freshness,
    ...(reasons.length > 0 ? { degradedReasons: reasons } : {}),
    ...(isGit
      ? {
          repoInstance: {
            repoInstanceId: fallback.path,
            localPath: fallback.path,
            repoIdentity: null,
            name: fallback.name,
            currentBranch: null,
            defaultBranch: null,
          },
        }
      : {}),
    generatedAt,
  });
  if (isGit && input.fallbackWorktreePath) {
    const worktreePath = input.fallbackWorktreePath;
    options.push({
      schemaVersion: 1,
      id: optionIdFor(syntheticNode.nodeId, fallback.path, worktreePath),
      node: nodeSummary(syntheticNode),
      capabilities: caps,
      cwd: worktreePath,
      cwdMode: 'repo',
      freshness,
      ...(reasons.length > 0 ? { degradedReasons: reasons } : {}),
      repoInstance: {
        repoInstanceId: fallback.path,
        localPath: fallback.path,
        repoIdentity: null,
        name: fallback.name,
        currentBranch: null,
        defaultBranch: null,
      },
      bench: {
        worktreeInstanceId: worktreePath,
        localPath: worktreePath,
        branchName: null,
        displayName: worktreePath.split('/').pop() ?? worktreePath,
      },
      generatedAt,
    });
  }
  return options;
}

/**
 * Convert inventory + nodes into `EnvironmentOption[]` for the picker (#627).
 *
 * Order is stable: inventory group order is preserved, instances within a
 * group keep inventory order, and the local-fallback options (if any) follow
 * the inventory ones. This matters because `pickDefaultEnvironment` (#628)
 * falls back to the first-fresh candidate in the supplied order when there is
 * no active tab and no history match.
 *
 * Nodes paired with the hub but absent from inventory (no repos checked out)
 * appear as a single free / non-git cwd option pointing at the node's
 * displayName-less home (cwd `''` — caller is expected to prompt for a cwd
 * before launching against this option, matching the existing remote-cwd lane
 * the dialog already supports).
 */
export function buildEnvironmentOptions(
  input: BuildEnvironmentOptionsInput
): EnvironmentOption[] {
  const nodesById = new Map<NodeId, HubNodeSummary>(
    input.nodes.map((node) => [node.nodeId, node])
  );
  if (!nodesById.has(DEFAULT_LOCAL_NODE_ID)) {
    nodesById.set(DEFAULT_LOCAL_NODE_ID, syntheticLocalNode());
  }
  const generatedAt = input.generatedAt;
  const options: EnvironmentOption[] = [];
  const groups: AggregatedRepoInventoryGroup[] = input.inventory?.groups ?? [];

  // Track which (node, repoInstance) pairs we've emitted so the
  // remote-only-node pass below doesn't double-list them as free cwd entries.
  const emittedNodeIds = new Set<NodeId>();

  for (const group of groups) {
    for (const instance of group.instances) {
      const node =
        nodesById.get(instance.nodeId) ??
        syntheticForUnknownNode(instance.nodeId);
      const { freshness, reasons } = nodeFreshnessAndReasons(
        node,
        input.sessionType,
        input.selectedAgent,
        node.lastSeenAt
      );
      const caps = baseCapabilitiesFor(node, input.sessionType);
      const next = emitRepoInstanceOptions(
        instance,
        node,
        freshness,
        reasons,
        caps,
        generatedAt
      );
      options.push(...next);
      emittedNodeIds.add(node.nodeId);
    }
  }

  // Append fallback workspace if inventory is empty / didn't surface the
  // active workspace as a group. Without this the picker would render no
  // options on a fresh hub with no remote inventory yet, blocking launch.
  if (
    input.fallbackWorkspace &&
    !options.some((opt) => opt.cwd === input.fallbackWorkspace?.path)
  ) {
    const fallback = fallbackOptions(
      input,
      nodesById.get(DEFAULT_LOCAL_NODE_ID)!,
      generatedAt
    );
    options.push(...fallback);
  }

  // Append paired-but-empty nodes (remote nodes with no inventory) as free
  // cwd entries. Mirrors the existing dialog behavior where remote nodes
  // surface a free-text cwd lane even without repo metadata.
  for (const node of input.nodes) {
    if (emittedNodeIds.has(node.nodeId)) continue;
    if (node.nodeId === DEFAULT_LOCAL_NODE_ID) continue;
    const { freshness, reasons } = nodeFreshnessAndReasons(
      node,
      input.sessionType,
      input.selectedAgent,
      node.lastSeenAt
    );
    const caps = baseCapabilitiesFor(node, input.sessionType);
    options.push({
      schemaVersion: 1,
      id: optionIdFor(node.nodeId, null, null),
      node: nodeSummary(node),
      capabilities: caps,
      cwd: node.homeDir ?? '',
      cwdMode: 'free',
      freshness,
      ...(reasons.length > 0 ? { degradedReasons: reasons } : {}),
      generatedAt,
    });
  }

  return options;
}

function syntheticForUnknownNode(nodeId: NodeId): HubNodeSummary {
  // Inventory referenced a node we don't have a manifest for — treat as
  // offline so the picker surfaces it but the launch path stays blocked.
  const synthetic = syntheticLocalNode();
  return {
    ...synthetic,
    nodeId,
    displayName: nodeId,
    status: 'offline',
    capabilities: {
      ...synthetic.capabilities,
      core: {
        ...synthetic.capabilities.core,
        shell: 'unknown',
        tmux: 'unknown',
      },
      agents: {},
    },
  };
}

/**
 * Convenience helper: first the most actionable reason from a degraded
 * option, used to render the "block launch" chip in the dialog.
 */
export function firstDegradedReasonMessage(
  reasons: EnvironmentDegradedReason[] | undefined
): string | null {
  if (!reasons || reasons.length === 0) return null;
  const reason = reasons[0]!;
  switch (reason.kind) {
    case 'node-offline':
      return reason.message ?? 'node offline';
    case 'node-stale':
      return reason.message ?? `node stale since ${reason.lastSeenAt}`;
    case 'capability-missing':
      return reason.message ?? `missing capability ${reason.capability}`;
    case 'repo-missing':
      return reason.message ?? 'repo missing';
    case 'worktree-missing':
      return reason.message ?? `worktree missing at ${reason.localPath}`;
    case 'auth-failed':
      return reason.message;
    case 'other':
      return reason.message;
    default: {
      const _exhaustive: never = reason;
      return String(_exhaustive);
    }
  }
}
