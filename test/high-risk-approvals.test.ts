import { describe, expect, it } from 'vitest';
import {
  classifyHighRiskOperation,
  createHighRiskApprovalContract,
  isHighRiskApprovalOutcome,
} from '../server/high-risk-approvals.js';
import {
  canonicalConfirmationParams,
  createConfirmationChallengeStore,
  publicChallenge,
} from '../server/confirmation-challenges.js';
import type { HubPolicyDecision } from '../server/hub-policy-evaluator.js';

const NOW = new Date('2026-01-02T03:04:05.000Z');

function challengeDecision(overrides: Partial<HubPolicyDecision> = {}): HubPolicyDecision {
  return {
    decision: 'challenge',
    reasonCode: 'POLICY_CHALLENGE_REQUIRED',
    message: 'node ACL requires confirmation for this capability',
    nodeId: 'node_prod',
    peer: { kind: 'hub' },
    intent: { action: 'rpc.fs.write', target: 'node_prod' },
    scope: {
      kind: 'repo',
      nodeId: 'node_prod',
      cwd: '/srv/app',
      repoPath: '/srv/app',
      workspaceId: 'workspace-1',
    },
    trustTier: 'prod',
    aclRef: 'acl_prod',
    policyVersion: '1.0',
    requiredBits: ['rpc:fs:write'],
    grantedBits: [],
    deniedBits: [],
    challengeBits: ['rpc:fs:write'],
    unknownBits: [],
    sessionId: 'session-1',
    correlationId: 'corr-1',
    params: canonicalConfirmationParams('rpc.fs.write', {
      cwd: '/srv/app',
      path: 'secrets.txt',
      content: 'hello',
    }),
    ...overrides,
  };
}

describe('high-risk approval classifier', () => {
  it.each([
    ['cross-node control', { action: 'sessions.control.set-agent', sourceNodeId: 'node_a', targetNodeId: 'node_b', requiredCapabilities: ['session:attach', 'tab:mode:set-agent'] }],
    ['capability escalation / ACL widening', { action: 'nodes.acl.widen', targetNodeId: 'node_prod', requiredCapabilities: ['node:acl:widen'] }],
    ['shell/exec on high-trust node', { action: 'pty.exec.arbitrary', targetNodeId: 'node_prod', trustTier: 'prod', requiredCapabilities: ['pty:exec:arbitrary'] }],
    ['file write across boundary', { action: 'rpc.fs.write', targetNodeId: 'node_prod', scopeKind: 'path', boundaryCrossing: true, requiredCapabilities: ['rpc:fs:write'] }],
    ['credential or secret export', { action: 'credentials.export', targetNodeId: 'node_prod', requiredCapabilities: ['credential:export'] }],
    ['node revoke/rotate/re-pair/destructive lifecycle', { action: 'nodes.revoke', targetNodeId: 'node_prod', requiredCapabilities: ['node:lifecycle:destructive'] }],
    ['destructive session control', { action: 'sessions.kill', targetNodeId: 'node_prod', requiredCapabilities: ['session:control:kill'] }],
  ])('marks %s as approval-required with auditable reason', (_label, input) => {
    const result = classifyHighRiskOperation(input);
    expect(result.decision).toBe('approvalRequired');
    expect(result.riskReason).toMatch(/high-risk|cross-node|capability|exec|file|credential|node lifecycle|session control/i);
  });

  it('fails closed for unknown operations or capabilities while leaving low-risk read/ref-only flows silent', () => {
    expect(
      classifyHighRiskOperation({
        action: 'mystery.op',
        targetNodeId: 'node_prod',
        requiredCapabilities: ['rpc:fs:read'],
      })
    ).toMatchObject({ decision: 'deny', riskReason: 'unknown_operation' });
    expect(
      classifyHighRiskOperation({
        action: 'rpc.fs.read',
        targetNodeId: 'node_prod',
        requiredCapabilities: ['totally:unknown'],
      })
    ).toMatchObject({ decision: 'deny', riskReason: 'unknown_capability' });
    expect(
      classifyHighRiskOperation({
        action: 'context.write',
        targetNodeId: 'node_prod',
        requiredCapabilities: ['context:write'],
      })
    ).toMatchObject({ decision: 'silentAllowIfPolicyAllows', riskReason: 'low_risk_ref_only' });
    expect(
      classifyHighRiskOperation({
        action: 'rpc.fs.read',
        targetNodeId: 'node_prod',
        requiredCapabilities: ['rpc:fs:read'],
      })
    ).toMatchObject({ decision: 'silentAllowIfPolicyAllows', riskReason: 'low_risk_read' });
  });
});

describe('high-risk approval contract bindings', () => {
  it('binds schema, operation, risk, policy, requester actor, correlation, target, ttl, params hash, and one-time nonce without raw secrets', () => {
    const canonicalParams = canonicalConfirmationParams('rpc.fs.write', {
      cwd: '/srv/app',
      path: 'secrets.txt',
      content: 'hello',
      authorization: 'Bearer relay-super-secret-token',
    });
    const decision = challengeDecision({ params: canonicalParams });
    const contract = createHighRiskApprovalContract({
      challengeId: 'challenge-1',
      decision,
      canonicalParams,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
      requester: {
        kind: 'scoped-actor',
        authSessionHash: 'requester-session-hash',
        actorType: 'agent',
        actorId: 'agent/raw/id',
        credentialId: 'cred-raw-id',
        credentialJti: 'jti-raw-id',
        sessionId: 'session-1',
        workContextId: 'work-context-1',
      },
      approvalTarget: { kind: 'human', id: 'operator-1' },
      redemptionNonce: 'raw-confirmation-token',
    });

    expect(contract).toMatchObject({
      schemaVersion: 1,
      challengeKind: 'exact-operation-high-risk-approval',
      challengeId: 'challenge-1',
      outcome: 'challenge_created',
      correlationId: 'corr-1',
      operation: { action: 'rpc.fs.write', target: 'node_prod', nodeId: 'node_prod' },
      risk: { decision: 'approvalRequired' },
      policy: {
        aclRef: 'acl_prod',
        policyVersion: '1.0',
        trustTier: 'prod',
        requiredBits: ['rpc:fs:write'],
        challengeBits: ['rpc:fs:write'],
      },
      requester: {
        kind: 'scoped-actor',
        authSessionHash: 'requester-session-hash',
        actorType: 'agent',
        actorIdHash: expect.any(String),
        credentialIdHash: expect.any(String),
        credentialJtiHash: expect.any(String),
        sessionId: 'session-1',
        workContextId: 'work-context-1',
      },
      approvalTarget: { kind: 'human', idHash: expect.any(String) },
      paramsHash: expect.any(String),
      redemptionNonceHash: expect.any(String),
      contractHash: expect.any(String),
    });
    const serialized = JSON.stringify(contract);
    expect(serialized).not.toContain('raw-confirmation-token');
    expect(serialized).not.toContain('cred-raw-id');
    expect(serialized).not.toContain('jti-raw-id');
    expect(serialized).not.toContain('agent/raw/id');
    expect(serialized).not.toContain('hello');
    expect(serialized).not.toContain('relay-super-secret-token');
  });

  it('summarizes pty exec command text without exposing raw shell text to public challenge or audit material', () => {
    const command = 'curl -H "Authorization: Bearer relay-...456" https://example.test && echo ghp_12...cdef';
    const canonicalParams = canonicalConfirmationParams('pty.exec.arbitrary', {
      cwd: '/srv/app',
      command,
      env: { PATH: '/bin', SECRET_TOKEN: 'secret-env-value' },
    });

    expect(canonicalParams).toMatchObject({
      action: 'pty.exec.arbitrary',
      cwd: '/srv/app',
      commandHash: expect.any(String),
      commandByteCount: Buffer.byteLength(command, 'utf8'),
      commandCharCount: command.length,
      commandClasses: expect.arrayContaining(['secret-looking', 'shell-metacharacters']),
      envHash: expect.any(String),
    });
    expect(canonicalParams).not.toHaveProperty('command');

    const store = createConfirmationChallengeStore({
      now: () => NOW,
      randomId: () => 'pty-challenge-1',
      randomToken: () => 'raw-confirmation-token',
    });
    const challenge = store.createChallenge(
      challengeDecision({
        intent: { action: 'pty.exec.arbitrary', target: 'node_prod' },
        requiredBits: ['pty:exec:arbitrary'],
        challengeBits: ['pty:exec:arbitrary'],
        params: canonicalParams,
      }),
      {
        requesterAuthSessionHash: 'requester-session-hash',
        canonicalParams,
      }
    );
    const approved = store.approveChallenge({
      challengeId: challenge.challengeId,
      approverAuthSessionHash: 'operator-session',
      decision: 'approve',
      now: NOW,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error('expected approval');
    const publicJson = JSON.stringify(publicChallenge(challenge));
    const auditJson = JSON.stringify(approved.audit);
    for (const forbidden of [
      'relay-super-secret-token-123456',
      'ghp_12...cdef',
      'secret-env-value',
      command,
    ]) {
      expect(publicJson).not.toContain(forbidden);
      expect(auditJson).not.toContain(forbidden);
    }
  });

  it.each([
    'challenge_created',
    'approved',
    'denied',
    'expired',
    'redeemed',
    'reuse_denied',
    'mismatch_denied',
    'approval_target_invalid',
    'audit_write_failed',
  ])('recognizes typed fail-closed outcome %s', (outcome) => {
    expect(isHighRiskApprovalOutcome(outcome)).toBe(true);
  });

  it('rejects same actor, same credential, same session, and missing approver while accepting a distinct human operator', () => {
    const store = createConfirmationChallengeStore({
      now: () => NOW,
      randomId: () => 'challenge-1',
      randomToken: () => 'raw-confirmation-token',
    });
    const challenge = store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session-hash',
      requester: {
        kind: 'scoped-actor',
        authSessionHash: 'requester-session-hash',
        actorType: 'agent',
        actorId: 'agent-1',
        credentialId: 'cred-1',
        sessionId: 'session-1',
        workContextId: 'work-context-1',
      },
      approvalTarget: { kind: 'human', id: 'operator-1' },
      canonicalParams: canonicalConfirmationParams('rpc.fs.write', { path: '/srv/app/a', content: 'a' }),
    });

    expect(publicChallenge(challenge)).toMatchObject({
      contract: expect.objectContaining({
        challengeKind: 'exact-operation-high-risk-approval',
        requester: expect.objectContaining({ credentialIdHash: expect.any(String) }),
        approvalTarget: expect.objectContaining({ kind: 'human' }),
      }),
    });
    expect(JSON.stringify(publicChallenge(challenge))).not.toContain('cred-1');

    const missingApprover = store.approveChallenge({
      challengeId: challenge.challengeId,
      approverAuthSessionHash: 'operator-session',
      decision: 'approve',
      now: NOW,
    });
    expect(missingApprover).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_APPROVAL_TARGET_INVALID' });

    const sameActor = store.approveChallenge({
      challengeId: challenge.challengeId,
      approverAuthSessionHash: 'operator-session',
      approver: { kind: 'scoped-actor', actorType: 'agent', actorId: 'agent-1', credentialId: 'cred-2' },
      decision: 'approve',
      now: NOW,
    });
    expect(sameActor).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_SAME_ACTOR' });

    const sameCredential = store.approveChallenge({
      challengeId: challenge.challengeId,
      approverAuthSessionHash: 'operator-session',
      approver: { kind: 'human', actorId: 'operator-1', credentialId: 'cred-1' },
      decision: 'approve',
      now: NOW,
    });
    expect(sameCredential).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_SAME_CREDENTIAL' });

    const sameSession = store.approveChallenge({
      challengeId: challenge.challengeId,
      approverAuthSessionHash: 'different-browser',
      approver: { kind: 'human', actorId: 'operator-1', sessionId: 'session-1' },
      decision: 'approve',
      now: NOW,
    });
    expect(sameSession).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_SAME_SESSION' });

    const wrongOperator = store.approveChallenge({
      challengeId: challenge.challengeId,
      approverAuthSessionHash: 'operator-session',
      approver: { kind: 'human', actorId: 'operator-2', sessionId: 'operator-session-2' },
      decision: 'approve',
      now: NOW,
    });
    expect(wrongOperator).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_APPROVAL_TARGET_INVALID' });

    const approved = store.approveChallenge({
      challengeId: challenge.challengeId,
      approverAuthSessionHash: 'operator-session',
      approver: { kind: 'human', actorId: 'operator-1', sessionId: 'operator-session-2' },
      approverDisplayName: 'operator',
      decision: 'approve',
      now: NOW,
    });
    expect(approved).toMatchObject({ ok: true, reasonCode: 'CONFIRMATION_APPROVED' });
    if (!approved.ok) throw new Error('expected approval');
    expect(approved.challenge.outcome).toBe('approved');
    expect(approved.challenge.contract.outcome).toBe('approved');
    const approvedNonceHash = approved.challenge.contract.redemptionNonceHash;
    expect(approvedNonceHash).toEqual(expect.any(String));
    expect(JSON.stringify(approved.challenge.contract)).not.toContain('raw-confirmation-token');

    const redeemed = store.redeemToken({
      token: 'raw-confirmation-token',
      requesterAuthSessionHash: 'requester-session-hash',
      decision: challengeDecision(),
      canonicalParams: canonicalConfirmationParams('rpc.fs.write', { path: '/srv/app/a', content: 'a' }),
      now: NOW,
    });
    expect(redeemed).toMatchObject({ ok: true, reasonCode: 'CONFIRMATION_APPROVED' });
    if (!redeemed.ok) throw new Error('expected redemption');
    expect(redeemed.challenge.contract.outcome).toBe('redeemed');
    expect(redeemed.challenge.contract.redemptionNonceHash).toBe(approvedNonceHash);
    expect(JSON.stringify(publicChallenge(redeemed.challenge))).not.toContain('raw-confirmation-token');
  });

  it('exercises deny, expire, redeem, reuse, and fail-closed parameter/context drift invalidation', () => {
    let current = NOW;
    let nextId = 0;
    const store = createConfirmationChallengeStore({
      now: () => current,
      randomId: () => `challenge-${++nextId}`,
      randomToken: () => `raw-token-${nextId}`,
      challengeTtlMs: 1_000,
      tokenTtlMs: 1_000,
    });
    const canonicalParams = canonicalConfirmationParams('rpc.fs.write', {
      cwd: '/srv/app',
      path: 'secrets.txt',
      content: 'hello',
    });

    const denied = store.createChallenge(challengeDecision({ params: canonicalParams }), {
      requesterAuthSessionHash: 'requester-session-hash',
      canonicalParams,
    });
    const deniedResult = store.approveChallenge({
      challengeId: denied.challengeId,
      approverAuthSessionHash: 'operator-session',
      decision: 'deny',
      now: current,
    });
    expect(deniedResult).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_DENIED' });
    expect(store.getChallenge(denied.challengeId)).toMatchObject({ status: 'denied', outcome: 'denied' });

    const expired = store.createChallenge(challengeDecision({ params: canonicalParams }), {
      requesterAuthSessionHash: 'requester-session-hash',
      canonicalParams,
    });
    current = new Date(NOW.getTime() + 1_001);
    expect(
      store.approveChallenge({
        challengeId: expired.challengeId,
        approverAuthSessionHash: 'operator-session',
        decision: 'approve',
        now: current,
      })
    ).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_EXPIRED' });
    expect(store.getChallenge(expired.challengeId)).toMatchObject({ status: 'expired', outcome: 'expired' });

    current = NOW;
    const redeemable = store.createChallenge(challengeDecision({ params: canonicalParams }), {
      requesterAuthSessionHash: 'requester-session-hash',
      canonicalParams,
    });
    const approved = store.approveChallenge({
      challengeId: redeemable.challengeId,
      approverAuthSessionHash: 'operator-session',
      decision: 'approve',
      now: current,
    });
    expect(approved).toMatchObject({ ok: true, reasonCode: 'CONFIRMATION_APPROVED' });
    if (!approved.ok) throw new Error('expected approval');
    const redeemed = store.redeemToken({
      token: approved.confirmationToken,
      requesterAuthSessionHash: 'requester-session-hash',
      decision: challengeDecision({ params: canonicalParams }),
      canonicalParams,
      now: current,
    });
    expect(redeemed).toMatchObject({ ok: true, reasonCode: 'CONFIRMATION_APPROVED' });
    const reused = store.redeemToken({
      token: approved.confirmationToken,
      requesterAuthSessionHash: 'requester-session-hash',
      decision: challengeDecision({ params: canonicalParams }),
      canonicalParams,
      now: current,
    });
    expect(reused).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_ALREADY_USED' });
    if (reused.ok) throw new Error('expected reuse denial');
    expect(reused.audit).toMatchObject({
      eventType: 'failed_redemption',
      decision: 'failed',
      reasonCode: 'CONFIRMATION_ALREADY_USED',
    });

    const drift = store.createChallenge(challengeDecision({ params: canonicalParams }), {
      requesterAuthSessionHash: 'requester-session-hash',
      canonicalParams,
    });
    const driftApproved = store.approveChallenge({
      challengeId: drift.challengeId,
      approverAuthSessionHash: 'operator-session',
      decision: 'approve',
      now: current,
    });
    if (!driftApproved.ok) throw new Error('expected drift approval');
    const driftResult = store.redeemToken({
      token: driftApproved.confirmationToken,
      requesterAuthSessionHash: 'requester-session-hash',
      decision: challengeDecision({ params: canonicalParams }),
      canonicalParams: canonicalConfirmationParams('rpc.fs.write', {
        cwd: '/srv/app',
        path: 'secrets.txt',
        content: 'tampered',
      }),
      now: current,
    });
    expect(driftResult).toMatchObject({
      ok: false,
      reasonCode: 'CONFIRMATION_PARAM_MISMATCH',
      challenge: {
        status: 'invalidated',
        failedRedemptions: 1,
        outcome: 'mismatch_denied',
      },
    });
    expect(driftResult.challenge?.tokenHash).toBeUndefined();
    expect(driftResult.challenge?.requesterToken).toBeUndefined();
    expect(
      store.redeemToken({
        token: driftApproved.confirmationToken,
        requesterAuthSessionHash: 'requester-session-hash',
        decision: challengeDecision({ params: canonicalParams }),
        canonicalParams,
        now: current,
      })
    ).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_TOKEN_INVALID' });

    const contextDrift = store.createChallenge(challengeDecision({ params: canonicalParams }), {
      requesterAuthSessionHash: 'requester-session-hash',
      canonicalParams,
    });
    const contextApproved = store.approveChallenge({
      challengeId: contextDrift.challengeId,
      approverAuthSessionHash: 'operator-session',
      decision: 'approve',
      now: current,
    });
    if (!contextApproved.ok) throw new Error('expected context approval');
    const contextResult = store.redeemToken({
      token: contextApproved.confirmationToken,
      requesterAuthSessionHash: 'requester-session-hash',
      decision: challengeDecision({ params: canonicalParams, sessionId: 'session-2' }),
      canonicalParams,
      now: current,
    });
    expect(contextResult).toMatchObject({
      ok: false,
      reasonCode: 'CONFIRMATION_CONTEXT_MISMATCH',
      challenge: {
        status: 'invalidated',
        failedRedemptions: 1,
        outcome: 'mismatch_denied',
      },
    });
    expect(contextResult.challenge?.tokenHash).toBeUndefined();
    expect(contextResult.challenge?.requesterToken).toBeUndefined();
  });
});
