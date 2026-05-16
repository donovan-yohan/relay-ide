import { describe, expect, it } from 'vitest';
import {
  LOCAL_COMPATIBILITY_SESSION_INTENT,
  ROUTED_NODE_SESSION_INTENT,
} from '../shared/session-envelope.js';
import {
  createSessionEnvelopeRegistry,
  expiresAtFromLifecycleInput,
  lifecycleInputError,
} from '../server/session-envelope-registry.js';

describe('session envelope registry', () => {
  it('creates, reads, and lists active local compatibility envelopes', () => {
    const registry = createSessionEnvelopeRegistry();
    const envelope = registry.create({
      sessionId: 'sess-local',
      nodeId: 'local',
      globalSessionId: 'local:sess-local',
      cwd: '/repo',
      repoPath: '/repo',
      worktreePath: null,
      issuedAt: '2026-01-02T03:04:05.000Z',
    });

    expect(envelope.intent.kind).toBe(LOCAL_COMPATIBILITY_SESSION_INTENT);
    expect(envelope.scope.kind).toBe('local-compatibility');
    expect(envelope.revocable).toBe(true);
    expect(registry.read('local:sess-local')).toEqual(envelope);
    expect(registry.read('sess-local')).toEqual(envelope);
    expect(registry.listActive()).toEqual([envelope]);
  });

  it('normalizes missing legacy metadata into explicit local compatibility envelope', () => {
    const registry = createSessionEnvelopeRegistry();
    const envelope = registry.create({
      envelope: null,
      sessionId: 'legacy-session',
      cwd: '/tmp/free',
      issuedAt: '2026-01-02T03:04:05.000Z',
    });

    expect(envelope.intent.kind).toBe(LOCAL_COMPATIBILITY_SESSION_INTENT);
    expect(envelope.scope).toMatchObject({
      kind: 'local-compatibility',
      cwd: '/tmp/free',
    });
    expect(envelope.expiresAt).toBeNull();
  });

  it('keeps routed node envelopes distinct from local compatibility', () => {
    const registry = createSessionEnvelopeRegistry();
    const envelope = registry.create({
      sessionId: 'remote-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:remote-session',
      cwd: '/srv/app',
      repoPath: '/srv/app',
      issuedAt: '2026-01-02T03:04:05.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });

    expect(envelope.intent.kind).toBe(ROUTED_NODE_SESSION_INTENT);
    expect(envelope.scope.kind).toBe('repo');
    expect(envelope.peerIdentity).toMatchObject({
      kind: 'relay-node',
      nodeId: 'node-a',
    });
  });

  it('accepts explicit agent peer identities for future brain-as-peer adapters', () => {
    const registry = createSessionEnvelopeRegistry();
    const envelope = registry.create({
      envelope: {
        sessionId: 'agent-peer-session',
        globalSessionId: 'node-a:agent-peer-session',
        nodeId: 'node-a',
        intent: {
          kind: ROUTED_NODE_SESSION_INTENT,
          description: 'adapter-owned routed node session',
        },
        scope: {
          kind: 'node-cwd',
          nodeId: 'node-a',
          cwd: '/srv/app',
        },
        issuedAt: '2026-01-02T03:04:05.000Z',
        expiresAt: null,
        revocable: true,
        peerIdentity: {
          kind: 'agent',
          id: 'brain-1',
          adapter: 'example-adapter',
          displayName: 'Example Brain',
        },
      },
      sessionId: 'agent-peer-session',
      nodeId: 'node-a',
      cwd: '/srv/app',
      issuedAt: '2026-01-02T03:04:05.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });

    expect(envelope.peerIdentity).toEqual({
      kind: 'agent',
      id: 'brain-1',
      adapter: 'example-adapter',
      displayName: 'Example Brain',
    });
  });

  it('validates allowed, expired, revoked, and mismatched routed envelopes', () => {
    const registry = createSessionEnvelopeRegistry();
    const issuedAt = '2026-01-02T03:04:05.000Z';
    const active = registry.create({
      sessionId: 'remote-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:remote-session',
      cwd: '/srv/app',
      repoPath: '/srv/app',
      issuedAt,
      expiresAt: '2026-01-02T03:05:00.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });

    expect(
      registry.validate({
        sessionId: active.sessionId,
        nodeId: active.nodeId,
        now: new Date('2026-01-02T03:04:30.000Z'),
      })
    ).toMatchObject({ ok: true });

    expect(
      registry.validate({
        sessionId: active.sessionId,
        nodeId: active.nodeId,
        now: new Date('2026-01-02T03:05:01.000Z'),
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'SESSION_EXPIRED', details: { reasonCode: 'SESSION_EXPIRED' } },
    });

    const revoked = registry.create({
      sessionId: 'revoked-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:revoked-session',
      cwd: '/srv/app',
      repoPath: '/srv/app',
      issuedAt,
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });
    registry.revoke(revoked.sessionId, {
      nodeId: revoked.nodeId,
      reason: 'operator-test',
      now: new Date('2026-01-02T03:04:20.000Z'),
    });

    expect(
      registry.validate({
        sessionId: revoked.sessionId,
        nodeId: revoked.nodeId,
        now: new Date('2026-01-02T03:04:30.000Z'),
      })
    ).toMatchObject({
      ok: false,
      error: {
        code: 'SESSION_REVOKED',
        details: { reasonCode: 'SESSION_REVOKED', revokeReason: 'operator-test' },
      },
    });

    expect(
      registry.validate({
        sessionId: active.sessionId,
        nodeId: 'node-b',
        now: new Date('2026-01-02T03:04:30.000Z'),
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'SESSION_MISMATCH', details: { reasonCode: 'SESSION_NODE_MISMATCH' } },
    });
  });

  it('fails closed for malformed present lifecycle fields', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');

    expect(lifecycleInputError({ expiresAt: 'not-a-date' })).toMatchObject({
      field: 'expiresAt',
    });
    expect(lifecycleInputError({ ttlMs: 0 })).toMatchObject({ field: 'ttlMs' });
    expect(lifecycleInputError({ ttlSeconds: '60' })).toMatchObject({
      field: 'ttlSeconds',
    });
    expect(lifecycleInputError({ ttlSeconds: Number.MAX_SAFE_INTEGER }, now)).toMatchObject({
      field: 'ttlSeconds',
    });
    expect(lifecycleInputError({ ttlMs: Number.MAX_SAFE_INTEGER }, now)).toMatchObject({
      field: 'ttlMs',
    });
    expect(lifecycleInputError({ ttlMs: 500 }, now)).toBeNull();
    expect(expiresAtFromLifecycleInput({ ttlMs: 500 }, now)).toBe(
      '2026-01-02T03:04:05.500Z'
    );
  });

  it('requires nodeId or globalSessionId for revoke and renew by duplicate local session id', () => {
    const registry = createSessionEnvelopeRegistry();
    registry.create({
      sessionId: 'duplicate-local',
      nodeId: 'node-a',
      globalSessionId: 'node-a:duplicate-local',
      cwd: '/srv/a',
      issuedAt: '2026-01-02T03:04:05.000Z',
      expiresAt: '2026-01-02T03:05:00.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });
    registry.create({
      sessionId: 'duplicate-local',
      nodeId: 'node-b',
      globalSessionId: 'node-b:duplicate-local',
      cwd: '/srv/b',
      issuedAt: '2026-01-02T03:04:05.000Z',
      expiresAt: '2026-01-02T03:05:00.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });

    expect(registry.countLocalSessionId('duplicate-local')).toBe(2);
    expect(registry.validate({ sessionId: 'duplicate-local' })).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        details: { reasonCode: 'AMBIGUOUS_LOCAL_SESSION_ID', matches: 2 },
      },
    });
    expect(
      registry.renew({
        sessionId: 'duplicate-local',
        expiresAt: '2026-01-02T03:10:00.000Z',
        now: new Date('2026-01-02T03:04:30.000Z'),
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', details: { reasonCode: 'AMBIGUOUS_LOCAL_SESSION_ID' } },
    });
    expect(registry.revoke('duplicate-local')).toBeUndefined();
    expect(registry.revoke('node-a:duplicate-local')).toMatchObject({
      nodeId: 'node-a',
      status: 'revoked',
    });
    expect(registry.revoke('duplicate-local', { nodeId: 'node-b' })).toMatchObject({
      nodeId: 'node-b',
      status: 'revoked',
    });
  });

  it('lists scoped session lifecycle state for operator visibility', () => {
    const registry = createSessionEnvelopeRegistry();
    registry.create({
      sessionId: 'active-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:active-session',
      cwd: '/srv/app',
      repoPath: '/srv/app',
      issuedAt: '2026-01-02T03:04:05.000Z',
      expiresAt: '2026-01-02T03:06:00.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });
    registry.create({
      sessionId: 'expired-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:expired-session',
      cwd: '/srv/app',
      repoPath: '/srv/app',
      issuedAt: '2026-01-02T03:04:04.000Z',
      expiresAt: '2026-01-02T03:04:30.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });

    const summaries = registry.listSummaries({
      now: new Date('2026-01-02T03:05:00.000Z'),
    });

    expect(summaries.map((entry) => [entry.sessionId, entry.status])).toEqual([
      ['active-session', 'active'],
      ['expired-session', 'expired'],
    ]);
    expect(registry.listActive(new Date('2026-01-02T03:05:00.000Z'))).toHaveLength(1);
  });

  it('renews only expiry while preserving scoped authority', () => {
    const registry = createSessionEnvelopeRegistry();
    const envelope = registry.create({
      sessionId: 'renewable-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:renewable-session',
      cwd: '/srv/app',
      repoPath: '/srv/app',
      issuedAt: '2026-01-02T03:04:05.000Z',
      expiresAt: '2026-01-02T03:05:00.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
      correlationId: 'corr-renew',
      auditId: 'audit-renew',
    });
    const beforeAuthority = {
      intent: envelope.intent,
      scope: envelope.scope,
      peerIdentity: envelope.peerIdentity,
      nodeId: envelope.nodeId,
      globalSessionId: envelope.globalSessionId,
      issuedAt: envelope.issuedAt,
      correlationId: envelope.correlationId,
      auditId: envelope.auditId,
    };

    const result = registry.renew({
      sessionId: envelope.sessionId,
      nodeId: envelope.nodeId,
      expiresAt: '2026-01-02T03:10:00.000Z',
      now: new Date('2026-01-02T03:04:30.000Z'),
    });

    expect(result).toMatchObject({
      ok: true,
      previousSummary: { expiresAt: '2026-01-02T03:05:00.000Z' },
      summary: { expiresAt: '2026-01-02T03:10:00.000Z', status: 'active' },
    });
    const renewed = registry.read(envelope.globalSessionId);
    expect(renewed?.expiresAt).toBe('2026-01-02T03:10:00.000Z');
    expect({
      intent: renewed?.intent,
      scope: renewed?.scope,
      peerIdentity: renewed?.peerIdentity,
      nodeId: renewed?.nodeId,
      globalSessionId: renewed?.globalSessionId,
      issuedAt: renewed?.issuedAt,
      correlationId: renewed?.correlationId,
      auditId: renewed?.auditId,
    }).toEqual(beforeAuthority);
  });

  it('preserves a renewed expiry when stale remote listings replay the old envelope', () => {
    const registry = createSessionEnvelopeRegistry();
    const envelope = registry.create({
      sessionId: 'stale-listed-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:stale-listed-session',
      cwd: '/srv/app',
      repoPath: '/srv/app',
      issuedAt: '2026-01-02T03:04:05.000Z',
      expiresAt: '2026-01-02T03:05:00.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });

    expect(
      registry.renew({
        sessionId: envelope.sessionId,
        nodeId: envelope.nodeId,
        expiresAt: '2026-01-02T03:10:00.000Z',
        now: new Date('2026-01-02T03:04:30.000Z'),
      })
    ).toMatchObject({ ok: true });

    const stored = registry.upsert(envelope);
    expect(stored.expiresAt).toBe('2026-01-02T03:10:00.000Z');
    expect(registry.read(envelope.globalSessionId)?.expiresAt).toBe(
      '2026-01-02T03:10:00.000Z'
    );
  });

  it('does not preserve renewed expiry when stale listings carry a different peer authority', () => {
    const cases = [
      {
        name: 'local user id',
        previousPeerIdentity: { kind: 'local-user' as const, id: 'local-a' },
        incomingPeerIdentity: { kind: 'local-user' as const, id: 'local-b' },
      },
      {
        name: 'relay node credential',
        previousPeerIdentity: {
          kind: 'relay-node' as const,
          nodeId: 'node-a',
          credentialId: 'credential-a',
        },
        incomingPeerIdentity: {
          kind: 'relay-node' as const,
          nodeId: 'node-a',
          credentialId: 'credential-b',
        },
      },
      {
        name: 'agent id',
        previousPeerIdentity: { kind: 'agent' as const, id: 'agent-a', adapter: 'codex' },
        incomingPeerIdentity: { kind: 'agent' as const, id: 'agent-b', adapter: 'codex' },
      },
      {
        name: 'agent adapter',
        previousPeerIdentity: { kind: 'agent' as const, id: 'agent-a', adapter: 'codex' },
        incomingPeerIdentity: { kind: 'agent' as const, id: 'agent-a', adapter: 'claude' },
      },
    ];

    for (const testCase of cases) {
      const registry = createSessionEnvelopeRegistry();
      const caseSlug = testCase.name.replace(/ /g, '-');
      const envelope = registry.create({
        sessionId: `stale-listed-${caseSlug}`,
        nodeId: 'node-a',
        globalSessionId: `node-a:stale-listed-${caseSlug}`,
        cwd: '/srv/app',
        repoPath: '/srv/app',
        issuedAt: '2026-01-02T03:04:05.000Z',
        expiresAt: '2026-01-02T03:05:00.000Z',
        intentKind: ROUTED_NODE_SESSION_INTENT,
        peerIdentity: testCase.previousPeerIdentity,
      });

      expect(
        registry.renew({
          sessionId: envelope.sessionId,
          nodeId: envelope.nodeId,
          expiresAt: '2026-01-02T03:10:00.000Z',
          now: new Date('2026-01-02T03:04:30.000Z'),
        })
      ).toMatchObject({ ok: true });

      const staleFromDifferentAuthority = {
        ...envelope,
        peerIdentity: testCase.incomingPeerIdentity,
      };
      const stored = registry.upsert(staleFromDifferentAuthority);

      expect(stored.expiresAt).toBe('2026-01-02T03:05:00.000Z');
      expect(stored.peerIdentity).toEqual(testCase.incomingPeerIdentity);
      expect(registry.read(envelope.globalSessionId)?.expiresAt).toBe(
        '2026-01-02T03:05:00.000Z'
      );
    }
  });

  it('denies renewal for expired, revoked, mismatched, and non-renewable sessions', () => {
    const registry = createSessionEnvelopeRegistry();
    const issuedAt = '2026-01-02T03:04:05.000Z';
    const active = registry.create({
      sessionId: 'active-renewal-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:active-renewal-session',
      cwd: '/srv/app',
      issuedAt,
      expiresAt: '2026-01-02T03:10:00.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });
    const expired = registry.create({
      sessionId: 'expired-renewal-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:expired-renewal-session',
      cwd: '/srv/app',
      issuedAt,
      expiresAt: '2026-01-02T03:04:10.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });
    const revoked = registry.create({
      sessionId: 'revoked-renewal-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:revoked-renewal-session',
      cwd: '/srv/app',
      issuedAt,
      expiresAt: '2026-01-02T03:10:00.000Z',
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });
    registry.revoke(revoked.sessionId, { nodeId: revoked.nodeId, reason: 'test-revoke' });
    const nonRenewable = registry.create({
      sessionId: 'non-renewable-session',
      nodeId: 'node-a',
      globalSessionId: 'node-a:non-renewable-session',
      cwd: '/srv/app',
      issuedAt,
      expiresAt: '2026-01-02T03:10:00.000Z',
      revocable: false,
      intentKind: ROUTED_NODE_SESSION_INTENT,
    });

    expect(
      registry.renew({
        sessionId: expired.sessionId,
        nodeId: expired.nodeId,
        expiresAt: '2026-01-02T03:20:00.000Z',
        now: new Date('2026-01-02T03:05:00.000Z'),
      })
    ).toMatchObject({ ok: false, error: { code: 'SESSION_EXPIRED' } });
    expect(
      registry.renew({
        sessionId: revoked.sessionId,
        nodeId: revoked.nodeId,
        expiresAt: '2026-01-02T03:20:00.000Z',
        now: new Date('2026-01-02T03:05:00.000Z'),
      })
    ).toMatchObject({ ok: false, error: { code: 'SESSION_REVOKED' } });
    expect(
      registry.renew({
        sessionId: active.sessionId,
        nodeId: 'node-b',
        expiresAt: '2026-01-02T03:20:00.000Z',
        now: new Date('2026-01-02T03:05:00.000Z'),
      })
    ).toMatchObject({ ok: false, error: { code: 'SESSION_MISMATCH' } });
    expect(
      registry.renew({
        sessionId: nonRenewable.sessionId,
        nodeId: nonRenewable.nodeId,
        expiresAt: '2026-01-02T03:20:00.000Z',
        now: new Date('2026-01-02T03:05:00.000Z'),
      })
    ).toMatchObject({ ok: false, error: { code: 'SESSION_NON_RENEWABLE' } });
  });
});
