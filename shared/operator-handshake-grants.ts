import * as crypto from 'node:crypto';
import {
  hashAuditMaterial,
  redactAuditValue,
  sha256Hex,
  type SecurityAuditDecision,
  type SecurityAuditEntryInput,
  type SecurityAuditEventType,
} from './security-audit.js';
import {
  HIGH_RISK_CAPABILITIES,
  RELAY_SECURITY_POLICY_VERSION,
  isRelayCapabilityBit,
  type RelayCapabilityBit,
} from './security-policy.js';

export const HANDSHAKE_GRANT_TOKEN_PREFIX = 'relay-ohg-v1' as const;
export const NODE_PAIR_TOKEN_MINT_GRANT_AUDIENCE =
  'relay:node-pair-token:v1' as const;
export const NODE_PAIR_TOKEN_CREATE_CAPABILITY =
  'node:pair-token:create' as const;

export const HANDSHAKE_GRANT_ACTOR_TYPES = [
  'agent',
  'cli',
  'automation-system',
] as const;

export type HandshakeGrantActorType =
  (typeof HANDSHAKE_GRANT_ACTOR_TYPES)[number];

export const HANDSHAKE_GRANT_AUDIENCES = [
  'relay:operator-handshake:v1',
  'relay:cli-gateway:v1',
  NODE_PAIR_TOKEN_MINT_GRANT_AUDIENCE,
  'relay:registry-test',
] as const;

export type HandshakeGrantAudience = (typeof HANDSHAKE_GRANT_AUDIENCES)[number];

export const DEFAULT_HANDSHAKE_GRANT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_HANDSHAKE_GRANT_MAX_TTL_MS = 30 * 60 * 1000;

const HIGH_RISK_CAPABILITY_SET = new Set<RelayCapabilityBit>(
  HIGH_RISK_CAPABILITIES
);

export type HandshakeGrantRequestStatus =
  | 'requested'
  | 'approved'
  | 'denied'
  | 'revoked'
  | 'expired'
  | 'consumed';

export type HandshakeGrantValidationFailureReason =
  | 'malformed_grant'
  | 'lane_mixing'
  | 'unknown_audience'
  | 'wrong_audience'
  | 'not_approved'
  | 'expired'
  | 'revoked'
  | 'replayed'
  | 'actor_mismatch'
  | 'device_mismatch'
  | 'session_mismatch'
  | 'missing_scope'
  | 'wrong_node_scope'
  | 'wrong_session_scope'
  | 'wrong_global_session_scope'
  | 'wrong_work_context_scope'
  | 'wrong_repo_scope'
  | 'wrong_path_scope'
  | 'wrong_task_scope'
  | 'unknown_capability'
  | 'insufficient_capability';

export type HandshakeGrantIssueFailureReason =
  | 'unsupported_actor_type'
  | 'unknown_audience'
  | 'unknown_capability'
  | 'scope_required'
  | 'expiry_required'
  | 'expiry_exceeds_max_ttl'
  | 'duplicate_grant_id'
  | 'high_risk_approval_required'
  | 'grant_not_found'
  | 'grant_not_pending';

export interface HandshakeGrantActor {
  type: string;
  id: string;
  displayName?: string;
}

export interface HandshakeGrantIssuer {
  id: string;
  displayName?: string;
}

export interface HandshakeGrantDeviceBindingInput {
  id: string;
  displayName?: string;
}

export interface HandshakeGrantSessionBinding {
  sessionId?: string;
  globalSessionId?: string;
  workContextId?: string;
  authSessionHash?: string;
}

export interface HandshakeGrantScope {
  nodeIds?: string[];
  sessionIds?: string[];
  globalSessionIds?: string[];
  workContextIds?: string[];
  repoIds?: string[];
  pathPrefixes?: string[];
  taskRefs?: string[];
}

export interface HandshakeGrantValidationScope {
  nodeId?: string;
  sessionId?: string;
  globalSessionId?: string;
  workContextId?: string;
  deferWorkContextScope?: boolean;
  repoId?: string;
  path?: string;
  taskRef?: string;
}

export interface HandshakeGrantMetadata {
  reason?: string;
  taskRef?: string;
  refs?: string[];
}

export interface HandshakeGrantHighRiskApprovalRef {
  challengeId: string;
  contractHash: string;
  approvedAt: string;
}

export interface HandshakeGrantRecord {
  id: string;
  jti: string;
  status: HandshakeGrantRequestStatus;
  actor: HandshakeGrantActor & { type: HandshakeGrantActorType };
  issuer: {
    idHash: string;
    displayName?: string;
  };
  audience: HandshakeGrantAudience;
  capabilities: RelayCapabilityBit[];
  scope: HandshakeGrantScope;
  device?: {
    idHash: string;
    displayName?: string;
  };
  sessionBinding?: HandshakeGrantSessionBinding;
  metadata?: HandshakeGrantMetadata;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  approvedByHash?: string;
  deniedAt?: string;
  deniedByHash?: string;
  deniedReason?: string;
  revokedAt?: string;
  revokedByHash?: string;
  revocationReason?: string;
  consumedAt?: string;
  consumedBy?: string;
  highRiskApproval?: HandshakeGrantHighRiskApprovalRef;
  correlationId: string;
}

interface InternalHandshakeGrantRecord extends HandshakeGrantRecord {
  handleHash?: string;
}

export interface RequestHandshakeGrantInput {
  id?: string;
  actor: HandshakeGrantActor;
  issuer: HandshakeGrantIssuer;
  audience: string;
  capabilities: string[];
  scope: HandshakeGrantScope;
  device?: HandshakeGrantDeviceBindingInput;
  sessionBinding?: HandshakeGrantSessionBinding;
  metadata?: HandshakeGrantMetadata;
  expiresAt?: Date | string;
  ttlMs?: number;
  correlationId?: string;
}

export interface ApproveHandshakeGrantInput {
  approvedBy: HandshakeGrantIssuer;
  highRiskApproval?: HandshakeGrantHighRiskApprovalRef;
  correlationId?: string;
}

export interface DenyHandshakeGrantInput {
  deniedBy: HandshakeGrantIssuer;
  reason?: string;
  correlationId?: string;
}

export interface ApprovedHandshakeGrant {
  handle: string;
  grant: HandshakeGrantRecord;
  copy: HandshakeGrantApprovalCopy;
}

export interface ValidateHandshakeGrantInput {
  audience: string;
  requiredCapabilities: string[];
  actor?: HandshakeGrantActor;
  deviceId?: string;
  sessionBinding?: HandshakeGrantSessionBinding;
  scope?: HandshakeGrantValidationScope;
  consume?: boolean;
  correlationId?: string;
}

export type HandshakeGrantValidationResult =
  | {
      ok: true;
      grant: HandshakeGrantRecord;
      grantedBits: RelayCapabilityBit[];
      consumed: boolean;
    }
  | {
      ok: false;
      reason: HandshakeGrantValidationFailureReason;
      grantId?: string;
      deniedBits: string[];
    };

export interface RevokeHandshakeGrantInput {
  revokedBy: HandshakeGrantIssuer;
  reason?: string;
  correlationId?: string;
}

export interface HandshakeGrantAuditEvent {
  action:
    | 'request'
    | 'approve'
    | 'deny'
    | 'issue'
    | 'validate'
    | 'expiry'
    | 'revoke'
    | 'replay';
  decision: SecurityAuditDecision;
  reasonCode: string;
  grantId?: string;
  jti?: string;
  actor?: HandshakeGrantRecord['actor'];
  issuer?: HandshakeGrantRecord['issuer'];
  audience?: HandshakeGrantAudience;
  scopeHash: string;
  paramsHash: string;
  requiredBits: RelayCapabilityBit[];
  grantedBits: RelayCapabilityBit[];
  deniedBits: string[];
  correlationId: string;
}

export interface CreateHandshakeGrantAuditEntryInput {
  action: HandshakeGrantAuditEvent['action'];
  decision: SecurityAuditDecision;
  reasonCode: string;
  grant?: HandshakeGrantRecord;
  requiredCapabilities?: RelayCapabilityBit[];
  grantedCapabilities?: RelayCapabilityBit[];
  deniedCapabilities?: RelayCapabilityBit[];
  correlationId?: string;
  material?: {
    scope?: unknown;
    params?: unknown;
  };
}

export interface HandshakeGrantApprovalCopy {
  title: string;
  summary: string;
  details: string[];
  revokePath: string;
}

export class HandshakeGrantRegistryError extends Error {
  constructor(
    public readonly code: HandshakeGrantIssueFailureReason,
    message: string
  ) {
    super(`${code.toUpperCase()}: ${message}`);
    this.name = 'HandshakeGrantRegistryError';
  }
}

export class HandshakeGrantRegistry {
  private readonly grants = new Map<string, InternalHandshakeGrantRecord>();
  private readonly auditEvents: HandshakeGrantAuditEvent[] = [];
  private readonly maxTtlMs: number;
  private readonly now: () => Date;
  private readonly secretBytes: () => Buffer;

  constructor(
    options: {
      maxTtlMs?: number;
      now?: () => Date;
      secretBytes?: () => Buffer;
    } = {}
  ) {
    this.maxTtlMs = options.maxTtlMs ?? DEFAULT_HANDSHAKE_GRANT_MAX_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.secretBytes = options.secretBytes ?? (() => crypto.randomBytes(32));
  }

  request(input: RequestHandshakeGrantInput): HandshakeGrantRecord {
    const actorType = normalizeActorType(input.actor.type);
    const audience = normalizeAudience(input.audience);
    const capabilities = normalizeGrantCapabilities(input.capabilities);
    const scope = normalizeGrantScope(input.scope);
    const metadata = input.metadata
      ? normalizeMetadata(input.metadata)
      : undefined;
    const createdAt = this.now();
    const expiresAt = this.resolveExpiry(input, createdAt);
    const id = input.id ?? crypto.randomUUID();
    if (this.grants.has(id)) {
      throw new HandshakeGrantRegistryError(
        'duplicate_grant_id',
        `handshake grant ${id} already exists`
      );
    }

    const grant: InternalHandshakeGrantRecord = {
      id,
      jti: id,
      status: 'requested',
      actor: {
        type: actorType,
        id: input.actor.id,
        ...(input.actor.displayName
          ? { displayName: input.actor.displayName }
          : {}),
      },
      issuer: {
        idHash: sha256Hex(input.issuer.id),
        ...(input.issuer.displayName
          ? { displayName: input.issuer.displayName }
          : {}),
      },
      audience,
      capabilities,
      scope,
      ...(input.device
        ? {
            device: {
              idHash: sha256Hex(input.device.id),
              ...(input.device.displayName
                ? { displayName: input.device.displayName }
                : {}),
            },
          }
        : {}),
      ...(input.sessionBinding
        ? { sessionBinding: copySessionBinding(input.sessionBinding) }
        : {}),
      ...(metadata ? { metadata } : {}),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      correlationId: input.correlationId ?? crypto.randomUUID(),
    };
    this.grants.set(id, grant);
    this.recordAudit({
      action: 'request',
      decision: 'requires_confirmation',
      reasonCode: 'HANDSHAKE_GRANT_REQUESTED',
      grant,
      requiredCapabilities: capabilities,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: auditMaterialForGrant(grant, { operation: 'request' }),
    });
    return publicGrant(grant);
  }

  approve(
    grantId: string,
    input: ApproveHandshakeGrantInput
  ): ApprovedHandshakeGrant {
    const grant = this.grants.get(grantId);
    if (!grant) {
      throw new HandshakeGrantRegistryError(
        'grant_not_found',
        `handshake grant ${grantId} was not found`
      );
    }
    if (grant.status !== 'requested') {
      throw new HandshakeGrantRegistryError(
        'grant_not_pending',
        `handshake grant ${grantId} is ${grant.status}`
      );
    }
    const requiresApprovalEvidence = requiresHighRiskApproval(grant);
    const highRiskApproval = requiresApprovalEvidence
      ? normalizeHighRiskApprovalEvidence(input.highRiskApproval)
      : input.highRiskApproval;
    if (requiresApprovalEvidence && !highRiskApproval) {
      grant.status = 'denied';
      grant.deniedAt = this.now().toISOString();
      grant.deniedByHash = sha256Hex(input.approvedBy.id);
      grant.deniedReason =
        'high-risk capabilities require approval contract evidence';
      this.recordAudit({
        action: 'deny',
        decision: 'deny',
        reasonCode: 'HANDSHAKE_GRANT_HIGH_RISK_APPROVAL_REQUIRED',
        grant,
        deniedCapabilities: grant.capabilities.filter((bit) =>
          HIGH_RISK_CAPABILITY_SET.has(bit)
        ),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        material: auditMaterialForGrant(grant, { operation: 'approve-denied' }),
      });
      throw new HandshakeGrantRegistryError(
        'high_risk_approval_required',
        'handshake grants for high-risk capabilities require non-empty #807 approval contract evidence fields'
      );
    }

    const secret = this.secretBytes().toString('hex');
    const handle = `${HANDSHAKE_GRANT_TOKEN_PREFIX}.${grant.id}.${secret}`;
    grant.handleHash = sha256Hex(secret);
    grant.status = 'approved';
    grant.approvedAt = this.now().toISOString();
    grant.approvedByHash = sha256Hex(input.approvedBy.id);
    if (input.highRiskApproval) {
      grant.highRiskApproval = { ...input.highRiskApproval };
    }
    this.recordAudit({
      action: 'approve',
      decision: 'approved',
      reasonCode: 'HANDSHAKE_GRANT_APPROVED',
      grant,
      grantedCapabilities: grant.capabilities,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: auditMaterialForGrant(grant, { operation: 'approve' }),
    });
    this.recordAudit({
      action: 'issue',
      decision: 'allow',
      reasonCode: 'HANDSHAKE_GRANT_ISSUED',
      grant,
      grantedCapabilities: grant.capabilities,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: auditMaterialForGrant(grant, { operation: 'issue' }),
    });
    return {
      handle,
      grant: publicGrant(grant),
      copy: operatorHandshakeGrantApprovalCopy(publicGrant(grant)),
    };
  }

  deny(
    grantId: string,
    input: DenyHandshakeGrantInput
  ): HandshakeGrantRecord | null {
    const grant = this.grants.get(grantId);
    if (!grant) return null;
    if (grant.status !== 'requested') return publicGrant(grant);
    grant.status = 'denied';
    grant.deniedAt = this.now().toISOString();
    grant.deniedByHash = sha256Hex(input.deniedBy.id);
    if (input.reason) {
      const deniedReason = redactSafeString(input.reason);
      if (deniedReason) grant.deniedReason = deniedReason;
    }
    this.recordAudit({
      action: 'deny',
      decision: 'deny',
      reasonCode: 'HANDSHAKE_GRANT_DENIED',
      grant,
      deniedCapabilities: grant.capabilities,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: auditMaterialForGrant(grant, { operation: 'deny' }),
    });
    return publicGrant(grant);
  }

  validate(
    handle: string,
    input: ValidateHandshakeGrantInput
  ): HandshakeGrantValidationResult {
    const parsed = parseHandshakeGrantHandle(handle);
    if (!parsed) {
      return this.denyValidation(
        isForeignCredentialLane(handle) ? 'lane_mixing' : 'malformed_grant',
        undefined,
        input,
        []
      );
    }
    const grant = this.grants.get(parsed.id);
    if (!grant || grant.handleHash !== sha256Hex(parsed.secret)) {
      return this.denyValidation('malformed_grant', parsed.id, input, []);
    }
    if (!isHandshakeGrantAudience(input.audience)) {
      return this.denyValidation('unknown_audience', grant.id, input, []);
    }
    if (grant.audience !== input.audience) {
      return this.denyValidation('wrong_audience', grant.id, input, []);
    }
    if (grant.status === 'requested' || grant.status === 'denied') {
      return this.denyValidation('not_approved', grant.id, input, []);
    }
    if (new Date(grant.expiresAt).getTime() <= this.now().getTime()) {
      grant.status = 'expired';
      return this.denyValidation(
        'expired',
        grant.id,
        input,
        input.requiredCapabilities
      );
    }
    if (grant.revokedAt || grant.status === 'revoked') {
      return this.denyValidation(
        'revoked',
        grant.id,
        input,
        input.requiredCapabilities
      );
    }
    if (grant.consumedAt || grant.status === 'consumed') {
      return this.denyValidation(
        'replayed',
        grant.id,
        input,
        input.requiredCapabilities
      );
    }
    if (input.actor && !actorMatches(grant.actor, input.actor)) {
      return this.denyValidation(
        'actor_mismatch',
        grant.id,
        input,
        input.requiredCapabilities
      );
    }
    if (
      grant.device &&
      sha256Hex(input.deviceId ?? '') !== grant.device.idHash
    ) {
      return this.denyValidation(
        'device_mismatch',
        grant.id,
        input,
        input.requiredCapabilities
      );
    }
    if (!sessionBindingMatches(grant.sessionBinding, input.sessionBinding)) {
      return this.denyValidation(
        'session_mismatch',
        grant.id,
        input,
        input.requiredCapabilities
      );
    }

    const unknownCapability = input.requiredCapabilities.find(
      (capability) => !isRelayCapabilityBit(capability)
    );
    if (unknownCapability) {
      return this.denyValidation('unknown_capability', grant.id, input, [
        unknownCapability,
      ]);
    }
    const required = input.requiredCapabilities as RelayCapabilityBit[];
    const missing = required.filter(
      (capability) => !grant.capabilities.includes(capability)
    );
    if (missing.length > 0) {
      return this.denyValidation(
        'insufficient_capability',
        grant.id,
        input,
        missing
      );
    }
    const scopeFailure = validateGrantScope(grant.scope, input.scope);
    if (scopeFailure) {
      return this.denyValidation(scopeFailure, grant.id, input, required);
    }

    const consume = input.consume ?? true;
    if (consume) {
      grant.status = 'consumed';
      grant.consumedAt = this.now().toISOString();
      grant.consumedBy = input.actor
        ? `${input.actor.type}:${input.actor.id}`
        : 'unknown';
    }
    this.recordAudit({
      action: 'validate',
      decision: 'allow',
      reasonCode: consume
        ? 'HANDSHAKE_GRANT_CONSUMED'
        : 'HANDSHAKE_GRANT_VALIDATED',
      grant,
      requiredCapabilities: required,
      grantedCapabilities: required,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: auditMaterialForValidation(grant, input),
    });
    return {
      ok: true,
      grant: publicGrant(grant),
      grantedBits: required,
      consumed: consume,
    };
  }

  revoke(
    grantId: string,
    input: RevokeHandshakeGrantInput
  ): HandshakeGrantRecord | null {
    const grant = this.grants.get(grantId);
    if (!grant) return null;
    grant.status = 'revoked';
    grant.revokedAt = this.now().toISOString();
    grant.revokedByHash = sha256Hex(input.revokedBy.id);
    if (input.reason) {
      const revocationReason = redactSafeString(input.reason);
      if (revocationReason) grant.revocationReason = revocationReason;
    }
    this.recordAudit({
      action: 'revoke',
      decision: 'revoked',
      reasonCode: 'HANDSHAKE_GRANT_REVOKED',
      grant,
      deniedCapabilities: grant.capabilities,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: auditMaterialForGrant(grant, { operation: 'revoke' }),
    });
    return publicGrant(grant);
  }

  listGrants(): HandshakeGrantRecord[] {
    return Array.from(this.grants.values()).map(publicGrant);
  }

  getGrant(grantId: string): HandshakeGrantRecord | null {
    const grant = this.grants.get(grantId);
    return grant ? publicGrant(grant) : null;
  }

  listAuditEvents(): HandshakeGrantAuditEvent[] {
    return this.auditEvents.map((event) => ({
      ...event,
      ...(event.actor ? { actor: { ...event.actor } } : {}),
      ...(event.issuer ? { issuer: { ...event.issuer } } : {}),
      requiredBits: [...event.requiredBits],
      grantedBits: [...event.grantedBits],
      deniedBits: [...event.deniedBits],
    }));
  }

  private resolveExpiry(
    input: RequestHandshakeGrantInput,
    createdAt: Date
  ): Date {
    if (!input.expiresAt && input.ttlMs == null) {
      return new Date(createdAt.getTime() + DEFAULT_HANDSHAKE_GRANT_TTL_MS);
    }
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(createdAt.getTime() + (input.ttlMs ?? 0));
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new HandshakeGrantRegistryError(
        'expiry_required',
        'handshake grant expiry must be a valid date'
      );
    }
    if (expiresAt.getTime() - createdAt.getTime() > this.maxTtlMs) {
      throw new HandshakeGrantRegistryError(
        'expiry_exceeds_max_ttl',
        'handshake grant ttl exceeds registry maximum'
      );
    }
    return expiresAt;
  }

  private denyValidation(
    reason: HandshakeGrantValidationFailureReason,
    grantId: string | undefined,
    input: ValidateHandshakeGrantInput,
    deniedBits: string[]
  ): HandshakeGrantValidationResult {
    const grant = grantId ? this.grants.get(grantId) : undefined;
    this.recordAudit({
      action:
        reason === 'expired'
          ? 'expiry'
          : reason === 'revoked'
            ? 'revoke'
            : reason === 'replayed'
              ? 'replay'
              : 'validate',
      decision:
        reason === 'expired'
          ? 'expired'
          : reason === 'revoked'
            ? 'revoked'
            : 'deny',
      reasonCode: handshakeGrantReasonCode(reason),
      ...(grant ? { grant } : {}),
      deniedCapabilities: knownDeniedCapabilities(deniedBits),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: grant
        ? auditMaterialForValidation(grant, input)
        : {
            params: {
              grantId: grantId ?? null,
              reason,
              audience: input.audience,
            },
          },
    });
    return {
      ok: false,
      reason,
      ...(grantId ? { grantId } : {}),
      deniedBits,
    };
  }

  private recordAudit(input: CreateHandshakeGrantAuditEntryInput): void {
    const grant = input.grant;
    const materialScope = redactHandshakeGrantValue(
      input.material?.scope ?? grant?.scope ?? null
    );
    const materialParams = redactHandshakeGrantValue(
      input.material?.params ?? null
    );
    this.auditEvents.push({
      action: input.action,
      decision: input.decision,
      reasonCode: input.reasonCode,
      ...(grant ? { grantId: grant.id, jti: grant.jti } : {}),
      ...(grant ? { actor: { ...grant.actor } } : {}),
      ...(grant ? { issuer: { ...grant.issuer } } : {}),
      ...(grant ? { audience: grant.audience } : {}),
      scopeHash: hashAuditMaterial(materialScope),
      paramsHash: hashAuditMaterial(materialParams),
      requiredBits: [...(input.requiredCapabilities ?? [])],
      grantedBits: [...(input.grantedCapabilities ?? [])],
      deniedBits: [...(input.deniedCapabilities ?? [])],
      correlationId: input.correlationId ?? crypto.randomUUID(),
    });
  }
}

export function isHandshakeGrantActorType(
  value: unknown
): value is HandshakeGrantActorType {
  return (
    typeof value === 'string' &&
    (HANDSHAKE_GRANT_ACTOR_TYPES as readonly string[]).includes(value)
  );
}

export function isHandshakeGrantAudience(
  value: unknown
): value is HandshakeGrantAudience {
  return (
    typeof value === 'string' &&
    (HANDSHAKE_GRANT_AUDIENCES as readonly string[]).includes(value)
  );
}

export function redactHandshakeGrantValue(value: unknown): unknown {
  return redactAuditValue(value);
}

export function operatorHandshakeGrantApprovalCopy(
  grant: HandshakeGrantRecord
): HandshakeGrantApprovalCopy {
  const scope = describeGrantScope(grant.scope);
  const device = grant.device?.displayName ?? 'no device binding';
  const session = describeSessionBinding(grant.sessionBinding);
  return {
    title: `Approve one-time Relay handshake grant for ${grant.actor.displayName ?? grant.actor.id}`,
    summary:
      `Delegates ${grant.capabilities.join(', ')} to ${grant.actor.type}:${grant.actor.id} ` +
      `for audience ${grant.audience} until ${grant.expiresAt}. This is a one-time handshake grant, not a browser login, pair token, node credential, or reusable scoped actor token.`,
    details: [
      `Actor: ${grant.actor.type}:${grant.actor.id}`,
      `Audience: ${grant.audience}`,
      `TTL/expires: ${grant.expiresAt}`,
      `Scope: ${scope}`,
      `Device: ${device}`,
      `Session binding: ${session}`,
      `Revoke: DELETE /operator/handshake-grants/${grant.id}`,
    ],
    revokePath: `/operator/handshake-grants/${grant.id}`,
  };
}

export function createHandshakeGrantAuditEntry(
  input: CreateHandshakeGrantAuditEntryInput
): SecurityAuditEntryInput {
  const grant = input.grant;
  const inputParams =
    typeof input.material?.params === 'object' && input.material.params !== null
      ? (input.material.params as Record<string, unknown>)
      : { params: input.material?.params ?? null };
  return {
    eventType: handshakeGrantAuditEventType(input.action, input.decision),
    decision: input.decision,
    reasonCode: input.reasonCode,
    peer: grant
      ? {
          kind: 'system',
          credentialId: grant.id,
          displayName: grant.actor.displayName ?? grant.actor.type,
          principalHash: sha256Hex(`${grant.actor.type}:${grant.actor.id}`),
        }
      : { kind: 'system' },
    intent: {
      action: `operator-handshake-grant.${input.action}`,
      ...(grant ? { target: grant.id } : {}),
    },
    material: {
      scope: redactHandshakeGrantValue(
        input.material?.scope ?? grant?.scope ?? null
      ),
      params: redactHandshakeGrantValue({
        ...inputParams,
        ...(grant ? { grant: redactHandshakeGrantForAudit(grant) } : {}),
      }),
    },
    requiredBits: [...(input.requiredCapabilities ?? [])],
    grantedBits: [...(input.grantedCapabilities ?? [])],
    deniedBits: [...(input.deniedCapabilities ?? [])],
    refs: { policyVersion: RELAY_SECURITY_POLICY_VERSION },
    correlationId: input.correlationId ?? crypto.randomUUID(),
  };
}

export function redactHandshakeGrantForAudit(grant: HandshakeGrantRecord): Omit<
  HandshakeGrantRecord,
  'actor' | 'deniedReason' | 'revocationReason'
> & {
  actor: Omit<HandshakeGrantRecord['actor'], 'id'> & { idHash: string };
} {
  const { id: _actorId, ...actor } = grant.actor;
  const {
    deniedReason: _deniedReason,
    revocationReason: _revocationReason,
    ...publicRecord
  } = publicGrant(grant);
  return {
    ...publicRecord,
    actor: {
      ...actor,
      idHash: sha256Hex(grant.actor.id),
    },
  };
}

function normalizeActorType(value: string): HandshakeGrantActorType {
  if (isHandshakeGrantActorType(value)) return value;
  throw new HandshakeGrantRegistryError(
    'unsupported_actor_type',
    `unsupported handshake grant actor type: ${value}`
  );
}

function normalizeAudience(value: string): HandshakeGrantAudience {
  if (isHandshakeGrantAudience(value)) return value;
  throw new HandshakeGrantRegistryError(
    'unknown_audience',
    `unknown handshake grant audience: ${value}`
  );
}

function normalizeGrantCapabilities(values: string[]): RelayCapabilityBit[] {
  const normalized: RelayCapabilityBit[] = [];
  const seen = new Set<RelayCapabilityBit>();
  for (const value of values) {
    if (!isRelayCapabilityBit(value)) {
      throw new HandshakeGrantRegistryError(
        'unknown_capability',
        `unknown Relay capability bit: ${value}`
      );
    }
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized;
}

function normalizeGrantScope(scope: HandshakeGrantScope): HandshakeGrantScope {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new HandshakeGrantRegistryError(
      'scope_required',
      'handshake grants require at least one explicit scope dimension'
    );
  }
  const normalized: HandshakeGrantScope = {
    ...(normalizeStringList(scope.nodeIds).length > 0
      ? { nodeIds: normalizeStringList(scope.nodeIds) }
      : {}),
    ...(normalizeStringList(scope.sessionIds).length > 0
      ? { sessionIds: normalizeStringList(scope.sessionIds) }
      : {}),
    ...(normalizeStringList(scope.globalSessionIds).length > 0
      ? { globalSessionIds: normalizeStringList(scope.globalSessionIds) }
      : {}),
    ...(normalizeStringList(scope.workContextIds).length > 0
      ? { workContextIds: normalizeStringList(scope.workContextIds) }
      : {}),
    ...(normalizeStringList(scope.repoIds).length > 0
      ? { repoIds: normalizeStringList(scope.repoIds) }
      : {}),
    ...(normalizeStringList(scope.pathPrefixes).length > 0
      ? { pathPrefixes: normalizeStringList(scope.pathPrefixes) }
      : {}),
    ...(normalizeStringList(scope.taskRefs).length > 0
      ? { taskRefs: normalizeStringList(scope.taskRefs) }
      : {}),
  };
  if (Object.keys(normalized).length === 0) {
    throw new HandshakeGrantRegistryError(
      'scope_required',
      'handshake grants require at least one explicit scope dimension'
    );
  }
  return normalized;
}

type ScopeValidationRule = {
  values: string[] | undefined;
  requested: string | undefined;
  wrongReason: HandshakeGrantValidationFailureReason;
  matches?: (values: string[], requested: string) => boolean;
};

function validateGrantScope(
  grantScope: HandshakeGrantScope,
  expectedScope: HandshakeGrantValidationScope | undefined
): HandshakeGrantValidationFailureReason | null {
  const rules: ScopeValidationRule[] = [
    {
      values: grantScope.nodeIds,
      requested: expectedScope?.nodeId,
      wrongReason: 'wrong_node_scope',
    },
    {
      values: grantScope.sessionIds,
      requested: expectedScope?.sessionId,
      wrongReason: 'wrong_session_scope',
    },
    {
      values: grantScope.globalSessionIds,
      requested: expectedScope?.globalSessionId,
      wrongReason: 'wrong_global_session_scope',
    },
    {
      values: grantScope.workContextIds,
      requested: expectedScope?.workContextId,
      wrongReason: 'wrong_work_context_scope',
    },
    {
      values: grantScope.repoIds,
      requested: expectedScope?.repoId,
      wrongReason: 'wrong_repo_scope',
    },
    {
      values: grantScope.pathPrefixes,
      requested: expectedScope?.path,
      wrongReason: 'wrong_path_scope',
      matches: (prefixes, path) =>
        prefixes.some((prefix) => pathMatchesGrantPrefix(path, prefix)),
    },
    {
      values: grantScope.taskRefs,
      requested: expectedScope?.taskRef,
      wrongReason: 'wrong_task_scope',
    },
  ];

  for (const rule of rules) {
    if (!rule.values || !rule.requested) continue;
    const matches = rule.matches ?? listIncludesRequestedValue;
    if (!matches(rule.values, rule.requested)) return rule.wrongReason;
  }

  return rules.some((rule) => rule.values && !rule.requested)
    ? 'missing_scope'
    : null;
}

function parseHandshakeGrantHandle(
  handle: unknown
): { id: string; secret: string } | null {
  if (typeof handle !== 'string') return null;
  const parts = handle.split('.');
  if (parts.length !== 3 || parts[0] !== HANDSHAKE_GRANT_TOKEN_PREFIX) {
    return null;
  }
  const [, id, secret] = parts;
  if (!id || !secret) return null;
  return { id, secret };
}

function isForeignCredentialLane(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  return (
    trimmed.startsWith('bearer ') ||
    trimmed.startsWith('relay-sac-v1.') ||
    trimmed.startsWith('pair_') ||
    trimmed.startsWith('node_') ||
    trimmed.includes('.secret_') ||
    trimmed.startsWith('relay-pair-') ||
    trimmed.startsWith('relay-node-') ||
    trimmed.includes('connect.sid=') ||
    trimmed.includes('token=')
  );
}

function requiresHighRiskApproval(grant: HandshakeGrantRecord): boolean {
  return grant.capabilities.some((capability) =>
    HIGH_RISK_CAPABILITY_SET.has(capability)
  );
}

function normalizeHighRiskApprovalEvidence(
  value: unknown
): HandshakeGrantHighRiskApprovalRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const challengeId = candidate.challengeId;
  const contractHash = candidate.contractHash;
  const approvedAt = candidate.approvedAt;
  if (
    typeof challengeId !== 'string' ||
    !challengeId.trim() ||
    typeof contractHash !== 'string' ||
    !contractHash.trim() ||
    typeof approvedAt !== 'string' ||
    !approvedAt.trim()
  ) {
    return null;
  }
  return { challengeId, contractHash, approvedAt };
}

function actorMatches(
  grantActor: HandshakeGrantRecord['actor'],
  requestedActor: HandshakeGrantActor
): boolean {
  return (
    grantActor.type === requestedActor.type &&
    grantActor.id === requestedActor.id
  );
}

function sessionBindingMatches(
  grantBinding: HandshakeGrantSessionBinding | undefined,
  requestedBinding: HandshakeGrantSessionBinding | undefined
): boolean {
  if (!grantBinding) return true;
  return (
    (!grantBinding.sessionId ||
      grantBinding.sessionId === requestedBinding?.sessionId) &&
    (!grantBinding.globalSessionId ||
      grantBinding.globalSessionId === requestedBinding?.globalSessionId) &&
    (!grantBinding.workContextId ||
      grantBinding.workContextId === requestedBinding?.workContextId) &&
    (!grantBinding.authSessionHash ||
      grantBinding.authSessionHash === requestedBinding?.authSessionHash)
  );
}

function listIncludesRequestedValue(
  values: string[],
  requested: string
): boolean {
  return values.includes(requested);
}

function pathMatchesGrantPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(normalizedPrefix);
}

function normalizeStringList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeMetadata(
  metadata: HandshakeGrantMetadata
): HandshakeGrantMetadata | undefined {
  const normalized: HandshakeGrantMetadata = {};
  const reason = redactSafeString(metadata.reason);
  const taskRef = redactSafeString(metadata.taskRef);
  const refs = normalizeStringList(metadata.refs).map((ref) =>
    redactSafeString(ref)
  );
  const safeRefs = refs.filter((ref): ref is string => Boolean(ref));
  if (reason) normalized.reason = reason;
  if (taskRef) normalized.taskRef = taskRef;
  if (safeRefs.length > 0) normalized.refs = safeRefs;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function redactSafeString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const redacted = redactHandshakeGrantValue(value);
  return typeof redacted === 'string' && redacted.trim()
    ? redacted.trim()
    : undefined;
}

function publicGrant(
  grant: InternalHandshakeGrantRecord
): HandshakeGrantRecord {
  const {
    handleHash: _handleHash,
    deniedReason: _deniedReason,
    revocationReason: _revocationReason,
    ...publicRecord
  } = grant;
  return {
    ...publicRecord,
    actor: { ...publicRecord.actor },
    issuer: { ...publicRecord.issuer },
    capabilities: [...publicRecord.capabilities],
    scope: copyScope(publicRecord.scope),
    ...(publicRecord.device ? { device: { ...publicRecord.device } } : {}),
    ...(publicRecord.sessionBinding
      ? { sessionBinding: copySessionBinding(publicRecord.sessionBinding) }
      : {}),
    ...(publicRecord.metadata
      ? { metadata: copyMetadata(publicRecord.metadata) }
      : {}),
    ...(publicRecord.highRiskApproval
      ? { highRiskApproval: { ...publicRecord.highRiskApproval } }
      : {}),
  };
}

function copyScope(scope: HandshakeGrantScope): HandshakeGrantScope {
  return {
    ...(scope.nodeIds ? { nodeIds: [...scope.nodeIds] } : {}),
    ...(scope.sessionIds ? { sessionIds: [...scope.sessionIds] } : {}),
    ...(scope.globalSessionIds
      ? { globalSessionIds: [...scope.globalSessionIds] }
      : {}),
    ...(scope.workContextIds
      ? { workContextIds: [...scope.workContextIds] }
      : {}),
    ...(scope.repoIds ? { repoIds: [...scope.repoIds] } : {}),
    ...(scope.pathPrefixes ? { pathPrefixes: [...scope.pathPrefixes] } : {}),
    ...(scope.taskRefs ? { taskRefs: [...scope.taskRefs] } : {}),
  };
}

function copySessionBinding(
  binding: HandshakeGrantSessionBinding
): HandshakeGrantSessionBinding {
  return {
    ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
    ...(binding.globalSessionId
      ? { globalSessionId: binding.globalSessionId }
      : {}),
    ...(binding.workContextId ? { workContextId: binding.workContextId } : {}),
    ...(binding.authSessionHash
      ? { authSessionHash: binding.authSessionHash }
      : {}),
  };
}

function copyMetadata(
  metadata: HandshakeGrantMetadata
): HandshakeGrantMetadata {
  return {
    ...(metadata.reason ? { reason: metadata.reason } : {}),
    ...(metadata.taskRef ? { taskRef: metadata.taskRef } : {}),
    ...(metadata.refs ? { refs: [...metadata.refs] } : {}),
  };
}

function knownDeniedCapabilities(values: string[]): RelayCapabilityBit[] {
  return values.filter(isRelayCapabilityBit);
}

function handshakeGrantReasonCode(
  reason: HandshakeGrantValidationFailureReason
): string {
  return `HANDSHAKE_GRANT_${reason.toUpperCase()}`;
}

function auditMaterialForGrant(
  grant: HandshakeGrantRecord,
  params: Record<string, unknown>
): { scope: unknown; params: unknown } {
  return {
    scope: {
      grantScope: grant.scope,
      device: grant.device ?? null,
      sessionBinding: grant.sessionBinding ?? null,
    },
    params: {
      ...params,
      grant: redactHandshakeGrantForAudit(grant),
    },
  };
}

function auditMaterialForValidation(
  grant: HandshakeGrantRecord,
  input: ValidateHandshakeGrantInput
): { scope: unknown; params: unknown } {
  return {
    scope: {
      grantScope: grant.scope,
      requestedScope: input.scope ?? null,
      sessionBinding: input.sessionBinding ?? null,
      devicePresented: Boolean(input.deviceId),
    },
    params: {
      grantId: grant.id,
      audience: input.audience,
      actor: input.actor ?? null,
      requiredCapabilities: input.requiredCapabilities,
      consume: input.consume ?? true,
    },
  };
}

function handshakeGrantAuditEventType(
  action: HandshakeGrantAuditEvent['action'],
  decision: SecurityAuditDecision
): SecurityAuditEventType {
  if (action === 'revoke' || decision === 'revoked') return 'revocation';
  if (action === 'expiry' || decision === 'expired') return 'expiry';
  if (action === 'replay') return 'failed_redemption';
  if (action === 'approve' || decision === 'approved') return 'approval';
  if (decision === 'deny' || decision === 'failed') return 'denial';
  return 'grant';
}

function describeGrantScope(scope: HandshakeGrantScope): string {
  return Object.entries(scope)
    .map(
      ([key, values]) =>
        `${key}=${Array.isArray(values) ? values.join(',') : ''}`
    )
    .join('; ');
}

function describeSessionBinding(
  binding: HandshakeGrantSessionBinding | undefined
): string {
  if (!binding) return 'no session binding';
  return Object.entries(binding)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}
