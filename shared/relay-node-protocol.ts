export const RELAY_NODE_LINK_PROTOCOL = 'relay-node-link' as const;
export const RELAY_NODE_LINK_PROTOCOL_VERSION = '1.0' as const;

export type RelayNodeLinkProtocol = typeof RELAY_NODE_LINK_PROTOCOL;
export type RelayNodeProtocolVersion = string;

export type RelayNodeChannel = 'control' | 'rpc' | 'events' | 'pty' | 'preview';

export type RelayNodeErrorCode =
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'NODE_REVOKED'
  | 'NODE_OFFLINE'
  | 'NODE_UNSUPPORTED'
  | 'NODE_BUSY'
  | 'UNSUPPORTED_CAPABILITY'
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

export type HubNodeStatus = 'online' | 'stale' | 'offline' | 'revoked';
export type HubNodeCredentialState = 'active' | 'revoked';
export type HubNodeTrustState = 'trusted' | 'revoked';
export type HubNodeTrustLevel = 'privileged-local-user';
export type HubNodeVersionState =
  | 'compatible'
  | 'version-skew'
  | 'incompatible';

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
}

export interface HubNodeSummary {
  nodeId: string;
  displayName: string;
  hostname: string;
  platform: string;
  arch: string;
  relayVersion: string;
  protocolVersion: string;
  status: HubNodeStatus;
  connection: HubNodeConnectionSummary;
  trust: {
    state: HubNodeTrustState;
    level: HubNodeTrustLevel;
    warning: string;
  };
  credentialState: HubNodeCredentialState;
  version: {
    state: HubNodeVersionState;
    nodeProtocolVersion: string;
    hubProtocolVersion: typeof RELAY_NODE_LINK_PROTOCOL_VERSION;
  };
  capabilities: NodeCapabilityManifestSummary;
  createdAt: string;
  pairedAt: string;
  lastSeenAt: string;
  credentialId: string;
}
