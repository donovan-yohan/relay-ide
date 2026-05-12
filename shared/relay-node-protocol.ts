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

export interface NodeCapabilityManifestSummary {
  totals: {
    available: number;
    degraded: number;
    unavailable: number;
    unknown: number;
  };
  agents: Record<string, 'available' | 'degraded' | 'unavailable' | 'unknown'>;
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
  capabilities: NodeCapabilityManifestSummary;
  createdAt: string;
  pairedAt: string;
  lastSeenAt: string;
  credentialId: string;
}
