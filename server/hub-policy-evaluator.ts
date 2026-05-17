import * as path from 'node:path';
import {
  classifySecurityAuditWriteFailure,
  type SecurityAuditDecision,
  type SecurityAuditEntryInput,
  type SecurityAuditEventType,
} from '../shared/security-audit.js';
import {
  RELAY_SECURITY_POLICY_VERSION,
  isRelayCapabilityBit,
  isRelayTrustTier,
  type RelayAclSummary,
  type RelayCapabilityBit,
  type RelayPolicyScope,
  type RelayTrustTier,
} from '../shared/security-policy.js';
import type { HubNodeSummary, RelayNodeError } from '../shared/relay-node-protocol.js';
import type {
  InMemorySessionEnvelopeRegistry,
  ScopedSessionSummary,
} from './session-envelope-registry.js';
import type { RoutedSessionAuditSink } from './hub-node-router.js';

export type HubPolicyDecisionKind = 'allow' | 'deny' | 'challenge' | 'revoke';

export type HubPolicyReasonCode =
  | 'POLICY_ALLOWED'
  | 'POLICY_CHALLENGE_REQUIRED'
  | 'POLICY_NODE_NOT_PAIRED'
  | 'POLICY_NODE_REVOKED'
  | 'POLICY_NODE_ID_MISMATCH'
  | 'POLICY_PEER_NODE_MISMATCH'
  | 'POLICY_PEER_CREDENTIAL_MISMATCH'
  | 'POLICY_SCOPE_NODE_MISMATCH'
  | 'POLICY_SCOPE_DENIED'
  | 'POLICY_ACL_MISSING'
  | 'POLICY_ACL_REVOKED'
  | 'POLICY_SESSION_EXPIRED'
  | 'POLICY_SESSION_REVOKED'
  | 'POLICY_UNKNOWN_CAPABILITY'
  | 'POLICY_CAPABILITY_DENIED'
  | 'POLICY_AUDIT_WRITE_FAILED_CLOSED'
  | 'POLICY_LOCAL_COMPATIBILITY_ALLOWED';

export interface HubPolicyPeerIdentity {
  kind: 'hub' | 'node' | 'local-user' | 'system';
  nodeId?: string;
  credentialId?: string;
  displayName?: string;
}

export interface HubPolicyIntent {
  action: string;
  target?: string;
}

export interface HubPolicyScope {
  kind: 'local-compatibility' | RelayPolicyScope['kind'] | 'node-cwd' | 'worktree';
  nodeId: string;
  cwd?: string | undefined;
  path?: string | undefined;
  workspaceId?: string | undefined;
  repoId?: string | undefined;
  repoPath?: string | undefined;
  worktreePath?: string | null | undefined;
}

export interface HubPolicyEvaluationInput {
  peer: HubPolicyPeerIdentity;
  node?: HubNodeSummary | null | undefined;
  nodeId: string;
  intent: HubPolicyIntent;
  scope: HubPolicyScope;
  requiredCapabilities: readonly string[];
  now?: Date | undefined;
  expiresAt?: string | null | undefined;
  revokedAt?: string | null | undefined;
  sessionId?: string | undefined;
  correlationId?: string | undefined;
  params?: unknown;
}

export interface HubPolicyDecision {
  decision: HubPolicyDecisionKind;
  reasonCode: HubPolicyReasonCode;
  message: string;
  nodeId: string;
  peer: HubPolicyPeerIdentity;
  intent: HubPolicyIntent;
  scope: HubPolicyScope;
  trustTier?: RelayTrustTier;
  aclRef?: string;
  policyVersion?: string;
  requiredBits: RelayCapabilityBit[];
  grantedBits: RelayCapabilityBit[];
  deniedBits: RelayCapabilityBit[];
  challengeBits: RelayCapabilityBit[];
  unknownBits: string[];
  sessionId?: string;
  correlationId?: string;
  params?: unknown;
}

export type SessionCreateType = 'agent' | 'terminal';

type SessionCreateControlMode = 'agent-driven' | 'human-driven';

export function isSessionCreateType(value: unknown): value is SessionCreateType {
  return value === 'agent' || value === 'terminal';
}

function normalizeSessionCreateControlMode(value: unknown): SessionCreateControlMode | undefined {
  if (value === 'agent-driven' || value === 'human-driven') return value;
  return undefined;
}

export function sessionCreateCapability(sessionType: SessionCreateType): RelayCapabilityBit {
  return sessionType === 'agent' ? 'session:create:agent' : 'session:create:terminal';
}

export function sessionCreateCapabilities(input: {
  sessionType: SessionCreateType;
  controlMode?: unknown;
}): RelayCapabilityBit[] {
  const capabilities = [sessionCreateCapability(input.sessionType)];
  const effectiveControlMode =
    normalizeSessionCreateControlMode(input.controlMode) ??
    (input.sessionType === 'agent' ? 'agent-driven' : 'human-driven');
  if (effectiveControlMode === 'agent-driven') capabilities.push('tab:mode:set-agent');
  return capabilities;
}

export function requiredCapabilitiesForRpcIntent(action: string): string[] {
  if (action === 'sessions.interventions.read') return ['session:read', 'tab:intervention:read'];
  if (action === 'sessions.control.set-agent') return ['session:attach', 'tab:mode:set-agent'];
  if (action === 'sessions.kill') return ['session:control:kill'];
  switch (action) {
    case 'sessions.create.terminal':
      return ['session:create:terminal'];
    case 'sessions.create.agent':
      return ['session:create:agent'];
    case 'sessions.attach':
      return ['session:attach'];
    case 'sessions.renew':
      return ['session:attach'];
    case 'sessions.read':
      return ['session:read'];
    case 'rpc.fs.list':
      return ['rpc:fs:list'];
    case 'rpc.fs.stat':
      return ['rpc:fs:read'];
    case 'rpc.fs.read':
      return ['rpc:fs:read'];
    case 'rpc.fs.tail':
      return ['rpc:fs:tail'];
    case 'rpc.fs.write':
      return ['rpc:fs:write'];
    case 'rpc.fs.delete':
      return ['rpc:fs:delete'];
    case 'rpc.git.read':
      return ['rpc:git:read'];
    case 'rpc.git.write':
      return ['rpc:git:write'];
    case 'pty.exec.arbitrary':
      return ['pty:exec:arbitrary'];
    case 'preview.port-forward':
      return ['preview:port-forward'];
    default:
      return [`rpc:unknown:${action}`];
  }
}

export function evaluateHubPolicy(input: HubPolicyEvaluationInput): HubPolicyDecision {
  const required = normalizeRequiredCapabilities(input.requiredCapabilities);
  const base = baseDecision(input, required.known, required.unknown);
  if (!input.node) {
    return deny(base, 'POLICY_NODE_NOT_PAIRED', 'node is not paired');
  }
  if (input.node.status === 'revoked' || input.node.credentialState === 'revoked') {
    return revoke(base, input.node, 'POLICY_NODE_REVOKED', 'node credential was revoked');
  }
  if (input.node.nodeId !== input.nodeId) {
    return deny(
      withPolicy(base, input.node),
      'POLICY_NODE_ID_MISMATCH',
      'policy node does not match requested node'
    );
  }
  if (input.peer.kind === 'node' && input.peer.nodeId !== input.nodeId) {
    return deny(
      withPolicy(base, input.node),
      'POLICY_PEER_NODE_MISMATCH',
      'node credential cannot act as a different node'
    );
  }
  if (
    input.peer.kind === 'node' &&
    input.peer.credentialId &&
    input.peer.credentialId !== input.node.credentialId
  ) {
    return deny(
      withPolicy(base, input.node),
      'POLICY_PEER_CREDENTIAL_MISMATCH',
      'node credential does not match the active credential for this node'
    );
  }
  if (input.scope.nodeId !== input.nodeId) {
    return deny(
      withPolicy(base, input.node),
      'POLICY_SCOPE_NODE_MISMATCH',
      'requested scope belongs to a different node'
    );
  }
  if (input.revokedAt) {
    return revoke(
      withPolicy(base, input.node),
      input.node,
      'POLICY_SESSION_REVOKED',
      'scoped session has been revoked'
    );
  }
  if (isExpired(input.expiresAt, input.now ?? new Date())) {
    return revoke(
      withPolicy(base, input.node),
      input.node,
      'POLICY_SESSION_EXPIRED',
      'scoped session has expired'
    );
  }

  const policy = input.node.trust.policy;
  if (!policy) {
    return deny(
      withPolicy(base, input.node),
      'POLICY_ACL_MISSING',
      'node ACL policy is missing'
    );
  }
  if (policy.revokedAt || policy.supersededBy) {
    return revoke(
      withPolicy(base, input.node),
      input.node,
      'POLICY_ACL_REVOKED',
      'node ACL is revoked or superseded'
    );
  }
  if (!scopeMatchesPolicy(policy.scope, input.scope)) {
    return deny(
      withPolicy(base, input.node),
      'POLICY_SCOPE_DENIED',
      'requested scope is outside the node ACL'
    );
  }
  if (required.unknown.length > 0) {
    return deny(
      withPolicy(base, input.node),
      'POLICY_UNKNOWN_CAPABILITY',
      'required capability is unknown to this policy version'
    );
  }

  const allowed = new Set(policy.allowed);
  const challenged = new Set(policy.requiresConfirmation);
  const grantedBits: RelayCapabilityBit[] = [];
  const challengeBits: RelayCapabilityBit[] = [];
  const deniedBits: RelayCapabilityBit[] = [];
  for (const bit of required.known) {
    if (challenged.has(bit)) challengeBits.push(bit);
    else if (allowed.has(bit)) grantedBits.push(bit);
    else deniedBits.push(bit);
  }
  const withBits = {
    ...withPolicy(base, input.node),
    grantedBits,
    challengeBits,
    deniedBits,
  };
  if (deniedBits.length > 0) {
    return deny(
      withBits,
      'POLICY_CAPABILITY_DENIED',
      'node ACL does not grant a required capability'
    );
  }
  if (challengeBits.length > 0) {
    return {
      ...withBits,
      decision: 'challenge',
      reasonCode: 'POLICY_CHALLENGE_REQUIRED',
      message: 'node ACL requires confirmation for this capability',
    };
  }
  return {
    ...withBits,
    decision: 'allow',
    reasonCode:
      input.scope.kind === 'local-compatibility'
        ? 'POLICY_LOCAL_COMPATIBILITY_ALLOWED'
        : 'POLICY_ALLOWED',
    message: 'policy allowed',
  };
}

export function policyDecisionToRelayError(decision: HubPolicyDecision): RelayNodeError {
  const code: RelayNodeError['code'] = policyDecisionErrorCode(decision);
  return {
    code,
    message: decision.message,
    retryable: false,
    details: {
      reasonCode: decision.reasonCode,
      decision: decision.decision,
      requiredBits: decision.requiredBits,
      grantedBits: decision.grantedBits,
      deniedBits: decision.deniedBits,
      challengeBits: decision.challengeBits,
      unknownBits: decision.unknownBits,
      aclRef: decision.aclRef ?? null,
      policyVersion: decision.policyVersion ?? null,
    },
  };
}

function policyDecisionErrorCode(decision: HubPolicyDecision): RelayNodeError['code'] {
  switch (decision.reasonCode) {
    case 'POLICY_NODE_NOT_PAIRED':
      return 'NOT_FOUND';
    case 'POLICY_NODE_REVOKED':
    case 'POLICY_ACL_REVOKED':
      return 'NODE_REVOKED';
    case 'POLICY_SESSION_EXPIRED':
      return 'SESSION_EXPIRED';
    case 'POLICY_SESSION_REVOKED':
      return 'SESSION_REVOKED';
    case 'POLICY_SCOPE_NODE_MISMATCH':
      return 'SESSION_MISMATCH';
    case 'POLICY_AUDIT_WRITE_FAILED_CLOSED':
      return 'INTERNAL';
    default:
      return decision.decision === 'challenge' ? 'UNSUPPORTED_CAPABILITY' : 'UNAUTHORIZED';
  }
}

export function auditEntryForPolicyDecision(
  decision: HubPolicyDecision,
  material?: { params?: unknown; scope?: unknown }
): SecurityAuditEntryInput {
  return {
    eventType: auditEventType(decision),
    decision: auditDecision(decision),
    reasonCode: decision.reasonCode,
    peer: auditPeer(decision.peer),
    node: { nodeId: decision.nodeId, ...(decision.trustTier ? { trustTier: decision.trustTier } : {}) },
    ...(decision.sessionId ? { sessionId: decision.sessionId } : {}),
    intent: decision.intent,
    material: {
      scope: material?.scope ?? decision.scope,
      params: material?.params ?? decision.params ?? null,
    },
    requiredBits: decision.requiredBits,
    grantedBits: decision.grantedBits,
    deniedBits: [...decision.deniedBits, ...knownDeniedUnknowns(decision)],
    refs: {
      ...(decision.aclRef ? { aclRef: decision.aclRef } : {}),
      policyVersion: decision.policyVersion ?? RELAY_SECURITY_POLICY_VERSION,
    },
    ...(decision.correlationId ? { correlationId: decision.correlationId } : {}),
  };
}

export function appendPolicyAudit(
  sink: RoutedSessionAuditSink | undefined,
  decision: HubPolicyDecision,
  material?: { params?: unknown; scope?: unknown }
): HubPolicyDecision {
  if (!sink) return decision;
  try {
    sink.append(auditEntryForPolicyDecision(decision, material));
    return decision;
  } catch {
    const classification = classifySecurityAuditWriteFailure({
      ...(decision.trustTier ? { trustTier: decision.trustTier } : {}),
      requiredBits: decision.requiredBits,
      decision: auditDecision(decision),
    });
    if (classification.mode === 'fail-closed') {
      return deny(
        {
          ...decision,
          grantedBits: [],
          deniedBits: decision.requiredBits,
          challengeBits: [],
        },
        'POLICY_AUDIT_WRITE_FAILED_CLOSED',
        classification.visibleMessage
      );
    }
    return decision;
  }
}

export function revokePolicyAffectedSessions(input: {
  envelopes: InMemorySessionEnvelopeRegistry;
  nodeId: string;
  node?: HubNodeSummary | null;
  reason?: string;
  now?: Date;
  auditSink?: RoutedSessionAuditSink | undefined;
}): ScopedSessionSummary[] {
  const now = input.now ?? new Date();
  const summaries = input.envelopes.revokeForNode(input.nodeId, {
    reason: input.reason ?? 'policy-revoked',
    now,
  });
  for (const summary of summaries) {
    const decision = evaluateHubPolicy({
      peer: { kind: 'system' },
      node: input.node ?? null,
      nodeId: input.nodeId,
      intent: { action: 'sessions.revalidate', target: input.nodeId },
      scope: {
        kind: summary.scope.kind,
        nodeId: summary.nodeId,
        cwd: summary.scope.cwd,
        ...(summary.scope.repoPath ? { repoPath: summary.scope.repoPath } : {}),
        ...(summary.scope.worktreePath !== undefined
          ? { worktreePath: summary.scope.worktreePath }
          : {}),
      },
      requiredCapabilities: ['session:attach'],
      revokedAt: summary.revokedAt,
      expiresAt: summary.expiresAt,
      sessionId: summary.sessionId,
      ...(summary.correlationId ? { correlationId: summary.correlationId } : {}),
      now,
    });
    appendPolicyAudit(input.auditSink, {
      ...decision,
      decision: 'revoke',
      reasonCode: 'POLICY_SESSION_REVOKED',
      message: 'session permission revoked after policy change',
    });
  }
  return summaries;
}

function normalizeRequiredCapabilities(required: readonly string[]): {
  known: RelayCapabilityBit[];
  unknown: string[];
} {
  const known: RelayCapabilityBit[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const bit of required) {
    if (seen.has(bit)) continue;
    seen.add(bit);
    if (isRelayCapabilityBit(bit)) known.push(bit);
    else unknown.push(bit);
  }
  return { known, unknown };
}

function baseDecision(
  input: HubPolicyEvaluationInput,
  requiredBits: RelayCapabilityBit[],
  unknownBits: string[]
): HubPolicyDecision {
  return {
    decision: 'deny',
    reasonCode: 'POLICY_CAPABILITY_DENIED',
    message: 'policy denied',
    nodeId: input.nodeId,
    peer: input.peer,
    intent: input.intent,
    scope: input.scope,
    requiredBits,
    grantedBits: [],
    deniedBits: requiredBits,
    challengeBits: [],
    unknownBits,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.params !== undefined ? { params: input.params } : {}),
  };
}

function withPolicy(decision: HubPolicyDecision, node: HubNodeSummary): HubPolicyDecision {
  const policy = node.trust.policy;
  const trustTier = policy?.trustTier ?? node.trust.tier;
  return {
    ...decision,
    ...(isRelayTrustTier(trustTier) ? { trustTier } : {}),
    ...(policy ? { aclRef: policy.ref, policyVersion: policy.policyVersion } : {}),
  };
}

function deny(
  decision: HubPolicyDecision,
  reasonCode: HubPolicyReasonCode,
  message: string
): HubPolicyDecision {
  return { ...decision, decision: 'deny', reasonCode, message };
}

function revoke(
  decision: HubPolicyDecision,
  node: HubNodeSummary,
  reasonCode: HubPolicyReasonCode,
  message: string
): HubPolicyDecision {
  return { ...withPolicy(decision, node), decision: 'revoke', reasonCode, message };
}

function isExpired(expiresAt: string | null | undefined, now: Date): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  return !Number.isFinite(ms) || ms <= now.getTime();
}

function scopeMatchesPolicy(policy: RelayPolicyScope, scope: HubPolicyScope): boolean {
  if (scope.kind === 'local-compatibility') return true;
  if (policy.kind === 'node') return true;
  if (policy.kind === 'workspace') {
    return Boolean(
      scope.workspaceId && policy.workspaceIds?.includes(scope.workspaceId)
    );
  }
  if (policy.kind === 'repo') {
    return Boolean(
      (scope.repoId && policy.repoIds?.includes(scope.repoId)) ||
        (scope.repoPath && policy.repoIds?.includes(scope.repoPath))
    );
  }
  const requestedPath = scope.path ?? scope.worktreePath ?? scope.repoPath ?? scope.cwd;
  return Boolean(
    requestedPath &&
      policy.pathPrefixes?.some((prefix) => pathWithinPrefix(requestedPath, prefix))
  );
}

function pathWithinPrefix(candidate: string, prefix: string): boolean {
  const candidatePath = canonicalPolicyPath(candidate);
  const prefixPath = canonicalPolicyPath(prefix);
  if (!candidatePath || !prefixPath) return false;
  return candidatePath === prefixPath || candidatePath.startsWith(`${prefixPath}/`);
}

function canonicalPolicyPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  const normalized = path.posix.normalize(trimmed);
  if (!path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function auditEventType(decision: HubPolicyDecision): SecurityAuditEventType {
  if (decision.decision === 'allow') return 'grant';
  if (decision.decision === 'challenge') return 'challenge';
  if (decision.decision === 'revoke') return 'revocation';
  return 'denial';
}

function auditDecision(decision: HubPolicyDecision): SecurityAuditDecision {
  if (decision.decision === 'allow') return 'allow';
  if (decision.decision === 'challenge') return 'requires_confirmation';
  if (decision.decision === 'revoke') return 'revoked';
  return 'deny';
}

function auditPeer(peer: HubPolicyPeerIdentity): SecurityAuditEntryInput['peer'] {
  if (peer.kind === 'node') {
    return {
      kind: 'node',
      ...(peer.nodeId ? { nodeId: peer.nodeId } : {}),
      ...(peer.credentialId ? { credentialId: peer.credentialId } : {}),
      ...(peer.displayName ? { displayName: peer.displayName } : {}),
    };
  }
  if (peer.kind === 'local-user') {
    return {
      kind: 'user',
      ...(peer.displayName ? { displayName: peer.displayName } : {}),
    };
  }
  return { kind: peer.kind };
}

function knownDeniedUnknowns(decision: HubPolicyDecision): RelayCapabilityBit[] {
  return decision.unknownBits.filter(isRelayCapabilityBit);
}

export type { RelayAclSummary };
