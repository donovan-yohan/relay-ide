import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  NodeCapabilityProbe,
  NodeManifest,
} from '../shared/node-manifest.js';
import { createLogger } from './logger.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type HubNodeCredentialRotationState,
  type HubNodeCredentialRotationSummary,
  type HubNodeCredentialState,
  type HubNodeHelperSkewSummary,
  type HubNodeStatus,
  type HubNodeSummary,
  type HubNodeVersionState,
  type NodeCapabilityManifestSummary,
  type RelayNodeCredential,
  type RelayNodeCredentialRecordSummary,
  type RelayNodeError,
  type RelayNodeErrorCode,
  type RelayNodeSourceDiagnostics,
} from '../shared/relay-node-protocol.js';
import {
  evaluateRelayNodeSource,
  hasTailscaleSourceSignal,
  sourceDisplayHint,
  sourceFingerprint,
  sourceTupleWithHostname,
  type RelayNodeSourceTuple,
} from './node-source-diagnostics.js';
import { classifyHelperSkew } from './node-version-skew.js';
import {
  RELAY_SECURITY_POLICY_VERSION,
  applyTrustTierOverlay,
  createLegacyDefaultNodeAcl,
  isRelayCapabilityBit,
  isRelayTrustTier,
  normalizeCapabilityBits,
  normalizeNodeAcl,
  summarizeAcl,
  type RelayCapabilityBit,
  type RelayNodeAcl,
  type RelayTrustTier,
} from '../shared/security-policy.js';
import type {
  SecurityAuditDecision,
  SecurityAuditEntryInput,
  SecurityAuditEventType,
} from '../shared/security-audit.js';

const logger = createLogger('hub-node-registry');
const REVERSE_LINK_ROUTE = 'reverse-link' as const;
const UNKNOWN_CAPABILITY_STATUS = 'unknown' as const;

interface StoredPairTokenIssuer {
  grantId?: string;
  actorType?: string;
  actorDisplayName?: string;
  actorIdHash?: string;
}

interface StoredPairToken {
  tokenId: string;
  tokenHash: string;
  displayName?: string;
  platform?: string;
  trustTier?: RelayTrustTier;
  allowedCapabilities?: RelayCapabilityBit[];
  requiresConfirmationCapabilities?: RelayCapabilityBit[];
  issuer?: StoredPairTokenIssuer;
  correlationId?: string;
  mintSourceFingerprint?: string;
  mintSourceDiagnostics?: RelayNodeSourceDiagnostics;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

interface StoredCredentialRotation {
  rotationId: string;
  previousCredentialId: string;
  nextCredentialId: string;
  nextCredentialHash?: string;
  state: HubNodeCredentialRotationState;
  issuedAt: string;
  deliveredAt?: string;
  provedAt?: string;
  stableAt?: string;
  failedAt?: string;
  failureReason?: string;
}

interface StoredNodeIdentity {
  nodeId: string;
  displayName: string;
  hostname: string;
  createdAt: string;
  pairedAt: string;
}

interface StoredActiveCredential {
  credentialId: string;
  tokenHash: string;
  issuedAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

interface StoredNodeSourceBinding {
  expected?: RelayNodeSourceTuple;
  lastObserved?: RelayNodeSourceTuple;
  observedFingerprints?: string[];
  diagnostics?: RelayNodeSourceDiagnostics;
}

interface StoredNodeRecord {
  nodeId: string;
  identity?: StoredNodeIdentity;
  activeCredential?: StoredActiveCredential;
  credentialId: string;
  credentialHash: string;
  // Timestamp of the currently-active credential. Set on pair and updated
  // when a rotation proves. Optional for backward compatibility with
  // registry files written before this field existed; consumers fall back
  // to derived logic when missing.
  credentialIssuedAt?: string;
  displayName: string;
  hostname: string;
  homeDir?: string;
  platform: string;
  arch: string;
  relayVersion: string;
  /** Helper binary version from NodeManifest.helperVersion; optional for legacy records. */
  helperVersion?: string;
  protocolVersion: string;
  capabilities: NodeCapabilityManifestSummary;
  /** Whether File RPC is available on this node (from NodeManifest.fileRpc.available). */
  fileRpcAvailable?: boolean;
  /** Structured degraded reasons from the manifest, persisted on heartbeat. */
  degradedReasons?: import('../shared/node-manifest.js').NodeManifestDegradedReason[];
  acl?: RelayNodeAcl;
  repoInventory?: unknown;
  credentialRotation?: StoredCredentialRotation;
  sourceBinding?: StoredNodeSourceBinding;
  createdAt: string;
  pairedAt: string;
  lastSeenAt: string;
  linkDisconnectedAt?: string;
  revokedAt?: string;
  /** Set while `relay-ide node update` is in progress. Cleared when update completes. */
  updatingAt?: string;
}

interface RegistryFile {
  schemaVersion: 1;
  pairTokens: StoredPairToken[];
  nodes: StoredNodeRecord[];
}

export interface PairTokenMintIssuer {
  grantId?: string;
  actorType?: string;
  actorDisplayName?: string;
  actorId?: string;
}

export interface PairTokenCapabilityEnvelope {
  allowed?: RelayCapabilityBit[];
  requiresConfirmation?: RelayCapabilityBit[];
}

export interface PairTokenResponse {
  tokenId: string;
  pairToken: string;
  expiresAt: string;
}

export interface PairExchangeInput {
  pairToken: string;
  manifest: NodeManifest;
  displayName?: string;
  protocolVersion?: string;
  source?: RelayNodeSourceTuple;
}

export interface HeartbeatInput {
  nodeId: string;
  protocolVersion: string;
  credentialId?: string;
  manifest?: NodeManifest;
  repoInventory?: unknown;
}

export interface CredentialRotationResult {
  node: HubNodeSummary;
  credential: RelayNodeCredential;
  rotation: HubNodeCredentialRotationSummary;
}

export interface CredentialRotationPublicResult {
  node: HubNodeSummary;
  rotation: HubNodeCredentialRotationSummary;
}

export interface ScheduledRotationCandidate {
  nodeId: string;
  credentialId: string;
  activeCredentialIssuedAt: string;
  ageMs: number;
}

export interface InventoryPayloadRecord {
  nodeId: string;
  payload: unknown;
}

export interface HubNodeRegistryOptions {
  storagePath: string;
  now?: () => Date;
  staleMs?: number;
  offlineMs?: number;
  heartbeatPersistDebounceMs?: number;
  auditSink?: { append(input: SecurityAuditEntryInput): unknown };
  /** Hub's own package version, used for helper-version skew detection (#655). */
  hubVersion?: string;
}

export const DEFAULT_PAIR_TOKEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_NODE_HEARTBEAT_TIMEOUTS = {
  staleMs: 45 * 1000,
  offlineMs: 90 * 1000,
} as const;
export const DEFAULT_HEARTBEAT_PERSIST_DEBOUNCE_MS = 5 * 1000;
const PRIVILEGED_NODE_WARNING =
  "A paired Relay node runs with that machine's local OS-user blast radius; hub ACL policy grants individual capability bits.";

export type CredentialAuthResult =
  | {
      ok: true;
      node: HubNodeSummary;
      credentialId: string;
      rotationId?: string;
    }
  | { ok: false; error: RelayNodeError };

export interface CredentialAuthContext {
  source?: RelayNodeSourceTuple;
  strictSourceDeny?: boolean;
}

export interface HubNodeStatusEvent {
  nodeId: string;
  status: HubNodeStatus;
  lastSeenAt: string;
  manifest?: NodeManifest;
}

type NodeStatusListener = (event: HubNodeStatusEvent) => void;

class HubNodeRegistryError extends Error {
  readonly relayNodeError: RelayNodeError;

  constructor(
    code: RelayNodeErrorCode,
    message: string,
    retryable = false,
    details?: Record<string, unknown>
  ) {
    super(`${code}: ${message}`);
    this.name = 'HubNodeRegistryError';
    this.relayNodeError = {
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    };
  }
}

function emptyRegistryFile(): RegistryFile {
  return { schemaVersion: 1, pairTokens: [], nodes: [] };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function assertCompatibleProtocol(protocolVersion: string): void {
  if (protocolVersion === RELAY_NODE_LINK_PROTOCOL_VERSION) return;
  const [requestedMajor] = protocolVersion.split('.');
  const [hubMajor] = RELAY_NODE_LINK_PROTOCOL_VERSION.split('.');
  const code: RelayNodeErrorCode =
    requestedMajor === hubMajor ? 'VERSION_SKEW' : 'PROTOCOL_INCOMPATIBLE';
  throw new HubNodeRegistryError(
    code,
    `relay-node-link protocol ${protocolVersion} must exactly match hub protocol ${RELAY_NODE_LINK_PROTOCOL_VERSION}`
  );
}

function countProbe(
  totals: NodeCapabilityManifestSummary['totals'],
  probe: NodeCapabilityProbe | undefined
): void {
  const status = probe?.status ?? 'unknown';
  totals[status] += 1;
}

function summarizeCapabilities(
  manifest: NodeManifest
): NodeCapabilityManifestSummary {
  const totals = { available: 0, degraded: 0, unavailable: 0, unknown: 0 };
  countProbe(totals, manifest.capabilities.git);
  countProbe(totals, manifest.capabilities.clipboard);
  countProbe(totals, manifest.capabilities.browserAutomation);
  countProbe(totals, manifest.capabilities.githubCli);
  countProbe(totals, manifest.capabilities.tailscale);
  countProbe(totals, manifest.capabilities.ssh);

  const agents: NodeCapabilityManifestSummary['agents'] = {};
  for (const [id, probe] of Object.entries(manifest.capabilities.agents)) {
    agents[id] = probe.status;
    countProbe(totals, probe);
  }

  // `worktrees` is intentionally NOT populated here. It is a
  // repo-feature-layer capability and belongs in a repo feature
  // decorator that composition root may layer on top of this core
  // summary. Consumers that need a worktree-availability hint should
  // fall back to deriving from `core.git` (the canonical worktree
  // capability today is just "is git usable here?").
  const terminalBackends = manifest.capabilities.terminalBackends ?? {
    'relay-pty': {
      id: 'relay-pty',
      label: 'Relay PTY',
      status: 'unknown' as const,
      message: 'pre-#837 node did not report relay-pty availability.',
    },
  };
  return {
    totals,
    core: {
      shell: 'available',
      git: manifest.capabilities.git.status,
      browserAutomation: manifest.capabilities.browserAutomation.status,
      clipboardImage: manifest.capabilities.clipboard.status,
      ssh: manifest.capabilities.ssh.status,
      tailscale: manifest.capabilities.tailscale.status,
    },
    terminalBackends: {
      'relay-pty': terminalBackends['relay-pty'].status,
    },
    agents,
    serviceManager: manifest.serviceManager.kind,
    wsl: manifest.wsl.detected,
    // #467: pass through the resume kind so the frontend can show a
    // resumable badge without re-deriving from backend availability.
    // Pre-#467 manifests omit this field; treat as 'none' on the read
    // side via `?? 'none'`.
    sessionResume: manifest.capabilities.sessionResume ?? 'none',
  };
}

function nodeDisplayName(
  displayName: string | undefined,
  manifest: NodeManifest
): string {
  const trimmed = displayName?.trim();
  return trimmed || manifest.hostname;
}

function fallbackAclInput(node: StoredNodeRecord): {
  nodeId: string;
  credentialId?: string;
  displayName?: string;
  createdAt: string;
} {
  return {
    nodeId: node.nodeId,
    credentialId: node.credentialId,
    displayName: node.displayName,
    createdAt: node.pairedAt || node.createdAt,
  };
}

function ensureNodeAcl(node: StoredNodeRecord): RelayNodeAcl {
  node.acl = normalizeNodeAcl(node.acl, fallbackAclInput(node));
  return node.acl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKnownCapabilityBits(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => isRelayCapabilityBit(item))
  );
}

function nodeNeedsAclMigration(node: StoredNodeRecord): boolean {
  const acl = node.acl as unknown;
  if (!isRecord(acl)) return true;

  const peer = acl['peer'];
  const aclNode = acl['node'];
  const grants = acl['grants'];
  const lifecycle = acl['lifecycle'];

  if (acl['schemaVersion'] !== 1) return true;
  if (acl['policyVersion'] !== RELAY_SECURITY_POLICY_VERSION) return true;
  if (typeof acl['ref'] !== 'string') return true;
  if (!isRecord(peer) || peer['kind'] !== 'node') return true;
  if (peer['nodeId'] !== node.nodeId) return true;
  if (node.credentialId && peer['credentialId'] !== node.credentialId) {
    return true;
  }
  if (!isRecord(aclNode) || aclNode['nodeId'] !== node.nodeId) return true;
  if (!isRelayTrustTier(aclNode['trustTier'])) return true;
  if (!isRecord(grants)) return true;
  if (!hasOnlyKnownCapabilityBits(grants['allowed'])) return true;
  if (!hasOnlyKnownCapabilityBits(grants['requiresConfirmation'])) return true;
  if (!isRecord(lifecycle)) return true;
  if (typeof lifecycle['createdAt'] !== 'string') return true;
  if (typeof lifecycle['updatedAt'] !== 'string') return true;
  return false;
}

function registryNeedsAclMigration(registry: RegistryFile): boolean {
  return registry.nodes.some((node) => nodeNeedsAclMigration(node));
}

function registryNeedsIdentityMigration(registry: RegistryFile): boolean {
  return registry.nodes.some(
    (node) => !node.identity || !node.activeCredential
  );
}

function readRegistryFile(storagePath: string): RegistryFile {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(storagePath, 'utf8')
    ) as Partial<RegistryFile>;
    if (parsed.schemaVersion !== 1) return emptyRegistryFile();
    return {
      schemaVersion: 1,
      pairTokens: Array.isArray(parsed.pairTokens) ? parsed.pairTokens : [],
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    };
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code === 'ENOENT') return emptyRegistryFile();
    if (error instanceof SyntaxError) {
      quarantineCorruptRegistryFile(storagePath);
      return emptyRegistryFile();
    }
    throw error;
  }
}

function quarantineCorruptRegistryFile(storagePath: string): void {
  const quarantinePath = `${storagePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(storagePath, quarantinePath);
    logger.warn(
      'hub node registry file is corrupt; quarantined file and starting with empty registry: %s',
      quarantinePath
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      'hub node registry file is corrupt; could not quarantine file and starting with empty registry: %s',
      message
    );
  }
}

function writeRegistryFile(storagePath: string, registry: RegistryFile): void {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  const tmpPath = `${storagePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, storagePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

function statusForNode(
  node: StoredNodeRecord,
  now: Date,
  staleMs: number,
  offlineMs: number
): HubNodeStatus {
  if (node.revokedAt) return 'revoked';
  if (node.updatingAt) return 'updating';
  if (
    node.linkDisconnectedAt &&
    Date.parse(node.linkDisconnectedAt) >= Date.parse(node.lastSeenAt)
  ) {
    return 'offline';
  }
  const ageMs = now.getTime() - Date.parse(node.lastSeenAt);
  if (ageMs > offlineMs) return 'offline';
  if (ageMs > staleMs) return 'stale';
  return 'online';
}

function normalizeCapabilitySummary(
  capabilities: NodeCapabilityManifestSummary
): NodeCapabilityManifestSummary {
  if (capabilities.core) {
    return {
      ...capabilities,
      terminalBackends: capabilities.terminalBackends ?? {
        'relay-pty': UNKNOWN_CAPABILITY_STATUS,
      },
    };
  }
  return {
    ...capabilities,
    core: {
      shell: UNKNOWN_CAPABILITY_STATUS,
      git: UNKNOWN_CAPABILITY_STATUS,
      browserAutomation: UNKNOWN_CAPABILITY_STATUS,
      clipboardImage: UNKNOWN_CAPABILITY_STATUS,
      ssh: UNKNOWN_CAPABILITY_STATUS,
      tailscale: UNKNOWN_CAPABILITY_STATUS,
    },
    terminalBackends: {
      'relay-pty': UNKNOWN_CAPABILITY_STATUS,
    },
  };
}

function versionState(protocolVersion: string): HubNodeVersionState {
  if (protocolVersion === RELAY_NODE_LINK_PROTOCOL_VERSION) return 'compatible';
  const [nodeMajor] = protocolVersion.split('.');
  const [hubMajor] = RELAY_NODE_LINK_PROTOCOL_VERSION.split('.');
  return nodeMajor === hubMajor ? 'version-skew' : 'incompatible';
}

function publicRotation(
  rotation: StoredCredentialRotation | undefined
): HubNodeCredentialRotationSummary | undefined {
  if (!rotation) return undefined;
  return {
    rotationId: rotation.rotationId,
    state: rotation.state,
    previousCredentialId: rotation.previousCredentialId,
    nextCredentialId: rotation.nextCredentialId,
    issuedAt: rotation.issuedAt,
    ...(rotation.deliveredAt ? { deliveredAt: rotation.deliveredAt } : {}),
    ...(rotation.provedAt ? { provedAt: rotation.provedAt } : {}),
    ...(rotation.stableAt ? { stableAt: rotation.stableAt } : {}),
    ...(rotation.failedAt ? { failedAt: rotation.failedAt } : {}),
    ...(rotation.failureReason
      ? { failureReason: rotation.failureReason }
      : {}),
  };
}

function credentialState(node: StoredNodeRecord): HubNodeCredentialState {
  if (node.revokedAt) return 'revoked';
  if (node.credentialRotation?.state === 'failed') return 'rotation-failed';
  if (node.credentialRotation && node.credentialRotation.state !== 'stable') {
    return 'rotating';
  }
  return 'active';
}

function ensureSeparatedIdentity(node: StoredNodeRecord): StoredNodeIdentity {
  node.identity ??= {
    nodeId: node.nodeId,
    displayName: node.displayName,
    hostname: node.hostname,
    createdAt: node.createdAt,
    pairedAt: node.pairedAt,
  };
  return node.identity;
}

function ensureSeparatedCredential(
  node: StoredNodeRecord
): StoredActiveCredential {
  node.activeCredential ??= {
    credentialId: node.credentialId,
    tokenHash: node.credentialHash,
    issuedAt: activeCredentialIssuedAt(node),
    ...(node.revokedAt ? { revokedAt: node.revokedAt } : {}),
  };
  return node.activeCredential;
}

function sourceBindingForNode(node: StoredNodeRecord): StoredNodeSourceBinding {
  node.sourceBinding ??= {};
  node.sourceBinding.observedFingerprints ??= [];
  return node.sourceBinding;
}

function publicSourceDiagnostics(
  diagnostics: RelayNodeSourceDiagnostics | undefined
): RelayNodeSourceDiagnostics | undefined {
  if (!diagnostics) return undefined;
  return {
    state: diagnostics.state,
    policy: diagnostics.policy,
    reasonCode: diagnostics.reasonCode,
    observedAt: diagnostics.observedAt,
    ...(diagnostics.sourceFingerprint
      ? { sourceFingerprint: diagnostics.sourceFingerprint }
      : {}),
    ...(diagnostics.displayHint
      ? { displayHint: diagnostics.displayHint }
      : {}),
  };
}

function sourceDiagnosticsForAuthDenied(input: {
  source?: RelayNodeSourceTuple | undefined;
  now: string;
  strictDeny?: boolean | undefined;
  fingerprintKey?: string | undefined;
}): RelayNodeSourceDiagnostics {
  const normalized = sourceTupleWithHostname(input.source, undefined);
  const hasSignal = hasTailscaleSourceSignal(normalized);
  const fingerprint = normalized
    ? sourceFingerprint(normalized, input.fingerprintKey)
    : undefined;
  return {
    state: hasSignal ? 'source-mismatch' : 'signal-unavailable',
    policy: input.strictDeny ? 'strict-deny' : 'audit',
    reasonCode: hasSignal
      ? 'TAILSCALE_REACHABLE_RELAY_AUTH_DENIED'
      : 'NODE_SOURCE_SIGNAL_UNAVAILABLE',
    observedAt: input.now,
    ...(fingerprint ? { sourceFingerprint: fingerprint } : {}),
    displayHint: sourceDisplayHint(normalized, fingerprint),
  };
}

function credentialSummary(
  node: StoredNodeRecord
): RelayNodeCredentialRecordSummary {
  const credential = ensureSeparatedCredential(node);
  const state = credentialState(node);
  return {
    credentialId: credential.credentialId,
    issuedAt: credential.issuedAt,
    state,
    ...(node.credentialRotation && state === 'rotating'
      ? { rotationId: node.credentialRotation.rotationId }
      : {}),
  };
}

function activeCredentialIssuedAt(node: StoredNodeRecord): string {
  // Prefer the persisted credentialIssuedAt so the value survives in-flight
  // rotation windows where `credentialRotation` is overwritten before proof.
  // Fall back to derived logic for legacy records that predate the field
  // (pair time, or the most recent stable rotation if later).
  if (node.credentialIssuedAt) return node.credentialIssuedAt;
  const pairedMs = Date.parse(node.pairedAt);
  const rotation = node.credentialRotation;
  if (!rotation || rotation.state !== 'stable' || !rotation.stableAt) {
    return node.pairedAt;
  }
  const stableMs = Date.parse(rotation.stableAt);
  if (!Number.isFinite(stableMs)) return node.pairedAt;
  if (!Number.isFinite(pairedMs) || stableMs > pairedMs)
    return rotation.stableAt;
  return node.pairedAt;
}

function provableRotation(
  node: StoredNodeRecord
): StoredCredentialRotation | undefined {
  const rotation = node.credentialRotation;
  if (!rotation) return undefined;
  if (rotation.state === 'stable' || !rotation.nextCredentialHash)
    return undefined;
  return rotation;
}

function updateAclCredential(
  node: StoredNodeRecord,
  credentialId: string,
  now: string
): void {
  const acl = ensureNodeAcl(node);
  node.acl = {
    ...acl,
    peer: {
      ...acl.peer,
      credentialId,
    },
    lifecycle: {
      ...acl.lifecycle,
      updatedAt: now,
    },
  };
}

function createNodeAclForPairToken(input: {
  pairToken: StoredPairToken;
  nodeId: string;
  credentialId: string;
  displayName: string;
  createdAt: string;
}): RelayNodeAcl {
  const base = createLegacyDefaultNodeAcl({
    nodeId: input.nodeId,
    credentialId: input.credentialId,
    displayName: input.displayName,
    trustTier: input.pairToken.trustTier ?? 'dev',
    createdAt: input.createdAt,
  });
  const allowed = normalizeCapabilityBits(input.pairToken.allowedCapabilities);
  const requiresConfirmation = normalizeCapabilityBits(
    input.pairToken.requiresConfirmationCapabilities
  );
  const nodeAllowed = allowed.filter(
    (capability) => capability !== 'node:pair-token:create'
  );
  const nodeRequiresConfirmation = requiresConfirmation.filter(
    (capability) => capability !== 'node:pair-token:create'
  );
  if (nodeAllowed.length === 0 && nodeRequiresConfirmation.length === 0)
    return base;
  return applyTrustTierOverlay({
    ...base,
    grants: {
      allowed: nodeAllowed.length > 0 ? nodeAllowed : base.grants.allowed,
      requiresConfirmation: nodeRequiresConfirmation,
    },
  });
}

function credentialToken(nodeId: string): {
  token: string;
  credentialId: string;
  hash: string;
} {
  const credentialId = randomToken('cred');
  const secret = randomToken('secret');
  const token = `${nodeId}.${secret}`;
  return { token, credentialId, hash: sha256(token) };
}

function assertNoActiveRotation(node: StoredNodeRecord): void {
  const rotation = node.credentialRotation;
  if (!rotation || rotation.state === 'stable') return;
  throw new HubNodeRegistryError(
    'ROTATION_IN_PROGRESS',
    'credential rotation is already in progress',
    true,
    { rotationId: rotation.rotationId, reasonCode: 'ROTATION_IN_PROGRESS' }
  );
}

function publicNode(
  node: StoredNodeRecord,
  status: HubNodeStatus,
  hubVersion?: string
): HubNodeSummary {
  const acl = ensureNodeAcl(node);
  const identity = ensureSeparatedIdentity(node);
  const credential = credentialSummary(node);
  const aclSummary = summarizeAcl(acl);
  const rotationSummary = node.credentialRotation
    ? publicRotation(node.credentialRotation)
    : undefined;
  const sourceDiagnostics = publicSourceDiagnostics(
    node.sourceBinding?.diagnostics
  );

  let helperSkew: HubNodeHelperSkewSummary | undefined;
  if (hubVersion && (node.helperVersion || node.relayVersion)) {
    const result = classifyHelperSkew(
      node.helperVersion ?? node.relayVersion,
      hubVersion
    );
    helperSkew = {
      category: result.category,
      helperVersion: result.helperVersion,
      hubVersion: result.hubVersion,
      message: result.message,
      ...(result.remediationHint
        ? { remediationHint: result.remediationHint }
        : {}),
    };
  }

  return {
    nodeId: node.nodeId,
    identity,
    displayName: node.displayName,
    hostname: node.hostname,
    ...(node.homeDir ? { homeDir: node.homeDir } : {}),
    platform: node.platform,
    arch: node.arch,
    relayVersion: node.relayVersion,
    ...(node.helperVersion ? { helperVersion: node.helperVersion } : {}),
    protocolVersion: node.protocolVersion,
    status,
    connection: connectionSummary(status),
    trust: {
      state: node.revokedAt ? 'revoked' : 'active',
      level: aclSummary.trustTier,
      tier: aclSummary.trustTier,
      warning: PRIVILEGED_NODE_WARNING,
      policy: aclSummary,
    },
    credentialState: credential.state,
    credential,
    ...(rotationSummary ? { credentialRotation: rotationSummary } : {}),
    version: {
      state: versionState(node.protocolVersion),
      nodeProtocolVersion: node.protocolVersion,
      hubProtocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    },
    ...(helperSkew ? { helperSkew } : {}),
    capabilities: normalizeCapabilitySummary(node.capabilities),
    ...(node.fileRpcAvailable !== undefined
      ? { fileRpcAvailable: node.fileRpcAvailable }
      : {}),
    ...(node.degradedReasons && node.degradedReasons.length > 0
      ? { degradedReasons: node.degradedReasons }
      : {}),
    ...(sourceDiagnostics ? { sourceDiagnostics } : {}),
    createdAt: node.createdAt,
    pairedAt: node.pairedAt,
    lastSeenAt: node.lastSeenAt,
    credentialId: node.credentialId,
  };
}

function connectionSummary(
  status: HubNodeStatus
): HubNodeSummary['connection'] {
  if (status === 'online')
    return { route: REVERSE_LINK_ROUTE, status: 'connected' };
  if (status === 'stale')
    return { route: REVERSE_LINK_ROUTE, status: 'stale heartbeat' };
  if (status === 'offline')
    return { route: REVERSE_LINK_ROUTE, status: 'offline' };
  if (status === 'updating')
    return { route: REVERSE_LINK_ROUTE, status: 'updating' };
  return { route: REVERSE_LINK_ROUTE, status: 'revoked' };
}

export class HubNodeRegistry {
  readonly storagePath: string;
  private now: () => Date;
  private readonly staleMs: number;
  private readonly offlineMs: number;
  private readonly heartbeatPersistDebounceMs: number;
  private state: RegistryFile;
  private heartbeatPersistTimer: NodeJS.Timeout | null = null;
  private heartbeatPersistDirty = false;
  private heartbeatPersistError: unknown = null;
  private readonly auditSink:
    | { append(input: SecurityAuditEntryInput): unknown }
    | undefined;
  private readonly nodeStatusListeners = new Set<NodeStatusListener>();
  private readonly lastNotifiedStatuses = new Map<string, HubNodeStatus>();
  /** Hub's own package version, forwarded to helperSkew computation. */
  private readonly hubVersion: string | undefined;

  constructor(options: HubNodeRegistryOptions) {
    this.storagePath = options.storagePath;
    this.now = options.now ?? (() => new Date());
    this.staleMs = options.staleMs ?? DEFAULT_NODE_HEARTBEAT_TIMEOUTS.staleMs;
    this.offlineMs =
      options.offlineMs ?? DEFAULT_NODE_HEARTBEAT_TIMEOUTS.offlineMs;
    this.heartbeatPersistDebounceMs =
      options.heartbeatPersistDebounceMs ??
      DEFAULT_HEARTBEAT_PERSIST_DEBOUNCE_MS;
    this.auditSink = options.auditSink;
    this.hubVersion = options.hubVersion;
    this.state = readRegistryFile(options.storagePath);
    const needsAclMigration = registryNeedsAclMigration(this.state);
    const needsIdentityMigration = registryNeedsIdentityMigration(this.state);
    for (const node of this.state.nodes) {
      ensureNodeAcl(node);
      ensureSeparatedIdentity(node);
      ensureSeparatedCredential(node);
    }
    this.refreshLastNotifiedStatuses();
    if (needsAclMigration || needsIdentityMigration)
      writeRegistryFile(this.storagePath, this.state);
  }

  setNowForTest(now: () => Date): void {
    this.now = now;
  }

  onNodeStatus(listener: NodeStatusListener): () => void {
    this.nodeStatusListeners.add(listener);
    return () => {
      this.nodeStatusListeners.delete(listener);
    };
  }

  onNodeRevoked(listener: (nodeId: string) => void): () => void {
    return this.onNodeStatus((event) => {
      if (event.status === 'revoked') listener(event.nodeId);
    });
  }

  createPairToken(options: {
    displayName?: string;
    ttlMs?: number;
    platform?: string;
    trustTier?: RelayTrustTier;
    capabilityEnvelope?: PairTokenCapabilityEnvelope;
    issuer?: PairTokenMintIssuer;
    correlationId?: string;
    source?: RelayNodeSourceTuple;
  }): PairTokenResponse {
    const createdAt = this.now();
    const expiresAt = new Date(
      createdAt.getTime() + (options.ttlMs ?? DEFAULT_PAIR_TOKEN_TTL_MS)
    );
    const pairToken = randomToken('pair');
    const tokenId = randomToken('pt');
    const tokenHash = sha256(pairToken);
    const mintSource = sourceTupleWithHostname(options.source, undefined);
    const mintSourceFingerprint = mintSource
      ? sourceFingerprint(mintSource, tokenHash)
      : undefined;
    const mintSourceDiagnostics = mintSource
      ? {
          state: hasTailscaleSourceSignal(mintSource)
            ? ('source-match' as const)
            : ('signal-unavailable' as const),
          policy: 'audit' as const,
          reasonCode: hasTailscaleSourceSignal(mintSource)
            ? 'PAIR_TOKEN_MINT_SOURCE_RECORDED'
            : 'PAIR_TOKEN_MINT_SOURCE_SIGNAL_UNAVAILABLE',
          observedAt: createdAt.toISOString(),
          ...(mintSourceFingerprint
            ? { sourceFingerprint: mintSourceFingerprint }
            : {}),
          displayHint: sourceDisplayHint(mintSource, mintSourceFingerprint),
        }
      : undefined;
    const allowedCapabilities = normalizeCapabilityBits(
      options.capabilityEnvelope?.allowed
    );
    const requiresConfirmationCapabilities = normalizeCapabilityBits(
      options.capabilityEnvelope?.requiresConfirmation
    );
    const storedPairToken: StoredPairToken = {
      tokenId,
      tokenHash,
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.trustTier ? { trustTier: options.trustTier } : {}),
      ...(allowedCapabilities.length > 0 ? { allowedCapabilities } : {}),
      ...(requiresConfirmationCapabilities.length > 0
        ? { requiresConfirmationCapabilities }
        : {}),
      ...(options.issuer
        ? {
            issuer: {
              ...(options.issuer.grantId
                ? { grantId: options.issuer.grantId }
                : {}),
              ...(options.issuer.actorType
                ? { actorType: options.issuer.actorType }
                : {}),
              ...(options.issuer.actorDisplayName
                ? { actorDisplayName: options.issuer.actorDisplayName }
                : {}),
              ...(options.issuer.actorId
                ? { actorIdHash: sha256(options.issuer.actorId) }
                : {}),
            },
          }
        : {}),
      ...(options.correlationId
        ? { correlationId: options.correlationId }
        : {}),
      ...(mintSourceFingerprint ? { mintSourceFingerprint } : {}),
      ...(mintSourceDiagnostics ? { mintSourceDiagnostics } : {}),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.state.pairTokens.push(storedPairToken);
    this.persist();
    this.auditPairTokenLifecycle({
      pairToken: storedPairToken,
      decision: 'allow',
      eventType: 'grant',
      reasonCode: 'PAIR_TOKEN_MINTED',
      action: 'nodes.pair-token.create',
      grantedBits: ['node:pair-token:create'],
      ...(mintSourceDiagnostics
        ? { sourceDiagnostics: mintSourceDiagnostics }
        : {}),
    });
    return {
      tokenId,
      pairToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  exchangePairToken(input: PairExchangeInput): {
    credential: RelayNodeCredential;
    node: HubNodeSummary;
  } {
    const protocolVersion =
      input.protocolVersion ?? RELAY_NODE_LINK_PROTOCOL_VERSION;
    assertCompatibleProtocol(protocolVersion);
    const tokenHash = sha256(input.pairToken);
    const pairToken = this.state.pairTokens.find((candidate) =>
      timingSafeEqualHex(candidate.tokenHash, tokenHash)
    );
    if (!pairToken) {
      this.auditPairTokenLifecycle({
        decision: 'deny',
        eventType: 'denial',
        reasonCode: 'PAIR_TOKEN_NOT_FOUND',
        action: 'nodes.pair-token.redeem',
      });
      throw new HubNodeRegistryError(
        'UNAUTHORIZED',
        'pair token was not found',
        false,
        { reasonCode: 'PAIR_TOKEN_NOT_FOUND' }
      );
    }
    if (pairToken.usedAt) {
      this.auditPairTokenLifecycle({
        pairToken,
        decision: 'deny',
        eventType: 'failed_redemption',
        reasonCode: 'PAIR_TOKEN_REUSE_DENIED',
        action: 'nodes.pair-token.redeem',
      });
      throw new HubNodeRegistryError(
        'TOKEN_ALREADY_USED',
        'pair token has already been used',
        false,
        { reasonCode: 'PAIR_TOKEN_REUSE_DENIED' }
      );
    }
    const now = this.now();
    if (Date.parse(pairToken.expiresAt) <= now.getTime()) {
      this.auditPairTokenLifecycle({
        pairToken,
        decision: 'expired',
        eventType: 'expiry',
        reasonCode: 'PAIR_TOKEN_EXPIRED',
        action: 'nodes.pair-token.redeem',
      });
      throw new HubNodeRegistryError(
        'TOKEN_EXPIRED',
        'pair token expired',
        false,
        {
          reasonCode: 'PAIR_TOKEN_EXPIRED',
        }
      );
    }

    const nodeId = randomToken('node');
    const credential = credentialToken(nodeId);
    const timestamp = now.toISOString();
    const displayName = nodeDisplayName(
      input.displayName ?? pairToken.displayName,
      input.manifest
    );
    const pairedSource = sourceTupleWithHostname(
      input.source,
      input.manifest.hostname
    );
    const pairedSourceFingerprint = pairedSource
      ? sourceFingerprint(pairedSource, credential.hash)
      : undefined;
    const pairTokenRedeemSourceFingerprint = pairedSource
      ? sourceFingerprint(pairedSource, pairToken.tokenHash)
      : undefined;
    if (
      pairToken.mintSourceFingerprint &&
      pairTokenRedeemSourceFingerprint &&
      pairToken.mintSourceFingerprint !== pairTokenRedeemSourceFingerprint
    ) {
      this.auditPairTokenLifecycle({
        pairToken,
        decision: 'recorded',
        eventType: 'bridge_event',
        reasonCode: 'PAIR_TOKEN_SOURCE_MISMATCH_RECORDED',
        action: 'nodes.pair-token.source-check',
        sourceDiagnostics: {
          state: 'source-mismatch',
          policy: 'audit',
          reasonCode: 'PAIR_TOKEN_SOURCE_MISMATCH',
          observedAt: timestamp,
          sourceFingerprint: pairTokenRedeemSourceFingerprint,
          displayHint: sourceDisplayHint(
            pairedSource,
            pairTokenRedeemSourceFingerprint
          ),
        },
      });
    }
    const nodeAcl = createNodeAclForPairToken({
      pairToken,
      nodeId,
      credentialId: credential.credentialId,
      displayName,
      createdAt: timestamp,
    });
    const node: StoredNodeRecord = {
      nodeId,
      identity: {
        nodeId,
        displayName,
        hostname: input.manifest.hostname,
        createdAt: timestamp,
        pairedAt: timestamp,
      },
      activeCredential: {
        credentialId: credential.credentialId,
        tokenHash: credential.hash,
        issuedAt: timestamp,
      },
      credentialId: credential.credentialId,
      credentialHash: credential.hash,
      displayName,
      hostname: input.manifest.hostname,
      ...(input.manifest.homeDir ? { homeDir: input.manifest.homeDir } : {}),
      platform: input.manifest.platform,
      arch: input.manifest.arch,
      relayVersion: input.manifest.relayVersion,
      helperVersion:
        input.manifest.helperVersion ?? input.manifest.relayVersion,
      protocolVersion,
      capabilities: summarizeCapabilities(input.manifest),
      ...(input.manifest.fileRpc
        ? { fileRpcAvailable: input.manifest.fileRpc.available }
        : {}),
      degradedReasons: input.manifest.degradedReasons ?? [],
      acl: nodeAcl,
      credentialIssuedAt: timestamp,
      ...(pairedSource
        ? {
            sourceBinding: {
              expected: pairedSource,
              lastObserved: pairedSource,
              observedFingerprints: pairedSourceFingerprint
                ? [pairedSourceFingerprint]
                : [],
              diagnostics: {
                state: hasTailscaleSourceSignal(pairedSource)
                  ? 'source-match'
                  : 'signal-unavailable',
                policy: 'audit',
                reasonCode: hasTailscaleSourceSignal(pairedSource)
                  ? 'NODE_SOURCE_MATCH'
                  : 'NODE_SOURCE_SIGNAL_UNAVAILABLE',
                observedAt: timestamp,
                ...(pairedSourceFingerprint
                  ? { sourceFingerprint: pairedSourceFingerprint }
                  : {}),
                displayHint: sourceDisplayHint(
                  pairedSource,
                  pairedSourceFingerprint
                ),
              },
            },
          }
        : {}),
      createdAt: timestamp,
      pairedAt: timestamp,
      lastSeenAt: timestamp,
    };
    pairToken.usedAt = timestamp;
    this.state.nodes.push(node);
    this.persist();
    this.auditPairTokenLifecycle({
      pairToken,
      decision: 'allow',
      eventType: 'grant',
      reasonCode: 'PAIR_TOKEN_REDEEMED',
      action: 'nodes.pair-token.redeem',
      grantedBits: nodeAcl.grants.allowed,
      ...(node.sourceBinding?.diagnostics
        ? { sourceDiagnostics: node.sourceBinding.diagnostics }
        : {}),
    });
    this.auditNodeCredentialLifecycle({
      node,
      credentialId: credential.credentialId,
      decision: 'allow',
      eventType: 'grant',
      reasonCode: 'NODE_PAIR_ALLOWED',
      action: 'nodes.pair',
    });
    this.notifyNodeStatusIfChanged(node, 'online', input.manifest);
    return {
      credential: {
        protocol: RELAY_NODE_LINK_PROTOCOL,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        nodeId,
        credentialId: credential.credentialId,
        token: credential.token,
        issuedAt: timestamp,
      },
      node: publicNode(node, 'online', this.hubVersion),
    };
  }

  authenticateCredential(
    token: string,
    context: CredentialAuthContext = {}
  ): HubNodeSummary | null {
    const result = this.authenticateCredentialDetailed(token, context);
    return result.ok ? result.node : null;
  }

  private parseCredentialToken(
    token: string,
    context: CredentialAuthContext = {}
  ):
    | { ok: true; nodeId: string }
    | { ok: false; result: CredentialAuthResult } {
    if (token.length === 0) {
      return {
        ok: false,
        result: this.credentialDenied(
          'NODE_CREDENTIAL_MISSING',
          undefined,
          undefined,
          context
        ),
      };
    }
    const firstSeparator = token.indexOf('.');
    if (
      firstSeparator <= 0 ||
      firstSeparator === token.length - 1 ||
      token.indexOf('.', firstSeparator + 1) !== -1
    ) {
      return {
        ok: false,
        result: this.credentialDenied(
          'NODE_CREDENTIAL_MALFORMED',
          undefined,
          undefined,
          context
        ),
      };
    }
    const nodeId = token.slice(0, firstSeparator);
    if (!nodeId.startsWith('node_')) {
      return {
        ok: false,
        result: this.credentialDenied(
          'NODE_CREDENTIAL_MALFORMED',
          undefined,
          undefined,
          context
        ),
      };
    }
    return { ok: true, nodeId };
  }

  private credentialDenied(
    code: RelayNodeErrorCode,
    node?: StoredNodeRecord,
    nodeId?: string,
    context: CredentialAuthContext = {}
  ): CredentialAuthResult {
    const sourceDiagnostics = sourceDiagnosticsForAuthDenied({
      source: context.source,
      now: this.now().toISOString(),
      strictDeny: context.strictSourceDeny,
      ...(node
        ? { fingerprintKey: ensureSeparatedCredential(node).tokenHash }
        : {}),
    });
    const error = this.credentialError(code, sourceDiagnostics);
    this.auditNodeCredentialLifecycle({
      ...(node ? { node } : {}),
      ...(nodeId ? { nodeId } : {}),
      decision: code === 'NODE_CREDENTIAL_EXPIRED' ? 'expired' : 'deny',
      eventType: code === 'NODE_CREDENTIAL_EXPIRED' ? 'expiry' : 'denial',
      reasonCode: code,
      sourceDiagnostics,
    });
    return { ok: false, error };
  }

  private credentialError(
    code: RelayNodeErrorCode,
    sourceDiagnostics?: RelayNodeSourceDiagnostics
  ): RelayNodeError {
    const messages: Partial<Record<RelayNodeErrorCode, string>> = {
      NODE_CREDENTIAL_MISSING: 'node credential is missing; re-pair this node',
      NODE_CREDENTIAL_MALFORMED:
        'node credential is malformed; re-pair this node',
      NODE_CREDENTIAL_MISMATCH:
        'node credential does not match the stable node identity',
      NODE_CREDENTIAL_EXPIRED: 'node credential expired; rotate or re-pair',
      NODE_REVOKED: 'node credential was revoked',
      REPAIR_REQUIRED:
        'node credential no longer matches hub state; re-pair required',
    };
    return {
      code,
      message: messages[code] ?? 'invalid node credential',
      retryable: false,
      details: {
        reasonCode: code,
        ...(sourceDiagnostics ? { sourceDiagnostics } : {}),
      },
    };
  }

  // eslint-disable-next-line complexity -- lifecycle audit payload is intentionally explicit so sensitive pair-token/grant material never gets serialized accidentally.
  private auditPairTokenLifecycle(input: {
    pairToken?: StoredPairToken;
    decision: SecurityAuditDecision;
    eventType: SecurityAuditEventType;
    reasonCode: string;
    action: string;
    grantedBits?: RelayCapabilityBit[];
    deniedBits?: RelayCapabilityBit[];
    sourceDiagnostics?: RelayNodeSourceDiagnostics;
  }): void {
    if (!this.auditSink) return;
    const pairToken = input.pairToken;
    try {
      this.auditSink.append({
        eventType: input.eventType,
        decision: input.decision,
        reasonCode: input.reasonCode,
        peer: {
          kind: pairToken?.issuer ? 'system' : 'hub',
          ...(pairToken?.tokenId ? { credentialId: pairToken.tokenId } : {}),
          ...(pairToken?.issuer?.actorDisplayName
            ? { displayName: pairToken.issuer.actorDisplayName }
            : {}),
          ...(pairToken?.issuer?.actorIdHash
            ? { principalHash: pairToken.issuer.actorIdHash }
            : {}),
        },
        intent: {
          action: input.action,
          ...(pairToken?.tokenId ? { target: pairToken.tokenId } : {}),
        },
        material: {
          params: {
            reasonCode: input.reasonCode,
            tokenId: pairToken?.tokenId ?? null,
            displayName: pairToken?.displayName ?? null,
            platform: pairToken?.platform ?? null,
            expiresAt: pairToken?.expiresAt ?? null,
            trustTier: pairToken?.trustTier ?? null,
            issuerGrantId: pairToken?.issuer?.grantId ?? null,
            sourceState: input.sourceDiagnostics?.state ?? null,
          },
          scope: {
            allowedCapabilities: pairToken?.allowedCapabilities ?? [],
            requiresConfirmationCapabilities:
              pairToken?.requiresConfirmationCapabilities ?? [],
          },
        },
        grantedBits: input.grantedBits ?? [],
        deniedBits: input.deniedBits ?? [],
        refs: { policyVersion: RELAY_SECURITY_POLICY_VERSION },
        ...(input.sourceDiagnostics
          ? { sourceDiagnostics: input.sourceDiagnostics }
          : {}),
        ...(pairToken?.correlationId
          ? { correlationId: pairToken.correlationId }
          : {}),
      });
    } catch {
      // Best-effort pair-token lifecycle visibility only. Never retry or log
      // raw bootstrap/grant material if the audit sink fails.
    }
  }

  private auditNodeCredentialLifecycle(input: {
    node?: StoredNodeRecord;
    nodeId?: string;
    credentialId?: string;
    decision: SecurityAuditDecision;
    eventType: SecurityAuditEventType;
    reasonCode: string;
    action?: string;
    sourceDiagnostics?: RelayNodeSourceDiagnostics;
  }): void {
    if (!this.auditSink) return;
    const nodeId = input.node?.nodeId ?? input.nodeId;
    try {
      this.auditSink.append({
        eventType: input.eventType,
        decision: input.decision,
        reasonCode: input.reasonCode,
        peer: {
          kind: 'node',
          ...(nodeId ? { nodeId } : {}),
          ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        },
        node: { ...(nodeId ? { nodeId } : {}) },
        intent: {
          action: input.action ?? 'nodes.credential.authenticate',
          ...(nodeId ? { target: nodeId } : {}),
        },
        material: {
          params: {
            recoveryReason: input.reasonCode,
            hasCredentialId: Boolean(input.credentialId),
            ...(input.sourceDiagnostics
              ? { sourceState: input.sourceDiagnostics.state }
              : {}),
          },
        },
        ...(input.sourceDiagnostics
          ? { sourceDiagnostics: input.sourceDiagnostics }
          : {}),
      });
    } catch {
      // Best-effort lifecycle visibility only. Authentication remains
      // fail-closed/allow-closed on the credential decision itself; audit
      // failures must not cause raw bearer material to be retried or logged.
    }
  }

  private recordSourceObservation(
    node: StoredNodeRecord,
    context: CredentialAuthContext,
    fingerprintKey: string,
    now: string
  ): RelayNodeSourceDiagnostics {
    const binding = sourceBindingForNode(node);
    const observed = sourceTupleWithHostname(
      context.source,
      node.identity?.hostname ?? node.hostname
    );
    if (!binding.expected && observed && hasTailscaleSourceSignal(observed)) {
      binding.expected = observed;
    }
    const evaluation = evaluateRelayNodeSource({
      expected: binding.expected,
      observed,
      observedFingerprints: binding.observedFingerprints,
      strictDeny: context.strictSourceDeny,
      fingerprintKey,
      now,
    });
    if (evaluation.normalizedObserved) {
      binding.lastObserved = evaluation.normalizedObserved;
    }
    if (evaluation.observedFingerprint) {
      const fingerprints = new Set(binding.observedFingerprints ?? []);
      fingerprints.add(evaluation.observedFingerprint);
      binding.observedFingerprints = Array.from(fingerprints).slice(-8);
    }
    binding.diagnostics = evaluation.diagnostics;
    return evaluation.diagnostics;
  }

  authenticateCredentialDetailed(
    token: string,
    context: CredentialAuthContext = {}
  ): CredentialAuthResult {
    const trimmedToken = token.trim();
    const parsed = this.parseCredentialToken(trimmedToken, context);
    if (parsed.ok === false) return parsed.result;
    const { nodeId } = parsed;
    const tokenHash = sha256(trimmedToken);
    const node = this.state.nodes.find(
      (candidate) => candidate.nodeId === nodeId
    );
    const rotation = node ? provableRotation(node) : undefined;
    const activeCredential = node ? ensureSeparatedCredential(node) : undefined;
    const matchesActive = activeCredential
      ? timingSafeEqualHex(activeCredential.tokenHash, tokenHash)
      : false;
    const matchesRotation =
      node &&
      rotation?.nextCredentialHash &&
      timingSafeEqualHex(rotation.nextCredentialHash, tokenHash);
    if (!node || (!matchesActive && !matchesRotation)) {
      const code: RelayNodeErrorCode = !node
        ? 'REPAIR_REQUIRED'
        : node.credentialRotation?.state === 'stable'
          ? 'REPAIR_REQUIRED'
          : 'NODE_CREDENTIAL_MISMATCH';
      return this.credentialDenied(code, node, nodeId, context);
    }
    if (activeCredential?.expiresAt) {
      const expiresAt = Date.parse(activeCredential.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= this.now().getTime()) {
        return this.credentialDenied(
          'NODE_CREDENTIAL_EXPIRED',
          node,
          nodeId,
          context
        );
      }
    }
    if (node.revokedAt) {
      return this.credentialDenied('NODE_REVOKED', node, nodeId, context);
    }
    const credentialId = matchesRotation
      ? rotation!.nextCredentialId
      : node.credentialId;
    const sourceDiagnostics = this.recordSourceObservation(
      node,
      context,
      matchesRotation
        ? rotation!.nextCredentialHash!
        : activeCredential!.tokenHash,
      this.now().toISOString()
    );
    if (sourceDiagnostics.state === 'strict-deny') {
      this.persist();
      this.auditNodeCredentialLifecycle({
        node,
        credentialId,
        decision: 'deny',
        eventType: 'denial',
        reasonCode: sourceDiagnostics.reasonCode,
        sourceDiagnostics,
      });
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message:
            'node credential source does not match the expected Tailscale/MagicDNS binding',
          retryable: false,
          details: {
            reasonCode: sourceDiagnostics.reasonCode,
            sourceDiagnostics,
          },
        },
      };
    }
    this.persist();
    this.auditNodeCredentialLifecycle({
      node,
      credentialId,
      decision: 'allow',
      eventType: 'grant',
      reasonCode: matchesRotation
        ? 'NODE_CREDENTIAL_ROTATION_RECONNECT_ALLOWED'
        : 'NODE_CREDENTIAL_RECONNECT_ALLOWED',
      sourceDiagnostics,
    });
    return {
      ok: true,
      node: publicNode(
        node,
        statusForNode(node, this.now(), this.staleMs, this.offlineMs),
        this.hubVersion
      ),
      credentialId,
      ...(matchesRotation ? { rotationId: rotation!.rotationId } : {}),
    };
  }

  recordHeartbeat(input: HeartbeatInput): HubNodeSummary {
    assertCompatibleProtocol(input.protocolVersion);
    const node = this.state.nodes.find(
      (candidate) => candidate.nodeId === input.nodeId
    );
    if (!node)
      throw new HubNodeRegistryError('NOT_FOUND', 'node is not paired');
    if (node.revokedAt)
      throw new HubNodeRegistryError('NODE_REVOKED', 'node was revoked');
    const now = this.now().toISOString();
    if (input.credentialId) {
      this.proveCredentialRotation(node, input.credentialId, now);
    }
    const previousStatus = statusForNode(
      node,
      this.now(),
      this.staleMs,
      this.offlineMs
    );
    node.lastSeenAt = now;
    delete node.linkDisconnectedAt;
    node.protocolVersion = input.protocolVersion;
    if (input.manifest) {
      node.hostname = input.manifest.hostname;
      const identity = ensureSeparatedIdentity(node);
      node.identity = { ...identity, hostname: input.manifest.hostname };
      if (input.manifest.homeDir) node.homeDir = input.manifest.homeDir;
      else delete node.homeDir;
      node.platform = input.manifest.platform;
      node.arch = input.manifest.arch;
      node.relayVersion = input.manifest.relayVersion;
      node.helperVersion =
        input.manifest.helperVersion ?? input.manifest.relayVersion;
      node.capabilities = summarizeCapabilities(input.manifest);
      // Persist file-rpc availability and degraded reasons from the manifest
      // so the frontend can surface structured degraded state without re-fetching.
      if (input.manifest.fileRpc) {
        node.fileRpcAvailable = input.manifest.fileRpc.available;
      }
      node.degradedReasons = input.manifest.degradedReasons ?? [];
    }
    if (input.repoInventory !== undefined && input.repoInventory !== null) {
      node.repoInventory = input.repoInventory;
    }
    this.scheduleHeartbeatPersist();
    this.notifyNodeStatusIfChanged(
      node,
      'online',
      input.manifest,
      previousStatus
    );
    return publicNode(node, 'online', this.hubVersion);
  }

  markNodeLinkDisconnected(nodeId: string): HubNodeSummary {
    const node = this.state.nodes.find(
      (candidate) => candidate.nodeId === nodeId
    );
    if (!node)
      throw new HubNodeRegistryError('NOT_FOUND', 'node is not paired');
    if (node.revokedAt) return publicNode(node, 'revoked', this.hubVersion);

    const previousStatus = statusForNode(
      node,
      this.now(),
      this.staleMs,
      this.offlineMs
    );
    node.linkDisconnectedAt = this.now().toISOString();
    this.persist();
    this.notifyNodeStatusIfChanged(node, 'offline', undefined, previousStatus);
    return publicNode(node, 'offline', this.hubVersion);
  }

  beginCredentialRotation(nodeId: string): CredentialRotationResult {
    const node = this.state.nodes.find(
      (candidate) => candidate.nodeId === nodeId
    );
    if (!node)
      throw new HubNodeRegistryError('NOT_FOUND', 'node is not paired');
    if (node.revokedAt)
      throw new HubNodeRegistryError('NODE_REVOKED', 'node was revoked');
    assertNoActiveRotation(node);
    const issuedAt = this.now().toISOString();
    const next = credentialToken(nodeId);
    node.credentialRotation = {
      rotationId: randomToken('rot'),
      previousCredentialId: node.credentialId,
      nextCredentialId: next.credentialId,
      nextCredentialHash: next.hash,
      state: 'issuing',
      issuedAt,
    };
    this.persist();
    return {
      node: publicNode(
        node,
        statusForNode(node, this.now(), this.staleMs, this.offlineMs),
        this.hubVersion
      ),
      credential: {
        protocol: RELAY_NODE_LINK_PROTOCOL,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        nodeId,
        credentialId: next.credentialId,
        token: next.token,
        issuedAt,
      },
      rotation: publicRotation(node.credentialRotation)!,
    };
  }

  markCredentialRotationDelivered(
    nodeId: string,
    rotationId: string
  ): CredentialRotationPublicResult {
    const node = this.requireRotationNode(nodeId, rotationId);
    const rotation = node.credentialRotation!;
    if (rotation.state === 'issuing') {
      rotation.state = 'delivered';
      rotation.deliveredAt = this.now().toISOString();
      this.persist();
    }
    return {
      node: publicNode(
        node,
        statusForNode(node, this.now(), this.staleMs, this.offlineMs),
        this.hubVersion
      ),
      rotation: publicRotation(rotation)!,
    };
  }

  failCredentialRotation(
    nodeId: string,
    rotationId: string,
    reason: string
  ): CredentialRotationPublicResult {
    const node = this.requireRotationNode(nodeId, rotationId);
    const rotation = node.credentialRotation!;
    if (rotation.state !== 'stable') {
      rotation.state = 'failed';
      rotation.failedAt = this.now().toISOString();
      rotation.failureReason = reason;
      this.persist();
    }
    return {
      node: publicNode(
        node,
        statusForNode(node, this.now(), this.staleMs, this.offlineMs),
        this.hubVersion
      ),
      rotation: publicRotation(rotation)!,
    };
  }

  clearCredentialRotationFailure(nodeId: string): HubNodeSummary {
    const node = this.state.nodes.find(
      (candidate) => candidate.nodeId === nodeId
    );
    if (!node)
      throw new HubNodeRegistryError('NOT_FOUND', 'node is not paired');
    if (!node.credentialRotation) {
      throw new HubNodeRegistryError(
        'INVALID_REQUEST',
        'node has no failed or in-progress credential rotation to clear'
      );
    }
    if (node.credentialRotation.state === 'stable') {
      throw new HubNodeRegistryError(
        'INVALID_REQUEST',
        'node has no failed or in-progress credential rotation to clear'
      );
    }
    delete node.credentialRotation;
    this.persist();
    return publicNode(
      node,
      statusForNode(node, this.now(), this.staleMs, this.offlineMs),
      this.hubVersion
    );
  }

  private requireRotationNode(
    nodeId: string,
    rotationId: string
  ): StoredNodeRecord {
    const node = this.state.nodes.find(
      (candidate) => candidate.nodeId === nodeId
    );
    if (!node)
      throw new HubNodeRegistryError('NOT_FOUND', 'node is not paired');
    if (
      !node.credentialRotation ||
      node.credentialRotation.rotationId !== rotationId
    ) {
      throw new HubNodeRegistryError(
        'NOT_FOUND',
        'credential rotation was not found'
      );
    }
    return node;
  }

  private proveCredentialRotation(
    node: StoredNodeRecord,
    credentialId: string,
    now: string
  ): void {
    const rotation = provableRotation(node);
    if (!rotation || rotation.nextCredentialId !== credentialId) return;
    if (!rotation.nextCredentialHash) {
      throw new HubNodeRegistryError(
        'INTERNAL',
        'credential rotation is missing proof hash'
      );
    }
    rotation.state = 'proved';
    rotation.provedAt = now;
    node.credentialId = rotation.nextCredentialId;
    node.credentialHash = rotation.nextCredentialHash;
    node.credentialIssuedAt = now;
    updateAclCredential(node, rotation.nextCredentialId, now);
    node.activeCredential = {
      credentialId: rotation.nextCredentialId,
      tokenHash: rotation.nextCredentialHash,
      issuedAt: now,
    };
    delete rotation.nextCredentialHash;
    rotation.state = 'stable';
    rotation.stableAt = now;
    this.auditCredentialRotationProved(node, rotation, now);
  }

  private auditCredentialRotationProved(
    node: StoredNodeRecord,
    rotation: StoredCredentialRotation,
    provedAt: string
  ): void {
    if (!this.auditSink) return;
    try {
      this.auditSink.append({
        eventType: 'rotation',
        decision: 'rotated',
        reasonCode: 'CREDENTIAL_ROTATION_PROVED',
        peer: {
          kind: 'node',
          nodeId: node.nodeId,
          credentialId: rotation.nextCredentialId,
        },
        node: { nodeId: node.nodeId },
        intent: { action: 'nodes.credential.rotate', target: node.nodeId },
        material: {
          params: {
            rotationId: rotation.rotationId,
            previousCredentialId: rotation.previousCredentialId,
            nextCredentialId: rotation.nextCredentialId,
            provedAt,
          },
        },
      });
    } catch {
      // Best-effort proof visibility only. Never leak or retry bearer tokens
      // from the heartbeat path when an audit sink is unavailable.
    }
  }

  async flushPendingHeartbeatPersist(): Promise<void> {
    if (this.heartbeatPersistTimer) {
      clearTimeout(this.heartbeatPersistTimer);
      this.heartbeatPersistTimer = null;
    }
    this.flushHeartbeatPersistNow();

    if (this.heartbeatPersistError) {
      const error = this.heartbeatPersistError;
      this.heartbeatPersistError = null;
      throw error;
    }
  }

  listNodes(): HubNodeSummary[] {
    const now = this.now();
    return this.state.nodes.map((node) =>
      publicNode(
        node,
        statusForNode(node, now, this.staleMs, this.offlineMs),
        this.hubVersion
      )
    );
  }

  listScheduledRotationCandidates(
    intervalMs: number
  ): ScheduledRotationCandidate[] {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return [];
    const nowMs = this.now().getTime();
    const candidates: ScheduledRotationCandidate[] = [];
    for (const node of this.state.nodes) {
      if (node.revokedAt) continue;
      const rotation = node.credentialRotation;
      if (rotation && rotation.state !== 'stable') continue;
      const issuedAtIso = activeCredentialIssuedAt(node);
      const issuedAtMs = Date.parse(issuedAtIso);
      if (!Number.isFinite(issuedAtMs)) continue;
      const ageMs = nowMs - issuedAtMs;
      if (ageMs < intervalMs) continue;
      candidates.push({
        nodeId: node.nodeId,
        credentialId: node.credentialId,
        activeCredentialIssuedAt: issuedAtIso,
        ageMs,
      });
    }
    return candidates;
  }

  refreshNodeStatuses(): HubNodeStatusEvent[] {
    const now = this.now();
    const events: HubNodeStatusEvent[] = [];
    for (const node of this.state.nodes) {
      const status = statusForNode(node, now, this.staleMs, this.offlineMs);
      const event = this.notifyNodeStatusIfChanged(node, status);
      if (event) events.push(event);
    }
    return events;
  }

  listInventoryPayloads(
    options: { includeRevoked?: boolean } = {}
  ): InventoryPayloadRecord[] {
    return this.state.nodes
      .filter((node) => options.includeRevoked || !node.revokedAt)
      .filter(
        (node) =>
          node.repoInventory !== undefined && node.repoInventory !== null
      )
      .map((node) => ({ nodeId: node.nodeId, payload: node.repoInventory }));
  }

  revokeNode(nodeId: string): HubNodeSummary {
    const node = this.state.nodes.find(
      (candidate) => candidate.nodeId === nodeId
    );
    if (!node)
      throw new HubNodeRegistryError('NOT_FOUND', 'node is not paired');
    const alreadyRevoked = Boolean(node.revokedAt);
    if (!alreadyRevoked) {
      node.revokedAt = this.now().toISOString();
      node.activeCredential = {
        ...ensureSeparatedCredential(node),
        revokedAt: node.revokedAt,
      };
      this.persist();
      this.auditNodeCredentialLifecycle({
        node,
        credentialId: node.credentialId,
        decision: 'revoked',
        eventType: 'revocation',
        reasonCode: 'NODE_CREDENTIAL_REVOKED',
        action: 'nodes.revoke',
      });
      this.notifyNodeStatusIfChanged(node, 'revoked');
    }
    return publicNode(node, 'revoked', this.hubVersion);
  }

  /**
   * Mark a node as `updating`. While in this state the hub refuses new
   * session-create requests for the node (returns 503 with Retry-After).
   * Existing sessions are allowed to drain naturally (#655).
   */
  markNodeUpdating(nodeId: string): HubNodeSummary {
    const node = this.state.nodes.find(
      (candidate) => candidate.nodeId === nodeId
    );
    if (!node)
      throw new HubNodeRegistryError('NOT_FOUND', 'node is not paired');
    if (node.revokedAt)
      throw new HubNodeRegistryError('NODE_REVOKED', 'node was revoked');
    if (!node.updatingAt) {
      node.updatingAt = this.now().toISOString();
      this.persist();
      this.notifyNodeStatusIfChanged(node, 'updating');
    }
    return publicNode(node, 'updating', this.hubVersion);
  }

  /**
   * Clear the `updating` flag after a node update completes. The node
   * transitions back to its normal heartbeat-derived status.
   */
  markNodeUpdateComplete(nodeId: string): HubNodeSummary {
    const node = this.state.nodes.find(
      (candidate) => candidate.nodeId === nodeId
    );
    if (!node)
      throw new HubNodeRegistryError('NOT_FOUND', 'node is not paired');
    if (node.revokedAt)
      throw new HubNodeRegistryError('NODE_REVOKED', 'node was revoked');
    if (node.updatingAt) {
      delete node.updatingAt;
      this.persist();
    }
    const status = statusForNode(
      node,
      this.now(),
      this.staleMs,
      this.offlineMs
    );
    this.notifyNodeStatusIfChanged(node, status);
    return publicNode(node, status, this.hubVersion);
  }

  errorBody(error: unknown): { error: RelayNodeError } {
    if (error instanceof HubNodeRegistryError) {
      return { error: error.relayNodeError };
    }
    return {
      error: {
        code: 'INTERNAL',
        message:
          error instanceof Error
            ? error.message
            : 'internal hub node registry error',
        retryable: true,
      },
    };
  }

  private refreshLastNotifiedStatuses(): void {
    const now = this.now();
    this.lastNotifiedStatuses.clear();
    for (const node of this.state.nodes) {
      this.lastNotifiedStatuses.set(
        node.nodeId,
        statusForNode(node, now, this.staleMs, this.offlineMs)
      );
    }
  }

  private notifyNodeStatusIfChanged(
    node: StoredNodeRecord,
    status: HubNodeStatus,
    manifest?: NodeManifest,
    previousStatus: HubNodeStatus | undefined = this.lastNotifiedStatuses.get(
      node.nodeId
    )
  ): HubNodeStatusEvent | null {
    if (previousStatus === status) return null;
    this.lastNotifiedStatuses.set(node.nodeId, status);
    const event: HubNodeStatusEvent = {
      nodeId: node.nodeId,
      status,
      lastSeenAt: node.lastSeenAt,
      ...(manifest ? { manifest } : {}),
    };
    this.nodeStatusListeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        logger.warn(
          'hub node status listener failed; continuing status notifications for node %s',
          node.nodeId
        );
      }
    });
    return event;
  }

  private persist(): void {
    this.cancelPendingHeartbeatPersist();
    this.heartbeatPersistError = null;
    writeRegistryFile(this.storagePath, this.state);
  }

  private scheduleHeartbeatPersist(): void {
    this.heartbeatPersistDirty = true;
    if (this.heartbeatPersistTimer) return;
    this.heartbeatPersistTimer = setTimeout(() => {
      this.heartbeatPersistTimer = null;
      try {
        this.flushHeartbeatPersistNow();
      } catch {
        /* error is recorded for a later deterministic flush/retry */
      }
    }, this.heartbeatPersistDebounceMs);
    this.heartbeatPersistTimer.unref?.();
  }

  private flushHeartbeatPersistNow(): void {
    if (!this.heartbeatPersistDirty) return;
    try {
      writeRegistryFile(this.storagePath, this.state);
      this.heartbeatPersistDirty = false;
      this.heartbeatPersistError = null;
    } catch (error) {
      this.heartbeatPersistError = error;
      throw error;
    }
  }

  private cancelPendingHeartbeatPersist(): void {
    if (this.heartbeatPersistTimer) {
      clearTimeout(this.heartbeatPersistTimer);
      this.heartbeatPersistTimer = null;
    }
    this.heartbeatPersistDirty = false;
  }
}

export function createHubNodeRegistry(
  options: HubNodeRegistryOptions
): HubNodeRegistry {
  return new HubNodeRegistry(options);
}

export { HubNodeRegistryError, summarizeCapabilities };
