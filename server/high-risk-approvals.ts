import {
  sha256Hex,
  stableStringify,
} from '../shared/security-audit.js';
import {
  HIGH_RISK_CAPABILITIES,
  isRelayCapabilityBit,
  type RelayCapabilityBit,
  type RelayTrustTier,
} from '../shared/security-policy.js';
import type { HubPolicyDecision } from './hub-policy-evaluator.js';

export const HIGH_RISK_APPROVAL_SCHEMA_VERSION = 1 as const;
export const HIGH_RISK_APPROVAL_CHALLENGE_KIND =
  'exact-operation-high-risk-approval' as const;

export const HIGH_RISK_APPROVAL_OUTCOMES = [
  'challenge_created',
  'approved',
  'denied',
  'expired',
  'redeemed',
  'reuse_denied',
  'mismatch_denied',
  'approval_target_invalid',
  'audit_write_failed',
] as const;

export type HighRiskApprovalOutcome =
  (typeof HIGH_RISK_APPROVAL_OUTCOMES)[number];

export type HighRiskClassificationDecision =
  | 'approvalRequired'
  | 'silentAllowIfPolicyAllows'
  | 'deny';

export type HighRiskRiskReason =
  | 'cross-node control high-risk'
  | 'capability escalation high-risk'
  | 'shell exec high-risk'
  | 'file boundary mutation high-risk'
  | 'credential export high-risk'
  | 'node lifecycle high-risk'
  | 'destructive session control high-risk'
  | 'generic high-risk capability'
  | 'low_risk_ref_only'
  | 'low_risk_read'
  | 'unknown_capability'
  | 'unknown_operation';

export interface HighRiskOperationClassificationInput {
  action: string;
  targetNodeId?: string;
  sourceNodeId?: string;
  trustTier?: RelayTrustTier;
  scopeKind?: string;
  boundaryCrossing?: boolean;
  requiredCapabilities: readonly string[];
}

export interface HighRiskOperationClassification {
  decision: HighRiskClassificationDecision;
  riskReason: HighRiskRiskReason;
  requiredBits: RelayCapabilityBit[];
  unknownBits: string[];
}

export type HighRiskApprovalActorKind =
  | 'browser-session'
  | 'scoped-actor'
  | 'human'
  | 'node'
  | 'system';

export interface HighRiskApprovalRequesterIdentity {
  kind: HighRiskApprovalActorKind;
  authSessionHash: string;
  actorType?: string;
  actorId?: string;
  credentialId?: string;
  credentialJti?: string;
  nodeId?: string;
  sessionId?: string;
  workContextId?: string;
  displayName?: string;
}

export interface HighRiskApprovalApproverIdentity {
  kind: HighRiskApprovalActorKind;
  actorType?: string;
  actorId?: string;
  credentialId?: string;
  credentialJti?: string;
  nodeId?: string;
  sessionId?: string;
  workContextId?: string;
  displayName?: string;
}

export interface HighRiskApprovalTarget {
  kind: 'human' | 'operator' | 'session' | 'external';
  id?: string;
  sessionId?: string;
  displayName?: string;
}

export interface SafeHighRiskApprovalRequesterIdentity {
  kind: HighRiskApprovalActorKind;
  authSessionHash: string;
  actorType?: string;
  actorIdHash?: string;
  credentialIdHash?: string;
  credentialJtiHash?: string;
  nodeId?: string;
  sessionId?: string;
  workContextId?: string;
  displayName?: string;
}

export interface SafeHighRiskApprovalApproverIdentity {
  kind: HighRiskApprovalActorKind;
  actorType?: string;
  actorIdHash?: string;
  credentialIdHash?: string;
  credentialJtiHash?: string;
  nodeId?: string;
  sessionId?: string;
  workContextId?: string;
  displayName?: string;
}

export interface SafeHighRiskApprovalTarget {
  kind: HighRiskApprovalTarget['kind'];
  idHash?: string;
  sessionId?: string;
  displayName?: string;
}

export interface HighRiskApprovalContract {
  schemaVersion: typeof HIGH_RISK_APPROVAL_SCHEMA_VERSION;
  challengeKind: typeof HIGH_RISK_APPROVAL_CHALLENGE_KIND;
  challengeId: string;
  outcome: HighRiskApprovalOutcome;
  correlationId: string;
  operation: {
    action: string;
    nodeId: string;
    target?: string;
    sessionId?: string;
    workContextId?: string;
  };
  risk: Pick<HighRiskOperationClassification, 'decision' | 'riskReason' | 'unknownBits'>;
  policy: {
    aclRef?: string;
    policyVersion?: string;
    trustTier?: RelayTrustTier;
    requiredBits: RelayCapabilityBit[];
    challengeBits: RelayCapabilityBit[];
    scopeHash: string;
  };
  requester: SafeHighRiskApprovalRequesterIdentity;
  approver?: SafeHighRiskApprovalApproverIdentity;
  approvalTarget: SafeHighRiskApprovalTarget;
  paramsHash: string;
  createdAt: string;
  expiresAt: string;
  redemptionNonceHash?: string;
  contractHash: string;
}

export interface CreateHighRiskApprovalContractInput {
  challengeId: string;
  decision: HubPolicyDecision;
  canonicalParams: unknown;
  createdAt: Date;
  expiresAt: Date;
  requester: HighRiskApprovalRequesterIdentity;
  approvalTarget?: HighRiskApprovalTarget;
  approver?: HighRiskApprovalApproverIdentity;
  redemptionNonce?: string;
  redemptionNonceHash?: string;
  outcome?: HighRiskApprovalOutcome;
}

const HIGH_RISK_CAPABILITY_SET = new Set<string>(HIGH_RISK_CAPABILITIES);
const LOW_RISK_READ_ACTIONS = new Set([
  'sessions.read',
  'sessions.interventions.read',
  'rpc.fs.list',
  'rpc.fs.stat',
  'rpc.fs.read',
  'rpc.fs.tail',
  'rpc.git.read',
  'logs.tail',
]);
const LOW_RISK_REF_ONLY_ACTIONS = new Set([
  'context.read',
  'context.write',
  'inbox.read',
  'inbox.write',
]);
const KNOWN_ACTIONS = new Set([
  ...Array.from(LOW_RISK_READ_ACTIONS),
  ...Array.from(LOW_RISK_REF_ONLY_ACTIONS),
  'sessions.create',
  'sessions.create.agent',
  'sessions.create.terminal',
  'sessions.attach',
  'sessions.kill',
  'sessions.control.set-agent',
  'pty.exec.arbitrary',
  'preview.port-forward',
  'rpc.fs.write',
  'rpc.fs.delete',
  'rpc.git.write',
  'nodes.acl.widen',
  'capabilities.grant',
  'credentials.export',
  'secrets.export',
  'nodes.revoke',
  'nodes.rotate',
  'nodes.repair',
  'nodes.re-pair',
  'nodes.destroy',
]);

export function isHighRiskApprovalOutcome(
  value: unknown
): value is HighRiskApprovalOutcome {
  return (
    typeof value === 'string' &&
    (HIGH_RISK_APPROVAL_OUTCOMES as readonly string[]).includes(value)
  );
}

export function classifyHighRiskOperation(
  input: HighRiskOperationClassificationInput
): HighRiskOperationClassification {
  const required = normalizeRequiredBits(input.requiredCapabilities);
  if (required.unknownBits.length > 0) {
    return deny('unknown_capability', required);
  }
  if (!KNOWN_ACTIONS.has(input.action)) {
    return deny('unknown_operation', required);
  }
  if (isCrossNodeControl(input)) {
    return approvalRequired('cross-node control high-risk', required);
  }
  if (isCapabilityEscalation(input)) {
    return approvalRequired('capability escalation high-risk', required);
  }
  if (isShellExec(input)) {
    return approvalRequired('shell exec high-risk', required);
  }
  if (isFileBoundaryMutation(input)) {
    return approvalRequired('file boundary mutation high-risk', required);
  }
  if (isCredentialExport(input)) {
    return approvalRequired('credential export high-risk', required);
  }
  if (isNodeLifecycle(input)) {
    return approvalRequired('node lifecycle high-risk', required);
  }
  if (isDestructiveSessionControl(input)) {
    return approvalRequired('destructive session control high-risk', required);
  }
  if (required.requiredBits.some((bit) => HIGH_RISK_CAPABILITY_SET.has(bit))) {
    return approvalRequired('generic high-risk capability', required);
  }
  if (LOW_RISK_REF_ONLY_ACTIONS.has(input.action)) {
    return silent('low_risk_ref_only', required);
  }
  return silent('low_risk_read', required);
}

export function createHighRiskApprovalContract(
  input: CreateHighRiskApprovalContractInput
): HighRiskApprovalContract {
  const classification = classifyHighRiskOperation({
    action: input.decision.intent.action,
    targetNodeId: input.decision.nodeId,
    scopeKind: input.decision.scope.kind,
    requiredCapabilities: input.decision.requiredBits,
    ...(input.decision.trustTier ? { trustTier: input.decision.trustTier } : {}),
  });
  const workContextId =
    input.requester.workContextId ?? stringField(input.decision.scope as unknown as Record<string, unknown>, 'workspaceId');
  const redemptionNonceHash = input.redemptionNonce
    ? sha256Hex(`relay-approval-nonce:${input.redemptionNonce}`)
    : input.redemptionNonceHash;
  const payload: Omit<HighRiskApprovalContract, 'contractHash'> = {
    schemaVersion: HIGH_RISK_APPROVAL_SCHEMA_VERSION,
    challengeKind: HIGH_RISK_APPROVAL_CHALLENGE_KIND,
    challengeId: input.challengeId,
    outcome: input.outcome ?? 'challenge_created',
    correlationId: input.decision.correlationId ?? input.challengeId,
    operation: {
      action: input.decision.intent.action,
      nodeId: input.decision.nodeId,
      ...(input.decision.intent.target ? { target: input.decision.intent.target } : {}),
      ...(input.decision.sessionId ? { sessionId: input.decision.sessionId } : {}),
      ...(workContextId ? { workContextId } : {}),
    },
    risk: {
      decision: classification.decision,
      riskReason: classification.riskReason,
      unknownBits: [...classification.unknownBits],
    },
    policy: {
      ...(input.decision.aclRef ? { aclRef: input.decision.aclRef } : {}),
      ...(input.decision.policyVersion
        ? { policyVersion: input.decision.policyVersion }
        : {}),
      ...(input.decision.trustTier ? { trustTier: input.decision.trustTier } : {}),
      requiredBits: [...input.decision.requiredBits],
      challengeBits: [...input.decision.challengeBits],
      scopeHash: sha256Hex(stableStringify(input.decision.scope)),
    },
    requester: safeRequester(input.requester),
    ...(input.approver ? { approver: safeApprover(input.approver) } : {}),
    approvalTarget: safeTarget(input.approvalTarget ?? { kind: 'human' }),
    paramsHash: sha256Hex(stableStringify(input.canonicalParams ?? null)),
    createdAt: input.createdAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    ...(redemptionNonceHash ? { redemptionNonceHash } : {}),
  };
  return {
    ...payload,
    contractHash: sha256Hex(stableStringify(payload)),
  };
}

export function sameHighRiskActor(
  requester: HighRiskApprovalRequesterIdentity | undefined,
  approver: HighRiskApprovalApproverIdentity | undefined
): boolean {
  if (!requester || !approver) return false;
  return Boolean(
    requester.actorId &&
      approver.actorId &&
      requester.actorType === approver.actorType &&
      hashIdentity(requester.actorId) === hashIdentity(approver.actorId)
  );
}

export function sameHighRiskCredential(
  requester: HighRiskApprovalRequesterIdentity | undefined,
  approver: HighRiskApprovalApproverIdentity | undefined
): boolean {
  if (!requester || !approver) return false;
  return Boolean(
    requester.credentialId &&
      approver.credentialId &&
      hashIdentity(requester.credentialId) === hashIdentity(approver.credentialId)
  );
}

export function sameHighRiskSession(
  requester: HighRiskApprovalRequesterIdentity | undefined,
  approver: HighRiskApprovalApproverIdentity | undefined
): boolean {
  if (!requester || !approver) return false;
  return Boolean(
    requester.sessionId &&
      approver.sessionId &&
      hashIdentity(requester.sessionId) === hashIdentity(approver.sessionId)
  );
}

function normalizeRequiredBits(requiredCapabilities: readonly string[]): {
  requiredBits: RelayCapabilityBit[];
  unknownBits: string[];
} {
  const requiredBits: RelayCapabilityBit[] = [];
  const unknownBits: string[] = [];
  const seen = new Set<string>();
  for (const bit of requiredCapabilities) {
    if (seen.has(bit)) continue;
    seen.add(bit);
    if (isRelayCapabilityBit(bit)) requiredBits.push(bit);
    else unknownBits.push(bit);
  }
  return { requiredBits, unknownBits };
}

function deny(
  riskReason: Extract<HighRiskRiskReason, 'unknown_capability' | 'unknown_operation'>,
  bits: { requiredBits: RelayCapabilityBit[]; unknownBits: string[] }
): HighRiskOperationClassification {
  return { decision: 'deny', riskReason, ...bits };
}

function silent(
  riskReason: Extract<HighRiskRiskReason, 'low_risk_ref_only' | 'low_risk_read'>,
  bits: { requiredBits: RelayCapabilityBit[]; unknownBits: string[] }
): HighRiskOperationClassification {
  return { decision: 'silentAllowIfPolicyAllows', riskReason, ...bits };
}

function approvalRequired(
  riskReason: Exclude<HighRiskRiskReason, 'low_risk_ref_only' | 'low_risk_read' | 'unknown_capability' | 'unknown_operation'>,
  bits: { requiredBits: RelayCapabilityBit[]; unknownBits: string[] }
): HighRiskOperationClassification {
  return { decision: 'approvalRequired', riskReason, ...bits };
}

function isCrossNodeControl(input: HighRiskOperationClassificationInput): boolean {
  return Boolean(
    input.sourceNodeId &&
      input.targetNodeId &&
      input.sourceNodeId !== input.targetNodeId &&
      (input.action.startsWith('sessions.') || input.action.startsWith('nodes.'))
  );
}

function isCapabilityEscalation(input: HighRiskOperationClassificationInput): boolean {
  return (
    input.action === 'nodes.acl.widen' ||
    input.action === 'capabilities.grant' ||
    input.requiredCapabilities.includes('node:acl:widen')
  );
}

function isShellExec(input: HighRiskOperationClassificationInput): boolean {
  return (
    input.action === 'pty.exec.arbitrary' ||
    (input.trustTier === 'prod' && input.requiredCapabilities.includes('pty:exec:arbitrary'))
  );
}

function isFileBoundaryMutation(input: HighRiskOperationClassificationInput): boolean {
  return (
    input.action === 'rpc.fs.write' ||
    input.action === 'rpc.fs.delete' ||
    input.boundaryCrossing === true ||
    input.requiredCapabilities.includes('rpc:fs:write') ||
    input.requiredCapabilities.includes('rpc:fs:delete')
  );
}

function isCredentialExport(input: HighRiskOperationClassificationInput): boolean {
  return (
    input.action === 'credentials.export' ||
    input.action === 'secrets.export' ||
    input.requiredCapabilities.includes('credential:export')
  );
}

function isNodeLifecycle(input: HighRiskOperationClassificationInput): boolean {
  return (
    input.action === 'nodes.revoke' ||
    input.action === 'nodes.rotate' ||
    input.action === 'nodes.repair' ||
    input.action === 'nodes.re-pair' ||
    input.action === 'nodes.destroy' ||
    input.requiredCapabilities.includes('node:lifecycle:destructive')
  );
}

function isDestructiveSessionControl(input: HighRiskOperationClassificationInput): boolean {
  return (
    input.action === 'sessions.kill' ||
    input.requiredCapabilities.includes('session:control:kill')
  );
}

function safeRequester(
  requester: HighRiskApprovalRequesterIdentity
): SafeHighRiskApprovalRequesterIdentity {
  return {
    kind: requester.kind,
    authSessionHash: requester.authSessionHash,
    ...(requester.actorType ? { actorType: requester.actorType } : {}),
    ...(requester.actorId ? { actorIdHash: hashIdentity(requester.actorId) } : {}),
    ...(requester.credentialId
      ? { credentialIdHash: hashIdentity(requester.credentialId) }
      : {}),
    ...(requester.credentialJti
      ? { credentialJtiHash: hashIdentity(requester.credentialJti) }
      : {}),
    ...(requester.nodeId ? { nodeId: requester.nodeId } : {}),
    ...(requester.sessionId ? { sessionId: requester.sessionId } : {}),
    ...(requester.workContextId ? { workContextId: requester.workContextId } : {}),
    ...(requester.displayName ? { displayName: requester.displayName } : {}),
  };
}

function safeApprover(
  approver: HighRiskApprovalApproverIdentity
): SafeHighRiskApprovalApproverIdentity {
  return {
    kind: approver.kind,
    ...(approver.actorType ? { actorType: approver.actorType } : {}),
    ...(approver.actorId ? { actorIdHash: hashIdentity(approver.actorId) } : {}),
    ...(approver.credentialId
      ? { credentialIdHash: hashIdentity(approver.credentialId) }
      : {}),
    ...(approver.credentialJti
      ? { credentialJtiHash: hashIdentity(approver.credentialJti) }
      : {}),
    ...(approver.nodeId ? { nodeId: approver.nodeId } : {}),
    ...(approver.sessionId ? { sessionId: approver.sessionId } : {}),
    ...(approver.workContextId ? { workContextId: approver.workContextId } : {}),
    ...(approver.displayName ? { displayName: approver.displayName } : {}),
  };
}

function safeTarget(target: HighRiskApprovalTarget): SafeHighRiskApprovalTarget {
  return {
    kind: target.kind,
    ...(target.id ? { idHash: hashIdentity(target.id) } : {}),
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    ...(target.displayName ? { displayName: target.displayName } : {}),
  };
}

function hashIdentity(value: string): string {
  return sha256Hex(`relay-high-risk-approval:${value}`);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
