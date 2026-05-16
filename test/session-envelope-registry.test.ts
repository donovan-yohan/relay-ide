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
});
