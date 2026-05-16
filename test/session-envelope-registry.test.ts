import { describe, expect, it } from 'vitest';
import {
  LOCAL_COMPATIBILITY_SESSION_INTENT,
  ROUTED_NODE_SESSION_INTENT,
} from '../shared/session-envelope.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';

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
});
