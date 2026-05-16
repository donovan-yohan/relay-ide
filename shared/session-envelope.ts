import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
  type GlobalSessionId,
  type LocalSessionId,
  type NodeId,
} from './identity.js';

export const LOCAL_COMPATIBILITY_SESSION_INTENT = 'local-dev-compatibility';
export const ROUTED_NODE_SESSION_INTENT = 'routed-node-session';

export type SessionIntentKind =
  | typeof LOCAL_COMPATIBILITY_SESSION_INTENT
  | typeof ROUTED_NODE_SESSION_INTENT;

export interface SessionIntent {
  /**
   * Names why this session exists. This is data for future policy hooks,
   * not a capability grant by itself.
   */
  kind: SessionIntentKind;
  description: string;
}

export type SessionScopeKind =
  | 'local-compatibility'
  | 'node-cwd'
  | 'repo'
  | 'worktree';

export interface SessionScope {
  /**
   * Compatibility/default scope is explicit so legacy local flows do not
   * silently masquerade as an all-powerful authorization bypass.
   */
  kind: SessionScopeKind;
  nodeId: NodeId;
  cwd: string;
  repoPath?: string;
  worktreePath?: string | null;
}

export type SessionPeerIdentity =
  | { kind: 'local-user'; id: string; displayName?: string }
  | { kind: 'relay-node'; nodeId: NodeId; credentialId?: string; displayName?: string }
  | { kind: 'unknown'; id?: string; displayName?: string };

export interface SessionEnvelope {
  /** Node-local session id. */
  sessionId: LocalSessionId;
  /** Node-scoped session id used by the hub for collision-free routing. */
  globalSessionId: GlobalSessionId;
  nodeId: NodeId;
  intent: SessionIntent;
  scope: SessionScope;
  issuedAt: string;
  expiresAt: string | null;
  revocable: boolean;
  peerIdentity: SessionPeerIdentity;
  correlationId?: string;
  auditId?: string;
}

export interface SessionEnvelopeFallback {
  sessionId: string;
  nodeId?: NodeId;
  globalSessionId?: GlobalSessionId;
  cwd: string;
  repoPath?: string;
  worktreePath?: string | null;
  issuedAt?: string;
  expiresAt?: string | null;
  revocable?: boolean;
  peerIdentity?: SessionPeerIdentity;
  correlationId?: string;
  auditId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return stringValue(value);
}

function isIntent(value: unknown): value is SessionIntent {
  const candidate = record(value);
  return (
    !!candidate &&
    (candidate['kind'] === LOCAL_COMPATIBILITY_SESSION_INTENT ||
      candidate['kind'] === ROUTED_NODE_SESSION_INTENT) &&
    typeof candidate['description'] === 'string'
  );
}

function isScope(value: unknown): value is SessionScope {
  const candidate = record(value);
  return (
    !!candidate &&
    (candidate['kind'] === 'local-compatibility' ||
      candidate['kind'] === 'node-cwd' ||
      candidate['kind'] === 'repo' ||
      candidate['kind'] === 'worktree') &&
    typeof candidate['nodeId'] === 'string' &&
    typeof candidate['cwd'] === 'string' &&
    (candidate['repoPath'] === undefined || typeof candidate['repoPath'] === 'string') &&
    (candidate['worktreePath'] === undefined ||
      candidate['worktreePath'] === null ||
      typeof candidate['worktreePath'] === 'string')
  );
}

function isPeerIdentity(value: unknown): value is SessionPeerIdentity {
  const candidate = record(value);
  if (!candidate) return false;
  if (candidate['kind'] === 'local-user') return typeof candidate['id'] === 'string';
  if (candidate['kind'] === 'relay-node') return typeof candidate['nodeId'] === 'string';
  return candidate['kind'] === 'unknown';
}

export function isSessionEnvelope(value: unknown): value is SessionEnvelope {
  const candidate = record(value);
  return (
    !!candidate &&
    typeof candidate['sessionId'] === 'string' &&
    typeof candidate['globalSessionId'] === 'string' &&
    typeof candidate['nodeId'] === 'string' &&
    isIntent(candidate['intent']) &&
    isScope(candidate['scope']) &&
    typeof candidate['issuedAt'] === 'string' &&
    (candidate['expiresAt'] === null || typeof candidate['expiresAt'] === 'string') &&
    typeof candidate['revocable'] === 'boolean' &&
    isPeerIdentity(candidate['peerIdentity']) &&
    (candidate['correlationId'] === undefined || typeof candidate['correlationId'] === 'string') &&
    (candidate['auditId'] === undefined || typeof candidate['auditId'] === 'string')
  );
}

function compatibilityScope(fallback: SessionEnvelopeFallback): SessionScope {
  const nodeId = fallback.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  return {
    kind: 'local-compatibility',
    nodeId,
    cwd: fallback.cwd,
    ...(fallback.repoPath ? { repoPath: fallback.repoPath } : {}),
    ...(fallback.worktreePath !== undefined
      ? { worktreePath: fallback.worktreePath }
      : {}),
  };
}

function routedScope(fallback: SessionEnvelopeFallback): SessionScope {
  const nodeId = fallback.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const kind: SessionScopeKind = fallback.worktreePath
    ? 'worktree'
    : fallback.repoPath
      ? 'repo'
      : 'node-cwd';
  return {
    kind,
    nodeId,
    cwd: fallback.cwd,
    ...(fallback.repoPath ? { repoPath: fallback.repoPath } : {}),
    ...(fallback.worktreePath !== undefined
      ? { worktreePath: fallback.worktreePath }
      : {}),
  };
}

export function createLocalCompatibilitySessionEnvelope(
  fallback: SessionEnvelopeFallback
): SessionEnvelope {
  const nodeId = fallback.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  return {
    sessionId: fallback.sessionId,
    globalSessionId:
      fallback.globalSessionId ?? createGlobalSessionId(nodeId, fallback.sessionId),
    nodeId,
    intent: {
      kind: LOCAL_COMPATIBILITY_SESSION_INTENT,
      description: 'legacy local/single-node Relay session compatibility',
    },
    scope: compatibilityScope(fallback),
    issuedAt: fallback.issuedAt ?? new Date().toISOString(),
    expiresAt: fallback.expiresAt ?? null,
    revocable: fallback.revocable ?? true,
    peerIdentity: fallback.peerIdentity ?? { kind: 'local-user', id: 'local-dev' },
    ...(fallback.correlationId ? { correlationId: fallback.correlationId } : {}),
    ...(fallback.auditId ? { auditId: fallback.auditId } : {}),
  };
}

export function createRoutedNodeSessionEnvelope(
  fallback: SessionEnvelopeFallback
): SessionEnvelope {
  const nodeId = fallback.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  return {
    sessionId: fallback.sessionId,
    globalSessionId:
      fallback.globalSessionId ?? createGlobalSessionId(nodeId, fallback.sessionId),
    nodeId,
    intent: {
      kind: ROUTED_NODE_SESSION_INTENT,
      description: 'hub-routed node session',
    },
    scope: routedScope({ ...fallback, nodeId }),
    issuedAt: fallback.issuedAt ?? new Date().toISOString(),
    expiresAt: fallback.expiresAt ?? null,
    revocable: fallback.revocable ?? true,
    peerIdentity: fallback.peerIdentity ?? { kind: 'relay-node', nodeId },
    ...(fallback.correlationId ? { correlationId: fallback.correlationId } : {}),
    ...(fallback.auditId ? { auditId: fallback.auditId } : {}),
  };
}

export function normalizeSessionEnvelope(
  value: unknown,
  fallback: SessionEnvelopeFallback,
  intentKind: SessionIntentKind = LOCAL_COMPATIBILITY_SESSION_INTENT
): SessionEnvelope {
  if (isSessionEnvelope(value)) {
    const normalizedNodeId = fallback.nodeId ?? value.nodeId;
    const normalizedGlobalSessionId =
      fallback.globalSessionId ?? value.globalSessionId ?? createGlobalSessionId(normalizedNodeId, value.sessionId);
    return {
      ...value,
      nodeId: normalizedNodeId,
      globalSessionId: normalizedGlobalSessionId,
      scope: { ...value.scope, nodeId: normalizedNodeId },
    };
  }
  return intentKind === ROUTED_NODE_SESSION_INTENT
    ? createRoutedNodeSessionEnvelope(fallback)
    : createLocalCompatibilitySessionEnvelope(fallback);
}

export function sessionEnvelopeKey(envelope: Pick<SessionEnvelope, 'globalSessionId'>): string {
  return envelope.globalSessionId;
}

export function sessionEnvelopeFromUnknown(value: unknown): SessionEnvelope | null {
  return isSessionEnvelope(value) ? value : null;
}

export function envelopeStringField(value: unknown): string | undefined {
  return stringValue(value);
}

export function envelopeNullableStringField(value: unknown): string | null | undefined {
  return nullableString(value);
}
