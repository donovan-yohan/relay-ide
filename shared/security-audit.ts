import * as crypto from 'node:crypto';
import type { ControlActor, TabControlEvent } from './control-state.js';
import type { RelayNodeSourceDiagnostics } from './relay-node-protocol.js';
import {
  HIGH_RISK_CAPABILITIES,
  RELAY_SECURITY_POLICY_VERSION,
  type RelayCapabilityBit,
  type RelayTrustTier,
} from './security-policy.js';

export const SECURITY_AUDIT_SCHEMA_VERSION = 1 as const;

export const SECURITY_AUDIT_EVENT_TYPES = [
  'grant',
  'denial',
  'challenge',
  'approval',
  'expiry',
  'revocation',
  'rotation',
  'failed_redemption',
  'same_session_approval_attempt',
  'bridge_event',
] as const;

export type SecurityAuditEventType =
  (typeof SECURITY_AUDIT_EVENT_TYPES)[number];

export type SecurityAuditDecision =
  | 'allow'
  | 'deny'
  | 'requires_confirmation'
  | 'approved'
  | 'expired'
  | 'revoked'
  | 'rotated'
  | 'failed'
  | 'recorded';

export interface SecurityAuditPeerIdentity {
  kind: 'hub' | 'node' | 'user' | 'system';
  nodeId?: string;
  credentialId?: string;
  displayName?: string;
  principalHash?: string;
}

export interface SecurityAuditNodeIdentity {
  nodeId?: string;
  trustTier?: RelayTrustTier;
}

export interface SecurityAuditIntent {
  action: string;
  target?: string;
}

export interface SecurityAuditRefs {
  aclRef?: string;
  policyVersion?: typeof RELAY_SECURITY_POLICY_VERSION | string;
}

export interface SecurityAuditMaterial {
  scope?: unknown;
  params?: unknown;
}

export interface NormalizedSecurityAuditEntry {
  eventId: string;
  timestamp: string;
  sequence: number;
  schemaVersion: typeof SECURITY_AUDIT_SCHEMA_VERSION;
  eventType: SecurityAuditEventType;
  decision: SecurityAuditDecision;
  reasonCode: string;
  peer: SecurityAuditPeerIdentity;
  node: SecurityAuditNodeIdentity;
  sessionId?: string;
  intent: SecurityAuditIntent;
  scopeHash: string;
  paramsHash: string;
  requiredBits: RelayCapabilityBit[];
  grantedBits: RelayCapabilityBit[];
  deniedBits: RelayCapabilityBit[];
  aclRef?: string;
  policyVersion?: string;
  sourceDiagnostics?: RelayNodeSourceDiagnostics;
  correlationId: string;
  prevHash: string | null;
  entryHash: string;
}

export interface SecurityAuditEntryInput {
  eventId?: string;
  timestamp?: string;
  eventType: SecurityAuditEventType;
  decision: SecurityAuditDecision;
  reasonCode: string;
  peer: SecurityAuditPeerIdentity;
  node?: SecurityAuditNodeIdentity;
  sessionId?: string;
  intent: SecurityAuditIntent;
  material?: SecurityAuditMaterial;
  requiredBits?: RelayCapabilityBit[];
  grantedBits?: RelayCapabilityBit[];
  deniedBits?: RelayCapabilityBit[];
  refs?: SecurityAuditRefs;
  sourceDiagnostics?: RelayNodeSourceDiagnostics;
  correlationId?: string;
}

export interface SecurityAuditFailureContext {
  trustTier?: RelayTrustTier;
  requiredBits?: RelayCapabilityBit[];
  decision?: SecurityAuditDecision;
}

export interface SecurityAuditFailureClassification {
  mode: 'fail-closed' | 'degraded';
  reasonCode: 'AUDIT_WRITE_FAILED_CLOSED' | 'AUDIT_WRITE_DEGRADED_READ_ONLY';
  visibleMessage: string;
}

const REDACTED = '[REDACTED]';
const MAX_STRING_LENGTH = 512;
const SENSITIVE_KEY_TERMS = new Set([
  'authorization',
  'bearer',
  'confirmation_token',
  'confirmationtoken',
  'cookie',
  'credential',
  'env',
  'file_bytes',
  'filebytes',
  'password',
  'pair_token',
  'pairtoken',
  'secret',
  'stderr',
  'stdout',
  'terminal',
  'terminal_bytes',
  'terminalbytes',
  'token',
  'value',
]);
const SENSITIVE_TEXT_PATTERN =
  /(bearer\s+[a-z0-9._~+/=-]+|gh[pousr]_[a-z0-9_]+|sk-[a-z0-9_-]+|relay-[a-z0-9._~+/=-]{16,})/gi;
const HIGH_RISK_SET = new Set<RelayCapabilityBit>(HIGH_RISK_CAPABILITIES);

export function isSecurityAuditEventType(
  value: unknown
): value is SecurityAuditEventType {
  return (
    typeof value === 'string' &&
    (SECURITY_AUDIT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForJson(value)) ?? 'null';
}

export function hashAuditMaterial(value: unknown): string {
  return sha256Hex(stableStringify(redactAuditValue(value)));
}

export function securityAuditEntryForTabControlEvent(
  event: TabControlEvent
): SecurityAuditEntryInput {
  return {
    eventId: event.eventId,
    timestamp: event.occurredAt,
    eventType: 'bridge_event',
    decision: 'recorded',
    reasonCode:
      event.type === 'tab.mode-changed'
        ? 'TAB_CONTROL_MODE_CHANGED'
        : 'TAB_INTERVENTION_RECORDED',
    peer: auditPeerFromControlActor(event.actor),
    node: { nodeId: event.identity.nodeId },
    sessionId: event.identity.sessionId,
    intent: {
      action: event.type,
      target: event.identity.globalSessionId ?? event.identity.sessionId,
    },
    material: {
      scope: controlEventAuditScope(event),
      params: controlEventAuditParams(event),
    },
    requiredBits: controlEventRequiredBits(event),
    grantedBits: controlEventRequiredBits(event),
    deniedBits: [],
    refs: { policyVersion: RELAY_SECURITY_POLICY_VERSION },
    correlationId: event.eventId,
  };
}

function auditPeerFromControlActor(actor: ControlActor): SecurityAuditPeerIdentity {
  if (actor.kind === 'human') {
    return {
      kind: 'user',
      ...(actor.nodeId ? { nodeId: actor.nodeId } : {}),
      ...(actor.displayName ? { displayName: actor.displayName } : {}),
      ...(actor.id ? { principalHash: sha256Hex(actor.id) } : {}),
    };
  }
  if (actor.kind === 'agent' && actor.nodeId) {
    return {
      kind: 'node',
      nodeId: actor.nodeId,
      ...(actor.displayName ? { displayName: actor.displayName } : {}),
      ...(actor.id ? { principalHash: sha256Hex(actor.id) } : {}),
    };
  }
  return {
    kind: 'system',
    ...(actor.nodeId ? { nodeId: actor.nodeId } : {}),
    ...(actor.displayName ? { displayName: actor.displayName } : {}),
    ...(actor.id ? { principalHash: sha256Hex(actor.id) } : {}),
  };
}

function controlEventAuditScope(event: TabControlEvent): Record<string, unknown> {
  return {
    nodeId: event.identity.nodeId,
    sessionId: event.identity.sessionId,
    globalSessionId: event.identity.globalSessionId ?? null,
    cwd: event.identity.cwd,
    repoPath: event.identity.repoPath ?? null,
    worktreePath: event.identity.worktreePath ?? null,
  };
}

function controlActorAuditSummary(actor: ControlActor): Record<string, unknown> {
  return {
    kind: actor.kind,
    idHash: actor.id ? sha256Hex(actor.id) : null,
    displayName: actor.displayName ?? null,
    nodeId: actor.nodeId ?? null,
    sessionId: actor.sessionId ?? null,
  };
}

function controlEventAuditParams(event: TabControlEvent): Record<string, unknown> {
  const base = {
    sourceEventId: event.eventId,
    kind: event.type,
    reason: event.reason ?? null,
    author: controlActorAuditSummary(event.actor),
  };
  if (event.type === 'tab.mode-changed') {
    return {
      ...base,
      modeBefore: event.previousControlMode,
      modeAfter: event.controlMode,
    };
  }
  return {
    ...base,
    interventionId: event.intervention.id,
    interventionKind: event.intervention.kind,
    interventionSource: event.intervention.source,
    payload: {
      hashSha256: event.intervention.redaction.hashSha256,
      byteCount: event.intervention.redaction.byteCount,
      charCount: event.intervention.redaction.charCount,
      lineCount: event.intervention.redaction.lineCount,
      classes: event.intervention.redaction.classes,
      redacted: event.intervention.redaction.redacted,
    },
    modeBefore: event.intervention.modeBefore,
    modeAfter: event.intervention.modeAfter ?? event.controlMode,
    acked: event.intervention.ackedAt !== undefined,
  };
}

function controlEventRequiredBits(event: TabControlEvent): RelayCapabilityBit[] {
  if (event.type === 'tab.intervention') {
    if (event.intervention.kind === 'supervisor-send-text') {
      return ['session:attach', 'tab:intervention:send-text'];
    }
    if (event.intervention.kind === 'supervisor-submit') {
      return ['session:attach', 'tab:intervention:submit'];
    }
  }
  const modeAfter =
    event.type === 'tab.mode-changed'
      ? event.controlMode
      : event.intervention.modeAfter ?? event.controlMode;
  return modeAfter === 'agent-driven' ? ['tab:mode:set-agent'] : [];
}

/**
 * drop credentialId before exposing audit rows to browser clients;
 * credentialId is a stable handle to a paired-credential row and is hub-internal.
 */
export function redactPeerForBrowser(
  peer: SecurityAuditPeerIdentity
): SecurityAuditPeerIdentity {
  const { credentialId: _dropped, ...rest } = peer;
  return rest;
}

export function redactAuditValue(value: unknown): unknown {
  return redactAuditValueInner(value, undefined, new WeakSet<object>());
}

function redactAuditValueInner(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>
): unknown {
  if (key && isSensitiveAuditKey(key)) return REDACTED;
  if (value == null) return value;
  if (Buffer.isBuffer(value)) return REDACTED;
  if (value instanceof Uint8Array) return REDACTED;
  if (typeof value === 'string') {
    const scrubbed = value.replace(SENSITIVE_TEXT_PATTERN, REDACTED);
    return scrubbed.length > MAX_STRING_LENGTH
      ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : scrubbed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => redactAuditValueInner(item, undefined, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const record = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(record).sort(
      ([a], [b]) => compareJsonKeys(a, b)
    )) {
      redacted[childKey] = redactAuditValueInner(childValue, childKey, seen);
    }
    return redacted;
  }
  return String(value);
}

function isSensitiveAuditKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (SENSITIVE_KEY_TERMS.has(normalized)) return true;
  return normalized.split('_').some((part) => SENSITIVE_KEY_TERMS.has(part));
}

function compareJsonKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function sortForJson(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(sortForJson);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record).sort(([a], [b]) =>
      compareJsonKeys(a, b)
    )) {
      if (child !== undefined) sorted[key] = sortForJson(child);
    }
    return sorted;
  }
  return value;
}

function entryHashPayload(
  entry: Omit<NormalizedSecurityAuditEntry, 'entryHash'>
): string {
  return stableStringify(entry);
}

export function computeSecurityAuditEntryHash(
  entry: Omit<NormalizedSecurityAuditEntry, 'entryHash'>
): string {
  return sha256Hex(entryHashPayload(entry));
}

export function normalizeSecurityAuditEntry(
  input: SecurityAuditEntryInput,
  chain: { sequence: number; prevHash: string | null }
): NormalizedSecurityAuditEntry {
  if (!isSecurityAuditEventType(input.eventType)) {
    throw new Error(
      `Unknown security audit event type: ${String(input.eventType)}`
    );
  }
  const timestamp = input.timestamp ?? new Date().toISOString();
  const base: Omit<NormalizedSecurityAuditEntry, 'entryHash'> = {
    eventId: input.eventId ?? crypto.randomUUID(),
    timestamp,
    sequence: chain.sequence,
    schemaVersion: SECURITY_AUDIT_SCHEMA_VERSION,
    eventType: input.eventType,
    decision: input.decision,
    reasonCode: input.reasonCode,
    peer: normalizePeer(input.peer),
    node: normalizeNode(input.node),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    intent: {
      action: input.intent.action,
      ...(input.intent.target ? { target: input.intent.target } : {}),
    },
    scopeHash: hashAuditMaterial(input.material?.scope ?? null),
    paramsHash: hashAuditMaterial(input.material?.params ?? null),
    requiredBits: [...(input.requiredBits ?? [])],
    grantedBits: [...(input.grantedBits ?? [])],
    deniedBits: [...(input.deniedBits ?? [])],
    ...(input.refs?.aclRef ? { aclRef: input.refs.aclRef } : {}),
    ...(input.refs?.policyVersion
      ? { policyVersion: input.refs.policyVersion }
      : {}),
    ...(input.sourceDiagnostics
      ? { sourceDiagnostics: input.sourceDiagnostics }
      : {}),
    correlationId: input.correlationId ?? crypto.randomUUID(),
    prevHash: chain.prevHash,
  };
  return { ...base, entryHash: computeSecurityAuditEntryHash(base) };
}

function normalizePeer(
  peer: SecurityAuditPeerIdentity
): SecurityAuditPeerIdentity {
  return {
    kind: peer.kind,
    ...(peer.nodeId ? { nodeId: peer.nodeId } : {}),
    ...(peer.credentialId ? { credentialId: peer.credentialId } : {}),
    ...(peer.displayName ? { displayName: peer.displayName } : {}),
    ...(peer.principalHash ? { principalHash: peer.principalHash } : {}),
  };
}

function normalizeNode(
  node: SecurityAuditNodeIdentity | undefined
): SecurityAuditNodeIdentity {
  return {
    ...(node?.nodeId ? { nodeId: node.nodeId } : {}),
    ...(node?.trustTier ? { trustTier: node.trustTier } : {}),
  };
}

export function verifySecurityAuditEntryHash(
  entry: NormalizedSecurityAuditEntry
): { ok: true } | { ok: false; expected: string; actual: string } {
  const { entryHash: actual, ...base } = entry;
  const expected = computeSecurityAuditEntryHash(base);
  return expected === actual ? { ok: true } : { ok: false, expected, actual };
}

export function classifySecurityAuditWriteFailure(
  context: SecurityAuditFailureContext
): SecurityAuditFailureClassification {
  const requiredBits = context.requiredBits ?? [];
  const highRisk = requiredBits.some((bit) => HIGH_RISK_SET.has(bit));
  const failClosed = context.trustTier === 'prod' || highRisk;
  if (failClosed) {
    return {
      mode: 'fail-closed',
      reasonCode: 'AUDIT_WRITE_FAILED_CLOSED',
      visibleMessage:
        'Security audit write failed; operation must be denied for prod or destructive capability scope.',
    };
  }
  return {
    mode: 'degraded',
    reasonCode: 'AUDIT_WRITE_DEGRADED_READ_ONLY',
    visibleMessage:
      'Security audit write failed; low-tier read-only operation may continue only with explicit degraded audit visibility.',
  };
}
