/**
 * #982: shared wire contracts for the hub-side pending node pairing request
 * lifecycle. A node-initiated pairing request lives on the hub as a `pending`
 * record until an authenticated operator approves, denies, or it expires. The
 * device code only LOCATES a pending request in an operator surface; it never
 * authorizes the node. Approval authorizes a key-bound node credential that is
 * minted and delivered only to the waiting node on its authenticated status
 * claim, so raw credential material never appears in operator responses, lists,
 * or audit. See docs/ADD_NODE_PAIR_DEVICE_UX.md and docs/SECURITY_POLICY.md.
 *
 * Everything in this module is PUBLIC and redaction-safe, and is shaped so the
 * CLI, web UI, and Command Center can later project one `nodes.pair.*` command
 * family (final stable gateway ids land with #985/#986). These shapes must
 * NEVER carry raw pair tokens, node credential tokens or hashes, pairing status
 * tokens, browser cookies, raw forwarded headers, raw hostnames/MagicDNS/tailnet
 * IPs, env values, terminal bytes, full path inventories, or raw capability-bit
 * ACL internals in customer-facing copy.
 */
import type { RelayNodeSourceDiagnostics } from './relay-node-protocol.js';
import {
  HIGH_RISK_CAPABILITIES,
  LEGACY_DEFAULT_ALLOWED_CAPABILITIES,
  type RelayCapabilityBit,
  type RelayTrustTier,
} from './security-policy.js';

/**
 * Lifecycle states for a node-initiated pending pairing request. A request is
 * created `pending`; an operator moves it to `approved` or `denied`, or it
 * lapses to `expired`. `pending` is the only approvable state: `denied` and
 * `expired` are terminal and can never be replayed into `approved`.
 */
export type NodePairingRequestState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired';

/**
 * Product-language trust profile the node asks for at pairing time. Each maps
 * to an underlying `RelayTrustTier`. `infra-prod-host` is the higher-risk
 * profile and routes approval through the exact-operation confirmation
 * contract; the customer-facing copy never surfaces raw capability bits.
 */
export type NodePairingTrustProfile =
  | 'dev-workstation'
  | 'sandbox-runner'
  | 'automation-runner'
  | 'infra-prod-host';

export const NODE_PAIRING_TRUST_PROFILES = [
  'dev-workstation',
  'sandbox-runner',
  'automation-runner',
  'infra-prod-host',
] as const satisfies readonly NodePairingTrustProfile[];

export const DEFAULT_NODE_PAIRING_TRUST_PROFILE: NodePairingTrustProfile =
  'dev-workstation';

export function isNodePairingTrustProfile(
  value: unknown
): value is NodePairingTrustProfile {
  return (
    typeof value === 'string' &&
    (NODE_PAIRING_TRUST_PROFILES as readonly string[]).includes(value)
  );
}

const PROFILE_TRUST_TIER: Record<NodePairingTrustProfile, RelayTrustTier> = {
  'dev-workstation': 'dev',
  'sandbox-runner': 'sandbox',
  'automation-runner': 'sandbox',
  'infra-prod-host': 'prod',
};

export function nodePairingProfileTrustTier(
  profile: NodePairingTrustProfile
): RelayTrustTier {
  return PROFILE_TRUST_TIER[profile];
}

// The high-risk bits that are NOT already in the legacy default posture. A
// dev/sandbox node is granted the baseline (which itself contains some
// high-risk bits like `session:control:kill`) under standard operator
// approval; only an ELEVATED request — beyond that baseline — escalates the
// pairing ceremony. This keeps a plain dev-workstation request out of the
// exact-operation contract while still gating writes/exec/escalation.
const ELEVATED_HIGH_RISK_CAPABILITY_SET = new Set<string>(
  HIGH_RISK_CAPABILITIES.filter(
    (bit) =>
      !(LEGACY_DEFAULT_ALLOWED_CAPABILITIES as readonly string[]).includes(bit)
  )
);

/**
 * A pairing request is higher-risk when it targets the prod profile OR requests
 * an elevated high-risk capability beyond the standard baseline. Higher-risk
 * requests must route through the existing exact-operation/high-risk approval
 * contract before a credential is authorized.
 */
export function isHighRiskNodePairingRequest(input: {
  profile: NodePairingTrustProfile;
  requestedCapabilities?: readonly string[];
}): boolean {
  if (nodePairingProfileTrustTier(input.profile) === 'prod') return true;
  return (input.requestedCapabilities ?? []).some((bit) =>
    ELEVATED_HIGH_RISK_CAPABILITY_SET.has(bit)
  );
}

/**
 * Product-language posture labels for a resolved capability bit set. Raw bits
 * are NEVER surfaced in customer copy; unmapped bits collapse to a generic
 * bucket so nothing leaks while the posture stays informative.
 */
const CAPABILITY_POSTURE_LABELS: Partial<Record<RelayCapabilityBit, string>> = {
  'session:read': 'view sessions',
  'session:create:terminal': 'launch terminal sessions',
  'session:create:agent': 'launch configured agent CLIs',
  'session:attach': 'attach/detach sessions',
  'session:control:kill': 'stop sessions',
  'session:control:rename': 'rename sessions',
  'tab:mode:set-agent': 'drive agent tabs',
  'tab:intervention:read': 'observe agent tabs',
  'tab:intervention:send-text': 'intervene on agent tabs',
  'tab:intervention:send-key': 'intervene on agent tabs',
  'tab:intervention:submit': 'intervene on agent tabs',
  'rpc:fs:list': 'browse approved repo roots',
  'rpc:fs:read': 'read approved repo roots',
  'rpc:fs:tail': 'read approved repo roots',
  'rpc:fs:write': 'write approved repo roots',
  'rpc:fs:delete': 'write approved repo roots',
  'rpc:git:read': 'run git',
  'rpc:git:write': 'run git',
  'pty:exec:arbitrary': 'run arbitrary commands',
  'preview:port-forward': 'forward preview ports',
  'logs:read': 'read node logs',
};

const GENERIC_CAPABILITY_LABEL = 'additional approved operations';

export function nodePairingCapabilityPosture(
  bits: readonly RelayCapabilityBit[]
): string[] {
  const labels = new Set<string>();
  for (const bit of bits) {
    labels.add(CAPABILITY_POSTURE_LABELS[bit] ?? GENERIC_CAPABILITY_LABEL);
  }
  return Array.from(labels).sort();
}

/**
 * Device code: a short, human-transcribable locator. Comparison is
 * case-insensitive and dash/whitespace tolerant — normalize before lookup.
 */
export function normalizeNodePairingDeviceCode(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export function isNodePairingDeviceCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    normalizeNodePairingDeviceCode(value).length >= 6
  );
}

/**
 * The public, redaction-safe summary of a pending pairing request. Both the
 * authenticated operator surface and the waiting node read this shape; it
 * carries only safe correlation handles and product-language posture.
 */
export interface NodePairingRequestSummary {
  requestId: string;
  correlationId: string;
  /** Locator only; carries no authority. */
  deviceCode: string;
  state: NodePairingRequestState;
  /** Audit-safe lifecycle status code, e.g. `PENDING_PAIRING_REQUESTED`. */
  reasonCode: string;
  displayName: string;
  platform: string;
  relayVersion: string;
  requestedProfile: NodePairingTrustProfile;
  requestedTrustTier: RelayTrustTier;
  /** Product-language posture, never raw capability bits. */
  requestedCapabilities: string[];
  /** Operator decision metadata (approved repo roots in product language). */
  requestedRoots: string[];
  /** True when approval must route through the exact-operation contract. */
  requiresExactOperationApproval: boolean;
  /** Stable `nkey_…` public-key fingerprint; absent for bearer-only requests. */
  publicKeyFingerprint?: string;
  /** Already-redacted source/provenance diagnostics. */
  sourceDiagnostics?: RelayNodeSourceDiagnostics;
  createdAt: string;
  expiresAt: string;
  /** Set when an operator approved or denied the request. */
  decidedAt?: string;
  /** Present only after approval (stable, safe identity handle). */
  nodeId?: string;
  /** Present only after the node has claimed its issued credential. */
  credentialId?: string;
}

/** Audit-safe lifecycle reason codes for the pending pairing request flow. */
export const NODE_PAIRING_REASON_CODES = {
  requested: 'PENDING_PAIRING_REQUESTED',
  approved: 'PENDING_PAIRING_APPROVED',
  denied: 'PENDING_PAIRING_DENIED',
  expired: 'PENDING_PAIRING_EXPIRED',
  edited: 'PENDING_PAIRING_ACCESS_EDITED',
  credentialIssued: 'PENDING_PAIRING_CREDENTIAL_ISSUED',
  exactOperationApprovalRequired:
    'PENDING_PAIRING_EXACT_OPERATION_APPROVAL_REQUIRED',
  replayDenied: 'PENDING_PAIRING_REPLAY_DENIED',
} as const;
