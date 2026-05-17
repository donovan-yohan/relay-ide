import type { HubNodeSummary } from '../../../../shared/relay-node-protocol.js';
import {
  HIGH_RISK_CAPABILITIES,
  RELAY_CAPABILITY_BITS,
  type RelayCapabilityBit,
  type RelayPolicyScope,
  type RelayTrustTier,
} from '../../../../shared/security-policy.js';
import type { ConfirmationChallenge } from '../api.js';

export type SecurityPostureTone = 'safe' | 'warning' | 'danger' | 'muted';

export interface NodeSecurityVisibility {
  trustTier: RelayTrustTier | 'unknown';
  policyRef: string | null;
  scopeLabel: string;
  allowedBits: RelayCapabilityBit[];
  challengeBits: RelayCapabilityBit[];
  denyBits: RelayCapabilityBit[];
  postureLabel: string;
  highRiskLabel: string;
  tone: SecurityPostureTone;
  auditLabel: string;
}

export interface ConfirmationSecurityVisibility {
  nodeLabel: string;
  trustTier: RelayTrustTier | 'unknown';
  policyRef: string | null;
  postureLabel: string;
  allowedBits: string[];
  challengeBits: string[];
  deniedBits: string[];
  unknownBits: string[];
  tone: SecurityPostureTone;
}

const HIGH_RISK_SET = new Set<string>(HIGH_RISK_CAPABILITIES);

function unique<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function sortedKnownBits(values: readonly string[] | undefined): RelayCapabilityBit[] {
  if (!values) return [];
  const selected = new Set(values);
  return RELAY_CAPABILITY_BITS.filter((bit) => selected.has(bit));
}

function trustTierForNode(node: HubNodeSummary): RelayTrustTier | 'unknown' {
  return node.trust?.tier ?? node.trust?.policy?.trustTier ?? 'unknown';
}

function policyLifecycleDenyLabel(policy: HubNodeSummary['trust']['policy']): string | null {
  if (!policy) return null;
  if (policy.revokedAt) return 'policy revoked';
  if (policy.supersededBy) return 'policy superseded';
  return null;
}

export function formatPolicyScope(scope: RelayPolicyScope | undefined): string {
  if (!scope) return 'scope unavailable';
  if (scope.kind === 'workspace') {
    const count = scope.workspaceIds?.length ?? 0;
    return count > 0 ? `workspace scope · ${count} workspace${count === 1 ? '' : 's'}` : 'workspace scope';
  }
  if (scope.kind === 'repo') {
    const count = scope.repoIds?.length ?? 0;
    return count > 0 ? `repo scope · ${count} repo${count === 1 ? '' : 's'}` : 'repo scope';
  }
  if (scope.kind === 'path') {
    const count = scope.pathPrefixes?.length ?? 0;
    return count > 0 ? `path scope · ${count} prefix${count === 1 ? '' : 'es'}` : 'path scope';
  }
  return 'node scope';
}

export function deriveNodeSecurityVisibility(node: HubNodeSummary): NodeSecurityVisibility {
  const trustTier = trustTierForNode(node);
  const policy = node.trust?.policy;
  if (!policy) {
    return {
      trustTier,
      policyRef: null,
      scopeLabel: 'policy unavailable',
      allowedBits: [],
      challengeBits: [],
      denyBits: [],
      postureLabel: 'policy unavailable · capability grants hidden',
      highRiskLabel: 'audit: cli only · relay-ide audit verify',
      tone: trustTier === 'prod' ? 'danger' : 'muted',
      auditLabel: 'audit visibility: run relay-ide audit verify --db ~/.config/relay-ide/security-audit.db',
    };
  }

  const allowedBits = sortedKnownBits(policy.allowed);
  const challengeBits = sortedKnownBits(policy.requiresConfirmation);
  const lifecycleDenyLabel = policyLifecycleDenyLabel(policy);
  if (lifecycleDenyLabel) {
    return {
      trustTier,
      policyRef: policy.ref,
      scopeLabel: formatPolicyScope(policy.scope),
      allowedBits: [],
      challengeBits: [],
      denyBits: [...RELAY_CAPABILITY_BITS],
      postureLabel: `${lifecycleDenyLabel} · deny ${RELAY_CAPABILITY_BITS.length}`,
      highRiskLabel: `${lifecycleDenyLabel}: backend denies all capabilities`,
      tone: 'danger',
      auditLabel: 'audit visibility: cli only · relay-ide audit verify',
    };
  }
  const handled = new Set<string>([...allowedBits, ...challengeBits]);
  const denyBits = RELAY_CAPABILITY_BITS.filter((bit) => !handled.has(bit));
  const highRiskAllowed = allowedBits.filter((bit) => HIGH_RISK_SET.has(bit));
  const highRiskChallenged = challengeBits.filter((bit) => HIGH_RISK_SET.has(bit));
  const highRiskDenied = HIGH_RISK_CAPABILITIES.filter((bit) => denyBits.includes(bit));

  let tone: SecurityPostureTone = 'safe';
  let highRiskLabel = `${highRiskDenied.length}/${HIGH_RISK_CAPABILITIES.length} high-risk denied`;
  if (trustTier === 'prod' && highRiskChallenged.length > 0) {
    tone = 'danger';
    highRiskLabel = `prod high-risk: ${highRiskChallenged.length} require challenge`;
  } else if (highRiskAllowed.length > 0) {
    tone = 'warning';
    highRiskLabel = `${highRiskAllowed.length} high-risk silently allowed`;
  } else if (challengeBits.length > 0) {
    tone = 'warning';
  }

  return {
    trustTier,
    policyRef: policy.ref,
    scopeLabel: formatPolicyScope(policy.scope),
    allowedBits,
    challengeBits,
    denyBits,
    postureLabel: `allow ${allowedBits.length} · challenge ${challengeBits.length} · deny ${denyBits.length}`,
    highRiskLabel,
    tone,
    auditLabel: 'audit visibility: cli only · relay-ide audit verify',
  };
}

export function deriveConfirmationSecurityVisibility(
  challenge: ConfirmationChallenge,
  node?: HubNodeSummary
): ConfirmationSecurityVisibility {
  const policy = node?.trust?.policy;
  const trustTier = node ? trustTierForNode(node) : 'unknown';
  const challengeBits = unique([...challenge.challengeBits]);
  const requiredBits = unique([...challenge.requiredBits]);
  const requiredNonChallengedBits = requiredBits.filter((bit) => !challengeBits.includes(bit));
  const lifecycleDenyLabel = policyLifecycleDenyLabel(policy);
  if (lifecycleDenyLabel) {
    return {
      nodeLabel: node?.displayName ? `${node.displayName} (${challenge.nodeId})` : challenge.nodeId,
      trustTier,
      policyRef: policy?.ref ?? null,
      postureLabel: `${lifecycleDenyLabel} · deny ${requiredBits.length}`,
      allowedBits: [],
      challengeBits: [],
      deniedBits: requiredBits,
      unknownBits: [],
      tone: 'danger',
    };
  }
  const allowedByPolicy = new Set<string>(policy?.allowed ?? []);
  const challenged = new Set<string>(challengeBits);
  const allowedBits = requiredBits.filter((bit) => allowedByPolicy.has(bit) && !challenged.has(bit));
  const deniedBits = policy
    ? requiredBits.filter((bit) => !allowedByPolicy.has(bit) && !challenged.has(bit))
    : [];
  const unknownBits = policy ? [] : requiredNonChallengedBits;
  const postureLabel = !policy
    ? `policy unavailable · challenge ${challengeBits.length} · unknown ${unknownBits.length}`
    : challengeBits.length > 0
      ? `challenge required · allow ${allowedBits.length} · challenge ${challengeBits.length} · deny ${deniedBits.length}`
      : deniedBits.length > 0
        ? `denied by policy · allow ${allowedBits.length} · deny ${deniedBits.length}`
        : `allowed by policy · allow ${allowedBits.length}`;
  const highRiskChallenge = challengeBits.some((bit) => HIGH_RISK_SET.has(bit));
  const highRiskUnknown = unknownBits.some((bit) => HIGH_RISK_SET.has(bit));
  const tone: SecurityPostureTone = !policy
    ? highRiskChallenge || highRiskUnknown
      ? 'danger'
      : 'warning'
    : trustTier === 'prod' || highRiskChallenge
      ? 'danger'
      : challengeBits.length > 0
        ? 'warning'
        : 'safe';

  return {
    nodeLabel: node?.displayName ? `${node.displayName} (${challenge.nodeId})` : challenge.nodeId,
    trustTier,
    policyRef: policy?.ref ?? null,
    postureLabel,
    allowedBits,
    challengeBits,
    deniedBits,
    unknownBits,
    tone,
  };
}
