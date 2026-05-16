import {
  LOCAL_COMPATIBILITY_SESSION_INTENT,
  normalizeSessionEnvelope,
  sessionEnvelopeKey,
  type SessionEnvelope,
  type SessionEnvelopeFallback,
  type SessionIntentKind,
} from '../shared/session-envelope.js';
import type { RelayNodeError, RelayNodeErrorCode } from '../shared/relay-node-protocol.js';

export type ScopedSessionLifecycleState = 'active' | 'expired' | 'revoked';

export interface SessionEnvelopeCreateInput extends SessionEnvelopeFallback {
  envelope?: unknown;
  intentKind?: SessionIntentKind;
}

export interface SessionEnvelopeRecord {
  envelope: SessionEnvelope;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface ScopedSessionSummary {
  sessionId: string;
  globalSessionId: string;
  nodeId: string;
  intent: SessionEnvelope['intent'];
  scope: SessionEnvelope['scope'];
  peerIdentity: SessionEnvelope['peerIdentity'];
  issuedAt: string;
  expiresAt: string | null;
  revocable: boolean;
  status: ScopedSessionLifecycleState;
  revokedAt: string | null;
  revokeReason: string | null;
  expired: boolean;
  expiresInMs: number | null;
  correlationId?: string;
  auditId?: string;
}

export interface SessionLifecycleValidationContext {
  sessionId: string;
  nodeId?: string;
  globalSessionId?: string;
  now?: Date;
}

export type SessionLifecycleValidation =
  | { ok: true; record: SessionEnvelopeRecord; summary: ScopedSessionSummary }
  | { ok: false; error: RelayNodeError; record?: SessionEnvelopeRecord; summary?: ScopedSessionSummary };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

function nowDate(now?: Date): Date {
  return now ?? new Date();
}

function parseExpiryMs(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function lifecycleState(
  record: SessionEnvelopeRecord,
  now = new Date()
): ScopedSessionLifecycleState {
  if (record.revokedAt) return 'revoked';
  const expiryMs = parseExpiryMs(record.envelope.expiresAt);
  if (expiryMs !== null && expiryMs <= now.getTime()) return 'expired';
  return 'active';
}

function relaySessionError(
  code: RelayNodeErrorCode,
  reasonCode: string,
  message: string,
  details: Record<string, unknown> = {}
): RelayNodeError {
  return {
    code,
    message,
    retryable: false,
    details: { reasonCode, ...details },
  };
}

function expectedGlobalId(nodeId: string, sessionId: string): string {
  return `${encodeURIComponent(nodeId)}:${encodeURIComponent(sessionId)}`;
}

function isIsoLike(value: string): boolean {
  return ISO_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export interface LifecycleInputError {
  field: 'expiresAt' | 'ttlMs' | 'ttlSeconds';
  message: string;
}

export function lifecycleInputError(input: Record<string, unknown>): LifecycleInputError | null {
  if (hasOwn(input, 'expiresAt')) {
    const expiresAt = input['expiresAt'];
    if (expiresAt !== null && !(typeof expiresAt === 'string' && isIsoLike(expiresAt))) {
      return {
        field: 'expiresAt',
        message: 'expiresAt must be null or an ISO timestamp',
      };
    }
  }

  if (hasOwn(input, 'ttlMs')) {
    const ttlMs = input['ttlMs'];
    if (!(typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0)) {
      return { field: 'ttlMs', message: 'ttlMs must be a positive finite number' };
    }
  }

  if (hasOwn(input, 'ttlSeconds')) {
    const ttlSeconds = input['ttlSeconds'];
    if (!(typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0)) {
      return {
        field: 'ttlSeconds',
        message: 'ttlSeconds must be a positive finite number',
      };
    }
  }

  return null;
}

export function expiresAtFromLifecycleInput(
  input: Record<string, unknown>,
  now = new Date()
): string | null | undefined {
  const expiresAt = input['expiresAt'];
  if (expiresAt === null) return null;
  if (typeof expiresAt === 'string') return expiresAt;

  const ttlMs = input['ttlMs'];
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) {
    return new Date(now.getTime() + Math.round(ttlMs)).toISOString();
  }

  const ttlSeconds = input['ttlSeconds'];
  if (
    typeof ttlSeconds === 'number' &&
    Number.isFinite(ttlSeconds) &&
    ttlSeconds > 0
  ) {
    return new Date(now.getTime() + Math.round(ttlSeconds * 1000)).toISOString();
  }

  return undefined;
}

export function lifecycleSummary(
  record: SessionEnvelopeRecord,
  now = new Date()
): ScopedSessionSummary {
  const { envelope } = record;
  const expiryMs = parseExpiryMs(envelope.expiresAt);
  const remaining = expiryMs === null ? null : Math.max(0, expiryMs - now.getTime());
  const status = lifecycleState(record, now);
  return {
    sessionId: envelope.sessionId,
    globalSessionId: envelope.globalSessionId,
    nodeId: envelope.nodeId,
    intent: envelope.intent,
    scope: envelope.scope,
    peerIdentity: envelope.peerIdentity,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    revocable: envelope.revocable,
    status,
    revokedAt: record.revokedAt,
    revokeReason: record.revokeReason,
    expired: status === 'expired',
    expiresInMs: remaining,
    ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
    ...(envelope.auditId ? { auditId: envelope.auditId } : {}),
  };
}

export class InMemorySessionEnvelopeRegistry {
  private readonly records = new Map<string, SessionEnvelopeRecord>();

  create(input: SessionEnvelopeCreateInput): SessionEnvelope {
    const envelope = normalizeSessionEnvelope(
      input.envelope,
      input,
      input.intentKind ?? LOCAL_COMPATIBILITY_SESSION_INTENT
    );
    this.records.set(sessionEnvelopeKey(envelope), {
      envelope,
      revokedAt: null,
      revokeReason: null,
    });
    return envelope;
  }

  upsert(envelope: SessionEnvelope): SessionEnvelope {
    const key = sessionEnvelopeKey(envelope);
    const previous = this.records.get(key);
    this.records.set(key, {
      envelope,
      revokedAt: previous?.revokedAt ?? null,
      revokeReason: previous?.revokeReason ?? null,
    });
    return envelope;
  }

  readRecord(sessionIdOrGlobalId: string, nodeId?: string): SessionEnvelopeRecord | undefined {
    if (nodeId) {
      const direct = this.records.get(expectedGlobalId(nodeId, sessionIdOrGlobalId));
      if (direct) return direct;
      return Array.from(this.records.values()).find(
        (record) =>
          record.envelope.nodeId === nodeId &&
          (record.envelope.sessionId === sessionIdOrGlobalId ||
            record.envelope.globalSessionId === sessionIdOrGlobalId)
      );
    }
    const direct = this.records.get(sessionIdOrGlobalId);
    if (direct) return direct;
    return Array.from(this.records.values()).find(
      (record) => record.envelope.sessionId === sessionIdOrGlobalId
    );
  }

  read(sessionIdOrGlobalId: string, nodeId?: string): SessionEnvelope | undefined {
    return this.readRecord(sessionIdOrGlobalId, nodeId)?.envelope;
  }

  listActive(now = new Date()): SessionEnvelope[] {
    return this.list({ now, includeRevoked: false, includeExpired: false }).map(
      (entry) => entry.envelope
    );
  }

  list(options: {
    now?: Date;
    includeRevoked?: boolean;
    includeExpired?: boolean;
  } = {}): SessionEnvelopeRecord[] {
    const now = nowDate(options.now);
    const includeRevoked = options.includeRevoked ?? false;
    const includeExpired = options.includeExpired ?? true;
    return Array.from(this.records.values())
      .filter((record) => {
        const state = lifecycleState(record, now);
        if (state === 'revoked') return includeRevoked;
        if (state === 'expired') return includeExpired;
        return true;
      })
      .sort((a, b) => b.envelope.issuedAt.localeCompare(a.envelope.issuedAt));
  }

  listSummaries(options: {
    now?: Date;
    includeRevoked?: boolean;
    includeExpired?: boolean;
  } = {}): ScopedSessionSummary[] {
    const now = nowDate(options.now);
    return this.list({ ...options, now }).map((record) => lifecycleSummary(record, now));
  }

  hasGlobalSessionId(globalSessionId: string): boolean {
    return this.records.has(globalSessionId);
  }

  countLocalSessionId(sessionId: string): number {
    return Array.from(this.records.values()).filter(
      (record) => record.envelope.sessionId === sessionId
    ).length;
  }

  revoke(
    sessionIdOrGlobalId: string,
    options: { nodeId?: string; reason?: string; now?: Date } = {}
  ): ScopedSessionSummary | undefined {
    const record = options.nodeId
      ? this.readRecord(sessionIdOrGlobalId, options.nodeId)
      : this.records.get(sessionIdOrGlobalId);
    if (!record) return undefined;
    const nowIso = nowDate(options.now).toISOString();
    record.revokedAt = record.revokedAt ?? nowIso;
    record.revokeReason = options.reason ?? record.revokeReason ?? 'operator-revoked';
    return lifecycleSummary(record, nowDate(options.now));
  }

  validate(context: SessionLifecycleValidationContext): SessionLifecycleValidation {
    const now = nowDate(context.now);
    const record = this.readRecord(context.sessionId, context.nodeId);
    if (!record) {
      const mismatchedRecord = context.nodeId
        ? this.readRecord(context.sessionId)
        : undefined;
      if (mismatchedRecord) {
        const summary = lifecycleSummary(mismatchedRecord, now);
        return {
          ok: false,
          record: mismatchedRecord,
          summary,
          error: relaySessionError(
            'SESSION_MISMATCH',
            'SESSION_NODE_MISMATCH',
            'scoped session node does not match the routed node',
            {
              expectedNodeId: mismatchedRecord.envelope.nodeId,
              actualNodeId: context.nodeId,
            }
          ),
        };
      }
      return {
        ok: false,
        error: relaySessionError(
          'NOT_FOUND',
          'SESSION_ENVELOPE_NOT_FOUND',
          'scoped session envelope was not found',
          {
            sessionId: context.sessionId,
            nodeId: context.nodeId ?? null,
            globalSessionId: context.globalSessionId ?? null,
          }
        ),
      };
    }

    const summary = lifecycleSummary(record, now);
    const { envelope } = record;
    if (context.nodeId && envelope.nodeId !== context.nodeId) {
      return {
        ok: false,
        record,
        summary,
        error: relaySessionError(
          'SESSION_MISMATCH',
          'SESSION_NODE_MISMATCH',
          'scoped session node does not match the routed node',
          { expectedNodeId: envelope.nodeId, actualNodeId: context.nodeId }
        ),
      };
    }
    if (envelope.sessionId !== context.sessionId) {
      return {
        ok: false,
        record,
        summary,
        error: relaySessionError(
          'SESSION_MISMATCH',
          'SESSION_ID_MISMATCH',
          'scoped session id does not match the routed session',
          { expectedSessionId: envelope.sessionId, actualSessionId: context.sessionId }
        ),
      };
    }
    if (context.globalSessionId && envelope.globalSessionId !== context.globalSessionId) {
      return {
        ok: false,
        record,
        summary,
        error: relaySessionError(
          'SESSION_MISMATCH',
          'SESSION_GLOBAL_ID_MISMATCH',
          'scoped global session id does not match the routed session',
          {
            expectedGlobalSessionId: envelope.globalSessionId,
            actualGlobalSessionId: context.globalSessionId,
          }
        ),
      };
    }
    if (summary.status === 'revoked') {
      return {
        ok: false,
        record,
        summary,
        error: relaySessionError(
          'SESSION_REVOKED',
          'SESSION_REVOKED',
          'scoped session has been revoked',
          { revokedAt: summary.revokedAt, revokeReason: summary.revokeReason }
        ),
      };
    }
    if (summary.status === 'expired') {
      return {
        ok: false,
        record,
        summary,
        error: relaySessionError(
          'SESSION_EXPIRED',
          'SESSION_EXPIRED',
          'scoped session has expired',
          { expiresAt: summary.expiresAt }
        ),
      };
    }
    return { ok: true, record, summary };
  }

  delete(sessionIdOrGlobalId: string, nodeId?: string): boolean {
    const found = this.readRecord(sessionIdOrGlobalId, nodeId);
    if (!found) return false;
    return this.records.delete(sessionEnvelopeKey(found.envelope));
  }

  clear(): void {
    this.records.clear();
  }
}

export function createSessionEnvelopeRegistry(): InMemorySessionEnvelopeRegistry {
  return new InMemorySessionEnvelopeRegistry();
}

export const sessionEnvelopeRegistry = createSessionEnvelopeRegistry();
