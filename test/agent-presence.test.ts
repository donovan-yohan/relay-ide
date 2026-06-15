import { describe, expect, it } from 'vitest';

import {
  PRESENCE_DEFAULT_TTL_SECONDS,
  PRESENCE_MAX_TTL_SECONDS,
  PRESENCE_MIN_TTL_SECONDS,
  PresenceValidationError,
  isPresenceExpired,
  mergeRosterWithPresence,
  sanitizePresenceInput,
  type AgentPresence,
} from '../shared/agent-presence.js';
import {
  projectRosterEntry,
  type RosterEntry,
  type RosterSessionInput,
} from '../shared/agent-roster.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');

function presenceFixture(overrides: Partial<AgentPresence> = {}): AgentPresence {
  return {
    id: 'pres:abc123',
    registeredBy: 'actor:claude-1',
    createdAt: '2026-06-15T11:59:00.000Z',
    updatedAt: '2026-06-15T11:59:30.000Z',
    expiresAt: '2026-06-15T12:01:30.000Z',
    ...overrides,
  };
}

describe('sanitizePresenceInput', () => {
  it('hard-rejects secret-shaped fields (unsafe field rejection)', () => {
    for (const key of [
      'token',
      'secret',
      'apiKey',
      'env',
      'transcript',
      'prompt',
      'payload',
      'authorization',
      'credentials',
    ]) {
      expect(() => sanitizePresenceInput({ [key]: 'x' })).toThrowError(
        PresenceValidationError
      );
      try {
        sanitizePresenceInput({ [key]: 'x' });
      } catch (err) {
        expect((err as PresenceValidationError).code).toBe(
          'presence_unsafe_field'
        );
      }
    }
  });

  it('rejects an unknown role but keeps a valid one', () => {
    expect(() => sanitizePresenceInput({ role: 'hacker' })).toThrowError(
      /role must be one of/
    );
    expect(sanitizePresenceInput({ role: 'reviewer' }).fields.role).toBe(
      'reviewer'
    );
  });

  it('rejects a non-object body and a non-finite ttl', () => {
    expect(() => sanitizePresenceInput(null)).toThrowError(
      PresenceValidationError
    );
    expect(() => sanitizePresenceInput([1, 2])).toThrowError(
      /must be an object/
    );
    expect(() =>
      sanitizePresenceInput({ ttlSeconds: Number.POSITIVE_INFINITY })
    ).toThrowError(/finite number/);
  });

  it('clamps ttlSeconds into the allowed window', () => {
    expect(sanitizePresenceInput({ ttlSeconds: 2 }).fields.ttlSeconds).toBe(
      PRESENCE_MIN_TTL_SECONDS
    );
    expect(
      sanitizePresenceInput({ ttlSeconds: 99999 }).fields.ttlSeconds
    ).toBe(PRESENCE_MAX_TTL_SECONDS);
    expect(sanitizePresenceInput({ ttlSeconds: 90 }).fields.ttlSeconds).toBe(90);
  });

  it('redacts control chars + collapses whitespace + clamps length', () => {
    // Build the dirty input from char codes so no literal control bytes live
    // in this source file (tab, tab, newline, space as the separator).
    const sep = String.fromCharCode(9, 9, 10, 32);
    const dirty = ['run', 'tests', 'now', 'x'.repeat(400)].join(sep);
    const value = sanitizePresenceInput({ useCase: dirty }).fields.useCase ?? '';
    // no control chars survive; whitespace runs collapse to single spaces
    expect(Array.from(value).every((ch) => ch.charCodeAt(0) >= 32)).toBe(true);
    expect(value.includes('  ')).toBe(false);
    expect(value.startsWith('run tests now')).toBe(true);
    expect(value.length).toBeLessThanOrEqual(200);
  });

  it('normalizes capability hints (lowercase, safe charset, dedup, cap count)', () => {
    const { fields } = sanitizePresenceInput({
      capabilityHints: [
        'Hooks!',
        'hooks',
        'web sessions',
        '  Continue  ',
        ...Array.from({ length: 30 }, (_, i) => `cap${i}`),
      ],
    });
    expect(fields.capabilityHints).toContain('hooks');
    expect(fields.capabilityHints).toContain('websessions');
    expect(fields.capabilityHints).toContain('continue');
    // deduped: only one 'hooks'
    expect(fields.capabilityHints?.filter((c) => c === 'hooks')).toHaveLength(1);
    expect((fields.capabilityHints ?? []).length).toBeLessThanOrEqual(16);
  });

  it('drops unknown (non-secret) keys but reports them', () => {
    const { fields, droppedKeys } = sanitizePresenceInput({
      role: 'implementer',
      somethingExtra: 'meh',
      anotherUnknown: 1,
    });
    expect(fields.role).toBe('implementer');
    expect(droppedKeys).toEqual(
      expect.arrayContaining(['somethingExtra', 'anotherUnknown'])
    );
  });

  it('passes through sanitized scope + soft fields', () => {
    const { fields } = sanitizePresenceInput({
      sessionId: ' sess-1 ',
      globalSessionId: 'node-a:sess-1',
      workContextId: 'wc:9',
      repoPath: '/home/u/relay-ide',
      nodeId: 'node-a',
      provider: 'Claude',
      displayName: 'Claude impl',
      statusText: 'running tests',
      needsAttention: true,
    });
    expect(fields).toMatchObject({
      sessionId: 'sess-1',
      globalSessionId: 'node-a:sess-1',
      workContextId: 'wc:9',
      repoPath: '/home/u/relay-ide',
      nodeId: 'node-a',
      provider: 'Claude',
      displayName: 'Claude impl',
      statusText: 'running tests',
      needsAttention: true,
    });
  });
});

describe('isPresenceExpired', () => {
  it('is true at or past expiry, false before, true on a bad timestamp', () => {
    expect(
      isPresenceExpired(presenceFixture({ expiresAt: '2026-06-15T12:01:00.000Z' }), NOW)
    ).toBe(false);
    expect(
      isPresenceExpired(presenceFixture({ expiresAt: '2026-06-15T11:59:00.000Z' }), NOW)
    ).toBe(true);
    expect(
      isPresenceExpired(presenceFixture({ expiresAt: 'not-a-date' }), NOW)
    ).toBe(true);
  });
});

describe('mergeRosterWithPresence', () => {
  const session: RosterSessionInput = {
    id: 'sess-claude',
    globalSessionId: 'node-a:sess-claude',
    nodeId: 'node-a',
    agent: 'claude',
    type: 'agent',
    displayName: 'Claude impl',
    controlMode: 'agent-driven',
    status: 'active',
    agentState: 'idle',
    lastActivity: '2026-06-15T11:00:00.000Z',
  };
  const derived: RosterEntry[] = [
    projectRosterEntry(session, { capabilities: ['hooks'] }),
  ];

  it('merges presence onto a matching session without touching identity/control', () => {
    const presence = presenceFixture({
      id: 'pres:1',
      globalSessionId: 'node-a:sess-claude',
      role: 'reviewer',
      displayName: 'Claude (self)',
      useCase: 'reviewing #964',
      capabilityHints: ['continue'],
    });
    const [entry] = mergeRosterWithPresence(derived, [presence], { now: NOW });
    expect(entry.origin).toBe('merged');
    // soft overlay applied
    expect(entry.role).toBe('reviewer');
    expect(entry.displayName).toBe('Claude (self)');
    expect(entry.capabilities).toEqual(['hooks', 'continue']);
    expect(entry.selfDeclared).toMatchObject({
      presenceId: 'pres:1',
      useCase: 'reviewing #964',
    });
    // derived identity/control fields win and are untouched
    expect(entry.provider).toBe('claude');
    expect(entry.sessionId).toBe('sess-claude');
    expect(entry.controlMode).toBe('agent-driven');
  });

  it('synthesizes a self-declared entry for presence with no live session', () => {
    const presence = presenceFixture({
      id: 'pres:ext',
      sessionId: 'external-1',
      provider: 'codex',
      useCase: 'external reviewer',
      repoPath: '/home/u/relay-ide',
      workContextId: 'wc:1',
    });
    const entries = mergeRosterWithPresence([], [presence], { now: NOW });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      origin: 'self-declared',
      sessionId: 'external-1',
      provider: 'codex',
      role: 'reviewer', // default role for codex
      repoPath: '/home/u/relay-ide',
      workContextId: 'wc:1',
    });
    expect(entries[0].selfDeclared?.presenceId).toBe('pres:ext');
  });

  it('drops expired presence (no merge, no synthesis)', () => {
    const expired = presenceFixture({
      id: 'pres:dead',
      globalSessionId: 'node-a:sess-claude',
      role: 'orchestrator',
      expiresAt: '2026-06-15T11:00:00.000Z',
    });
    const [entry] = mergeRosterWithPresence(derived, [expired], { now: NOW });
    expect(entry.origin).toBeUndefined();
    expect(entry.role).toBe('implementer'); // unchanged derived default
    expect(
      mergeRosterWithPresence([], [expired], { now: NOW })
    ).toHaveLength(0);
  });

  it('treats self-declared attention as additive, never clearing derived', () => {
    const waitingSession: RosterSessionInput = {
      ...session,
      id: 'sess-wait',
      globalSessionId: 'node-a:sess-wait',
      agentState: 'permission-prompt',
    };
    const derivedWaiting = [projectRosterEntry(waitingSession, {})];
    // presence WITHOUT needsAttention must not clear the derived permission-prompt
    const quiet = presenceFixture({
      id: 'pres:q',
      globalSessionId: 'node-a:sess-wait',
    });
    const [keptAttention] = mergeRosterWithPresence(derivedWaiting, [quiet], {
      now: NOW,
    });
    expect(keptAttention.attention.needsAttention).toBe(true);
    expect(keptAttention.attention.reasons).toContain('permission-prompt');

    // presence WITH needsAttention raises attention on an otherwise-idle session
    const loud = presenceFixture({
      id: 'pres:l',
      globalSessionId: 'node-a:sess-claude',
      needsAttention: true,
    });
    const [raised] = mergeRosterWithPresence(derived, [loud], { now: NOW });
    expect(raised.attention.needsAttention).toBe(true);
    expect(raised.attention.reasons).toContain('self-declared');
  });

  it('keeps the merged TTL default sane (documents the heartbeat window)', () => {
    expect(PRESENCE_DEFAULT_TTL_SECONDS).toBeGreaterThan(0);
  });
});
