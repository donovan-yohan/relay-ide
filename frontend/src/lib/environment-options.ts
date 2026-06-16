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
  EnvironmentAgentProvider,
  EnvironmentDegradedReason,
  EnvironmentFreshness,
  EnvironmentOption,
  EnvironmentProviderAvailability,
} from '../../../shared/environment-option.js';
import type {
  HubNodeSummary,
  NodeCapabilityStatus,
} from '../../../shared/relay-node-protocol.js';
import {
  nodeHasTerminalBackend,
  nodeTerminalBackends,
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
  /** 'agent' uses agent + shell + terminal backend requirement; 'terminal' is shell + terminal backend only. */
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
  } else if (node.status === 'updating') {
    // #861(A): a node mid-update cannot accept new launches. Distinct from
    // stale/offline so the picker and launch boundary can render/gate it
    // separately. Copy mirrors `node-dashboard.ts` `disabledReason`.
    freshness = 'updating';
    reasons.push({
      kind: 'other',
      message: 'node is updating — new sessions blocked until update completes',
      code: 'updating',
    });
  }

  // #861(C): protocol + helper version skew, mapped to the typed `version-skew`
  // reason. Extracted into a helper to keep this function's branch count low.
  const skewReasons = versionSkewReasons(node);
  if (skewReasons.length > 0) {
    if (freshness === 'fresh') freshness = 'stale';
    reasons.push(...skewReasons);
  }

  if (capabilityProblem(node.capabilities.core.shell) !== null) {
    if (freshness === 'fresh') freshness = 'stale';
    reasons.push({
      kind: 'capability-missing',
      capability: 'session:create:terminal',
      message: `shell ${node.capabilities.core.shell ?? 'unknown'}`,
    });
  }
  if (!nodeHasTerminalBackend(node)) {
    const backends = nodeTerminalBackends(node);
    if (freshness === 'fresh') freshness = 'stale';
    reasons.push({
      kind: 'capability-missing',
      capability: 'session:create:terminal',
      message: `terminal backend unavailable (relay-pty ${backends['relay-pty']})`,
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

/**
 * #861(C): derive `version-skew` degraded reasons for a node, covering both the
 * node-link protocol version (`scope: 'protocol'`) and the helper binary
 * (`scope: 'helper'`). Protocol copy is preserved 1:1 from the legacy
 * `{ kind: 'other', code: versionState }` mapping so existing UI strings do not
 * regress; helper copy is taken verbatim from the node's `helperSkew` summary,
 * matching the established `node-dashboard.ts` `disabledReason` rendering.
 */
function versionSkewReasons(node: HubNodeSummary): EnvironmentDegradedReason[] {
  const reasons: EnvironmentDegradedReason[] = [];
  const versionState = node.version?.state;
  if (versionState === 'incompatible' || versionState === 'version-skew') {
    reasons.push({
      kind: 'version-skew',
      scope: 'protocol',
      category: versionState,
      message:
        versionState === 'incompatible'
          ? 'node protocol is incompatible'
          : 'node has version skew',
    });
  }
  const helperSkew = node.helperSkew;
  if (
    helperSkew &&
    (helperSkew.category === 'minor-skew-warn' ||
      helperSkew.category === 'major-skew-error')
  ) {
    reasons.push({
      kind: 'version-skew',
      scope: 'helper',
      category: helperSkew.category,
      message: helperSkew.message,
      ...(helperSkew.remediationHint
        ? { remediationHint: helperSkew.remediationHint }
        : {}),
    });
  }
  return reasons;
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
  // New PTY sessions require shell plus relay-pty.
  const shellOk = capabilityProblem(node.capabilities.core.shell) === null;
  const terminalBackendOk = nodeHasTerminalBackend(node);
  if (shellOk && terminalBackendOk) {
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
    identity: {
      nodeId: DEFAULT_LOCAL_NODE_ID,
      displayName: 'local',
      hostname: 'local',
      createdAt: '',
      pairedAt: '',
    },
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
    credential: {
      credentialId: 'local',
      issuedAt: '',
      state: 'active',
    },
    version: {
      state: 'compatible',
      nodeProtocolVersion: 'local',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 7, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        git: 'available',
        browserAutomation: 'available',
        clipboardImage: 'available',
        ssh: 'available',
        tailscale: 'available',
      },
      terminalBackends: {
        'relay-pty': 'available',
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

/**
 * #861(B): map a node's `NodeCapabilityStatus` for one agent provider to a
 * short reason string sourced from the `RelayNodeErrorCode` vocabulary. Only
 * non-`available` providers get a reason; `available` returns `undefined`.
 */
function providerReasonFor(status: NodeCapabilityStatus): string | undefined {
  switch (status) {
    case 'available':
      return undefined;
    case 'unavailable':
      // The provider is not installed/usable on the node.
      return 'UNSUPPORTED_CAPABILITY';
    case 'degraded':
      // Present but not fully ready (e.g. auth/login required).
      return 'REPAIR_REQUIRED';
    case 'unknown':
    default:
      // Capability not reported by the node manifest.
      return 'NODE_UNSUPPORTED';
  }
}

/**
 * #861(B): derive the `EnvironmentAgentProvider[]` for a node from
 * `node.capabilities.agents`. `availability` maps 1:1 from
 * `NodeCapabilityStatus`; `reason` is filled from the `RelayNodeErrorCode`
 * vocabulary for non-available providers. Data-only — no launcher UI.
 *
 * Iteration order follows `Object.entries`, which preserves the insertion
 * order of the agents record as the node reported it.
 */
function agentProvidersFor(node: HubNodeSummary): EnvironmentAgentProvider[] {
  return Object.entries(node.capabilities.agents ?? {}).map(([id, status]) => {
    const availability: EnvironmentProviderAvailability = status;
    const reason = providerReasonFor(status);
    return {
      id,
      availability,
      ...(reason ? { reason } : {}),
    } satisfies EnvironmentAgentProvider;
  });
}

function nodeSummary(node: HubNodeSummary): EnvironmentOption['node'] {
  const agentProviders = agentProvidersFor(node);
  return {
    nodeId: node.nodeId,
    kind: node.nodeId === DEFAULT_LOCAL_NODE_ID ? 'local' : 'remote',
    ...(node.displayName ? { displayName: node.displayName } : {}),
    online: node.status === 'online',
    ...(agentProviders.length > 0 ? { agentProviders } : {}),
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
    // Mark local as emitted so the paired-but-empty pass below does not also
    // add a redundant free-cwd home row for the same local node.
    emittedNodeIds.add(DEFAULT_LOCAL_NODE_ID);
  }

  // Append paired-but-empty nodes (nodes with no inventory hits) as free cwd
  // entries. This includes the local node: on a repo-less hub (#862 primary
  // use case) with no inventory and no fallbackWorkspace, the local node must
  // still yield a launchable free-cwd/home row so bare shell launch is always
  // reachable. Mirrors the existing behavior for remote paired-but-empty nodes
  // (which already surface free-cwd rows from node.homeDir).
  for (const node of input.nodes) {
    if (emittedNodeIds.has(node.nodeId)) continue;
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
    case 'version-skew':
      // #861(C): message is always present on the typed reason; remediationHint
      // is appended when set, mirroring node-dashboard.ts disabledReason copy.
      return reason.remediationHint
        ? `${reason.message} — ${reason.remediationHint}`
        : reason.message;
    case 'cwd-invalid':
      // #861(D): live population is deferred to the launcher slices; this arm
      // exists so the never-default exhaustiveness check stays green.
      return reason.message ?? `cwd unavailable at ${reason.cwd}`;
    case 'other':
      return reason.message;
    default: {
      const _exhaustive: never = reason;
      return String(_exhaustive);
    }
  }
}
