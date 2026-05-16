import * as crypto from 'node:crypto';
import { sha256Hex, stableStringify, type SecurityAuditEntryInput } from '../shared/security-audit.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';
import type { HubPolicyDecision } from './hub-policy-evaluator.js';

export const DEFAULT_CONFIRMATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_CONFIRMATION_TOKEN_TTL_MS = 60 * 1000;
export const DEFAULT_CONFIRMATION_MAX_FAILED_REDEMPTIONS = 3;
export const DEFAULT_CONFIRMATION_MAX_CHALLENGES = 1000;

export type ConfirmationDecision = 'approve' | 'deny' | 'deny_revoke';
export type ConfirmationChallengeStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'revoked'
  | 'expired'
  | 'redeemed'
  | 'invalidated';

export type ConfirmationReasonCode =
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_APPROVED'
  | 'CONFIRMATION_DENIED'
  | 'CONFIRMATION_DENIED_REVOKE'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_ALREADY_USED'
  | 'CONFIRMATION_SAME_SESSION'
  | 'CONFIRMATION_PARAM_MISMATCH'
  | 'CONFIRMATION_NOT_FOUND'
  | 'CONFIRMATION_NOT_APPROVED'
  | 'CONFIRMATION_TOKEN_INVALID'
  | 'CONFIRMATION_REQUESTER_MISMATCH'
  | 'CONFIRMATION_CONTEXT_MISMATCH';

export interface CanonicalConfirmationParams {
  action: string;
  [key: string]: unknown;
}

export interface ConfirmationChallenge {
  challengeId: string;
  status: ConfirmationChallengeStatus;
  requesterAuthSessionHash: string;
  requesterDisplayName?: string;
  approverAuthSessionHash?: string;
  approverDisplayName?: string;
  nodeId: string;
  intent: HubPolicyDecision['intent'];
  requiredBits: RelayCapabilityBit[];
  challengeBits: RelayCapabilityBit[];
  sessionId?: string;
  canonicalParams: CanonicalConfirmationParams;
  canonicalParamsHash: string;
  scopeHash: string;
  decision: HubPolicyDecision;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  tokenExpiresAt?: string;
  tokenHash?: string;
  requesterToken?: string;
  redeemedAt?: string;
  failedRedemptions: number;
  maxFailedRedemptions: number;
  reasonCode: ConfirmationReasonCode;
  message: string;
}

export interface ConfirmationChallengePublicView {
  challengeId: string;
  status: ConfirmationChallengeStatus;
  nodeId: string;
  intent: HubPolicyDecision['intent'];
  requiredBits: RelayCapabilityBit[];
  challengeBits: RelayCapabilityBit[];
  sessionId?: string;
  canonicalParams: CanonicalConfirmationParams;
  canonicalParamsHash: string;
  requesterDisplayName?: string;
  approverDisplayName?: string;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  tokenExpiresAt?: string;
  failedRedemptions: number;
  maxFailedRedemptions: number;
  reasonCode: ConfirmationReasonCode;
  message: string;
}

export type ConfirmationFailure = {
  ok: false;
  reasonCode: ConfirmationReasonCode;
  message: string;
  challenge?: ConfirmationChallenge;
  audit?: SecurityAuditEntryInput;
};

export type ConfirmationApprovalResult =
  | {
      ok: true;
      reasonCode: 'CONFIRMATION_APPROVED';
      message: string;
      challenge: ConfirmationChallenge;
      confirmationToken: string;
      audit: SecurityAuditEntryInput;
    }
  | ConfirmationFailure;

export type ConfirmationRedemptionResult =
  | {
      ok: true;
      reasonCode: 'CONFIRMATION_APPROVED';
      message: string;
      challenge: ConfirmationChallenge;
      audit: SecurityAuditEntryInput;
    }
  | ConfirmationFailure;

export type ConfirmationRequesterTokenResult =
  | {
      ok: true;
      reasonCode: 'CONFIRMATION_APPROVED';
      message: string;
      challenge: ConfirmationChallenge;
      confirmationToken: string;
    }
  | ConfirmationFailure;

export interface ConfirmationChallengeStoreOptions {
  now?: () => Date;
  randomId?: () => string;
  randomToken?: () => string;
  challengeTtlMs?: number;
  tokenTtlMs?: number;
  maxFailedRedemptions?: number;
  maxChallenges?: number;
}

export interface ConfirmationChallengeStore {
  createChallenge(
    decision: HubPolicyDecision,
    input: {
      requesterAuthSessionHash: string;
      requesterDisplayName?: string;
      canonicalParams: CanonicalConfirmationParams;
    }
  ): ConfirmationChallenge;
  approveChallenge(input: {
    challengeId: string;
    approverAuthSessionHash: string;
    approverDisplayName?: string;
    decision: ConfirmationDecision;
    now?: Date;
  }): ConfirmationApprovalResult;
  redeemToken(input: {
    token: string;
    requesterAuthSessionHash: string;
    decision: HubPolicyDecision;
    canonicalParams: CanonicalConfirmationParams;
    now?: Date;
  }): ConfirmationRedemptionResult;
  getRequesterToken(input: {
    challengeId: string;
    requesterAuthSessionHash: string;
    now?: Date;
  }): ConfirmationRequesterTokenResult;
  invalidateChallenge(input: {
    challengeId: string;
    reasonCode: ConfirmationReasonCode;
    message: string;
    now?: Date;
  }): ConfirmationChallenge | undefined;
  getChallenge(challengeId: string): ConfirmationChallenge | undefined;
  listChallenges(): ConfirmationChallengePublicView[];
}

export class ConfirmationChallengeCapacityError extends Error {
  readonly code = 'CONFIRMATION_CAPACITY_EXHAUSTED';

  constructor(readonly maxChallenges: number) {
    super('confirmation challenge capacity exhausted');
    this.name = 'ConfirmationChallengeCapacityError';
  }
}

export function createConfirmationChallengeStore(
  options: ConfirmationChallengeStoreOptions = {}
): ConfirmationChallengeStore {
  const challenges = new Map<string, ConfirmationChallenge>();
  const challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CONFIRMATION_CHALLENGE_TTL_MS;
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_CONFIRMATION_TOKEN_TTL_MS;
  const maxFailedRedemptions =
    options.maxFailedRedemptions ?? DEFAULT_CONFIRMATION_MAX_FAILED_REDEMPTIONS;
  const maxChallenges = Math.max(1, options.maxChallenges ?? DEFAULT_CONFIRMATION_MAX_CHALLENGES);
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomChallengeId;
  const randomToken = options.randomToken ?? randomConfirmationToken;

  function terminalRetentionMs(): number {
    return Math.max(challengeTtlMs, tokenTtlMs, 1);
  }

  function isTerminal(status: ConfirmationChallengeStatus): boolean {
    return status !== 'pending' && status !== 'approved';
  }

  function pruneExpired(current: Date): void {
    for (const challenge of Array.from(challenges.values())) expireIfNeeded(challenge, current, true);
  }

  function pruneStoredChallenges(current: Date): void {
    pruneExpired(current);
    const cutoff = current.getTime() - terminalRetentionMs();
    for (const [challengeId, challenge] of Array.from(challenges.entries())) {
      const finishedAt = Date.parse(
        challenge.redeemedAt ?? challenge.approvedAt ?? challenge.expiresAt
      );
      if (isTerminal(challenge.status) && Number.isFinite(finishedAt) && finishedAt < cutoff) {
        challenges.delete(challengeId);
      }
    }
    while (challenges.size > maxChallenges) {
      const terminal = Array.from(challenges.values()).find((challenge) => isTerminal(challenge.status));
      if (!terminal) break;
      challenges.delete(terminal.challengeId);
    }
  }

  function ensureCapacityForNewChallenge(): void {
    while (challenges.size >= maxChallenges) {
      const terminal = Array.from(challenges.values()).find((challenge) => isTerminal(challenge.status));
      if (!terminal) throw new ConfirmationChallengeCapacityError(maxChallenges);
      challenges.delete(terminal.challengeId);
    }
  }

  function createChallenge(
    decision: HubPolicyDecision,
    input: {
      requesterAuthSessionHash: string;
      requesterDisplayName?: string;
      canonicalParams: CanonicalConfirmationParams;
    }
  ): ConfirmationChallenge {
    const createdAt = now();
    pruneStoredChallenges(createdAt);
    ensureCapacityForNewChallenge();
    const challenge: ConfirmationChallenge = {
      challengeId: randomId(),
      status: 'pending',
      requesterAuthSessionHash: input.requesterAuthSessionHash,
      ...(input.requesterDisplayName ? { requesterDisplayName: input.requesterDisplayName } : {}),
      nodeId: decision.nodeId,
      intent: decision.intent,
      requiredBits: [...decision.requiredBits],
      challengeBits: [...decision.challengeBits],
      ...(decision.sessionId ? { sessionId: decision.sessionId } : {}),
      canonicalParams: input.canonicalParams,
      canonicalParamsHash: hashCanonicalParams(input.canonicalParams),
      scopeHash: sha256Hex(stableStringify(decision.scope)),
      decision,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + challengeTtlMs).toISOString(),
      failedRedemptions: 0,
      maxFailedRedemptions,
      reasonCode: 'CONFIRMATION_REQUIRED',
      message: 'confirmation required before Relay routes this operation to the node',
    };
    challenges.set(challenge.challengeId, challenge);
    return challenge;
  }

  function approveChallenge(input: {
    challengeId: string;
    approverAuthSessionHash: string;
    approverDisplayName?: string;
    decision: ConfirmationDecision;
    now?: Date;
  }): ConfirmationApprovalResult {
    const current = input.now ?? now();
    const challenge = challenges.get(input.challengeId);
    if (!challenge) return failure('CONFIRMATION_NOT_FOUND', 'confirmation challenge not found');
    const expiryFailure = expireIfNeeded(challenge, current);
    if (expiryFailure) return expiryFailure;
    if (challenge.status !== 'pending') {
      return failure('CONFIRMATION_NOT_APPROVED', `confirmation challenge is ${challenge.status}`, challenge);
    }
    if (challenge.requesterAuthSessionHash === input.approverAuthSessionHash) {
      return failChallenge(challenge, 'CONFIRMATION_SAME_SESSION', 'the requesting browser/auth session cannot approve its own challenge', 'same_session_approval_attempt', 'deny');
    }
    if (input.decision === 'deny' || input.decision === 'deny_revoke') {
      const reasonCode = input.decision === 'deny' ? 'CONFIRMATION_DENIED' : 'CONFIRMATION_DENIED_REVOKE';
      challenge.status = input.decision === 'deny' ? 'denied' : 'revoked';
      challenge.reasonCode = reasonCode;
      challenge.message = input.decision === 'deny'
        ? 'confirmation challenge was denied by a distinct authenticated session'
        : 'confirmation challenge was denied and the grant should be revoked';
      challenge.approverAuthSessionHash = input.approverAuthSessionHash;
      if (input.approverDisplayName) challenge.approverDisplayName = input.approverDisplayName;
      challenge.approvedAt = current.toISOString();
      return failure(reasonCode, challenge.message, challenge, auditForChallenge(challenge, {
        eventType: input.decision === 'deny' ? 'denial' : 'revocation',
        decision: input.decision === 'deny' ? 'deny' : 'revoked',
        reasonCode,
      }));
    }
    const token = randomToken();
    challenge.status = 'approved';
    challenge.reasonCode = 'CONFIRMATION_APPROVED';
    challenge.message = 'confirmation challenge approved by a distinct authenticated session';
    challenge.approverAuthSessionHash = input.approverAuthSessionHash;
    if (input.approverDisplayName) challenge.approverDisplayName = input.approverDisplayName;
    challenge.approvedAt = current.toISOString();
    challenge.tokenExpiresAt = new Date(current.getTime() + tokenTtlMs).toISOString();
    challenge.tokenHash = hashToken(token);
    challenge.requesterToken = token;
    return {
      ok: true,
      reasonCode: 'CONFIRMATION_APPROVED',
      message: challenge.message,
      challenge,
      confirmationToken: token,
      audit: auditForChallenge(challenge, {
        eventType: 'approval',
        decision: 'approved',
        reasonCode: 'CONFIRMATION_APPROVED',
      }),
    };
  }

  function redeemToken(input: {
    token: string;
    requesterAuthSessionHash: string;
    decision: HubPolicyDecision;
    canonicalParams: CanonicalConfirmationParams;
    now?: Date;
  }): ConfirmationRedemptionResult {
    const current = input.now ?? now();
    const tokenHash = hashToken(input.token);
    const challenge = Array.from(challenges.values()).find(
      (candidate) => candidate.tokenHash === tokenHash
    );
    if (!challenge) return failure('CONFIRMATION_TOKEN_INVALID', 'confirmation token is invalid');
    const expiryFailure = expireIfNeeded(challenge, current, true);
    if (expiryFailure) return expiryFailure;
    if (challenge.status === 'redeemed') {
      return failure('CONFIRMATION_ALREADY_USED', 'confirmation token was already used', challenge);
    }
    if (challenge.status !== 'approved') {
      return failure('CONFIRMATION_NOT_APPROVED', `confirmation challenge is ${challenge.status}`, challenge);
    }
    if (challenge.requesterAuthSessionHash !== input.requesterAuthSessionHash) {
      return failChallenge(challenge, 'CONFIRMATION_REQUESTER_MISMATCH', 'confirmation token can only be redeemed by the original requesting auth session', 'failed_redemption', 'failed');
    }
    if (challenge.approverAuthSessionHash === input.requesterAuthSessionHash) {
      return failChallenge(challenge, 'CONFIRMATION_SAME_SESSION', 'the approving browser/auth session cannot redeem its own approval', 'same_session_approval_attempt', 'deny');
    }
    if (!challengeContextMatches(challenge, input.decision)) {
      return failChallenge(challenge, 'CONFIRMATION_CONTEXT_MISMATCH', 'confirmation token does not match this node, intent, capability set, or session', 'failed_redemption', 'failed');
    }
    if (challenge.canonicalParamsHash !== hashCanonicalParams(input.canonicalParams)) {
      challenge.failedRedemptions += 1;
      if (challenge.failedRedemptions >= challenge.maxFailedRedemptions) {
        challenge.status = 'invalidated';
        challenge.reasonCode = 'CONFIRMATION_PARAM_MISMATCH';
        challenge.message = 'confirmation token invalidated after too many parameter mismatches';
      }
      return failure('CONFIRMATION_PARAM_MISMATCH', 'confirmation token parameters do not match the original challenge', challenge, auditForChallenge(challenge, {
        eventType: 'failed_redemption',
        decision: 'failed',
        reasonCode: 'CONFIRMATION_PARAM_MISMATCH',
        params: input.canonicalParams,
      }));
    }
    challenge.status = 'redeemed';
    challenge.redeemedAt = current.toISOString();
    challenge.reasonCode = 'CONFIRMATION_APPROVED';
    challenge.message = 'confirmation token redeemed';
    delete challenge.requesterToken;
    return {
      ok: true,
      reasonCode: 'CONFIRMATION_APPROVED',
      message: challenge.message,
      challenge,
      audit: auditForChallenge(challenge, {
        eventType: 'grant',
        decision: 'allow',
        reasonCode: 'CONFIRMATION_APPROVED',
      }),
    };
  }

  function getRequesterToken(input: {
    challengeId: string;
    requesterAuthSessionHash: string;
    now?: Date;
  }): ConfirmationRequesterTokenResult {
    const current = input.now ?? now();
    const challenge = challenges.get(input.challengeId);
    if (!challenge) return failure('CONFIRMATION_NOT_FOUND', 'confirmation challenge not found');
    const expiryFailure = expireIfNeeded(challenge, current, true);
    if (expiryFailure) return expiryFailure;
    if (challenge.requesterAuthSessionHash !== input.requesterAuthSessionHash) {
      return failure('CONFIRMATION_REQUESTER_MISMATCH', 'confirmation token can only be picked up by the original requesting auth session', challenge);
    }
    if (challenge.status === 'redeemed') {
      return failure('CONFIRMATION_ALREADY_USED', 'confirmation token was already used', challenge);
    }
    if (challenge.status !== 'approved') {
      return failure('CONFIRMATION_NOT_APPROVED', `confirmation challenge is ${challenge.status}`, challenge);
    }
    if (!challenge.requesterToken) {
      return failure('CONFIRMATION_TOKEN_INVALID', 'confirmation token is no longer available', challenge);
    }
    return {
      ok: true,
      reasonCode: 'CONFIRMATION_APPROVED',
      message: 'confirmation token available to original requester',
      challenge,
      confirmationToken: challenge.requesterToken,
    };
  }

  function invalidateChallenge(input: {
    challengeId: string;
    reasonCode: ConfirmationReasonCode;
    message: string;
    now?: Date;
  }): ConfirmationChallenge | undefined {
    const current = input.now ?? now();
    const challenge = challenges.get(input.challengeId);
    if (!challenge) return undefined;
    challenge.status = 'invalidated';
    challenge.reasonCode = input.reasonCode;
    challenge.message = input.message;
    challenge.approvedAt = current.toISOString();
    delete challenge.tokenExpiresAt;
    delete challenge.tokenHash;
    delete challenge.requesterToken;
    return challenge;
  }

  return {
    createChallenge,
    approveChallenge,
    redeemToken,
    getRequesterToken,
    invalidateChallenge,
    getChallenge: (challengeId) => {
      pruneStoredChallenges(now());
      return challenges.get(challengeId);
    },
    listChallenges: () => {
      pruneStoredChallenges(now());
      return Array.from(challenges.values()).map(publicChallenge);
    },
  };
}

export function canonicalConfirmationParams(
  action: string,
  params: unknown
): CanonicalConfirmationParams {
  const record = asRecord(params);
  switch (action) {
    case 'pty.exec.arbitrary':
      return stripUndefined({
        action,
        command: stringField(record, 'command'),
        cwd: stringField(record, 'cwd'),
        envHash: hashOptional(record?.['env']),
      });
    case 'rpc.fs.write': {
      const bytes = bytesFromFileWrite(record);
      return stripUndefined({
        action,
        cwd: stringField(record, 'cwd'),
        path: stringField(record, 'path'),
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
    }
    case 'rpc.fs.delete':
      return stripUndefined({
        action,
        cwd: stringField(record, 'cwd'),
        path: stringField(record, 'path'),
        recursive: Boolean(record?.['recursive']),
      });
    case 'rpc.git.write':
      return stripUndefined({
        action,
        cwd: stringField(record, 'cwd'),
        verb: stringField(record, 'verb') ?? stringField(record, 'gitVerb'),
        refSpec: stringField(record, 'refSpec'),
        remote: stringField(record, 'remote'),
      });
    case 'sessions.create':
    case 'sessions.kill':
    case 'sessions.create.agent':
    case 'sessions.create.terminal':
      return canonicalSessionParams(action, record, [
        'type',
        'cwd',
        'repoPath',
        'worktreePath',
        'sessionId',
        'method',
      ]);
    default:
      if (action.startsWith('rpc.fs.')) {
        return canonicalGenericParams(action, record, [
          'cwd',
          'path',
          'root',
          'maxBytes',
          'maxLines',
          'maxEntries',
          'recursive',
        ]);
      }
      return { action, paramsHash: sha256Hex(stableStringify(params ?? null)) };
  }
}

export function hashAuthSessionIdentity(value: string): string {
  return sha256Hex(`relay-auth-session:${value}`);
}

export function publicChallenge(
  challenge: ConfirmationChallenge
): ConfirmationChallengePublicView {
  return {
    challengeId: challenge.challengeId,
    status: challenge.status,
    nodeId: challenge.nodeId,
    intent: challenge.intent,
    requiredBits: challenge.requiredBits,
    challengeBits: challenge.challengeBits,
    ...(challenge.sessionId ? { sessionId: challenge.sessionId } : {}),
    canonicalParams: challenge.canonicalParams,
    canonicalParamsHash: challenge.canonicalParamsHash,
    ...(challenge.requesterDisplayName ? { requesterDisplayName: challenge.requesterDisplayName } : {}),
    ...(challenge.approverDisplayName ? { approverDisplayName: challenge.approverDisplayName } : {}),
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt,
    ...(challenge.approvedAt ? { approvedAt: challenge.approvedAt } : {}),
    ...(challenge.tokenExpiresAt ? { tokenExpiresAt: challenge.tokenExpiresAt } : {}),
    failedRedemptions: challenge.failedRedemptions,
    maxFailedRedemptions: challenge.maxFailedRedemptions,
    reasonCode: challenge.reasonCode,
    message: challenge.message,
  };
}

function failChallenge(
  challenge: ConfirmationChallenge,
  reasonCode: ConfirmationReasonCode,
  message: string,
  eventType: SecurityAuditEntryInput['eventType'],
  decision: SecurityAuditEntryInput['decision']
): ConfirmationFailure {
  challenge.reasonCode = reasonCode;
  challenge.message = message;
  return failure(reasonCode, message, challenge, auditForChallenge(challenge, {
    eventType,
    decision,
    reasonCode,
  }));
}

function failure(
  reasonCode: ConfirmationReasonCode,
  message: string,
  challenge?: ConfirmationChallenge,
  audit?: SecurityAuditEntryInput
): ConfirmationFailure {
  return { ok: false, reasonCode, message, ...(challenge ? { challenge } : {}), ...(audit ? { audit } : {}) };
}

function expireIfNeeded(
  challenge: ConfirmationChallenge,
  now: Date,
  includeToken = false
): ConfirmationFailure | null {
  if (isTerminalChallengeStatus(challenge.status)) return null;
  const challengeExpired = Date.parse(challenge.expiresAt) <= now.getTime();
  const tokenExpired =
    includeToken && challenge.tokenExpiresAt
      ? Date.parse(challenge.tokenExpiresAt) <= now.getTime()
      : false;
  if (!challengeExpired && !tokenExpired) return null;
  challenge.status = 'expired';
  challenge.reasonCode = 'CONFIRMATION_EXPIRED';
  delete challenge.requesterToken;
  challenge.message = tokenExpired
    ? 'confirmation token expired'
    : 'confirmation challenge expired';
  return failure('CONFIRMATION_EXPIRED', challenge.message, challenge, auditForChallenge(challenge, {
    eventType: 'expiry',
    decision: 'expired',
    reasonCode: 'CONFIRMATION_EXPIRED',
  }));
}

function challengeContextMatches(
  challenge: ConfirmationChallenge,
  decision: HubPolicyDecision
): boolean {
  return (
    challenge.nodeId === decision.nodeId &&
    challenge.intent.action === decision.intent.action &&
    (challenge.intent.target ?? null) === (decision.intent.target ?? null) &&
    (challenge.sessionId ?? null) === (decision.sessionId ?? null) &&
    stableStringify(challenge.requiredBits) === stableStringify(decision.requiredBits) &&
    stableStringify(challenge.challengeBits) === stableStringify(decision.challengeBits) &&
    challenge.scopeHash === sha256Hex(stableStringify(decision.scope))
  );
}

function auditForChallenge(
  challenge: ConfirmationChallenge,
  input: {
    eventType: SecurityAuditEntryInput['eventType'];
    decision: SecurityAuditEntryInput['decision'];
    reasonCode: string;
    params?: unknown;
  }
): SecurityAuditEntryInput {
  const policy = challenge.decision;
  return {
    eventType: input.eventType,
    decision: input.decision,
    reasonCode: input.reasonCode,
    peer: auditPeerForChallenge(challenge, input.eventType),
    node: {
      nodeId: challenge.nodeId,
      ...(policy.trustTier ? { trustTier: policy.trustTier } : {}),
    },
    ...(challenge.sessionId ? { sessionId: challenge.sessionId } : {}),
    intent: challenge.intent,
    material: {
      scope: policy.scope,
      params: input.params ?? challenge.canonicalParams,
    },
    requiredBits: challenge.requiredBits,
    grantedBits: input.decision === 'allow' || input.decision === 'approved' ? challenge.requiredBits : [],
    deniedBits: input.decision === 'deny' || input.decision === 'failed' ? challenge.requiredBits : [],
    refs: {
      ...(policy.aclRef ? { aclRef: policy.aclRef } : {}),
      ...(policy.policyVersion ? { policyVersion: policy.policyVersion } : {}),
    },
    ...(policy.correlationId ? { correlationId: policy.correlationId } : {}),
  };
}

function auditPeerForChallenge(
  challenge: ConfirmationChallenge,
  eventType: SecurityAuditEntryInput['eventType']
): SecurityAuditEntryInput['peer'] {
  const useApprover =
    (eventType === 'approval' || eventType === 'denial' || eventType === 'revocation') &&
    Boolean(challenge.approverAuthSessionHash);
  const principalHash = useApprover
    ? challenge.approverAuthSessionHash!
    : challenge.requesterAuthSessionHash;
  const displayName = useApprover
    ? challenge.approverDisplayName
    : challenge.requesterDisplayName;
  return {
    kind: 'user',
    principalHash,
    ...(displayName ? { displayName } : {}),
  };
}

function isTerminalChallengeStatus(status: ConfirmationChallengeStatus): boolean {
  return status !== 'pending' && status !== 'approved';
}

function hashCanonicalParams(value: CanonicalConfirmationParams): string {
  return sha256Hex(stableStringify(value));
}

function hashToken(token: string): string {
  return sha256Hex(`relay-confirmation-token:${token}`);
}

function randomChallengeId(): string {
  return `confirm_${crypto.randomBytes(16).toString('hex')}`;
}

function randomConfirmationToken(): string {
  return `relay-confirm.${crypto.randomBytes(32).toString('base64url')}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function hashOptional(value: unknown): string | undefined {
  return value === undefined ? undefined : sha256Hex(stableStringify(value));
}

function bytesFromFileWrite(record: Record<string, unknown> | undefined): Buffer {
  const content = record?.['content'] ?? record?.['bytes'] ?? record?.['data'];
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (typeof content === 'string') return Buffer.from(content);
  return Buffer.alloc(0);
}

function canonicalGenericParams(
  action: string,
  record: Record<string, unknown> | undefined,
  keys: string[]
): CanonicalConfirmationParams {
  const result: CanonicalConfirmationParams = { action };
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function canonicalSessionParams(
  action: string,
  record: Record<string, unknown> | undefined,
  keys: string[]
): CanonicalConfirmationParams {
  return {
    ...canonicalGenericParams(action, record, keys),
    // Keep the operator-readable fields above, but bind the approval token to
    // the full routed session payload so omitted security-relevant fields (for
    // example command/customCommand/initialPrompt/controlMode/useTmux) cannot be
    // changed between approval and redemption.
    paramsHash: sha256Hex(stableStringify(record ?? null)),
  };
}

function stripUndefined(input: Record<string, unknown>): CanonicalConfirmationParams {
  const output: CanonicalConfirmationParams = { action: String(input['action']) };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'action' || value === undefined) continue;
    output[key] = value;
  }
  return output;
}
