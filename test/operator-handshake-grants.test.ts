import { describe, expect, it } from 'vitest';
import {
  HANDSHAKE_GRANT_AUDIENCES,
  HANDSHAKE_GRANT_ACTOR_TYPES,
  HandshakeGrantRegistry,
  HandshakeGrantRegistryError,
  createHandshakeGrantAuditEntry,
  operatorHandshakeGrantApprovalCopy,
  redactHandshakeGrantForAudit,
  type HandshakeGrantValidationFailureReason,
} from '../shared/operator-handshake-grants.js';

const NOW = new Date('2026-05-29T00:00:00.000Z');
const LATER = new Date('2026-05-29T00:05:00.000Z');
const EXPIRED = new Date('2026-05-28T23:59:59.000Z');

function registry(): HandshakeGrantRegistry {
  return new HandshakeGrantRegistry({
    now: () => NOW,
    secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
  });
}

function requestedGrant(store = registry()) {
  const grant = store.request({
    id: 'grant-1',
    actor: { type: 'agent', id: 'agent-1', displayName: 'Hermes worker' },
    issuer: { id: 'operator-1', displayName: 'operator' },
    audience: 'relay:operator-handshake:v1',
    capabilities: ['session:read', 'logs:read'],
    scope: {
      nodeIds: ['node-a'],
      sessionIds: ['session-a'],
      globalSessionIds: ['node-a:session-a'],
      workContextIds: ['work-context-a'],
      repoIds: ['repo-a'],
      pathPrefixes: ['/repo-a/src/safe/'],
      taskRefs: ['issue-813'],
    },
    device: { id: 'device-a', displayName: 'work-mac' },
    sessionBinding: {
      sessionId: 'session-a',
      globalSessionId: 'node-a:session-a',
      workContextId: 'work-context-a',
      authSessionHash: 'auth-session-hash-a',
    },
    metadata: {
      reason: 'bounded handshake for issue #813',
      taskRef: 'issue-813',
      refs: ['github:issue:813'],
    },
    expiresAt: LATER,
    correlationId: 'corr-request-1',
  });
  return { store, grant };
}

function approvedGrant() {
  const { store, grant } = requestedGrant();
  const approved = store.approve(grant.id, {
    approvedBy: { id: 'operator-1', displayName: 'operator' },
    correlationId: 'corr-approve-1',
  });
  return { store, grant: approved.grant, handle: approved.handle };
}

describe('operator handshake grant registry', () => {
  it('defines closed actor and audience lanes for the handshake MVP', () => {
    expect(HANDSHAKE_GRANT_ACTOR_TYPES).toEqual([
      'agent',
      'cli',
      'automation-system',
    ]);
    expect(HANDSHAKE_GRANT_AUDIENCES).toEqual(
      expect.arrayContaining([
        'relay:operator-handshake:v1',
        'relay:registry-test',
      ])
    );
  });

  it('requests, approves, and validates a bounded one-time grant without minting a browser or scoped actor token', () => {
    const { store, grant, handle } = approvedGrant();

    expect(handle).toMatch(/^relay-ohg-v1\.grant-1\.[a-f0-9]+$/);
    expect(handle).not.toMatch(/^relay-sac-v1\./);
    expect(grant).toMatchObject({
      id: 'grant-1',
      jti: 'grant-1',
      status: 'approved',
      actor: { type: 'agent', id: 'agent-1' },
      issuer: { displayName: 'operator' },
      audience: 'relay:operator-handshake:v1',
      capabilities: ['session:read', 'logs:read'],
      scope: {
        nodeIds: ['node-a'],
        sessionIds: ['session-a'],
        globalSessionIds: ['node-a:session-a'],
        workContextIds: ['work-context-a'],
        repoIds: ['repo-a'],
        pathPrefixes: ['/repo-a/src/safe/'],
        taskRefs: ['issue-813'],
      },
      device: { displayName: 'work-mac' },
      sessionBinding: {
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        workContextId: 'work-context-a',
      },
      expiresAt: LATER.toISOString(),
    });
    expect(JSON.stringify(grant)).not.toContain('operator-1');
    expect(JSON.stringify(grant)).not.toContain('device-a');
    expect(JSON.stringify(grant)).not.toContain('handleHash');

    const valid = store.validate(handle, {
      audience: 'relay:operator-handshake:v1',
      requiredCapabilities: ['session:read'],
      actor: { type: 'agent', id: 'agent-1' },
      deviceId: 'device-a',
      sessionBinding: {
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        workContextId: 'work-context-a',
        authSessionHash: 'auth-session-hash-a',
      },
      scope: {
        nodeId: 'node-a',
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        workContextId: 'work-context-a',
        repoId: 'repo-a',
        path: '/repo-a/src/safe/file.ts',
        taskRef: 'issue-813',
      },
      correlationId: 'corr-validate-1',
    });

    expect(valid).toMatchObject({ ok: true, consumed: true });
    expect(store.getGrant(grant.id)).toMatchObject({ status: 'consumed' });
  });

  it.each([
    ['wrong_audience', { audience: 'relay:registry-test' }],
    ['unknown_audience', { audience: 'relay:nope' }],
    ['actor_mismatch', { actor: { type: 'agent', id: 'agent-2' } }],
    ['device_mismatch', { deviceId: 'device-b' }],
    ['session_mismatch', { sessionBinding: { sessionId: 'session-b' } }],
    ['wrong_node_scope', { scope: { nodeId: 'node-b' } }],
    ['wrong_session_scope', { scope: { sessionId: 'session-b' } }],
    [
      'wrong_global_session_scope',
      { scope: { globalSessionId: 'node-b:session-b' } },
    ],
    [
      'wrong_work_context_scope',
      { scope: { workContextId: 'work-context-b' } },
    ],
    ['wrong_repo_scope', { scope: { repoId: 'repo-b' } }],
    ['wrong_path_scope', { scope: { path: '/repo-a/src/secret.ts' } }],
    ['wrong_task_scope', { scope: { taskRef: 'issue-999' } }],
    ['missing_scope', { scope: { nodeId: undefined } }],
    ['unknown_capability', { requiredCapabilities: ['session:teleport'] }],
    ['insufficient_capability', { requiredCapabilities: ['rpc:fs:write'] }],
  ] satisfies [
    HandshakeGrantValidationFailureReason,
    Record<string, unknown>,
  ][])('fails closed for %s', (reason, override) => {
    const { store, handle } = approvedGrant();
    const validInput = {
      audience: 'relay:operator-handshake:v1',
      requiredCapabilities: ['session:read'],
      actor: { type: 'agent', id: 'agent-1' },
      deviceId: 'device-a',
      sessionBinding: {
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        workContextId: 'work-context-a',
        authSessionHash: 'auth-session-hash-a',
      },
      scope: {
        nodeId: 'node-a',
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        workContextId: 'work-context-a',
        repoId: 'repo-a',
        path: '/repo-a/src/safe/file.ts',
        taskRef: 'issue-813',
      },
      consume: false,
    };

    expect(
      store.validate(handle, { ...validInput, ...override })
    ).toMatchObject({
      ok: false,
      reason,
    });
  });

  it('rejects replay after one successful validation consumes the grant', () => {
    const { store, handle } = approvedGrant();
    const input = {
      audience: 'relay:operator-handshake:v1',
      requiredCapabilities: ['session:read'],
      actor: { type: 'agent', id: 'agent-1' },
      deviceId: 'device-a',
      sessionBinding: {
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        workContextId: 'work-context-a',
        authSessionHash: 'auth-session-hash-a',
      },
      scope: {
        nodeId: 'node-a',
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        workContextId: 'work-context-a',
        repoId: 'repo-a',
        path: '/repo-a/src/safe/file.ts',
        taskRef: 'issue-813',
      },
    };

    expect(store.validate(handle, input)).toMatchObject({ ok: true });
    expect(store.validate(handle, input)).toMatchObject({
      ok: false,
      reason: 'replayed',
    });
    expect(store.listAuditEvents().map((event) => event.reasonCode)).toContain(
      'HANDSHAKE_GRANT_REPLAYED'
    );
  });

  it('issues and redeems channel-scoped grants without widening the approved set', () => {
    const store = registry();
    const grant = store.request({
      id: 'grant-channels',
      actor: { type: 'cli', id: 'channel-peer' },
      issuer: { id: 'operator-1' },
      audience: 'relay:cli-gateway:v1',
      capabilities: ['context:read'],
      scope: { channelIds: ['channel-a', 'channel-b'] },
      ttlMs: 60_000,
    });
    expect(grant.scope.channelIds).toEqual(['channel-a', 'channel-b']);
    const approved = store.approve(grant.id, {
      approvedBy: { id: 'operator-1' },
    });
    expect(approved.grant.scope.channelIds).toEqual(['channel-a', 'channel-b']);
    expect(approved.copy.details).toContain(
      'Scope: channelIds=channel-a,channel-b'
    );
    expect(
      store.validate(approved.handle, {
        audience: 'relay:cli-gateway:v1',
        actor: { type: 'cli', id: 'channel-peer' },
        requiredCapabilities: ['context:read'],
        scope: { channelIds: ['channel-a'] },
        consume: false,
      })
    ).toMatchObject({ ok: true });
    expect(
      store.validate(approved.handle, {
        audience: 'relay:cli-gateway:v1',
        actor: { type: 'cli', id: 'channel-peer' },
        requiredCapabilities: ['context:read'],
        scope: { channelIds: ['channel-a', 'channel-c'] },
        consume: false,
      })
    ).toMatchObject({ ok: false, reason: 'wrong_channel_scope' });
    expect(store.getGrant(grant.id)?.scope.channelIds).toEqual([
      'channel-a',
      'channel-b',
    ]);
  });

  it('rejects lane-mixed browser, scoped actor, pair-token, and node credentials', () => {
    const store = registry();
    for (const foreign of [
      'Bearer relay-sac-v1.credential.raw-secret',
      'relay-sac-v1.credential.raw-secret',
      'relay-pair-token-raw-material',
      'relay-node-credential-raw-material',
      'connect.sid=s%3Araw-browser-cookie',
    ]) {
      expect(
        store.validate(foreign, {
          audience: 'relay:operator-handshake:v1',
          requiredCapabilities: ['session:read'],
        })
      ).toMatchObject({ ok: false, reason: 'lane_mixing' });
    }
  });

  it('expires and revokes grants without accepting the handle afterward', () => {
    const expiredStore = registry();
    const expiredGrant = expiredStore.request({
      actor: { type: 'cli', id: 'cli-1' },
      issuer: { id: 'operator-1' },
      audience: 'relay:operator-handshake:v1',
      capabilities: ['session:read'],
      scope: { nodeIds: ['node-a'] },
      expiresAt: EXPIRED,
    });
    const expired = expiredStore.approve(expiredGrant.id, {
      approvedBy: { id: 'operator-1' },
    });
    expect(
      expiredStore.validate(expired.handle, {
        audience: 'relay:operator-handshake:v1',
        requiredCapabilities: ['session:read'],
        scope: { nodeId: 'node-a' },
      })
    ).toMatchObject({ ok: false, reason: 'expired' });

    const { store, grant, handle } = approvedGrant();
    store.revoke(grant.id, {
      revokedBy: { id: 'operator-1' },
      reason: 'operator request',
    });
    expect(
      store.validate(handle, {
        audience: 'relay:operator-handshake:v1',
        requiredCapabilities: ['session:read'],
        scope: { nodeId: 'node-a' },
      })
    ).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('requires #807 approval evidence before approving high-risk capability grants', () => {
    const store = registry();
    const grant = store.request({
      actor: { type: 'automation-system', id: 'automation-1' },
      issuer: { id: 'operator-1' },
      audience: 'relay:operator-handshake:v1',
      capabilities: ['node:lifecycle:destructive'],
      scope: { nodeIds: ['node-a'] },
      expiresAt: LATER,
    });

    expect(() =>
      store.approve(grant.id, { approvedBy: { id: 'operator-1' } })
    ).toThrow(HandshakeGrantRegistryError);
    expect(store.getGrant(grant.id)).toMatchObject({ status: 'denied' });

    const malformedApprovals: Array<[string, unknown]> = [
      ['empty', {}],
      [
        'missing-approved-at',
        { challengeId: 'challenge-1', contractHash: 'hash-1' },
      ],
      [
        'blank-challenge-id',
        {
          challengeId: '   ',
          contractHash: 'hash-1',
          approvedAt: NOW.toISOString(),
        },
      ],
      [
        'non-string-contract-hash',
        {
          challengeId: 'challenge-1',
          contractHash: 123,
          approvedAt: NOW.toISOString(),
        },
      ],
    ];
    for (const [suffix, highRiskApproval] of malformedApprovals) {
      const malformedStore = registry();
      const malformedGrant = malformedStore.request({
        id: `malformed-high-risk-grant-${suffix}`,
        actor: { type: 'automation-system', id: 'automation-1' },
        issuer: { id: 'operator-1' },
        audience: 'relay:operator-handshake:v1',
        capabilities: ['credential:export'],
        scope: { nodeIds: ['node-a'] },
        expiresAt: LATER,
      });
      expect(() =>
        malformedStore.approve(malformedGrant.id, {
          approvedBy: { id: 'operator-1' },
          highRiskApproval: highRiskApproval as never,
        })
      ).toThrow(HandshakeGrantRegistryError);
      expect(malformedStore.getGrant(malformedGrant.id)).toMatchObject({
        status: 'denied',
      });
    }

    const approvedStore = registry();
    const approvedGrant = approvedStore.request({
      id: 'high-risk-grant-2',
      actor: { type: 'automation-system', id: 'automation-1' },
      issuer: { id: 'operator-1' },
      audience: 'relay:operator-handshake:v1',
      capabilities: ['node:lifecycle:destructive'],
      scope: { nodeIds: ['node-a'] },
      expiresAt: LATER,
    });
    expect(
      approvedStore.approve(approvedGrant.id, {
        approvedBy: { id: 'operator-1' },
        highRiskApproval: {
          challengeId: 'challenge-1',
          contractHash: 'hash-1',
          approvedAt: NOW.toISOString(),
        },
      }).grant.highRiskApproval
    ).toMatchObject({ challengeId: 'challenge-1', contractHash: 'hash-1' });
  });

  it('keeps grant handles, browser cookies, scoped actor tokens, pair tokens, and node credentials out of snapshots/audit payloads', () => {
    const { store, grant, handle } = approvedGrant();
    store.validate(handle, {
      audience: 'relay:operator-handshake:v1',
      requiredCapabilities: ['session:read'],
      actor: { type: 'agent', id: 'agent-1' },
      deviceId: 'device-a',
      sessionBinding: {
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        workContextId: 'work-context-a',
        authSessionHash: 'auth-session-hash-a',
      },
      scope: {
        nodeId: 'node-a',
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        workContextId: 'work-context-a',
        repoId: 'repo-a',
        path: '/repo-a/src/safe/file.ts',
        taskRef: 'issue-813',
      },
    });

    const rawCookie = 'connect.sid=s%3Araw-browser-cookie';
    const rawScopedActor = 'relay-sac-v1.credential.raw-secret-token-material';
    const rawPairToken = 'relay-pair-token-raw-material';
    const rawNodeCredential = 'relay-node-credential-raw-material';
    const serialized = JSON.stringify({
      grants: store.listGrants(),
      auditEvents: store.listAuditEvents(),
      auditEntry: createHandshakeGrantAuditEntry({
        action: 'validate',
        decision: 'deny',
        reasonCode: 'HANDSHAKE_GRANT_LANE_MIXING',
        grant,
        requiredCapabilities: ['session:read'],
        deniedCapabilities: ['session:read'],
        material: {
          scope: {
            grantHandle: handle,
            browserCookie: rawCookie,
            scopedActorToken: rawScopedActor,
            pairToken: rawPairToken,
            nodeCredential: rawNodeCredential,
          },
          params: {
            authorization: `Bearer ${handle}`,
            credential: rawNodeCredential,
          },
        },
      }),
      redacted: redactHandshakeGrantForAudit(grant),
    });

    expect(serialized).not.toContain(handle);
    expect(serialized).not.toContain('raw-browser-cookie');
    expect(serialized).not.toContain('raw-secret-token-material');
    expect(serialized).not.toContain(rawPairToken);
    expect(serialized).not.toContain(rawNodeCredential);
    expect(serialized).not.toContain('0123456789abcdef');
    expect(serialized).not.toContain('handleHash');
  });

  it('keeps hostile grant params and lifecycle reasons out of public and audit payloads', () => {
    const deniedStore = registry();
    const { grant: pendingGrant } = requestedGrant(deniedStore);
    const denialReason =
      'denial raw reason connect.sid=s%3Adeny-cookie token=deny-secret';
    const deniedGrant = deniedStore.deny(pendingGrant.id, {
      deniedBy: { id: 'operator-raw-deny-id', displayName: 'operator' },
      reason: denialReason,
      correlationId: 'corr-deny-redaction',
    });
    if (!deniedGrant) throw new Error('expected denied grant');

    const {
      store: revokedStore,
      grant: approvedForRevocation,
      handle: revokedHandle,
    } = approvedGrant();
    const revocationReason =
      'revocation raw reason connect.sid=s%3Arevoke-cookie token=revoke-secret';
    const revokedGrant = revokedStore.revoke(approvedForRevocation.id, {
      revokedBy: { id: 'operator-raw-revoke-id', displayName: 'operator' },
      reason: revocationReason,
      correlationId: 'corr-revoke-redaction',
    });
    if (!revokedGrant) throw new Error('expected revoked grant');

    const rawCookie = 'connect.sid=s%3Araw-browser-cookie';
    const tokenOnly = 'token=raw-token-only-secret';
    const rawHandle = `${revokedHandle}-malicious-copy`;
    const rawPairToken = 'relay-pair-token-malicious-material';
    const rawNodeCredential = 'relay-node-credential-malicious-material';
    const rawActorId = 'malicious-raw-actor-id';
    const auditEntry = createHandshakeGrantAuditEntry({
      action: 'validate',
      decision: 'deny',
      reasonCode: 'HANDSHAKE_GRANT_MALICIOUS_PARAMS',
      grant: revokedGrant,
      material: {
        scope: {
          note: `${rawCookie} ${tokenOnly}`,
          grantHandle: rawHandle,
        },
        params: {
          note: `${rawCookie} ${tokenOnly}`,
          grant: {
            actor: { id: rawActorId },
            deniedReason: denialReason,
            revocationReason,
            handle: rawHandle,
            pairToken: rawPairToken,
            nodeCredential: rawNodeCredential,
          },
        },
      },
    });

    const serialized = JSON.stringify({
      deniedGrant,
      deniedByIdSurface: deniedStore.listGrants(),
      deniedLookup: deniedStore.getGrant(pendingGrant.id),
      deniedAuditEvents: deniedStore.listAuditEvents(),
      revokedGrant,
      revokedSurface: revokedStore.listGrants(),
      revokedLookup: revokedStore.getGrant(approvedForRevocation.id),
      revokedAuditEvents: revokedStore.listAuditEvents(),
      auditEntry,
      redactedDenied: redactHandshakeGrantForAudit(deniedGrant),
      redactedRevoked: redactHandshakeGrantForAudit(revokedGrant),
    });

    expect(serialized).not.toContain(denialReason);
    expect(serialized).not.toContain(revocationReason);
    expect(serialized).not.toContain('raw reason');
    expect(serialized).not.toContain('raw-browser-cookie');
    expect(serialized).not.toContain('raw-token-only-secret');
    expect(serialized).not.toContain(rawHandle);
    expect(serialized).not.toContain(rawPairToken);
    expect(serialized).not.toContain(rawNodeCredential);
    expect(serialized).not.toContain(rawActorId);
    expect(serialized).not.toContain('operator-raw-deny-id');
    expect(serialized).not.toContain('operator-raw-revoke-id');
  });

  it('renders approval copy with delegation, TTL, actor, audience, scope, and revoke path', () => {
    const { grant } = requestedGrant();
    const copy = operatorHandshakeGrantApprovalCopy(grant);

    expect(copy.title).toContain('Approve one-time Relay handshake grant');
    expect(copy.summary).toContain('session:read');
    expect(copy.summary).toContain('agent:agent-1');
    expect(copy.summary).toContain('relay:operator-handshake:v1');
    expect(copy.summary).toContain(LATER.toISOString());
    expect(copy.summary).toContain('not a browser login');
    expect(copy.details.join('\n')).toContain('workContextIds=work-context-a');
    expect(copy.details.join('\n')).toContain(
      'Revoke: DELETE /operator/handshake-grants/grant-1'
    );
    expect(copy.revokePath).toBe('/operator/handshake-grants/grant-1');
  });
});
