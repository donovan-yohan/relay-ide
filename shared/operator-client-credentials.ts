import * as crypto from 'node:crypto';

export const OPERATOR_CLIENT_CREDENTIAL_AUDIENCE =
  'relay:operator-client:v1' as const;
export const OPERATOR_CLIENT_CREDENTIAL_TOKEN_PREFIX = 'relay-occ-v1' as const;
export const OPERATOR_CLIENT_CREDENTIAL_CAPABILITIES = [
  'context:read',
  'context:write',
] as const;
export const DEFAULT_OPERATOR_CLIENT_CREDENTIAL_MAX_TTL_MS = 15 * 60 * 1000;

export type OperatorClientCredentialCapability =
  (typeof OPERATOR_CLIENT_CREDENTIAL_CAPABILITIES)[number];

/** The local Relay operator is the only principal this credential family can represent. */
export interface OperatorClientCredentialPrincipal {
  kind: 'human';
  id: 'human:operator';
  displayName: 'Operator';
}

export interface OperatorClientCredentialClient {
  id: string;
  displayName?: string;
  platform?: string;
}

export interface OperatorClientCredentialDeviceInput {
  id: string;
  displayName?: string;
}

export interface OperatorClientCredentialDevice {
  idHash: string;
  displayName?: string;
}

export interface OperatorClientCredentialScope {
  /** Omitted means the authenticated human principal has no channel narrowing. */
  channelIds?: string[];
}

export interface OperatorClientCredentialRecord {
  id: string;
  audience: typeof OPERATOR_CLIENT_CREDENTIAL_AUDIENCE;
  principal: OperatorClientCredentialPrincipal;
  client: OperatorClientCredentialClient;
  device?: OperatorClientCredentialDevice;
  capabilities: OperatorClientCredentialCapability[];
  scope: OperatorClientCredentialScope;
  grantId?: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
  correlationId: string;
}

interface InternalOperatorClientCredentialRecord extends OperatorClientCredentialRecord {
  secretHash: string;
}

export interface IssueOperatorClientCredentialInput {
  client: OperatorClientCredentialClient;
  device?: OperatorClientCredentialDeviceInput;
  /**
   * Renewal passthrough: an already-hashed device binding copied from the
   * credential being renewed. Mutually exclusive with `device` — raw ids only
   * enter through issuance, hashes only through renewal.
   */
  deviceHash?: OperatorClientCredentialDevice;
  capabilities: string[];
  scope?: OperatorClientCredentialScope;
  ttlMs?: number;
  expiresAt?: string | Date;
  notAfter?: string | Date;
  grantId?: string;
  correlationId?: string;
}

export interface IssuedOperatorClientCredential {
  token: string;
  credential: OperatorClientCredentialRecord;
}

export type OperatorClientCredentialValidationFailureReason =
  | 'malformed_credential'
  | 'wrong_audience'
  | 'expired'
  | 'revoked'
  | 'wrong_channel_scope'
  | 'unknown_capability'
  | 'insufficient_capability';

export type OperatorClientCredentialValidationResult =
  | {
      ok: true;
      credential: OperatorClientCredentialRecord;
      grantedBits: OperatorClientCredentialCapability[];
    }
  | {
      ok: false;
      reason: OperatorClientCredentialValidationFailureReason;
      credentialId?: string;
      deniedBits: string[];
    };

export interface ValidateOperatorClientCredentialInput {
  audience: string;
  requiredCapabilities: string[];
  channelId?: string;
}

export interface RevokeOperatorClientCredentialInput {
  revokedBy: string;
  reason?: string;
}

export class OperatorClientCredentialRegistryError extends Error {
  constructor(
    public readonly code:
      | 'CLIENT_REQUIRED'
      | 'CAPABILITY_REQUIRED'
      | 'UNKNOWN_CAPABILITY'
      | 'EXPIRY_REQUIRED'
      | 'EXPIRY_EXCEEDS_MAX_TTL'
      | 'SCOPE_INVALID',
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'OperatorClientCredentialRegistryError';
  }
}

const OPERATOR_PRINCIPAL: OperatorClientCredentialPrincipal = {
  kind: 'human',
  id: 'human:operator',
  displayName: 'Operator',
};

export class OperatorClientCredentialRegistry {
  private readonly credentials = new Map<
    string,
    InternalOperatorClientCredentialRecord
  >();
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
      options.maxTtlMs ?? DEFAULT_OPERATOR_CLIENT_CREDENTIAL_MAX_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.secretBytes = options.secretBytes ?? (() => crypto.randomBytes(32));
  }

  issue(
    input: IssueOperatorClientCredentialInput
  ): IssuedOperatorClientCredential {
    const issuedAt = this.now();
    const client = normalizeClient(input.client);
    if (input.device && input.deviceHash) {
      throw new OperatorClientCredentialRegistryError(
        'CLIENT_REQUIRED',
        'operator client credentials accept either device or deviceHash, not both'
      );
    }
    const device =
      normalizeDevice(input.device) ??
      (input.deviceHash ? { ...input.deviceHash } : undefined);
    const capabilities = normalizeCapabilities(input.capabilities);
    const scope = normalizeScope(input.scope);
    const expiresAt = resolveExpiry(input, issuedAt, this.maxTtlMs);
    const grantId = safeString(input.grantId);
    const id = crypto.randomUUID();
    const secret = this.secretBytes().toString('hex');
    const credential: InternalOperatorClientCredentialRecord = {
      id,
      audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
      principal: { ...OPERATOR_PRINCIPAL },
      client,
      ...(device ? { device } : {}),
      capabilities,
      scope,
      ...(grantId ? { grantId } : {}),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      correlationId: safeString(input.correlationId) ?? crypto.randomUUID(),
      secretHash: sha256(secret),
    };
    this.credentials.set(id, credential);
    return {
      token: `${OPERATOR_CLIENT_CREDENTIAL_TOKEN_PREFIX}.${id}.${secret}`,
      credential: publicCredential(credential),
    };
  }

  validate(
    token: string,
    input: ValidateOperatorClientCredentialInput
  ): OperatorClientCredentialValidationResult {
    const parsed = parseToken(token);
    if (!parsed) return deny('malformed_credential', undefined, []);
    const credential = this.credentials.get(parsed.id);
    if (
      !credential ||
      !sameHash(credential.secretHash, sha256(parsed.secret))
    ) {
      return deny('malformed_credential', parsed.id, []);
    }
    if (input.audience !== OPERATOR_CLIENT_CREDENTIAL_AUDIENCE) {
      return deny('wrong_audience', credential.id, input.requiredCapabilities);
    }
    if (new Date(credential.expiresAt).getTime() <= this.now().getTime()) {
      return deny('expired', credential.id, input.requiredCapabilities);
    }
    if (credential.revokedAt) {
      return deny('revoked', credential.id, input.requiredCapabilities);
    }
    const unknown = input.requiredCapabilities.find(
      (capability) => !isOperatorClientCredentialCapability(capability)
    );
    if (unknown) return deny('unknown_capability', credential.id, [unknown]);
    const missing = input.requiredCapabilities.filter(
      (capability) =>
        !credential.capabilities.includes(
          capability as OperatorClientCredentialCapability
        )
    );
    if (missing.length)
      return deny('insufficient_capability', credential.id, missing);
    if (
      input.channelId &&
      credential.scope.channelIds &&
      !credential.scope.channelIds.includes(input.channelId)
    ) {
      return deny(
        'wrong_channel_scope',
        credential.id,
        input.requiredCapabilities
      );
    }
    return {
      ok: true,
      credential: publicCredential(credential),
      grantedBits:
        input.requiredCapabilities as OperatorClientCredentialCapability[],
    };
  }

  revoke(
    credentialId: string,
    input: RevokeOperatorClientCredentialInput
  ): OperatorClientCredentialRecord | null {
    const credential = this.credentials.get(credentialId);
    if (!credential) return null;
    if (!credential.revokedAt) {
      credential.revokedAt = this.now().toISOString();
      credential.revokedBy = safeString(input.revokedBy) ?? 'operator';
      const reason = safeString(input.reason);
      if (reason) credential.revocationReason = reason;
    }
    return publicCredential(credential);
  }

  revokeByGrantId(
    grantId: string,
    input: RevokeOperatorClientCredentialInput
  ): OperatorClientCredentialRecord[] {
    const revoked: OperatorClientCredentialRecord[] = [];
    for (const credential of this.credentials.values()) {
      if (credential.grantId !== grantId || credential.revokedAt) continue;
      const result = this.revoke(credential.id, input);
      if (result) revoked.push(result);
    }
    return revoked;
  }

  getCredential(credentialId: string): OperatorClientCredentialRecord | null {
    const credential = this.credentials.get(credentialId);
    return credential ? publicCredential(credential) : null;
  }

  listCredentials(): OperatorClientCredentialRecord[] {
    return [...this.credentials.values()].map(publicCredential);
  }
}

export function isOperatorClientCredentialCapability(
  value: unknown
): value is OperatorClientCredentialCapability {
  return (
    typeof value === 'string' &&
    (OPERATOR_CLIENT_CREDENTIAL_CAPABILITIES as readonly string[]).includes(
      value
    )
  );
}

function normalizeClient(
  input: OperatorClientCredentialClient
): OperatorClientCredentialClient {
  if (!input || typeof input !== 'object') {
    throw new OperatorClientCredentialRegistryError(
      'CLIENT_REQUIRED',
      'operator client credentials require client metadata'
    );
  }
  const id = safeString(input.id);
  if (!id) {
    throw new OperatorClientCredentialRegistryError(
      'CLIENT_REQUIRED',
      'operator client credentials require a client id'
    );
  }
  const displayName = safeString(input.displayName);
  const platform = safeString(input.platform);
  return {
    id,
    ...(displayName ? { displayName } : {}),
    ...(platform ? { platform } : {}),
  };
}

function normalizeDevice(
  input: OperatorClientCredentialDeviceInput | undefined
): OperatorClientCredentialDevice | undefined {
  if (!input) return undefined;
  const id = safeString(input.id);
  if (!id) {
    throw new OperatorClientCredentialRegistryError(
      'CLIENT_REQUIRED',
      'operator client device metadata requires a device id'
    );
  }
  const displayName = safeString(input.displayName);
  return {
    idHash: sha256(id),
    ...(displayName ? { displayName } : {}),
  };
}

function normalizeCapabilities(
  input: string[]
): OperatorClientCredentialCapability[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new OperatorClientCredentialRegistryError(
      'CAPABILITY_REQUIRED',
      'operator client credentials require context:read and/or context:write'
    );
  }
  const capabilities: OperatorClientCredentialCapability[] = [];
  for (const value of input) {
    if (!isOperatorClientCredentialCapability(value)) {
      throw new OperatorClientCredentialRegistryError(
        'UNKNOWN_CAPABILITY',
        'operator client credentials are limited to context:read and context:write'
      );
    }
    if (!capabilities.includes(value)) capabilities.push(value);
  }
  return capabilities;
}

function normalizeScope(
  input: OperatorClientCredentialScope | undefined
): OperatorClientCredentialScope {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorClientCredentialRegistryError(
      'SCOPE_INVALID',
      'operator client channel scope must be an object'
    );
  }
  if (input.channelIds === undefined) return {};
  if (!Array.isArray(input.channelIds)) {
    throw new OperatorClientCredentialRegistryError(
      'SCOPE_INVALID',
      'operator client channelIds must be an array'
    );
  }
  const channelIds = uniqueStrings(input.channelIds);
  if (channelIds.length === 0) {
    throw new OperatorClientCredentialRegistryError(
      'SCOPE_INVALID',
      'operator client channelIds must contain at least one channel id'
    );
  }
  return { channelIds };
}

function resolveExpiry(
  input: IssueOperatorClientCredentialInput,
  issuedAt: Date,
  maxTtlMs: number
): Date {
  if (input.ttlMs === undefined && input.expiresAt === undefined) {
    throw new OperatorClientCredentialRegistryError(
      'EXPIRY_REQUIRED',
      'operator client credentials require ttlMs or expiresAt'
    );
  }
  let expiresAt = input.expiresAt
    ? new Date(input.expiresAt)
    : new Date(issuedAt.getTime() + (input.ttlMs ?? 0));
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= issuedAt) {
    throw new OperatorClientCredentialRegistryError(
      'EXPIRY_REQUIRED',
      'operator client credential expiry must be in the future'
    );
  }
  if (expiresAt.getTime() - issuedAt.getTime() > maxTtlMs) {
    throw new OperatorClientCredentialRegistryError(
      'EXPIRY_EXCEEDS_MAX_TTL',
      'operator client credential ttl exceeds registry maximum'
    );
  }
  if (input.notAfter) {
    const notAfter = new Date(input.notAfter);
    if (!Number.isFinite(notAfter.getTime()) || notAfter <= issuedAt) {
      throw new OperatorClientCredentialRegistryError(
        'EXPIRY_REQUIRED',
        'operator client credential expiry ceiling must be in the future'
      );
    }
    if (expiresAt > notAfter) expiresAt = notAfter;
  }
  return expiresAt;
}

function parseToken(value: unknown): { id: string; secret: string } | null {
  if (typeof value !== 'string') return null;
  const [prefix, id, secret, ...rest] = value.split('.');
  if (
    prefix !== OPERATOR_CLIENT_CREDENTIAL_TOKEN_PREFIX ||
    !id ||
    !secret ||
    rest.length > 0
  ) {
    return null;
  }
  return { id, secret };
}

function publicCredential(
  credential: InternalOperatorClientCredentialRecord
): OperatorClientCredentialRecord {
  const { secretHash: _secretHash, ...record } = credential;
  return {
    ...record,
    principal: { ...record.principal },
    client: { ...record.client },
    ...(record.device ? { device: { ...record.device } } : {}),
    capabilities: [...record.capabilities],
    scope: record.scope.channelIds
      ? { channelIds: [...record.scope.channelIds] }
      : {},
  };
}

function deny(
  reason: OperatorClientCredentialValidationFailureReason,
  credentialId: string | undefined,
  deniedBits: string[]
): OperatorClientCredentialValidationResult {
  return {
    ok: false,
    reason,
    ...(credentialId ? { credentialId } : {}),
    deniedBits,
  };
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = safeString(value);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return (
    leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
}
