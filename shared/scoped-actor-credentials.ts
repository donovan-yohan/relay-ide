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
  RELAY_SECURITY_POLICY_VERSION,
  isRelayCapabilityBit,
  type RelayCapabilityBit,
} from './security-policy.js';

export const ACTOR_CREDENTIAL_TYPES = [
  'agent',
  'cli',
  'automation-system',
] as const;

export type ScopedActorCredentialType = (typeof ACTOR_CREDENTIAL_TYPES)[number];

export const ACTOR_CREDENTIAL_AUDIENCES = [
  'relay:registry-test',
  'relay:cli-gateway:v1',
] as const;

export type ScopedActorCredentialAudience =
  (typeof ACTOR_CREDENTIAL_AUDIENCES)[number];

export const DEFAULT_SCOPED_ACTOR_CREDENTIAL_MAX_TTL_MS = 15 * 60 * 1000;

export type ScopedActorCredentialValidationFailureReason =
  | 'malformed_credential'
  | 'unsupported_actor_type'
  | 'unknown_audience'
  | 'wrong_audience'
  | 'expired'
  | 'revoked'
  | 'missing_scope'
  | 'wrong_node_scope'
  | 'wrong_session_scope'
  | 'wrong_global_session_scope'
  | 'wrong_work_context_scope'
  | 'wrong_channel_scope'
  | 'wrong_repo_scope'
  | 'wrong_path_scope'
  | 'wrong_task_scope'
  | 'unknown_capability'
  | 'insufficient_capability';

export interface ScopedActorCredentialActor {
  type: string;
  id: string;
  displayName?: string;
}

export interface ScopedActorCredentialIssuer {
  id: string;
  displayName?: string;
}

export interface ScopedActorCredentialMetadata {
  reason?: string;
  taskRef?: string;
  refs?: string[];
}

export interface ScopedActorCredentialScope {
  nodeIds?: string[];
  sessionIds?: string[];
  globalSessionIds?: string[];
  workContextIds?: string[];
  channelIds?: string[];
  repoIds?: string[];
  pathPrefixes?: string[];
  taskRefs?: string[];
}

export interface ScopedActorCredentialValidationScope {
  nodeId?: string;
  sessionId?: string;
  globalSessionId?: string;
  workContextId?: string;
  workContextIds?: string[];
  deferWorkContextScope?: boolean;
  channelId?: string;
  channelIds?: string[];
  repoId?: string;
  path?: string;
  taskRef?: string;
}

export interface ScopedActorCredentialRecord {
  id: string;
  actor: ScopedActorCredentialActor & { type: ScopedActorCredentialType };
  issuer: ScopedActorCredentialIssuer;
  grantId?: string;
  audience: ScopedActorCredentialAudience;
  capabilities: RelayCapabilityBit[];
  scope: ScopedActorCredentialScope;
  metadata?: ScopedActorCredentialMetadata;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string | undefined;
  revokedBy?: string | undefined;
  revocationReason?: string | undefined;
  correlationId: string;
}

interface InternalScopedActorCredentialRecord extends ScopedActorCredentialRecord {
  secretHash: string;
}

export interface IssueScopedActorCredentialInput {
  id?: string;
  actor: ScopedActorCredentialActor;
  issuer: ScopedActorCredentialIssuer;
  grantId?: string;
  audience: string;
  capabilities: string[];
  scope: ScopedActorCredentialScope;
  metadata?: ScopedActorCredentialMetadata;
  expiresAt?: Date | string;
  ttlMs?: number;
  correlationId?: string;
}

export interface IssuedScopedActorCredential {
  token: string;
  credential: ScopedActorCredentialRecord;
}

export interface ValidateScopedActorCredentialInput {
  audience: string;
  requiredCapabilities: string[];
  scope?: ScopedActorCredentialValidationScope;
  correlationId?: string;
}

export type ScopedActorCredentialValidationResult =
  | {
      ok: true;
      credential: ScopedActorCredentialRecord;
      grantedBits: RelayCapabilityBit[];
    }
  | {
      ok: false;
      reason: ScopedActorCredentialValidationFailureReason;
      credentialId?: string;
      deniedBits: string[];
    };

export interface RevokeScopedActorCredentialInput {
  revokedBy: string;
  reason?: string;
  correlationId?: string;
}

export interface ScopedActorCredentialAuditEvent {
  action: 'issue' | 'validate' | 'revoke' | 'expiry';
  decision: SecurityAuditDecision;
  reasonCode: string;
  credentialId?: string;
  actor?: ScopedActorCredentialRecord['actor'];
  issuer?: ScopedActorCredentialIssuer;
  audience?: ScopedActorCredentialAudience;
  scopeHash: string;
  paramsHash: string;
  requiredBits: RelayCapabilityBit[];
  grantedBits: RelayCapabilityBit[];
  deniedBits: string[];
  correlationId: string;
}

export interface CreateScopedActorCredentialAuditEntryInput {
  action: ScopedActorCredentialAuditEvent['action'];
  decision: SecurityAuditDecision;
  reasonCode: string;
  credential?: ScopedActorCredentialRecord;
  requiredCapabilities?: RelayCapabilityBit[];
  grantedCapabilities?: RelayCapabilityBit[];
  deniedCapabilities?: RelayCapabilityBit[];
  correlationId?: string;
  material?: {
    scope?: unknown;
    params?: unknown;
  };
}

export class ScopedActorCredentialRegistryError extends Error {
  constructor(
    public readonly code:
      | 'UNSUPPORTED_ACTOR_TYPE'
      | 'UNKNOWN_AUDIENCE'
      | 'UNKNOWN_CAPABILITY'
      | 'EXPIRY_REQUIRED'
      | 'EXPIRY_EXCEEDS_MAX_TTL'
      | 'SCOPE_REQUIRED'
      | 'DUPLICATE_CREDENTIAL_ID',
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'ScopedActorCredentialRegistryError';
  }
}

export class ScopedActorCredentialRegistry {
  private readonly credentials = new Map<
    string,
    InternalScopedActorCredentialRecord
  >();
  private readonly auditEvents: ScopedActorCredentialAuditEvent[] = [];
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
    this.maxTtlMs =
      options.maxTtlMs ?? DEFAULT_SCOPED_ACTOR_CREDENTIAL_MAX_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.secretBytes = options.secretBytes ?? (() => crypto.randomBytes(32));
  }

  issue(input: IssueScopedActorCredentialInput): IssuedScopedActorCredential {
    const actorType = normalizeActorType(input.actor.type);
    const audience = normalizeAudience(input.audience);
    const capabilities = normalizeCredentialCapabilities(input.capabilities);
    const scope = normalizeCredentialScope(input.scope);
    const metadata = normalizeCredentialMetadata(input.metadata);
    const issuedAt = this.now();
    const expiresAt = this.resolveExpiry(input, issuedAt);
    const id = input.id ?? crypto.randomUUID();
    if (this.credentials.has(id)) {
      throw new ScopedActorCredentialRegistryError(
        'DUPLICATE_CREDENTIAL_ID',
        `scoped actor credential ${id} already exists`
      );
    }

    const secret = this.secretBytes();
    const secretEncoded = secret.toString('hex');
    const secretHash = sha256Hex(secretEncoded);
    const credential: InternalScopedActorCredentialRecord = {
      id,
      actor: {
        type: actorType,
        id: input.actor.id,
        ...(input.actor.displayName
          ? { displayName: input.actor.displayName }
          : {}),
      },
      issuer: {
        id: input.issuer.id,
        ...(input.issuer.displayName
          ? { displayName: input.issuer.displayName }
          : {}),
      },
      ...(input.grantId ? { grantId: input.grantId } : {}),
      audience,
      capabilities,
      scope,
      ...(metadata ? { metadata } : {}),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      secretHash,
      correlationId: input.correlationId ?? crypto.randomUUID(),
    };
    this.credentials.set(id, credential);
    this.recordAudit({
      action: 'issue',
      decision: 'allow',
      reasonCode: 'ACTOR_CREDENTIAL_ISSUED',
      credential,
      grantedCapabilities: capabilities,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: {
        scope,
        params: {
          credentialId: id,
          actor: credential.actor,
          ...(metadata ? { metadata } : {}),
        },
      },
    });

    return {
      token: `relay-sac-v1.${id}.${secretEncoded}`,
      credential: publicCredential(credential),
    };
  }

  validate(
    token: string,
    input: ValidateScopedActorCredentialInput
  ): ScopedActorCredentialValidationResult {
    const parsed = parseScopedActorToken(token);
    if (!parsed) {
      return this.deny('malformed_credential', undefined, input, []);
    }
    const credential = this.credentials.get(parsed.id);
    if (!credential || credential.secretHash !== sha256Hex(parsed.secret)) {
      return this.deny('malformed_credential', parsed.id, input, []);
    }
    if (!isScopedActorCredentialType(credential.actor.type)) {
      return this.deny('unsupported_actor_type', credential.id, input, []);
    }
    if (!isScopedActorCredentialAudience(input.audience)) {
      return this.deny('unknown_audience', credential.id, input, []);
    }
    if (credential.audience !== input.audience) {
      return this.deny('wrong_audience', credential.id, input, []);
    }
    if (new Date(credential.expiresAt).getTime() <= this.now().getTime()) {
      this.recordAudit({
        action: 'expiry',
        decision: 'expired',
        reasonCode: 'ACTOR_CREDENTIAL_EXPIRED',
        credential,
        deniedCapabilities: knownDeniedCapabilities(input.requiredCapabilities),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        material: auditMaterialForValidation(credential, input),
      });
      return {
        ok: false,
        reason: 'expired',
        credentialId: credential.id,
        deniedBits: input.requiredCapabilities,
      };
    }
    if (credential.revokedAt) {
      return this.deny(
        'revoked',
        credential.id,
        input,
        input.requiredCapabilities
      );
    }

    const unknownCapability = input.requiredCapabilities.find(
      (capability) => !isRelayCapabilityBit(capability)
    );
    if (unknownCapability) {
      return this.deny('unknown_capability', credential.id, input, [
        unknownCapability,
      ]);
    }
    const required = input.requiredCapabilities as RelayCapabilityBit[];
    const missing = required.filter(
      (capability) => !credential.capabilities.includes(capability)
    );
    if (missing.length > 0) {
      return this.deny(
        'insufficient_capability',
        credential.id,
        input,
        missing
      );
    }

    const scopeFailure = validateCredentialScope(credential.scope, input.scope);
    if (scopeFailure) {
      return this.deny(scopeFailure, credential.id, input, required);
    }

    this.recordAudit({
      action: 'validate',
      decision: 'allow',
      reasonCode: 'ACTOR_CREDENTIAL_ALLOWED',
      credential,
      requiredCapabilities: required,
      grantedCapabilities: required,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: auditMaterialForValidation(credential, input),
    });
    return {
      ok: true,
      credential: publicCredential(credential),
      grantedBits: required,
    };
  }

  revoke(
    credentialId: string,
    input: RevokeScopedActorCredentialInput
  ): ScopedActorCredentialRecord | null {
    const credential = this.credentials.get(credentialId);
    if (!credential) return null;
    credential.revokedAt = this.now().toISOString();
    credential.revokedBy = input.revokedBy;
    if (input.reason) {
      const reason = redactString(input.reason);
      if (reason) credential.revocationReason = reason;
    }
    this.recordAudit({
      action: 'revoke',
      decision: 'revoked',
      reasonCode: 'ACTOR_CREDENTIAL_REVOKED',
      credential,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: {
        scope: credential.scope,
        params: {
          credentialId,
          revokedBy: input.revokedBy,
          reason: input.reason ?? null,
        },
      },
    });
    return publicCredential(credential);
  }

  listCredentials(): ScopedActorCredentialRecord[] {
    return Array.from(this.credentials.values()).map(publicCredential);
  }

  getCredential(credentialId: string): ScopedActorCredentialRecord | null {
    const credential = this.credentials.get(credentialId);
    return credential ? publicCredential(credential) : null;
  }

  listAuditEvents(): ScopedActorCredentialAuditEvent[] {
    return this.auditEvents.map((event) => ({
      ...event,
      requiredBits: [...event.requiredBits],
      grantedBits: [...event.grantedBits],
      deniedBits: [...event.deniedBits],
      ...(event.actor ? { actor: { ...event.actor } } : {}),
      ...(event.issuer ? { issuer: { ...event.issuer } } : {}),
    }));
  }

  private resolveExpiry(
    input: IssueScopedActorCredentialInput,
    issuedAt: Date
  ): Date {
    if (!input.expiresAt && input.ttlMs == null) {
      throw new ScopedActorCredentialRegistryError(
        'EXPIRY_REQUIRED',
        'scoped actor credentials require expiresAt or ttlMs'
      );
    }
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(issuedAt.getTime() + (input.ttlMs ?? 0));
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new ScopedActorCredentialRegistryError(
        'EXPIRY_REQUIRED',
        'scoped actor credential expiry must be a valid date'
      );
    }
    if (expiresAt.getTime() - issuedAt.getTime() > this.maxTtlMs) {
      throw new ScopedActorCredentialRegistryError(
        'EXPIRY_EXCEEDS_MAX_TTL',
        'scoped actor credential ttl exceeds registry maximum'
      );
    }
    return expiresAt;
  }

  private deny(
    reason: ScopedActorCredentialValidationFailureReason,
    credentialId: string | undefined,
    input: ValidateScopedActorCredentialInput,
    deniedBits: string[]
  ): ScopedActorCredentialValidationResult {
    const credential = credentialId
      ? this.credentials.get(credentialId)
      : undefined;
    this.recordAudit({
      action: reason === 'expired' ? 'expiry' : 'validate',
      decision:
        reason === 'expired'
          ? 'expired'
          : reason === 'revoked'
            ? 'revoked'
            : 'deny',
      reasonCode: validationReasonCode(reason),
      ...(credential ? { credential } : {}),
      deniedCapabilities: knownDeniedCapabilities(deniedBits),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      material: credential
        ? auditMaterialForValidation(credential, input)
        : { params: { credentialId: credentialId ?? null, reason } },
    });
    return {
      ok: false,
      reason,
      ...(credentialId ? { credentialId } : {}),
      deniedBits,
    };
  }

  private recordAudit(input: CreateScopedActorCredentialAuditEntryInput): void {
    const credential = input.credential;
    const materialScope = redactAuditValue(
      input.material?.scope ?? credential?.scope ?? null
    );
    const materialParams = redactAuditValue(input.material?.params ?? null);
    this.auditEvents.push({
      action: input.action,
      decision: input.decision,
      reasonCode: input.reasonCode,
      ...(credential ? { credentialId: credential.id } : {}),
      ...(credential ? { actor: { ...credential.actor } } : {}),
      ...(credential ? { issuer: { ...credential.issuer } } : {}),
      ...(credential ? { audience: credential.audience } : {}),
      scopeHash: hashAuditMaterial(materialScope),
      paramsHash: hashAuditMaterial(materialParams),
      requiredBits: [...(input.requiredCapabilities ?? [])],
      grantedBits: [...(input.grantedCapabilities ?? [])],
      deniedBits: [...(input.deniedCapabilities ?? [])],
      correlationId: input.correlationId ?? crypto.randomUUID(),
    });
  }
}

export function isScopedActorCredentialType(
  value: unknown
): value is ScopedActorCredentialType {
  return (
    typeof value === 'string' &&
    (ACTOR_CREDENTIAL_TYPES as readonly string[]).includes(value)
  );
}

export function isScopedActorCredentialAudience(
  value: unknown
): value is ScopedActorCredentialAudience {
  return (
    typeof value === 'string' &&
    (ACTOR_CREDENTIAL_AUDIENCES as readonly string[]).includes(value)
  );
}

export function redactScopedActorCredentialForAudit(
  credential: ScopedActorCredentialRecord
): Omit<
  ScopedActorCredentialRecord,
  'actor' | 'issuer' | 'revocationReason'
> & {
  actor: Omit<ScopedActorCredentialRecord['actor'], 'id'> & { idHash: string };
  issuer: Omit<ScopedActorCredentialIssuer, 'id'> & { idHash: string };
} {
  const { id: _actorId, ...actor } = credential.actor;
  const { id: _issuerId, ...issuer } = credential.issuer;
  return {
    id: credential.id,
    actor: {
      ...actor,
      idHash: sha256Hex(credential.actor.id),
    },
    issuer: {
      ...issuer,
      idHash: sha256Hex(credential.issuer.id),
    },
    audience: credential.audience,
    capabilities: [...credential.capabilities],
    scope: copyScope(credential.scope),
    ...(credential.metadata
      ? { metadata: copyMetadata(credential.metadata) }
      : {}),
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt,
    ...(credential.revokedAt ? { revokedAt: credential.revokedAt } : {}),
    ...(credential.revokedBy ? { revokedBy: credential.revokedBy } : {}),
    correlationId: credential.correlationId,
  };
}

export function createScopedActorCredentialAuditEntry(
  input: CreateScopedActorCredentialAuditEntryInput
): SecurityAuditEntryInput {
  const credential = input.credential;
  return {
    eventType: auditEventType(input.action, input.decision),
    decision: input.decision,
    reasonCode: input.reasonCode,
    peer: credential
      ? {
          kind: 'system',
          credentialId: credential.id,
          displayName: credential.actor.displayName ?? credential.actor.type,
          principalHash: sha256Hex(
            `${credential.actor.type}:${credential.actor.id}`
          ),
        }
      : { kind: 'system' },
    intent: {
      action: `actor-credential.${input.action}`,
      ...(credential ? { target: credential.id } : {}),
    },
    material: {
      scope: redactAuditValue(
        input.material?.scope ??
          (credential
            ? redactScopedActorCredentialForAudit(credential).scope
            : null)
      ),
      params: redactAuditValue({
        credential: credential
          ? redactScopedActorCredentialForAudit(credential)
          : undefined,
        ...(typeof input.material?.params === 'object' &&
        input.material.params !== null
          ? (input.material.params as Record<string, unknown>)
          : { params: input.material?.params ?? null }),
      }),
    },
    requiredBits: [...(input.requiredCapabilities ?? [])],
    grantedBits: [...(input.grantedCapabilities ?? [])],
    deniedBits: [...(input.deniedCapabilities ?? [])],
    refs: { policyVersion: RELAY_SECURITY_POLICY_VERSION },
    correlationId: input.correlationId ?? crypto.randomUUID(),
  };
}

function normalizeActorType(value: string): ScopedActorCredentialType {
  if (isScopedActorCredentialType(value)) return value;
  throw new ScopedActorCredentialRegistryError(
    'UNSUPPORTED_ACTOR_TYPE',
    `unsupported scoped actor credential type: ${value}`
  );
}

function normalizeAudience(value: string): ScopedActorCredentialAudience {
  if (isScopedActorCredentialAudience(value)) return value;
  throw new ScopedActorCredentialRegistryError(
    'UNKNOWN_AUDIENCE',
    `unknown scoped actor credential audience: ${value}`
  );
}

function normalizeCredentialCapabilities(
  values: string[]
): RelayCapabilityBit[] {
  const normalized: RelayCapabilityBit[] = [];
  const seen = new Set<RelayCapabilityBit>();
  for (const value of values) {
    if (!isRelayCapabilityBit(value)) {
      throw new ScopedActorCredentialRegistryError(
        'UNKNOWN_CAPABILITY',
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

function normalizeCredentialScope(
  scope: ScopedActorCredentialScope
): ScopedActorCredentialScope {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new ScopedActorCredentialRegistryError(
      'SCOPE_REQUIRED',
      'scoped actor credentials require at least one explicit scope dimension'
    );
  }
  const normalized: ScopedActorCredentialScope = {
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
    ...(normalizeStringList(scope.channelIds).length > 0
      ? { channelIds: normalizeStringList(scope.channelIds) }
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
    throw new ScopedActorCredentialRegistryError(
      'SCOPE_REQUIRED',
      'scoped actor credentials require at least one explicit scope dimension'
    );
  }
  return normalized;
}

type ScopeValidationRule = {
  values: string[] | undefined;
  requested: string[] | undefined;
  wrongReason: ScopedActorCredentialValidationFailureReason;
  deferred?: boolean;
  /** Fail closed: deny when this dimension is requested but the credential holds no values. */
  requiredWhenRequested?: boolean;
  matches?: (values: string[], requested: string) => boolean;
};

function validateCredentialScope(
  credentialScope: ScopedActorCredentialScope,
  expectedScope: ScopedActorCredentialValidationScope | undefined
): ScopedActorCredentialValidationFailureReason | null {
  const rules: ScopeValidationRule[] = [
    {
      values: credentialScope.nodeIds,
      requested: singletonScopeValue(expectedScope?.nodeId),
      wrongReason: 'wrong_node_scope',
    },
    {
      values: credentialScope.sessionIds,
      requested: singletonScopeValue(expectedScope?.sessionId),
      wrongReason: 'wrong_session_scope',
    },
    {
      values: credentialScope.globalSessionIds,
      requested: singletonScopeValue(expectedScope?.globalSessionId),
      wrongReason: 'wrong_global_session_scope',
    },
    {
      values: credentialScope.workContextIds,
      requested: normalizedRequestedScopeValues(
        expectedScope?.workContextIds ??
          singletonScopeValue(expectedScope?.workContextId)
      ),
      deferred: expectedScope?.deferWorkContextScope === true,
      wrongReason: 'wrong_work_context_scope',
    },
    {
      values: credentialScope.channelIds,
      requested: normalizedRequestedScopeValues(
        expectedScope?.channelIds ??
          singletonScopeValue(expectedScope?.channelId)
      ),
      // Channel scope is load-bearing for the external harness bridge: an actor
      // with NO channel scope must never be treated as able to read/write any
      // channel. Deny rather than skip when a channel is requested but absent.
      requiredWhenRequested: true,
      wrongReason: 'wrong_channel_scope',
    },
    {
      values: credentialScope.repoIds,
      requested: singletonScopeValue(expectedScope?.repoId),
      wrongReason: 'wrong_repo_scope',
    },
    {
      values: credentialScope.pathPrefixes,
      requested: singletonScopeValue(expectedScope?.path),
      wrongReason: 'wrong_path_scope',
      matches: (prefixes, path) =>
        prefixes.some((prefix) => pathMatchesCredentialPrefix(path, prefix)),
    },
    {
      values: credentialScope.taskRefs,
      requested: singletonScopeValue(expectedScope?.taskRef),
      wrongReason: 'wrong_task_scope',
    },
  ];

  for (const rule of rules) {
    const hasRequested = Boolean(rule.requested?.length);
    if (!rule.values?.length) {
      // Fail-closed: a dimension that must be present when requested is denied
      // even when the credential holds no values for it.
      if (hasRequested && rule.requiredWhenRequested) return rule.wrongReason;
      continue;
    }
    if (!hasRequested) continue;
    const matches = rule.matches ?? listIncludesRequestedValue;
    if (
      !rule.requested!.every((requested) => matches(rule.values!, requested))
    ) {
      return rule.wrongReason;
    }
  }

  return rules.some((rule) => rule.values && !rule.requested && !rule.deferred)
    ? 'missing_scope'
    : null;
}

function listIncludesRequestedValue(
  values: string[],
  requested: string
): boolean {
  return values.includes(requested);
}

function singletonScopeValue(value: string | undefined): string[] | undefined {
  return value ? [value] : undefined;
}

function normalizedRequestedScopeValues(
  values: string[] | undefined
): string[] | undefined {
  const normalized = values?.filter((value) => value.trim().length > 0) ?? [];
  return normalized.length ? normalized : undefined;
}

function pathMatchesCredentialPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(normalizedPrefix);
}

function parseScopedActorToken(
  token: unknown
): { id: string; secret: string } | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'relay-sac-v1') return null;
  const [, id, secret] = parts;
  if (!id || !secret) return null;
  return { id, secret };
}

function publicCredential(
  credential: InternalScopedActorCredentialRecord
): ScopedActorCredentialRecord {
  const { secretHash: _secretHash, ...publicRecord } = credential;
  return {
    ...publicRecord,
    actor: { ...publicRecord.actor },
    issuer: { ...publicRecord.issuer },
    capabilities: [...publicRecord.capabilities],
    scope: copyScope(publicRecord.scope),
    ...(publicRecord.metadata
      ? { metadata: copyMetadata(publicRecord.metadata) }
      : {}),
  };
}

function copyScope(
  scope: ScopedActorCredentialScope
): ScopedActorCredentialScope {
  return {
    ...(scope.nodeIds ? { nodeIds: [...scope.nodeIds] } : {}),
    ...(scope.sessionIds ? { sessionIds: [...scope.sessionIds] } : {}),
    ...(scope.globalSessionIds
      ? { globalSessionIds: [...scope.globalSessionIds] }
      : {}),
    ...(scope.workContextIds
      ? { workContextIds: [...scope.workContextIds] }
      : {}),
    ...(scope.channelIds ? { channelIds: [...scope.channelIds] } : {}),
    ...(scope.repoIds ? { repoIds: [...scope.repoIds] } : {}),
    ...(scope.pathPrefixes ? { pathPrefixes: [...scope.pathPrefixes] } : {}),
    ...(scope.taskRefs ? { taskRefs: [...scope.taskRefs] } : {}),
  };
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

function normalizeCredentialMetadata(
  metadata: ScopedActorCredentialMetadata | undefined
): ScopedActorCredentialMetadata | undefined {
  if (!metadata) return undefined;
  const normalized: ScopedActorCredentialMetadata = {};
  const reason = redactString(metadata.reason);
  const taskRef = redactString(metadata.taskRef);
  const refs = normalizeStringList(metadata.refs).map((ref) =>
    redactString(ref)
  );
  const safeRefs = refs.filter((ref): ref is string => Boolean(ref));
  if (reason) normalized.reason = reason;
  if (taskRef) normalized.taskRef = taskRef;
  if (safeRefs.length > 0) normalized.refs = safeRefs;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function redactString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const redacted = redactAuditValue(value);
  return typeof redacted === 'string' && redacted.trim()
    ? redacted.trim()
    : undefined;
}

function copyMetadata(
  metadata: ScopedActorCredentialMetadata
): ScopedActorCredentialMetadata {
  return {
    ...(metadata.reason ? { reason: metadata.reason } : {}),
    ...(metadata.taskRef ? { taskRef: metadata.taskRef } : {}),
    ...(metadata.refs ? { refs: [...metadata.refs] } : {}),
  };
}

function validationReasonCode(
  reason: ScopedActorCredentialValidationFailureReason
): string {
  return `ACTOR_CREDENTIAL_${reason.toUpperCase()}`;
}

function knownDeniedCapabilities(values: string[]): RelayCapabilityBit[] {
  return values.filter(isRelayCapabilityBit);
}

function auditMaterialForValidation(
  credential: ScopedActorCredentialRecord,
  input: ValidateScopedActorCredentialInput
): { scope: unknown; params: unknown } {
  return {
    scope: {
      credentialScope: credential.scope,
      requestedScope: input.scope ?? null,
    },
    params: {
      credentialId: credential.id,
      audience: input.audience,
      requiredCapabilities: input.requiredCapabilities,
    },
  };
}

function auditEventType(
  action: ScopedActorCredentialAuditEvent['action'],
  decision: SecurityAuditDecision
): SecurityAuditEventType {
  if (action === 'revoke' || decision === 'revoked') return 'revocation';
  if (action === 'expiry' || decision === 'expired') return 'expiry';
  if (decision === 'deny' || decision === 'failed') return 'denial';
  return 'grant';
}
