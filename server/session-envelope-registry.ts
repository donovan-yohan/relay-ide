import {
  LOCAL_COMPATIBILITY_SESSION_INTENT,
  normalizeSessionEnvelope,
  sessionEnvelopeKey,
  type SessionEnvelope,
  type SessionEnvelopeFallback,
  type SessionIntentKind,
} from '../shared/session-envelope.js';

export interface SessionEnvelopeCreateInput extends SessionEnvelopeFallback {
  envelope?: unknown;
  intentKind?: SessionIntentKind;
}

export class InMemorySessionEnvelopeRegistry {
  private readonly envelopes = new Map<string, SessionEnvelope>();

  create(input: SessionEnvelopeCreateInput): SessionEnvelope {
    const envelope = normalizeSessionEnvelope(
      input.envelope,
      input,
      input.intentKind ?? LOCAL_COMPATIBILITY_SESSION_INTENT
    );
    this.envelopes.set(sessionEnvelopeKey(envelope), envelope);
    return envelope;
  }

  upsert(envelope: SessionEnvelope): SessionEnvelope {
    this.envelopes.set(sessionEnvelopeKey(envelope), envelope);
    return envelope;
  }

  read(sessionIdOrGlobalId: string, nodeId?: string): SessionEnvelope | undefined {
    if (nodeId) {
      return this.envelopes.get(`${encodeURIComponent(nodeId)}:${encodeURIComponent(sessionIdOrGlobalId)}`);
    }
    const direct = this.envelopes.get(sessionIdOrGlobalId);
    if (direct) return direct;
    return Array.from(this.envelopes.values()).find(
      (envelope) => envelope.sessionId === sessionIdOrGlobalId
    );
  }

  listActive(): SessionEnvelope[] {
    return Array.from(this.envelopes.values()).sort((a, b) =>
      b.issuedAt.localeCompare(a.issuedAt)
    );
  }

  delete(sessionIdOrGlobalId: string, nodeId?: string): boolean {
    const found = this.read(sessionIdOrGlobalId, nodeId);
    if (!found) return false;
    return this.envelopes.delete(sessionEnvelopeKey(found));
  }

  clear(): void {
    this.envelopes.clear();
  }
}

export function createSessionEnvelopeRegistry(): InMemorySessionEnvelopeRegistry {
  return new InMemorySessionEnvelopeRegistry();
}

export const sessionEnvelopeRegistry = createSessionEnvelopeRegistry();
