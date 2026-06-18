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
import { redactBootstrapSecrets } from '../shared/bootstrap-diagnostics.js';
import {
  DEFAULT_NODE_LINK_PROOF_FRESHNESS_MS,
  safeNodePublicKeyFingerprint,
  verifyNodeLinkProof,
  type NodeLinkProofAudience,
} from '../shared/node-identity-keys.js';
import {
  LEGACY_DEFAULT_ALLOWED_CAPABILITIES,
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
import {
  DEFAULT_NODE_PAIRING_TRUST_PROFILE,
  NODE_PAIRING_REASON_CODES,
  isHighRiskNodePairingRequest,
  nodePairingCapabilityPosture,
  nodePairingProfileTrustTier,
  normalizeNodePairingDeviceCode,
  type NodePairingRequestState,
  type NodePairingRequestSummary,
  type NodePairingTrustProfile,
} from '../shared/node-pairing-requests.js';
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
  // #981: key binding for the next credential. Carried forward from the active
  // credential by default so the node keeps proving with the same identity key
  // across a secret-only rotation; an explicit value rebinds to a new key.
  nextPublicKey?: string;
  nextPublicKeyFingerprint?: string;
  nextPublicKeyAlgorithm?: string;
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
  // #981: key-bound identity. When the node paired with a local key pair, the
  // hub binds the SPKI public key (PEM) + its stable `nkey_…` fingerprint to
  // the credential. Public material only — no private key ever reaches the hub.
  // Absent for legacy bearer-only credentials, which stay on the token path.
  publicKey?: string;
  publicKeyFingerprint?: string;
  publicKeyAlgorithm?: string;
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

/**
 * #982: a node-initiated pending pairing request. Lives here until an operator
 * approves/denies it or it expires. Stores only the manifest-derived fields the
 * approval decision and node-record creation need — never the raw manifest, a
 * repo/path inventory, the node credential, or the node's poll secret (only the
 * sha256 of the status token is persisted).
 */
interface StoredPendingPairingRequest {
  requestId: string;
  correlationId: string;
  deviceCode: string;
  /** sha256 of the one-time node-held status/poll token. Raw token never stored. */
  statusTokenHash: string;
  state: NodePairingRequestState;
  reasonCode: string;
  // #981 key binding (public material only). Bound to the issued credential on claim.
  publicKey?: string;
  publicKeyFingerprint?: string;
  // Manifest-derived display/decision metadata (no raw manifest, no path inventory).
  displayName: string;
  hostname: string;
  homeDir?: string;
  platform: string;
  arch: string;
  relayVersion: string;
  helperVersion?: string;
  protocolVersion: string;
  capabilities: NodeCapabilityManifestSummary;
  fileRpcAvailable?: boolean;
  degradedReasons?: import('../shared/node-manifest.js').NodeManifestDegradedReason[];
  // Requested access posture.
  requestedProfile: NodePairingTrustProfile;
  requestedTrustTier: RelayTrustTier;
  /** Resolved allowed capability bits (profile defaults ∪ requested extras). */
  capabilityBits: RelayCapabilityBit[];
  requestedRoots: string[];
  requiresExactOperationApproval: boolean;
  sourceBinding?: StoredNodeSourceBinding;
  // Lifecycle.
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decisionReason?: string;
  // Outputs once the node has claimed its credential.
  nodeId?: string;
  credentialId?: string;
  credentialDeliveredAt?: string;
}

interface RegistryFile {
  schemaVersion: 1;
  pairTokens: StoredPairToken[];
  nodes: StoredNodeRecord[];
  pendingPairings: StoredPendingPairingRequest[];
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
  /**
   * #981: node-generated SPKI public key (PEM). When present and valid, the hub
   * binds its fingerprint to the issued credential and the node must thereafter
   * prove private-key possession on node-link. Public material only.
   */
  publicKey?: string;
}

export interface HeartbeatInput {
  nodeId: string;
  protocolVersion: string;
  credentialId?: string;
  manifest?: NodeManifest;
  repoInventory?: unknown;
}

/** #982: node-facing submission of a pending pairing request. */
export interface PendingPairingRequestInput {
  manifest: NodeManifest;
  /** #981 SPKI public key (PEM). Public material only; bound on credential issuance. */
  publicKey?: string;
  displayName?: string;
  requestedProfile?: NodePairingTrustProfile;
  /** Optional extra capability bits beyond the profile defaults. */
  requestedCapabilities?: RelayCapabilityBit[];
  requestedRoots?: string[];
  protocolVersion?: string;
  correlationId?: string;
  source?: RelayNodeSourceTuple;
  ttlMs?: number;
}

export interface PendingPairingRequestResult {
  request: NodePairingRequestSummary;
  /**
   * One-time poll secret returned to the waiting node. The node presents it to
   * poll status and claim its issued credential. Hashed at rest; never
   * re-emitted, logged, or placed in a summary/audit.
   */
  statusToken: string;
}

/** #982: operator edit of requested access before approval (not a re-approval). */
export interface PendingPairingAccessEdit {
  displayName?: string;
  requestedProfile?: NodePairingTrustProfile;
  requestedCapabilities?: RelayCapabilityBit[];
  requestedRoots?: string[];
}

/** #982: result of a node status poll. `credential`/`node` present only on the one-time claim. */
export interface PendingPairingPollResult {
  request: NodePairingRequestSummary;
  credential?: RelayNodeCredential;
  node?: HubNodeSummary;
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
// #982: a node-initiated pending pairing request lives for this long before it
// lapses to `expired` (cannot be approved). Matches the pair-token/device-code
// 10-minute window so the operator countdown and node wait agree.
export const DEFAULT_PENDING_PAIRING_TTL_MS = 10 * 60 * 1000;
// Hard upper bound on a request TTL. A non-finite, non-positive, or absurd ttl
// (NaN/Infinity/huge) is rejected to the default; anything above the max clamps
// down — so a bad/hostile value can never produce an Invalid Date or a
// never-expiring request.
export const MAX_PENDING_PAIRING_TTL_MS = 60 * 60 * 1000;
// #982: cap concurrent pending requests so the unauthenticated submit lane
// cannot grow the registry file unbounded. Expired/decided records do not count.
export const MAX_PENDING_PAIRING_REQUESTS = 256;
// #982: bound retained resolved (denied/expired/claimed) request records so the
// registry file does not grow without limit across many pair attempts. Recent
// resolved records are kept briefly for operator visibility, then pruned.
export const PENDING_PAIRING_RESOLVED_RETENTION_MS = 60 * 60 * 1000;
export const MAX_RETAINED_RESOLVED_PAIRINGS = 256;
export const DEFAULT_NODE_HEARTBEAT_TIMEOUTS = {
  staleMs: 45 * 1000,
  offlineMs: 90 * 1000,
} as const;
export const DEFAULT_HEARTBEAT_PERSIST_DEBOUNCE_MS = 5 * 1000;
// #981: start pruning the node-link proof replay cache only once it grows past
// this size. Pruning is also time-gated below so high-QPS heartbeat traffic does
// not full-scan the cache on every accepted proof once it crosses the threshold.
const NODE_LINK_PROOF_REPLAY_PRUNE_THRESHOLD = 1024;
const NODE_LINK_PROOF_REPLAY_PRUNE_INTERVAL_MS = 30 * 1000;
const PRIVILEGED_NODE_WARNING =
  "A paired Relay node runs with that machine's local OS-user blast radius; hub ACL policy grants individual capability bits.";

export type CredentialAuthResult =
  | {
      ok: true;
      node: HubNodeSummary;
      credentialId: string;
      rotationId?: string;
      /** #981: true when the matched credential is bound to a node public key. */
      keyBound?: boolean;
    }
  | { ok: false; error: RelayNodeError };

export interface CredentialAuthContext {
  source?: RelayNodeSourceTuple;
  strictSourceDeny?: boolean;
}

/**
 * #981: proof-of-possession context for `/hub/node-link` + heartbeat. The
 * bearer token still locates the credential; for key-bound credentials a
 * fresh, replay-protected `proof` of the node private key is additionally
 * required, bound to the connection `audience`.
 */
export interface NodeLinkProofContext extends CredentialAuthContext {
  proof?: string;
  audience: NodeLinkProofAudience;
  proofFreshnessMs?: number;
}

/**
 * #981: a validated-but-not-yet-committed credential. Produced by
 * `resolveCredentialForAuth` with NO allow side-effects so the key-bound lane
 * can gate the allow effects behind proof-of-possession.
 */
interface ResolvedCredential {
  ok: true;
  node: StoredNodeRecord;
  credentialId: string;
  matchesRotation: boolean;
  /** Token/rotation hash used to key the source-observation fingerprint. */
  fingerprintKey: string;
  keyBound: boolean;
  rotationId?: string;
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
  return { schemaVersion: 1, pairTokens: [], nodes: [], pendingPairings: [] };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

// #982: device-code alphabet excludes visually ambiguous characters (0/O, 1/I)
// so an operator can transcribe a code reliably across devices.
const DEVICE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomDeviceCode(): string {
  let body = '';
  for (let i = 0; i < 6; i += 1) {
    body += DEVICE_CODE_ALPHABET[crypto.randomInt(DEVICE_CODE_ALPHABET.length)];
  }
  return `${body.slice(0, 3)}-${body.slice(3)}`;
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
      // #982: default to [] for registry files written before pending pairings
      // existed. This array-default is the only migration mechanism (schema
      // stays version 1, mirroring the pairTokens/nodes pattern).
      pendingPairings: Array.isArray(parsed.pendingPairings)
        ? parsed.pendingPairings
        : [],
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
  const keyBound = Boolean(credential.publicKeyFingerprint);
  return {
    credentialId: credential.credentialId,
    issuedAt: credential.issuedAt,
    state,
    keyBound,
    ...(keyBound
      ? { publicKeyFingerprint: credential.publicKeyFingerprint }
      : {}),
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

/**
 * #982: resolve the allowed capability bit set for a pending pairing request —
 * the legacy default posture plus any node-requested extras, normalized and
 * de-duplicated. `node:pair-token:create` is never a node ACL bit, so it is
 * dropped if requested.
 */
function resolvePendingPairingCapabilityBits(
  requestedCapabilities: RelayCapabilityBit[] | undefined
): RelayCapabilityBit[] {
  const merged = normalizeCapabilityBits([
    ...LEGACY_DEFAULT_ALLOWED_CAPABILITIES,
    ...normalizeCapabilityBits(requestedCapabilities),
  ]);
  return merged.filter((capability) => capability !== 'node:pair-token:create');
}

/**
 * #982: bound the requested roots so an operator's decision card stays a short
 * list of folder labels and never becomes a full path inventory. Trims, caps
 * length, de-duplicates, and limits the count.
 */
/**
 * #982: a request TTL must be a finite positive number; anything else (NaN,
 * Infinity, <=0, non-number) falls back to the default, and a too-large value
 * clamps to the hard maximum. Guarantees `now + ttl` is always a valid Date.
 */
function clampPendingPairingTtlMs(ttlMs: unknown): number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return DEFAULT_PENDING_PAIRING_TTL_MS;
  }
  return Math.min(ttlMs, MAX_PENDING_PAIRING_TTL_MS);
}

function sanitizeRequestedRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) return [];
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (typeof root !== 'string') continue;
    const trimmed = root.trim().slice(0, 256);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
    if (cleaned.length >= 16) break;
  }
  return cleaned;
}

function createNodeAclForPendingPairing(input: {
  record: StoredPendingPairingRequest;
  nodeId: string;
  credentialId: string;
  displayName: string;
  createdAt: string;
}): RelayNodeAcl {
  const base = createLegacyDefaultNodeAcl({
    nodeId: input.nodeId,
    credentialId: input.credentialId,
    displayName: input.displayName,
    trustTier: input.record.requestedTrustTier,
    createdAt: input.createdAt,
  });
  // The trust-tier overlay promotes any high-risk allowed bit to
  // requires-confirmation on the prod tier; dev/sandbox leave them silent-allow
  // once granted, exactly as documented in SECURITY_POLICY.md.
  return applyTrustTierOverlay({
    ...base,
    grants: {
      allowed: input.record.capabilityBits,
      requiresConfirmation: [],
    },
  });
}

/**
 * #982: a request is "active/claimable" while a node could still turn it into a
 * credential — `pending`, or `approved` but not yet claimed. The device code of
 * an active request is never reused, and a code lookup prefers the active match,
 * so an approved-but-unclaimed request is never silently displaced.
 */
function isActiveClaimablePairing(record: StoredPendingPairingRequest): boolean {
  return (
    record.state === 'pending' ||
    (record.state === 'approved' && !record.credentialDeliveredAt)
  );
}

/**
 * #982: redaction-safe public summary of a pending pairing request. Emits only
 * safe correlation handles and product-language posture — never the raw
 * hostname, the status token, raw capability bits, or any secret material.
 */
function publicPendingPairing(
  record: StoredPendingPairingRequest
): NodePairingRequestSummary {
  // No hostname-derived hint: even a suffix of a hostname/MagicDNS name leaks
  // the tailnet domain (`…ts.net`). Recognition is the editable displayName plus
  // the already-lossy source `displayHint`/`sourceFingerprint`; the raw hostname
  // is internal-only (stored like StoredNodeRecord.hostname, never surfaced).
  const sourceDiagnostics = publicSourceDiagnostics(
    record.sourceBinding?.diagnostics
  );
  return {
    requestId: record.requestId,
    correlationId: record.correlationId,
    deviceCode: record.deviceCode,
    state: record.state,
    reasonCode: record.reasonCode,
    displayName: record.displayName,
    platform: record.platform,
    relayVersion: record.relayVersion,
    requestedProfile: record.requestedProfile,
    requestedTrustTier: record.requestedTrustTier,
    requestedCapabilities: nodePairingCapabilityPosture(record.capabilityBits),
    requestedRoots: record.requestedRoots,
    requiresExactOperationApproval: record.requiresExactOperationApproval,
    ...(record.publicKeyFingerprint
      ? { publicKeyFingerprint: record.publicKeyFingerprint }
      : {}),
    ...(sourceDiagnostics ? { sourceDiagnostics } : {}),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
    ...(record.nodeId ? { nodeId: record.nodeId } : {}),
    ...(record.credentialId ? { credentialId: record.credentialId } : {}),
  };
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
  /**
   * #981: single-use jti replay guard for node-link proofs. Key is
   * `${credentialId}:${jti}`, value is the proof expiry (ms). Bounded by the
   * proof freshness window; entries are pruned lazily on each verify. Process
   * local — the proof freshness window is short enough that a hub restart does
   * not meaningfully widen the replay surface.
   */
  private readonly nodeLinkProofReplay = new Map<string, number>();
  private nextNodeLinkProofReplayPruneAtMs = 0;

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
    // #981: bind the node public key to this credential when the node supplied
    // usable public material. A malformed key fails closed to a bearer-only
    // (legacy) credential rather than throwing — the boundary is "key-bound
    // credentials REQUIRE proof", not "pairing without a key is forbidden".
    const boundFingerprint = safeNodePublicKeyFingerprint(input.publicKey);
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
        ...(boundFingerprint && input.publicKey
          ? {
              publicKey: input.publicKey,
              publicKeyFingerprint: boundFingerprint,
              publicKeyAlgorithm: 'ed25519',
            }
          : {}),
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
      reasonCode: boundFingerprint
        ? 'NODE_PAIR_ALLOWED_KEY_BOUND'
        : 'NODE_PAIR_ALLOWED',
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
        ...(boundFingerprint ? { publicKeyFingerprint: boundFingerprint } : {}),
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
    const resolved = this.resolveCredentialForAuth(token, context);
    if (resolved.ok === false) return resolved.result;
    return this.commitCredentialAllow(resolved, context);
  }

  /**
   * #981: validate a presented bearer token WITHOUT any allow side-effects.
   * Performs only read-and-compare checks (parse, locate, match active/rotation
   * hash, expiry, revocation) and audits denials, but never records a source
   * observation, persists registry state, or emits an allow audit. This lets
   * the key-bound lane reject an unproven (stolen) bearer before any
   * allow-shaped effect happens; `commitCredentialAllow` runs those effects
   * only once the request has actually earned authentication.
   */
  private resolveCredentialForAuth(
    token: string,
    context: CredentialAuthContext
  ): ResolvedCredential | { ok: false; result: CredentialAuthResult } {
    const trimmedToken = token.trim();
    const parsed = this.parseCredentialToken(trimmedToken, context);
    if (parsed.ok === false) return { ok: false, result: parsed.result };
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
    const matchesRotation = Boolean(
      node &&
        rotation?.nextCredentialHash &&
        timingSafeEqualHex(rotation.nextCredentialHash, tokenHash)
    );
    if (!node || (!matchesActive && !matchesRotation)) {
      const code: RelayNodeErrorCode = !node
        ? 'REPAIR_REQUIRED'
        : node.credentialRotation?.state === 'stable'
          ? 'REPAIR_REQUIRED'
          : 'NODE_CREDENTIAL_MISMATCH';
      return {
        ok: false,
        result: this.credentialDenied(code, node, nodeId, context),
      };
    }
    if (activeCredential?.expiresAt) {
      const expiresAt = Date.parse(activeCredential.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= this.now().getTime()) {
        return {
          ok: false,
          result: this.credentialDenied(
            'NODE_CREDENTIAL_EXPIRED',
            node,
            nodeId,
            context
          ),
        };
      }
    }
    if (node.revokedAt) {
      return {
        ok: false,
        result: this.credentialDenied('NODE_REVOKED', node, nodeId, context),
      };
    }
    return {
      ok: true,
      node,
      credentialId: matchesRotation
        ? rotation!.nextCredentialId
        : node.credentialId,
      matchesRotation,
      fingerprintKey: matchesRotation
        ? rotation!.nextCredentialHash!
        : activeCredential!.tokenHash,
      keyBound: Boolean(
        matchesRotation
          ? rotation!.nextPublicKeyFingerprint
          : activeCredential!.publicKeyFingerprint
      ),
      ...(matchesRotation ? { rotationId: rotation!.rotationId } : {}),
    };
  }

  /**
   * #981: apply the allow-shaped side-effects (source observation, persist,
   * allow audit) for a resolved credential and return the success result.
   * A strict-deny source binding still denies here (it is a denial, not an
   * allow). Called by the bearer-only path immediately, and by the key-bound
   * path only AFTER proof-of-possession has been verified.
   */
  private commitCredentialAllow(
    resolved: ResolvedCredential,
    context: CredentialAuthContext
  ): CredentialAuthResult {
    const { node, credentialId, matchesRotation } = resolved;
    const sourceDiagnostics = this.recordSourceObservation(
      node,
      context,
      resolved.fingerprintKey,
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
      keyBound: resolved.keyBound,
      ...(resolved.rotationId ? { rotationId: resolved.rotationId } : {}),
    };
  }

  /**
   * #981: key-bound node-link authentication. The bearer `token` LOCATES and
   * validates the credential via `resolveCredentialForAuth`, which has NO allow
   * side-effects. For a key-bound credential the caller MUST additionally supply
   * a fresh, audience-bound proof of node private-key possession; bearer-alone
   * fails closed with `NODE_PROOF_REQUIRED`. Crucially, source observation,
   * registry persistence, and the allow audit (`commitCredentialAllow`) run ONLY
   * after proof verification, so a stolen bearer token cannot drive allow-shaped
   * effects without the node private key. Legacy bearer-only credentials (no
   * bound key) commit immediately, exactly as before.
   */
  authenticateNodeLinkWithProof(
    token: string,
    context: NodeLinkProofContext
  ): CredentialAuthResult {
    const resolved = this.resolveCredentialForAuth(token, context);
    if (resolved.ok === false) return resolved.result;
    if (!resolved.keyBound) {
      // Legacy/bearer-only credential: no key bound, so no proof is possible or
      // required. Commit the allow effects immediately, as before.
      return this.commitCredentialAllow(resolved, context);
    }
    const { node, credentialId } = resolved;
    const boundKey = this.boundKeyForCredential(node, credentialId);
    if (!boundKey) {
      // keyBound said true but the bound key is unreadable — fail closed.
      return this.proofDenied(
        node,
        credentialId,
        'NODE_PROOF_INVALID',
        'NODE_LINK_PROOF_BINDING_UNAVAILABLE'
      );
    }
    if (!context.proof) {
      return this.proofDenied(
        node,
        credentialId,
        'NODE_PROOF_REQUIRED',
        'NODE_LINK_PROOF_MISSING'
      );
    }
    const nowMs = this.now().getTime();
    const freshnessMs =
      context.proofFreshnessMs ?? DEFAULT_NODE_LINK_PROOF_FRESHNESS_MS;
    const verified = verifyNodeLinkProof({
      proof: context.proof,
      publicKeyPem: boundKey.publicKey,
      expected: {
        nodeId: node.nodeId,
        credentialId,
        audience: context.audience,
        publicKeyFingerprint: boundKey.publicKeyFingerprint,
      },
      nowMs,
      freshnessMs,
    });
    if (verified.ok === false) {
      return this.proofDenied(
        node,
        credentialId,
        'NODE_PROOF_INVALID',
        verified.reason
      );
    }
    // Single-use replay guard, scoped to the matched credential.
    const replayKey = `${credentialId}:${verified.jti}`;
    this.pruneNodeLinkProofReplay(nowMs);
    if (this.nodeLinkProofReplay.has(replayKey)) {
      return this.proofDenied(
        node,
        credentialId,
        'NODE_PROOF_INVALID',
        'NODE_LINK_PROOF_REPLAYED'
      );
    }
    // `+ 1` so the replay entry strictly outlives the inclusive ±freshness
    // acceptance window (verifyNodeLinkProof accepts at exactly issuedAt+window,
    // and prune drops entries at `expiresAt <= now`): the replay record must
    // still be present for that final accepted millisecond.
    this.nodeLinkProofReplay.set(
      replayKey,
      verified.issuedAtMs + freshnessMs + 1
    );
    // Proof passed: NOW apply the allow-shaped effects (source/persist/audit).
    const allow = this.commitCredentialAllow(resolved, context);
    if (allow.ok) {
      this.auditNodeCredentialLifecycle({
        node,
        credentialId,
        decision: 'allow',
        eventType: 'grant',
        reasonCode: 'NODE_LINK_PROOF_VERIFIED',
      });
    }
    return allow;
  }

  private boundKeyForCredential(
    node: StoredNodeRecord,
    credentialId: string
  ): { publicKey: string; publicKeyFingerprint: string } | undefined {
    const rotation = node.credentialRotation;
    if (
      rotation &&
      rotation.nextCredentialId === credentialId &&
      rotation.nextPublicKey &&
      rotation.nextPublicKeyFingerprint
    ) {
      return {
        publicKey: rotation.nextPublicKey,
        publicKeyFingerprint: rotation.nextPublicKeyFingerprint,
      };
    }
    const active = ensureSeparatedCredential(node);
    if (
      active.credentialId === credentialId &&
      active.publicKey &&
      active.publicKeyFingerprint
    ) {
      return {
        publicKey: active.publicKey,
        publicKeyFingerprint: active.publicKeyFingerprint,
      };
    }
    return undefined;
  }

  private pruneNodeLinkProofReplay(nowMs: number): void {
    // Amortized: the per-accept cost is O(1) until the cache grows past the
    // threshold, then sweeps are rate-limited. Correctness does not depend on
    // pruning — a fresh proof carries a random jti, and stale proofs are already
    // rejected by the freshness gate before the replay check — so delaying a
    // sweep only affects bounded memory, never the guard.
    if (this.nodeLinkProofReplay.size <= NODE_LINK_PROOF_REPLAY_PRUNE_THRESHOLD) {
      return;
    }
    if (nowMs < this.nextNodeLinkProofReplayPruneAtMs) {
      return;
    }
    this.nextNodeLinkProofReplayPruneAtMs =
      nowMs + NODE_LINK_PROOF_REPLAY_PRUNE_INTERVAL_MS;
    for (const [key, expiresAt] of this.nodeLinkProofReplay) {
      if (expiresAt <= nowMs) this.nodeLinkProofReplay.delete(key);
    }
  }

  private proofDenied(
    node: StoredNodeRecord | undefined,
    credentialId: string,
    code: 'NODE_PROOF_REQUIRED' | 'NODE_PROOF_INVALID',
    reasonCode: string
  ): CredentialAuthResult {
    this.auditNodeCredentialLifecycle({
      ...(node ? { node } : {}),
      credentialId,
      decision: 'deny',
      eventType: 'denial',
      reasonCode,
    });
    return {
      ok: false,
      error: {
        code,
        message:
          code === 'NODE_PROOF_REQUIRED'
            ? 'node-link requires proof of private-key possession'
            : 'node-link proof of private-key possession was rejected',
        retryable: false,
        details: { reasonCode },
      },
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

  beginCredentialRotation(
    nodeId: string,
    options: { publicKey?: string } = {}
  ): CredentialRotationResult {
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
    // #981: rotation replaces credential material while preserving the stable
    // node identity. The key binding carries forward from the active credential
    // by default (secret-only rotation); an explicit, valid `publicKey` rebinds
    // to a new node key. A malformed override fails closed to carry-forward
    // rather than silently dropping the existing binding.
    const active = ensureSeparatedCredential(node);
    const overrideFingerprint = safeNodePublicKeyFingerprint(options.publicKey);
    const nextPublicKey =
      overrideFingerprint && options.publicKey
        ? options.publicKey
        : active.publicKey;
    const nextPublicKeyFingerprint =
      overrideFingerprint && options.publicKey
        ? overrideFingerprint
        : active.publicKeyFingerprint;
    node.credentialRotation = {
      rotationId: randomToken('rot'),
      previousCredentialId: node.credentialId,
      nextCredentialId: next.credentialId,
      nextCredentialHash: next.hash,
      ...(nextPublicKey && nextPublicKeyFingerprint
        ? {
            nextPublicKey,
            nextPublicKeyFingerprint,
            nextPublicKeyAlgorithm: 'ed25519',
          }
        : {}),
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
        ...(nextPublicKeyFingerprint
          ? { publicKeyFingerprint: nextPublicKeyFingerprint }
          : {}),
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
      // #981: preserve the key binding across rotation so the node keeps
      // proving possession with the same (or rebound) identity key.
      ...(rotation.nextPublicKey && rotation.nextPublicKeyFingerprint
        ? {
            publicKey: rotation.nextPublicKey,
            publicKeyFingerprint: rotation.nextPublicKeyFingerprint,
            publicKeyAlgorithm: rotation.nextPublicKeyAlgorithm ?? 'ed25519',
          }
        : {}),
    };
    delete rotation.nextCredentialHash;
    delete rotation.nextPublicKey;
    delete rotation.nextPublicKeyFingerprint;
    delete rotation.nextPublicKeyAlgorithm;
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

  // ===========================================================================
  // #982: pending node pairing request lifecycle.
  //
  // Node-initiated request -> operator approve/deny/edit -> node claims its
  // key-bound credential on an authenticated status poll. The device code only
  // LOCATES a request; only the node's one-time status token (hashed at rest)
  // authorizes the credential claim, and only `pending` is approvable so a
  // denied/expired request can never be replayed into an issued credential.
  // ===========================================================================

  submitPendingPairingRequest(
    input: PendingPairingRequestInput
  ): PendingPairingRequestResult {
    const protocolVersion =
      input.protocolVersion ?? RELAY_NODE_LINK_PROTOCOL_VERSION;
    assertCompatibleProtocol(protocolVersion);
    const now = this.now();
    this.expirePendingPairingNow(now.getTime());
    const pendingCount = this.state.pendingPairings.filter(
      (record) => record.state === 'pending'
    ).length;
    if (pendingCount >= MAX_PENDING_PAIRING_REQUESTS) {
      throw new HubNodeRegistryError(
        'NODE_BUSY',
        'too many pending pairing requests; retry after existing requests are resolved or expire',
        true,
        { reasonCode: 'PENDING_PAIRING_CAPACITY_EXHAUSTED' }
      );
    }
    const timestamp = now.toISOString();
    const ttlMs = clampPendingPairingTtlMs(input.ttlMs);
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const requestedProfile =
      input.requestedProfile ?? DEFAULT_NODE_PAIRING_TRUST_PROFILE;
    const requestedTrustTier = nodePairingProfileTrustTier(requestedProfile);
    const capabilityBits = resolvePendingPairingCapabilityBits(
      input.requestedCapabilities
    );
    const requestId = randomToken('ppreq');
    const statusToken = randomToken('pstat');
    const statusTokenHash = sha256(statusToken);
    // #981: bind only valid public material. A malformed key fails closed to a
    // bearer-only request rather than throwing — the boundary is "key-bound
    // credentials REQUIRE proof", not "pairing without a key is forbidden".
    const submittedFingerprint = safeNodePublicKeyFingerprint(input.publicKey);
    const record: StoredPendingPairingRequest = {
      requestId,
      correlationId: input.correlationId ?? randomToken('ppcorr'),
      deviceCode: this.generateUniqueDeviceCode(),
      statusTokenHash,
      state: 'pending',
      reasonCode: NODE_PAIRING_REASON_CODES.requested,
      ...(submittedFingerprint && input.publicKey
        ? {
            publicKey: input.publicKey,
            publicKeyFingerprint: submittedFingerprint,
          }
        : {}),
      displayName: nodeDisplayName(input.displayName, input.manifest),
      hostname: input.manifest.hostname,
      ...(input.manifest.homeDir ? { homeDir: input.manifest.homeDir } : {}),
      platform: input.manifest.platform,
      arch: input.manifest.arch,
      // A validator-passing manifest may carry only the canonical helperVersion
      // (isNodeManifest accepts either field); mirror the helperVersion fallback
      // so the stored record's relayVersion is never undefined.
      relayVersion: input.manifest.relayVersion ?? input.manifest.helperVersion,
      helperVersion:
        input.manifest.helperVersion ?? input.manifest.relayVersion,
      protocolVersion,
      capabilities: summarizeCapabilities(input.manifest),
      ...(input.manifest.fileRpc
        ? { fileRpcAvailable: input.manifest.fileRpc.available }
        : {}),
      degradedReasons: input.manifest.degradedReasons ?? [],
      requestedProfile,
      requestedTrustTier,
      capabilityBits,
      requestedRoots: sanitizeRequestedRoots(input.requestedRoots),
      requiresExactOperationApproval: isHighRiskNodePairingRequest({
        profile: requestedProfile,
        requestedCapabilities: capabilityBits,
      }),
      createdAt: timestamp,
      expiresAt,
    };
    const sourceBinding = this.pendingPairingSourceBinding(
      input.source,
      input.manifest.hostname,
      statusTokenHash,
      timestamp
    );
    if (sourceBinding) record.sourceBinding = sourceBinding;
    this.state.pendingPairings.push(record);
    this.persist();
    this.auditPendingPairingLifecycle({
      record,
      eventType: 'bridge_event',
      decision: 'recorded',
      reasonCode: NODE_PAIRING_REASON_CODES.requested,
      action: 'nodes.pair.request',
      grantedBits: capabilityBits,
    });
    return { request: publicPendingPairing(record), statusToken };
  }

  listPendingPairingRequests(
    options: { state?: NodePairingRequestState; includeResolved?: boolean } = {}
  ): NodePairingRequestSummary[] {
    this.expirePendingPairingNow(this.now().getTime());
    return this.state.pendingPairings
      .filter((record) => {
        if (options.state) return record.state === options.state;
        if (options.includeResolved) return true;
        return record.state === 'pending' || record.state === 'approved';
      })
      .map((record) => publicPendingPairing(record));
  }

  getPendingPairingRequest(
    requestId: string
  ): NodePairingRequestSummary | null {
    this.expirePendingPairingNow(this.now().getTime());
    const record = this.state.pendingPairings.find(
      (candidate) => candidate.requestId === requestId
    );
    return record ? publicPendingPairing(record) : null;
  }

  findPendingPairingRequestByDeviceCode(
    deviceCode: string
  ): NodePairingRequestSummary | null {
    this.expirePendingPairingNow(this.now().getTime());
    const normalized = normalizeNodePairingDeviceCode(deviceCode);
    if (!normalized) return null;
    // The active (still-claimable) match wins — there is at most one, since
    // device codes are never reused while a request is active. Only after every
    // matching request is terminal does the most-recent historical record show.
    const matches = this.state.pendingPairings.filter(
      (record) =>
        normalizeNodePairingDeviceCode(record.deviceCode) === normalized
    );
    const active = matches.find((record) => isActiveClaimablePairing(record));
    const record = active ?? matches[matches.length - 1];
    return record ? publicPendingPairing(record) : null;
  }

  /**
   * #982: the capability bit set approval WOULD grant given an optional edit —
   * raw bits, for binding the high-risk exact-operation confirmation challenge.
   * Read-only and intentionally NOT part of the redaction-safe summary (raw bits
   * never cross a public surface); the router uses it only to bind the
   * confirmation token to the exact capabilities being authorized. Returns null
   * for an unknown request.
   */
  pendingPairingEffectiveCapabilityBits(
    requestId: string,
    edit?: PendingPairingAccessEdit
  ): RelayCapabilityBit[] | null {
    const record = this.state.pendingPairings.find(
      (candidate) => candidate.requestId === requestId
    );
    if (!record) return null;
    if (edit?.requestedCapabilities) {
      return resolvePendingPairingCapabilityBits(edit.requestedCapabilities);
    }
    return [...record.capabilityBits];
  }

  /**
   * #982: the approved repo roots approval WOULD grant given an optional edit.
   * Used (as a hash) to bind the exact-operation confirmation token to the roots
   * set, so a token minted for one roots set cannot authorize a widened edit.
   * Returns null for an unknown request.
   */
  pendingPairingEffectiveRoots(
    requestId: string,
    edit?: PendingPairingAccessEdit
  ): string[] | null {
    const record = this.state.pendingPairings.find(
      (candidate) => candidate.requestId === requestId
    );
    if (!record) return null;
    if (edit?.requestedRoots) {
      return sanitizeRequestedRoots(edit.requestedRoots);
    }
    return [...record.requestedRoots];
  }

  editPendingPairingAccess(
    requestId: string,
    edit: PendingPairingAccessEdit
  ): NodePairingRequestSummary {
    const record = this.requirePendingPairingRecord(requestId);
    this.assertPendingState(record, 'edit access for');
    this.applyPendingPairingAccessEdit(record, edit);
    record.reasonCode = NODE_PAIRING_REASON_CODES.edited;
    this.persist();
    this.auditPendingPairingLifecycle({
      record,
      eventType: 'bridge_event',
      decision: 'recorded',
      reasonCode: NODE_PAIRING_REASON_CODES.edited,
      action: 'nodes.pair.edit-access',
      grantedBits: record.capabilityBits,
    });
    return publicPendingPairing(record);
  }

  approvePendingPairingRequest(
    requestId: string,
    options: { edit?: PendingPairingAccessEdit } = {}
  ): NodePairingRequestSummary {
    const record = this.requirePendingPairingRecord(requestId);
    this.assertPendingState(record, 'approve');
    if (options.edit) this.applyPendingPairingAccessEdit(record, options.edit);
    record.state = 'approved';
    record.reasonCode = NODE_PAIRING_REASON_CODES.approved;
    record.decidedAt = this.now().toISOString();
    this.persist();
    this.auditPendingPairingLifecycle({
      record,
      eventType: 'approval',
      decision: 'approved',
      reasonCode: NODE_PAIRING_REASON_CODES.approved,
      action: 'nodes.pair.approve',
      grantedBits: record.capabilityBits,
    });
    return publicPendingPairing(record);
  }

  denyPendingPairingRequest(
    requestId: string,
    options: { reason?: string } = {}
  ): NodePairingRequestSummary {
    const record = this.requirePendingPairingRecord(requestId);
    this.assertPendingState(record, 'deny');
    record.state = 'denied';
    record.reasonCode = NODE_PAIRING_REASON_CODES.denied;
    record.decidedAt = this.now().toISOString();
    // The denial reason is operator free text; scrub secret-shaped material
    // (pair/node/Bearer/secret_ tokens) and cap length before storing so it can
    // never leak through the stored record, audit, or any future surface.
    if (options.reason) {
      record.decisionReason = redactBootstrapSecrets(options.reason).slice(
        0,
        256
      );
    }
    this.persist();
    this.auditPendingPairingLifecycle({
      record,
      eventType: 'denial',
      decision: 'deny',
      reasonCode: NODE_PAIRING_REASON_CODES.denied,
      action: 'nodes.pair.deny',
    });
    return publicPendingPairing(record);
  }

  /**
   * Node-facing status poll + one-time credential claim. The status token
   * authenticates the waiting node. A `pending`/`denied`/`expired` request
   * returns status only. Only an `approved`, not-yet-claimed request mints the
   * key-bound credential, creates the node record, and returns the raw
   * credential exactly once — it is never stored raw, returned to the operator,
   * or placed in any list/audit.
   */
  pollPendingPairingRequest(
    requestId: string,
    statusToken: string,
    context: CredentialAuthContext = {}
  ): PendingPairingPollResult {
    this.expirePendingPairingNow(this.now().getTime());
    const record = this.requirePendingPairingRecord(requestId);
    const presentedHash = sha256(statusToken.trim());
    if (!timingSafeEqualHex(presentedHash, record.statusTokenHash)) {
      throw new HubNodeRegistryError(
        'UNAUTHORIZED',
        'pending pairing status token is invalid',
        false,
        { reasonCode: 'PENDING_PAIRING_STATUS_TOKEN_INVALID' }
      );
    }
    if (record.state !== 'approved' || record.credentialDeliveredAt) {
      return { request: publicPendingPairing(record) };
    }
    const now = this.now();
    const { node, credential, boundFingerprint } =
      this.buildPairedNodeFromPendingPairing(record, now, context);
    this.state.nodes.push(node);
    record.nodeId = node.nodeId;
    record.credentialId = credential.credentialId;
    record.credentialDeliveredAt = now.toISOString();
    record.reasonCode = NODE_PAIRING_REASON_CODES.credentialIssued;
    this.persist();
    this.auditPendingPairingLifecycle({
      record,
      eventType: 'grant',
      decision: 'allow',
      reasonCode: NODE_PAIRING_REASON_CODES.credentialIssued,
      action: 'nodes.pair.issue-credential',
      grantedBits: node.acl?.grants.allowed ?? [],
    });
    this.notifyNodeStatusIfChanged(node, 'online');
    return {
      request: publicPendingPairing(record),
      credential: {
        protocol: RELAY_NODE_LINK_PROTOCOL,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        nodeId: node.nodeId,
        credentialId: credential.credentialId,
        token: credential.token,
        issuedAt: record.credentialDeliveredAt,
        ...(boundFingerprint ? { publicKeyFingerprint: boundFingerprint } : {}),
      },
      node: publicNode(node, 'online', this.hubVersion),
    };
  }

  private requirePendingPairingRecord(
    requestId: string
  ): StoredPendingPairingRequest {
    this.expirePendingPairingNow(this.now().getTime());
    const record = this.state.pendingPairings.find(
      (candidate) => candidate.requestId === requestId
    );
    if (!record) {
      throw new HubNodeRegistryError(
        'NOT_FOUND',
        'pending pairing request was not found',
        false,
        { reasonCode: 'PENDING_PAIRING_NOT_FOUND' }
      );
    }
    return record;
  }

  private assertPendingState(
    record: StoredPendingPairingRequest,
    verb: string
  ): void {
    if (record.state === 'pending') return;
    // A denied/expired/already-approved request can never be replayed into a new
    // approval or edit. `expired` maps to TOKEN_EXPIRED so callers can present
    // the "request expired, re-run pair" path.
    if (record.state === 'expired') {
      throw new HubNodeRegistryError(
        'TOKEN_EXPIRED',
        `cannot ${verb} an expired pairing request`,
        false,
        { reasonCode: NODE_PAIRING_REASON_CODES.expired, state: record.state }
      );
    }
    throw new HubNodeRegistryError(
      'INVALID_REQUEST',
      `cannot ${verb} a ${record.state} pairing request`,
      false,
      {
        reasonCode: NODE_PAIRING_REASON_CODES.replayDenied,
        state: record.state,
      }
    );
  }

  private applyPendingPairingAccessEdit(
    record: StoredPendingPairingRequest,
    edit: PendingPairingAccessEdit
  ): void {
    if (typeof edit.displayName === 'string' && edit.displayName.trim()) {
      record.displayName = edit.displayName.trim();
    }
    if (edit.requestedProfile) {
      record.requestedProfile = edit.requestedProfile;
      record.requestedTrustTier = nodePairingProfileTrustTier(
        edit.requestedProfile
      );
    }
    if (edit.requestedCapabilities) {
      record.capabilityBits = resolvePendingPairingCapabilityBits(
        edit.requestedCapabilities
      );
    }
    if (edit.requestedRoots) {
      record.requestedRoots = sanitizeRequestedRoots(edit.requestedRoots);
    }
    record.requiresExactOperationApproval = isHighRiskNodePairingRequest({
      profile: record.requestedProfile,
      requestedCapabilities: record.capabilityBits,
    });
  }

  private buildPairedNodeFromPendingPairing(
    record: StoredPendingPairingRequest,
    now: Date,
    context: CredentialAuthContext
  ): {
    node: StoredNodeRecord;
    credential: ReturnType<typeof credentialToken>;
    boundFingerprint?: string;
  } {
    const timestamp = now.toISOString();
    const nodeId = randomToken('node');
    const credential = credentialToken(nodeId);
    const boundFingerprint = safeNodePublicKeyFingerprint(record.publicKey);
    const acl = createNodeAclForPendingPairing({
      record,
      nodeId,
      credentialId: credential.credentialId,
      displayName: record.displayName,
      createdAt: timestamp,
    });
    const sourceBinding = this.pairedSourceBindingForClaim(
      context.source,
      record.hostname,
      credential.hash,
      timestamp
    );
    const node: StoredNodeRecord = {
      nodeId,
      identity: {
        nodeId,
        displayName: record.displayName,
        hostname: record.hostname,
        createdAt: timestamp,
        pairedAt: timestamp,
      },
      activeCredential: {
        credentialId: credential.credentialId,
        tokenHash: credential.hash,
        issuedAt: timestamp,
        ...(boundFingerprint && record.publicKey
          ? {
              publicKey: record.publicKey,
              publicKeyFingerprint: boundFingerprint,
              publicKeyAlgorithm: 'ed25519',
            }
          : {}),
      },
      credentialId: credential.credentialId,
      credentialHash: credential.hash,
      credentialIssuedAt: timestamp,
      displayName: record.displayName,
      hostname: record.hostname,
      ...(record.homeDir ? { homeDir: record.homeDir } : {}),
      platform: record.platform,
      arch: record.arch,
      relayVersion: record.relayVersion,
      ...(record.helperVersion ? { helperVersion: record.helperVersion } : {}),
      protocolVersion: record.protocolVersion,
      capabilities: record.capabilities,
      ...(record.fileRpcAvailable !== undefined
        ? { fileRpcAvailable: record.fileRpcAvailable }
        : {}),
      degradedReasons: record.degradedReasons ?? [],
      acl,
      ...(sourceBinding ? { sourceBinding } : {}),
      createdAt: timestamp,
      pairedAt: timestamp,
      lastSeenAt: timestamp,
    };
    return {
      node,
      credential,
      ...(boundFingerprint ? { boundFingerprint } : {}),
    };
  }

  private pendingPairingSourceBinding(
    source: RelayNodeSourceTuple | undefined,
    hostname: string,
    fingerprintKey: string,
    now: string
  ): StoredNodeSourceBinding | undefined {
    const observed = sourceTupleWithHostname(source, hostname);
    if (!observed) return undefined;
    const observedFingerprint = sourceFingerprint(observed, fingerprintKey);
    const hasSignal = hasTailscaleSourceSignal(observed);
    return {
      diagnostics: {
        state: hasSignal ? 'source-match' : 'signal-unavailable',
        policy: 'audit',
        reasonCode: hasSignal
          ? 'PENDING_PAIRING_SOURCE_RECORDED'
          : 'PENDING_PAIRING_SOURCE_SIGNAL_UNAVAILABLE',
        observedAt: now,
        ...(observedFingerprint ? { sourceFingerprint: observedFingerprint } : {}),
        displayHint: sourceDisplayHint(observed, observedFingerprint),
      },
    };
  }

  private pairedSourceBindingForClaim(
    source: RelayNodeSourceTuple | undefined,
    hostname: string,
    fingerprintKey: string,
    now: string
  ): StoredNodeSourceBinding | undefined {
    const observed = sourceTupleWithHostname(source, hostname);
    if (!observed) return undefined;
    const observedFingerprint = sourceFingerprint(observed, fingerprintKey);
    const hasSignal = hasTailscaleSourceSignal(observed);
    return {
      expected: observed,
      lastObserved: observed,
      observedFingerprints: observedFingerprint ? [observedFingerprint] : [],
      diagnostics: {
        state: hasSignal ? 'source-match' : 'signal-unavailable',
        policy: 'audit',
        reasonCode: hasSignal
          ? 'NODE_SOURCE_MATCH'
          : 'NODE_SOURCE_SIGNAL_UNAVAILABLE',
        observedAt: now,
        ...(observedFingerprint ? { sourceFingerprint: observedFingerprint } : {}),
        displayHint: sourceDisplayHint(observed, observedFingerprint),
      },
    };
  }

  private generateUniqueDeviceCode(): string {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const code = randomDeviceCode();
      const normalized = normalizeNodePairingDeviceCode(code);
      // Never collide with a still-claimable request (pending OR approved but
      // unclaimed) so an active request's code — and therefore who can locate
      // and claim it — is never silently reused.
      const collision = this.state.pendingPairings.some(
        (record) =>
          isActiveClaimablePairing(record) &&
          normalizeNodePairingDeviceCode(record.deviceCode) === normalized
      );
      if (!collision) return code;
    }
    throw new HubNodeRegistryError(
      'INTERNAL',
      'could not allocate a unique pairing device code'
    );
  }

  private expirePendingPairingNow(nowMs: number): boolean {
    let changed = false;
    for (const record of this.state.pendingPairings) {
      if (record.state !== 'pending') continue;
      if (Date.parse(record.expiresAt) > nowMs) continue;
      record.state = 'expired';
      record.reasonCode = NODE_PAIRING_REASON_CODES.expired;
      record.decidedAt = new Date(nowMs).toISOString();
      changed = true;
      this.auditPendingPairingLifecycle({
        record,
        eventType: 'expiry',
        decision: 'expired',
        reasonCode: NODE_PAIRING_REASON_CODES.expired,
        action: 'nodes.pair.expire',
      });
    }
    if (this.prunePendingPairings(nowMs)) changed = true;
    if (changed) this.persist();
    return changed;
  }

  /**
   * Bound retained resolved records (denied/expired, or approved + already
   * claimed) so the registry file does not grow without limit across many pair
   * attempts. Pending and approved-but-unclaimed records are never pruned. Drops
   * records past the retention window, then caps the most-recent retained set.
   * Returns true if anything was removed.
   */
  private prunePendingPairings(nowMs: number): boolean {
    const isResolved = (record: StoredPendingPairingRequest): boolean =>
      record.state === 'denied' ||
      record.state === 'expired' ||
      (record.state === 'approved' && Boolean(record.credentialDeliveredAt));
    const decisionMs = (record: StoredPendingPairingRequest): number =>
      Date.parse(record.decidedAt ?? record.createdAt);
    const before = this.state.pendingPairings.length;
    let kept = this.state.pendingPairings.filter(
      (record) =>
        !(
          isResolved(record) &&
          decisionMs(record) + PENDING_PAIRING_RESOLVED_RETENTION_MS <= nowMs
        )
    );
    const resolved = kept
      .filter(isResolved)
      .sort((a, b) => decisionMs(a) - decisionMs(b));
    if (resolved.length > MAX_RETAINED_RESOLVED_PAIRINGS) {
      const drop = new Set(
        resolved
          .slice(0, resolved.length - MAX_RETAINED_RESOLVED_PAIRINGS)
          .map((record) => record.requestId)
      );
      kept = kept.filter((record) => !drop.has(record.requestId));
    }
    if (kept.length === before) return false;
    this.state.pendingPairings = kept;
    return true;
  }

  private auditPendingPairingLifecycle(input: {
    record: StoredPendingPairingRequest;
    decision: SecurityAuditDecision;
    eventType: SecurityAuditEventType;
    reasonCode: string;
    action: string;
    grantedBits?: RelayCapabilityBit[];
  }): void {
    if (!this.auditSink) return;
    const record = input.record;
    try {
      this.auditSink.append({
        eventType: input.eventType,
        decision: input.decision,
        reasonCode: input.reasonCode,
        peer: {
          kind: 'node',
          ...(record.nodeId ? { nodeId: record.nodeId } : {}),
          // requestId/credentialId are safe correlation handles, never secrets.
          credentialId: record.credentialId ?? record.requestId,
        },
        node: { ...(record.nodeId ? { nodeId: record.nodeId } : {}) },
        intent: { action: input.action, target: record.requestId },
        material: {
          params: {
            requestId: record.requestId,
            state: record.state,
            requestedProfile: record.requestedProfile,
            requestedTrustTier: record.requestedTrustTier,
            requiresExactOperationApproval:
              record.requiresExactOperationApproval,
            rootCount: record.requestedRoots.length,
            capabilityBitCount: record.capabilityBits.length,
            publicKeyFingerprint: record.publicKeyFingerprint ?? null,
            sourceState: record.sourceBinding?.diagnostics?.state ?? null,
            ...(record.decisionReason
              ? { decisionReason: record.decisionReason }
              : {}),
          },
        },
        grantedBits: input.grantedBits ?? [],
        refs: { policyVersion: RELAY_SECURITY_POLICY_VERSION },
        ...(record.sourceBinding?.diagnostics
          ? { sourceDiagnostics: record.sourceBinding.diagnostics }
          : {}),
        correlationId: record.correlationId,
      });
    } catch {
      // Best-effort lifecycle visibility only. Never log/retry raw status
      // tokens or credential material if the audit sink fails.
    }
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
