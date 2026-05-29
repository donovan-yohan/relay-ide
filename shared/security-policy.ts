export const RELAY_SECURITY_POLICY_VERSION = '1.0' as const;

export type RelayTrustTier = 'sandbox' | 'dev' | 'prod';

export const RELAY_CAPABILITY_BITS = [
  'session:read',
  'session:create:terminal',
  'session:create:agent',
  'session:attach',
  'session:control:kill',
  'tab:mode:set-agent',
  'tab:intervention:read',
  'tab:intervention:send-text',
  'tab:intervention:submit',
  'rpc:fs:list',
  'rpc:fs:read',
  'rpc:fs:tail',
  'rpc:fs:write',
  'rpc:fs:delete',
  'rpc:git:read',
  'rpc:git:write',
  'pty:exec:arbitrary',
  'preview:port-forward',
  'node:acl:widen',
  'credential:export',
  'node:lifecycle:destructive',
  // #597: dedicated read bit for the `logs.tail` RPC backbone. Separate
  // from `rpc:fs:tail` so operator-only log visibility can be granted
  // without exposing arbitrary file tail to peers. Always redacted via
  // the diagnostics-bundle pipeline before crossing the wire.
  'logs:read',
  // #765 / ADR-019: context packets + session inbox (ref-only, hub-mediated).
  // Reads are default-allow peers of `session:read`; writes are grant-gated
  // but NOT high-risk (ref-only metadata inserts — no raw payload, no file
  // mutation, no exec), so they stay silent-allow on dev/sandbox and never
  // get promoted to a confirmation prompt on prod (would break headless ack).
  'context:read',
  'context:write',
  'inbox:read',
  'inbox:write',
] as const;

export type RelayCapabilityBit = (typeof RELAY_CAPABILITY_BITS)[number];

export type RelayCapabilityDecision =
  | 'allow'
  | 'requiresConfirmation'
  | 'deny';

export const LEGACY_DEFAULT_ALLOWED_CAPABILITIES = [
  'session:read',
  'session:create:terminal',
  'session:create:agent',
  'session:attach',
  'session:control:kill',
  'tab:mode:set-agent',
  'rpc:fs:list',
  'rpc:fs:read',
  'rpc:fs:tail',
  'rpc:git:read',
  // #597: `logs:read` is operator-visible by default so existing
  // `relay-ide hub logs` workflows keep working without a manual ACL
  // edit. It is NOT in `HIGH_RISK_CAPABILITIES`, so the `prod` trust
  // tier overlay (`applyTrustTierOverlay`) leaves it in the silent-allow
  // set; operators can still revoke per-node by editing the ACL.
  'logs:read',
  // #765 / ADR-019: context/inbox reads are silent-allow peers of
  // `session:read` (default pull-model inspection). Writes are granted by
  // default and, because they are NOT in `HIGH_RISK_CAPABILITIES`, stay
  // silent-allow even on the `prod` tier — so a headless agent's
  // `inbox.ack`/`resolve`/`ignore` loop is never gated behind a
  // confirmation prompt. They remain grant-gated (an ACL edit can revoke).
  'context:read',
  'context:write',
  'inbox:read',
  'inbox:write',
] as const satisfies readonly RelayCapabilityBit[];

export const HIGH_RISK_CAPABILITIES = [
  'session:control:kill',
  'tab:intervention:send-text',
  'tab:intervention:submit',
  'rpc:fs:write',
  'rpc:fs:delete',
  'rpc:git:write',
  'pty:exec:arbitrary',
  'preview:port-forward',
  'node:acl:widen',
  'credential:export',
  'node:lifecycle:destructive',
] as const satisfies readonly RelayCapabilityBit[];

const RELAY_CAPABILITY_SET = new Set<string>(RELAY_CAPABILITY_BITS);
const HIGH_RISK_CAPABILITY_SET = new Set<RelayCapabilityBit>(
  HIGH_RISK_CAPABILITIES
);

export interface RelayPolicyScope {
  kind: 'node' | 'workspace' | 'repo' | 'path';
  workspaceIds?: string[];
  repoIds?: string[];
  pathPrefixes?: string[];
}

export interface RelayAclPeerIdentity {
  kind: 'node';
  nodeId: string;
  credentialId?: string;
  displayName?: string;
}

export interface RelayAclGrant {
  allowed: RelayCapabilityBit[];
  requiresConfirmation: RelayCapabilityBit[];
}

export interface RelayAclLifecycle {
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
  supersedes?: string;
  supersededBy?: string;
}

export interface RelayNodeAcl {
  schemaVersion: 1;
  policyVersion: typeof RELAY_SECURITY_POLICY_VERSION;
  ref: string;
  peer: RelayAclPeerIdentity;
  node: {
    nodeId: string;
    trustTier: RelayTrustTier;
  };
  grants: RelayAclGrant;
  scope: RelayPolicyScope;
  lifecycle: RelayAclLifecycle;
}

export interface RelayAclCapabilityResolution {
  decision: RelayCapabilityDecision;
  known: boolean;
  capability: string;
}

export interface RelayAclSummary {
  policyVersion: typeof RELAY_SECURITY_POLICY_VERSION;
  ref: string;
  trustTier: RelayTrustTier;
  allowed: RelayCapabilityBit[];
  requiresConfirmation: RelayCapabilityBit[];
  scope: RelayPolicyScope;
  revokedAt?: string;
  supersededBy?: string;
}

export function isRelayTrustTier(value: unknown): value is RelayTrustTier {
  return value === 'sandbox' || value === 'dev' || value === 'prod';
}

export function isRelayCapabilityBit(value: unknown): value is RelayCapabilityBit {
  return typeof value === 'string' && RELAY_CAPABILITY_SET.has(value);
}

export function normalizeCapabilityBits(values: unknown): RelayCapabilityBit[] {
  if (!Array.isArray(values)) return [];
  const normalized: RelayCapabilityBit[] = [];
  const seen = new Set<RelayCapabilityBit>();
  for (const value of values) {
    if (!isRelayCapabilityBit(value) || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

export function createLegacyDefaultNodeAcl(input: {
  nodeId: string;
  credentialId?: string;
  displayName?: string;
  trustTier?: RelayTrustTier;
  createdAt: string;
  supersedes?: string;
}): RelayNodeAcl {
  const trustTier = input.trustTier ?? 'dev';
  const ref = `acl:${input.nodeId}:${RELAY_SECURITY_POLICY_VERSION}`;
  return applyTrustTierOverlay({
    schemaVersion: 1,
    policyVersion: RELAY_SECURITY_POLICY_VERSION,
    ref,
    peer: {
      kind: 'node',
      nodeId: input.nodeId,
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    },
    node: {
      nodeId: input.nodeId,
      trustTier,
    },
    grants: {
      allowed: [...LEGACY_DEFAULT_ALLOWED_CAPABILITIES],
      requiresConfirmation: [],
    },
    scope: { kind: 'node' },
    lifecycle: {
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    },
  });
}

export function applyTrustTierOverlay(acl: RelayNodeAcl): RelayNodeAcl {
  const allowed = normalizeCapabilityBits(acl.grants.allowed);
  const requiresConfirmation = normalizeCapabilityBits(
    acl.grants.requiresConfirmation
  );
  const required = new Set<RelayCapabilityBit>(requiresConfirmation);
  const silentAllowed: RelayCapabilityBit[] = [];

  for (const capability of allowed) {
    if (required.has(capability)) continue;
    if (
      acl.node.trustTier === 'prod' &&
      HIGH_RISK_CAPABILITY_SET.has(capability)
    ) {
      required.add(capability);
      continue;
    }
    silentAllowed.push(capability);
  }

  return {
    ...acl,
    grants: {
      allowed: silentAllowed,
      requiresConfirmation: Array.from(required),
    },
  };
}

export function resolveAclCapability(
  acl: RelayNodeAcl,
  capability: string
): RelayAclCapabilityResolution {
  if (!isRelayCapabilityBit(capability)) {
    return { decision: 'deny', known: false, capability };
  }
  const effectiveAcl = applyTrustTierOverlay(acl);
  if (effectiveAcl.lifecycle.revokedAt) {
    return { decision: 'deny', known: true, capability };
  }
  if (effectiveAcl.grants.requiresConfirmation.includes(capability)) {
    return { decision: 'requiresConfirmation', known: true, capability };
  }
  if (effectiveAcl.grants.allowed.includes(capability)) {
    return { decision: 'allow', known: true, capability };
  }
  return { decision: 'deny', known: true, capability };
}

export function summarizeAcl(acl: RelayNodeAcl): RelayAclSummary {
  const effectiveAcl = applyTrustTierOverlay(acl);
  return {
    policyVersion: effectiveAcl.policyVersion,
    ref: effectiveAcl.ref,
    trustTier: effectiveAcl.node.trustTier,
    allowed: [...effectiveAcl.grants.allowed],
    requiresConfirmation: [...effectiveAcl.grants.requiresConfirmation],
    scope: effectiveAcl.scope,
    ...(effectiveAcl.lifecycle.revokedAt
      ? { revokedAt: effectiveAcl.lifecycle.revokedAt }
      : {}),
    ...(effectiveAcl.lifecycle.supersededBy
      ? { supersededBy: effectiveAcl.lifecycle.supersededBy }
      : {}),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeScope(value: unknown): RelayPolicyScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'node' };
  }
  const record = value as Record<string, unknown>;
  const kind =
    record['kind'] === 'workspace' ||
    record['kind'] === 'repo' ||
    record['kind'] === 'path'
      ? record['kind']
      : 'node';
  return {
    kind,
    ...(isStringArray(record['workspaceIds'])
      ? { workspaceIds: record['workspaceIds'] }
      : {}),
    ...(isStringArray(record['repoIds']) ? { repoIds: record['repoIds'] } : {}),
    ...(isStringArray(record['pathPrefixes'])
      ? { pathPrefixes: record['pathPrefixes'] }
      : {}),
  };
}

export function normalizeNodeAcl(
  value: unknown,
  fallback: {
    nodeId: string;
    credentialId?: string;
    displayName?: string;
    createdAt: string;
  }
): RelayNodeAcl {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return createLegacyDefaultNodeAcl(fallback);
  }
  const record = value as Record<string, unknown>;
  const node =
    typeof record['node'] === 'object' &&
    record['node'] !== null &&
    !Array.isArray(record['node'])
      ? (record['node'] as Record<string, unknown>)
      : {};
  const peer =
    typeof record['peer'] === 'object' &&
    record['peer'] !== null &&
    !Array.isArray(record['peer'])
      ? (record['peer'] as Record<string, unknown>)
      : {};
  const grants =
    typeof record['grants'] === 'object' &&
    record['grants'] !== null &&
    !Array.isArray(record['grants'])
      ? (record['grants'] as Record<string, unknown>)
      : {};
  const lifecycle =
    typeof record['lifecycle'] === 'object' &&
    record['lifecycle'] !== null &&
    !Array.isArray(record['lifecycle'])
      ? (record['lifecycle'] as Record<string, unknown>)
      : {};

  const trustTier = isRelayTrustTier(node['trustTier'])
    ? node['trustTier']
    : 'dev';
  const createdAt =
    typeof lifecycle['createdAt'] === 'string'
      ? lifecycle['createdAt']
      : fallback.createdAt;
  const updatedAt =
    typeof lifecycle['updatedAt'] === 'string' ? lifecycle['updatedAt'] : createdAt;

  return applyTrustTierOverlay({
    schemaVersion: 1,
    policyVersion: RELAY_SECURITY_POLICY_VERSION,
    ref:
      typeof record['ref'] === 'string'
        ? record['ref']
        : `acl:${fallback.nodeId}:${RELAY_SECURITY_POLICY_VERSION}`,
    peer: {
      kind: 'node',
      nodeId: fallback.nodeId,
      ...(fallback.credentialId ? { credentialId: fallback.credentialId } : {}),
      ...(typeof peer['displayName'] === 'string'
        ? { displayName: peer['displayName'] }
        : fallback.displayName
          ? { displayName: fallback.displayName }
          : {}),
    },
    node: {
      nodeId: fallback.nodeId,
      trustTier,
    },
    grants: {
      allowed: normalizeCapabilityBits(grants['allowed']),
      requiresConfirmation: normalizeCapabilityBits(
        grants['requiresConfirmation']
      ),
    },
    scope: normalizeScope(record['scope']),
    lifecycle: {
      createdAt,
      updatedAt,
      ...(typeof lifecycle['revokedAt'] === 'string'
        ? { revokedAt: lifecycle['revokedAt'] }
        : {}),
      ...(typeof lifecycle['revokedBy'] === 'string'
        ? { revokedBy: lifecycle['revokedBy'] }
        : {}),
      ...(typeof lifecycle['revocationReason'] === 'string'
        ? { revocationReason: lifecycle['revocationReason'] }
        : {}),
      ...(typeof lifecycle['supersedes'] === 'string'
        ? { supersedes: lifecycle['supersedes'] }
        : {}),
      ...(typeof lifecycle['supersededBy'] === 'string'
        ? { supersededBy: lifecycle['supersededBy'] }
        : {}),
    },
  });
}
