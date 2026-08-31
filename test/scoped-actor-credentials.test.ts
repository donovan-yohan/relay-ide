import { describe, expect, it } from 'vitest';
import {
  ACTOR_CREDENTIAL_AUDIENCES,
  ACTOR_CREDENTIAL_TYPES,
  DEFAULT_SCOPED_ACTOR_CREDENTIAL_MAX_AUDIT_EVENTS,
  ScopedActorCredentialRegistry,
  createScopedActorCredentialAuditEntry,
  redactScopedActorCredentialForAudit,
  type ScopedActorCredentialValidationFailureReason,
} from '../shared/scoped-actor-credentials.js';

const NOW = new Date('2026-05-29T00:00:00.000Z');
const LATER = new Date('2026-05-29T00:05:00.000Z');
const EXPIRED = new Date('2026-05-28T23:59:59.000Z');

function registry(
  options: { maxAuditEvents?: number } = {}
): ScopedActorCredentialRegistry {
  return new ScopedActorCredentialRegistry({
    ...(options.maxAuditEvents === undefined
      ? {}
      : { maxAuditEvents: options.maxAuditEvents }),
    now: () => NOW,
    secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
  });
}

function issueAuditFixture(store: ScopedActorCredentialRegistry): string {
  return store.issue({
    actor: { type: 'cli', id: 'cli-1' },
    issuer: { id: 'operator-1' },
    audience: 'relay:registry-test',
    capabilities: ['context:read'],
    scope: { nodeIds: ['node-a'] },
    expiresAt: LATER,
    correlationId: 'corr-issue-audit-bound',
  }).token;
}

const AUDIT_FIXTURE_VALIDATION = {
  audience: 'relay:registry-test',
  requiredCapabilities: ['context:read'],
  scope: { nodeId: 'node-a' },
} as const;

describe('scoped actor credential registry', () => {
  it('defines closed actor types and audiences for this MVP', () => {
    expect(ACTOR_CREDENTIAL_TYPES).toEqual([
      'agent',
      'cli',
      'automation-system',
    ]);
    expect(ACTOR_CREDENTIAL_AUDIENCES).toEqual(
      expect.arrayContaining(['relay:registry-test', 'relay:cli-gateway:v1'])
    );
  });

  it('issues and validates a bounded credential with explicit audience, capability, and scopes', () => {
    const store = registry();
    const issued = store.issue({
      actor: { type: 'agent', id: 'agent-1', displayName: 'Codex worker' },
      issuer: { id: 'operator-1', displayName: 'operator' },
      audience: 'relay:registry-test',
      capabilities: ['session:read', 'context:read'],
      scope: {
        nodeIds: ['node-a'],
        sessionIds: ['session-a'],
        globalSessionIds: ['node-a:session-a'],
        workContextIds: ['work-context-a'],
        taskRefs: ['issue-802'],
      },
      metadata: {
        reason: 'bounded automation for #802',
        taskRef: 'issue-802',
        refs: ['github:issue:802'],
      },
      expiresAt: LATER,
      correlationId: 'corr-issue-1',
    });

    expect(issued.token).toMatch(/^relay-sac-v1\.[a-z0-9_-]+\.[a-z0-9_-]+$/);
    expect(issued.credential).toMatchObject({
      actor: { type: 'agent', id: 'agent-1' },
      issuer: { id: 'operator-1' },
      audience: 'relay:registry-test',
      capabilities: ['session:read', 'context:read'],
      scope: {
        nodeIds: ['node-a'],
        sessionIds: ['session-a'],
        globalSessionIds: ['node-a:session-a'],
        workContextIds: ['work-context-a'],
        taskRefs: ['issue-802'],
      },
      metadata: {
        reason: 'bounded automation for #802',
        taskRef: 'issue-802',
        refs: ['github:issue:802'],
      },
      expiresAt: LATER.toISOString(),
    });

    const valid = store.validate(issued.token, {
      audience: 'relay:registry-test',
      requiredCapabilities: ['session:read'],
      scope: {
        nodeId: 'node-a',
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        workContextId: 'work-context-a',
        taskRef: 'issue-802',
      },
      correlationId: 'corr-validate-1',
    });

    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.credential.id).toBe(issued.credential.id);
      expect(valid.grantedBits).toEqual(['session:read']);
    }
  });

  it('issues only the canonical input bound by strict preflight', () => {
    const store = registry();
    const input = {
      actor: { type: 'agent', id: 'agent-preflight' },
      issuer: { id: 'operator-1' },
      audience: 'relay:registry-test',
      capabilities: ['session:read'],
      scope: { nodeIds: ['node-a'] },
      expiresAt: LATER,
    };
    const prepared = store.prepareIssue(input, { requireFutureExpiry: true });

    // A caller cannot swap an expired or broader payload into a prepared
    // issuance after its future-expiry preflight has completed.
    input.expiresAt = EXPIRED;
    input.scope.nodeIds[0] = 'node-b';

    const issued = store.issuePrepared(prepared);
    expect(issued.credential).toMatchObject({
      expiresAt: LATER.toISOString(),
      scope: { nodeIds: ['node-a'] },
    });
  });

  it('rejects unsupported actor types and unknown issue-time capability grants', () => {
    const store = registry();

    expect(() =>
      store.issue({
        actor: { type: 'browser-human', id: 'human-1' },
        issuer: { id: 'operator-1' },
        audience: 'relay:registry-test',
        capabilities: ['session:read'],
        scope: { nodeIds: ['node-a'] },
        expiresAt: LATER,
      })
    ).toThrow(/UNSUPPORTED_ACTOR_TYPE/);

    expect(() =>
      store.issue({
        actor: { type: 'agent', id: 'agent-1' },
        issuer: { id: 'operator-1' },
        audience: 'relay:registry-test',
        capabilities: ['session:teleport'],
        scope: { nodeIds: ['node-a'] },
        expiresAt: LATER,
      })
    ).toThrow(/UNKNOWN_CAPABILITY/);
  });

  it.each([
    ['wrong_audience', { audience: 'relay:cli-gateway:v1' }],
    ['unknown_audience', { audience: 'relay:nope' }],
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
    ['wrong_path_scope', { scope: { path: '/repo-a/src/secrets.ts' } }],
    ['wrong_task_scope', { scope: { taskRef: 'issue-999' } }],
    ['missing_scope', { scope: { nodeId: undefined } }],
    ['unknown_capability', { requiredCapabilities: ['session:teleport'] }],
    ['insufficient_capability', { requiredCapabilities: ['rpc:fs:write'] }],
  ] satisfies [
    ScopedActorCredentialValidationFailureReason,
    Record<string, unknown>,
  ][])('fails closed for %s', (reason, override) => {
    const store = registry();
    const issued = store.issue({
      actor: { type: 'cli', id: 'cli-1' },
      issuer: { id: 'operator-1' },
      audience: 'relay:registry-test',
      capabilities: ['session:read'],
      scope: {
        nodeIds: ['node-a'],
        sessionIds: ['session-a'],
        globalSessionIds: ['node-a:session-a'],
        workContextIds: ['work-context-a'],
        repoIds: ['repo-a'],
        pathPrefixes: ['/repo-a/src/safe/'],
        taskRefs: ['issue-802'],
      },
      expiresAt: LATER,
    });
    const validateScope = {
      nodeId: 'node-a',
      sessionId: 'session-a',
      globalSessionId: 'node-a:session-a',
      workContextId: 'work-context-a',
      repoId: 'repo-a',
      path: '/repo-a/src/safe/file.ts',
      taskRef: 'issue-802',
    };
    const validation = store.validate(issued.token, {
      audience: 'relay:registry-test',
      requiredCapabilities: ['session:read'],
      scope: validateScope,
      ...override,
    });

    expect(validation).toMatchObject({ ok: false, reason });
  });

  it('requires validation request scope for repo, path prefix, and task scoped credentials', () => {
    const store = registry();
    const issued = store.issue({
      actor: { type: 'cli', id: 'cli-1' },
      issuer: { id: 'operator-1' },
      audience: 'relay:registry-test',
      capabilities: ['session:read'],
      scope: {
        repoIds: ['repo-a'],
        pathPrefixes: ['/repo-a/src/safe/'],
        taskRefs: ['issue-802'],
      },
      expiresAt: LATER,
    });

    expect(
      store.validate(issued.token, {
        audience: 'relay:registry-test',
        requiredCapabilities: ['session:read'],
      })
    ).toMatchObject({ ok: false, reason: 'missing_scope' });

    expect(
      store.validate(issued.token, {
        audience: 'relay:registry-test',
        requiredCapabilities: ['session:read'],
        scope: {
          repoId: 'repo-a',
          path: '/repo-a/src/safe/file.ts',
          taskRef: 'issue-802',
        },
      })
    ).toMatchObject({ ok: true });
  });

  it('fails closed for non-object scope input and non-string token validation', () => {
    const store = registry();

    expect(() =>
      store.issue({
        actor: { type: 'agent', id: 'agent-1' },
        issuer: { id: 'operator-1' },
        audience: 'relay:registry-test',
        capabilities: ['session:read'],
        scope: 'relay-sac-v1.synthetic.raw-secret-token-material' as never,
        expiresAt: LATER,
      })
    ).toThrow(/SCOPE_REQUIRED/);

    expect(
      store.validate(42 as never, {
        audience: 'relay:registry-test',
        requiredCapabilities: ['session:read'],
      })
    ).toMatchObject({ ok: false, reason: 'malformed_credential' });
  });

  it('requires expiry, enforces maximum ttl, expires tokens, and revokes without restart', () => {
    const store = registry();

    expect(() =>
      store.issue({
        actor: { type: 'agent', id: 'agent-1' },
        issuer: { id: 'operator-1' },
        audience: 'relay:registry-test',
        capabilities: ['session:read'],
        scope: { nodeIds: ['node-a'] },
      })
    ).toThrow(/EXPIRY_REQUIRED/);

    expect(() =>
      store.issue({
        actor: { type: 'agent', id: 'agent-1' },
        issuer: { id: 'operator-1' },
        audience: 'relay:registry-test',
        capabilities: ['session:read'],
        scope: { nodeIds: ['node-a'] },
        ttlMs: 60 * 60 * 1000,
      })
    ).toThrow(/EXPIRY_EXCEEDS_MAX_TTL/);

    const expired = store.issue({
      actor: { type: 'automation-system', id: 'cron-1' },
      issuer: { id: 'operator-1' },
      audience: 'relay:registry-test',
      capabilities: ['session:read'],
      scope: { nodeIds: ['node-a'] },
      expiresAt: EXPIRED,
    });
    expect(
      store.validate(expired.token, {
        audience: 'relay:registry-test',
        requiredCapabilities: ['session:read'],
        scope: { nodeId: 'node-a' },
      })
    ).toMatchObject({ ok: false, reason: 'expired' });

    const issued = store.issue({
      actor: { type: 'agent', id: 'agent-1' },
      issuer: { id: 'operator-1' },
      audience: 'relay:registry-test',
      capabilities: ['session:read'],
      scope: { nodeIds: ['node-a'] },
      expiresAt: LATER,
    });
    store.revoke(issued.credential.id, {
      revokedBy: 'operator-1',
      reason: 'operator request',
      correlationId: 'corr-revoke-1',
    });
    expect(
      store.validate(issued.token, {
        audience: 'relay:registry-test',
        requiredCapabilities: ['session:read'],
        scope: { nodeId: 'node-a' },
      })
    ).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('keeps token material out of registry snapshots and audit events', () => {
    const store = registry();
    const issued = store.issue({
      actor: { type: 'agent', id: 'agent-1' },
      issuer: { id: 'operator-1' },
      audience: 'relay:registry-test',
      capabilities: ['session:read'],
      scope: { nodeIds: ['node-a'] },
      metadata: {
        reason: 'investigate relay-sac-v1.synthetic.raw-secret-token-material',
        taskRef: 'issue-802',
      },
      expiresAt: LATER,
    });

    store.validate(issued.token, {
      audience: 'relay:registry-test',
      requiredCapabilities: ['session:read'],
      scope: { nodeId: 'node-a' },
      correlationId: 'corr-validate-1',
    });
    store.validate('relay-sac-v1.unknown.raw-secret-token-material', {
      audience: 'relay:registry-test',
      requiredCapabilities: ['session:read'],
      scope: { nodeId: 'node-a' },
      correlationId: 'corr-deny-1',
    });

    const serialized = JSON.stringify({
      credentials: store.listCredentials(),
      auditEvents: store.listAuditEvents(),
      auditEntry: createScopedActorCredentialAuditEntry({
        action: 'validate',
        decision: 'deny',
        reasonCode: 'MALFORMED_CREDENTIAL',
        credential: issued.credential,
        requiredCapabilities: ['session:read'],
        deniedCapabilities: ['session:read'],
        correlationId: 'corr-entry-1',
        material: {
          scope: {
            bearerToken: issued.token,
            nested: { authorization: `Bearer ${issued.token}` },
          },
          params: {
            bearerToken: issued.token,
            authorization: `Bearer ${issued.token}`,
          },
        },
      }),
      redacted: redactScopedActorCredentialForAudit(issued.credential),
    });

    expect(serialized).not.toContain(issued.token);
    expect(serialized).not.toContain('0123456789abcdef');
    expect(serialized).not.toContain('raw-secret-token-material');
    expect(serialized).not.toContain('secretHash');
    expect(serialized).toContain(issued.credential.id);
  });

  it('omits raw actor and issuer ids from audit-redacted credentials', () => {
    const store = registry();
    const issued = store.issue({
      actor: { type: 'agent', id: 'agent-1', displayName: 'worker' },
      issuer: { id: 'operator-1', displayName: 'operator' },
      audience: 'relay:registry-test',
      capabilities: ['session:read'],
      scope: { nodeIds: ['node-a'] },
      expiresAt: LATER,
    });

    const redacted = redactScopedActorCredentialForAudit(issued.credential);

    expect(redacted.actor).toMatchObject({
      type: 'agent',
      displayName: 'worker',
    });
    expect(redacted.actor).toHaveProperty('idHash');
    expect(redacted.actor).not.toHaveProperty('id');
    expect(redacted.issuer).toMatchObject({ displayName: 'operator' });
    expect(redacted.issuer).toHaveProperty('idHash');
    expect(redacted.issuer).not.toHaveProperty('id');
  });

  it('redacts custom audit material scope before exposing it', () => {
    const entry = createScopedActorCredentialAuditEntry({
      action: 'validate',
      decision: 'deny',
      reasonCode: 'MALFORMED_CREDENTIAL',
      material: {
        scope: {
          bearerToken: 'relay-sac-v1.custom.raw-secret-token-material',
          nested: {
            authorization:
              'Bearer relay-sac-v1.custom.raw-secret-token-material',
          },
        },
      },
    });

    const serialized = JSON.stringify(entry.material.scope);
    expect(serialized).not.toContain(
      'relay-sac-v1.custom.raw-secret-token-material'
    );
    expect(serialized).not.toContain(
      'Bearer relay-sac-v1.custom.raw-secret-token-material'
    );
  });
  // #1485: the channel subscribe stream re-validates before EVERY frame, so an
  // unbounded audit array retained one entry per frame for the hub's lifetime.
  it('bounds retained audit events under sustained correlated validation', () => {
    const store = registry({ maxAuditEvents: 8 });
    const token = issueAuditFixture(store);

    for (let index = 0; index < 200; index += 1) {
      const result = store.validate(token, {
        ...AUDIT_FIXTURE_VALIDATION,
        requiredCapabilities: ['context:read'],
        correlationId: `corr-frame-${index}`,
      });
      expect(result.ok).toBe(true);
      // The invariant that matters: the ring never exceeds its cap, at any
      // point during the run, not only at the end.
      expect(store.listAuditEvents().length).toBeLessThanOrEqual(8);
    }

    const events = store.listAuditEvents();
    expect(events).toHaveLength(8);
    // 1 issue + 200 validates recorded, 8 retained.
    expect(store.droppedAuditEventCount()).toBe(193);
    // Oldest first, and the retained window is the newest 8 events.
    expect(events.map((event) => event.correlationId)).toEqual([
      'corr-frame-192',
      'corr-frame-193',
      'corr-frame-194',
      'corr-frame-195',
      'corr-frame-196',
      'corr-frame-197',
      'corr-frame-198',
      'corr-frame-199',
    ]);
    // The evicted issue event is gone rather than silently duplicated.
    expect(events.some((event) => event.action === 'issue')).toBe(false);
  });

  it('bounds retained audit events at the default cap', () => {
    const store = registry();
    const token = issueAuditFixture(store);
    const pushes = DEFAULT_SCOPED_ACTOR_CREDENTIAL_MAX_AUDIT_EVENTS * 2;

    for (let index = 0; index < pushes; index += 1) {
      store.validate(token, {
        ...AUDIT_FIXTURE_VALIDATION,
        requiredCapabilities: ['context:read'],
        correlationId: `corr-default-${index}`,
      });
    }

    expect(store.listAuditEvents()).toHaveLength(
      DEFAULT_SCOPED_ACTOR_CREDENTIAL_MAX_AUDIT_EVENTS
    );
    expect(store.droppedAuditEventCount()).toBe(
      pushes + 1 - DEFAULT_SCOPED_ACTOR_CREDENTIAL_MAX_AUDIT_EVENTS
    );
  });

  it('coalesces the uncorrelated per-frame recheck instead of one entry per frame', () => {
    const store = registry({ maxAuditEvents: 8 });
    const token = issueAuditFixture(store);

    for (let index = 0; index < 500; index += 1) {
      expect(
        store.validate(token, {
          ...AUDIT_FIXTURE_VALIDATION,
          requiredCapabilities: ['context:read'],
        }).ok
      ).toBe(true);
    }

    const events = store.listAuditEvents();
    // Issue + one coalesced allow: 500 identical rechecks of an already
    // audited grant do not evict the interesting history behind them.
    expect(events).toHaveLength(2);
    expect(store.droppedAuditEventCount()).toBe(0);
    expect(events[0]).toMatchObject({ action: 'issue' });
    expect(events[1]).toMatchObject({
      action: 'validate',
      decision: 'allow',
      repeatedCount: 500,
    });

    // A state change still lands its own entry, behind the retained issue.
    store.revoke(store.listCredentials()[0]!.id, { revokedBy: 'operator-1' });
    const denied = store.validate(token, {
      ...AUDIT_FIXTURE_VALIDATION,
      requiredCapabilities: ['context:read'],
    });
    expect(denied).toMatchObject({ ok: false, reason: 'revoked' });
    const after = store.listAuditEvents();
    expect(after.map((event) => event.action)).toEqual([
      'issue',
      'validate',
      'revoke',
      'validate',
    ]);
    expect(after[3]).toMatchObject({ decision: 'revoked' });
    expect(after[3]).not.toHaveProperty('repeatedCount');
  });

  it('never folds a caller-correlated audit event into another entry', () => {
    const store = registry();
    const token = issueAuditFixture(store);

    store.validate(token, {
      ...AUDIT_FIXTURE_VALIDATION,
      requiredCapabilities: ['context:read'],
    });
    // Correlated repeats of an identical validation each keep their own id...
    store.validate(token, {
      ...AUDIT_FIXTURE_VALIDATION,
      requiredCapabilities: ['context:read'],
      correlationId: 'corr-request-a',
    });
    store.validate(token, {
      ...AUDIT_FIXTURE_VALIDATION,
      requiredCapabilities: ['context:read'],
      correlationId: 'corr-request-b',
    });
    // ...and an uncorrelated recheck does not fold into a correlated entry.
    store.validate(token, {
      ...AUDIT_FIXTURE_VALIDATION,
      requiredCapabilities: ['context:read'],
    });

    const events = store.listAuditEvents();
    expect(events).toHaveLength(5);
    expect(events.map((event) => event.correlationId).slice(2, 4)).toEqual([
      'corr-request-a',
      'corr-request-b',
    ]);
    expect(events.every((event) => event.repeatedCount === undefined)).toBe(
      true
    );
  });

  it('keeps the audit ring immutable to callers of listAuditEvents', () => {
    const store = registry();
    const token = issueAuditFixture(store);
    store.validate(token, {
      ...AUDIT_FIXTURE_VALIDATION,
      requiredCapabilities: ['context:read'],
    });

    const events = store.listAuditEvents();
    events[1]!.repeatedCount = 99;
    events[1]!.grantedBits.push('session:read');
    expect(store.listAuditEvents()[1]).not.toHaveProperty('repeatedCount');
    expect(store.listAuditEvents()[1]?.grantedBits).toEqual(['context:read']);
  });
});
