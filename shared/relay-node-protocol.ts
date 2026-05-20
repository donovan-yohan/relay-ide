import type { RelayAclSummary, RelayTrustTier } from './security-policy.js';
import type { NodeManifestDegradedReason } from './node-manifest.js';

export const RELAY_NODE_LINK_PROTOCOL = 'relay-node-link' as const;
export const RELAY_NODE_LINK_PROTOCOL_VERSION = '1.0' as const;

export type RelayNodeLinkProtocol = typeof RELAY_NODE_LINK_PROTOCOL;
export type RelayNodeProtocolVersion = string;

export type RelayNodeChannel = 'control' | 'rpc' | 'events' | 'pty' | 'preview';

export type RelayNodeErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFIRMATION_REQUIRED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'NODE_REVOKED'
  | 'NODE_OFFLINE'
  | 'NODE_UNSUPPORTED'
  | 'NODE_BUSY'
  | 'ROTATION_IN_PROGRESS'
  | 'UNSUPPORTED_CAPABILITY'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'SESSION_MISMATCH'
  | 'SESSION_NON_RENEWABLE'
  | 'PROTOCOL_INCOMPATIBLE'
  | 'VERSION_SKEW'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'INTERNAL';

export interface RelayNodeError {
  code: RelayNodeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface RelayNodeEnvelope {
  protocol: RelayNodeLinkProtocol;
  protocolVersion: RelayNodeProtocolVersion;
  nodeId: string;
  channel: RelayNodeChannel;
  type: string;
  requestId?: string;
  streamId?: string;
  timestamp: string;
  payload?: unknown;
  error?: RelayNodeError;
}

export interface RelayNodeCredential {
  protocol: RelayNodeLinkProtocol;
  protocolVersion: typeof RELAY_NODE_LINK_PROTOCOL_VERSION;
  nodeId: string;
  credentialId: string;
  token: string;
  issuedAt: string;
}

export type HubNodeStatus =
  | 'online'
  | 'stale'
  | 'offline'
  | 'revoked'
  | 'updating';
export type HubNodeCredentialRotationState =
  | 'issuing'
  | 'delivered'
  | 'proved'
  | 'stable'
  | 'failed';
export type HubNodeCredentialState =
  | 'active'
  | 'rotating'
  | 'rotation-failed'
  | 'revoked';

export interface HubNodeCredentialRotationSummary {
  rotationId: string;
  state: HubNodeCredentialRotationState;
  previousCredentialId: string;
  nextCredentialId: string;
  issuedAt: string;
  deliveredAt?: string;
  provedAt?: string;
  stableAt?: string;
  failedAt?: string;
  failureReason?: string;
}
export type HubNodeTrustState = 'active' | 'trusted' | 'paired' | 'revoked';
export type HubNodeTrustLevel =
  | RelayTrustTier
  | 'privileged-local-user'
  | 'standard';
export type HubNodeVersionState =
  | 'compatible'
  | 'version-skew'
  | 'incompatible';

/**
 * Hub↔node helper-version (binary) skew categories.
 * Distinct from the node-link protocol version check:
 *   - `compatible`       — helperVersion matches hub version or is within 2 minor versions
 *   - `minor-skew-warn`  — same major, minor gap > 0 but sessions are allowed
 *   - `major-skew-error` — different major; new session-create blocked (HTTP 503)
 */
export type HubNodeHelperSkewCategory =
  | 'compatible'
  | 'minor-skew-warn'
  | 'major-skew-error';

export interface HubNodeHelperSkewSummary {
  category: HubNodeHelperSkewCategory;
  helperVersion: string;
  hubVersion: string;
  message: string;
  remediationHint?: string;
}

export type NodeCapabilityStatus =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export type HubNodeCoreCapability =
  | 'shell'
  | 'tmux'
  | 'git'
  | 'browserAutomation'
  | 'clipboardImage'
  | 'ssh'
  | 'tailscale';

/**
 * Mirrors `NodeSessionResumeKind` from `shared/node-manifest.ts` but
 * lives on the hub-facing summary so frontend code can read it
 * without depending on the full manifest type.
 */
export type HubNodeSessionResumeKind = 'tmux' | 'canonical-emulator' | 'none';

export interface HubNodeConnectionSummary {
  route: 'reverse-link' | 'local' | 'unknown';
  status: string;
}

export interface NodeCapabilityManifestSummary {
  totals: {
    available: number;
    degraded: number;
    unavailable: number;
    unknown: number;
  };
  core: Record<HubNodeCoreCapability, NodeCapabilityStatus>;
  /**
   * Repo-feature-layer capability. Optional on the wire so a node with
   * no repo feature decorator wired in (or no repo capability at all)
   * can publish a coherent core summary. Consumers should fall back to
   * deriving from `core.git` when this is absent; the canonical worktree
   * capability is just "is git usable here?" until the repo feature
   * grows richer semantics.
   */
  worktrees?: NodeCapabilityStatus;
  agents: Record<string, NodeCapabilityStatus>;
  serviceManager: string;
  wsl: boolean;
  /**
   * #467: how the node persists a PTY across detach. Optional on the
   * wire — pre-#467 nodes do not publish it. Frontend treats absence
   * as 'none'.
   */
  sessionResume?: HubNodeSessionResumeKind;
}

export interface HubNodeSummary {
  nodeId: string;
  displayName: string;
  hostname: string;
  homeDir?: string;
  platform: string;
  arch: string;
  relayVersion: string;
  /**
   * Canonical helper binary version. Populated from `NodeManifest.helperVersion`
   * on heartbeat; absent on pre-#651 nodes that did not publish it.
   */
  helperVersion?: string;
  protocolVersion: string;
  status: HubNodeStatus;
  connection: HubNodeConnectionSummary;
  trust: {
    state: HubNodeTrustState;
    level: HubNodeTrustLevel;
    tier?: RelayTrustTier;
    warning?: string;
    policy?: RelayAclSummary;
  };
  credentialState: HubNodeCredentialState;
  credentialRotation?: HubNodeCredentialRotationSummary;
  version: {
    state: HubNodeVersionState;
    nodeProtocolVersion: string;
    hubProtocolVersion: typeof RELAY_NODE_LINK_PROTOCOL_VERSION;
  };
  /** Helper-binary version skew summary. Present when the node has reported helperVersion. */
  helperSkew?: HubNodeHelperSkewSummary;
  capabilities: NodeCapabilityManifestSummary;
  /**
   * Whether File RPC is available on this node. Populated from
   * `NodeManifest.fileRpc.available` on heartbeat; absent on pre-#651 nodes.
   * Consumers should treat `undefined` as unknown (not explicitly unavailable).
   */
  fileRpcAvailable?: boolean;
  /**
   * Structured degraded reasons from the node manifest. Populated on heartbeat
   * when the manifest includes `degradedReasons[]`. Empty on healthy nodes.
   */
  degradedReasons?: NodeManifestDegradedReason[];
  createdAt: string;
  pairedAt: string;
  lastSeenAt: string;
  credentialId: string;
}
