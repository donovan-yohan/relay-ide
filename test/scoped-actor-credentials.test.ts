import { describe, expect, it } from 'vitest';
import {
  ACTOR_CREDENTIAL_AUDIENCES,
  ACTOR_CREDENTIAL_TYPES,
  ScopedActorCredentialRegistry,
  createScopedActorCredentialAuditEntry,
  redactScopedActorCredentialForAudit,
  type ScopedActorCredentialValidationFailureReason,
} from '../shared/scoped-actor-credentials.js';

const NOW = new Date('2026-05-29T00:00:00.000Z');
const LATER = new Date('2026-05-29T00:05:00.000Z');
const EXPIRED = new Date('2026-05-28T23:59:59.000Z');

function registry(): ScopedActorCredentialRegistry {
  return new ScopedActorCredentialRegistry({
    now: () => NOW,
    secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
  });
}

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
});
