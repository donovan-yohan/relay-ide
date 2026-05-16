import { describe, expect, it } from 'vitest';
import {
  canonicalConfirmationParams,
  createConfirmationChallengeStore,
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
    scope: { kind: 'repo', nodeId: 'node_prod', cwd: '/srv/app', repoPath: '/srv/app' },
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

describe('confirmation challenge store', () => {
  it('canonicalizes dangerous operation params deterministically without raw env or file bytes', () => {
    const execA = canonicalConfirmationParams('pty.exec.arbitrary', {
      command: 'npm test',
      cwd: '/srv/app',
      env: { B: '2', A: '1' },
    });
    const execB = canonicalConfirmationParams('pty.exec.arbitrary', {
      env: { A: '1', B: '2' },
      cwd: '/srv/app',
      command: 'npm test',
    });
    expect(execA).toEqual(execB);
    expect(execA).toMatchObject({ action: 'pty.exec.arbitrary', command: 'npm test', cwd: '/srv/app' });
    expect(JSON.stringify(execA)).not.toContain('"A":"1"');
    expect(execA).toHaveProperty('envHash');

    const write = canonicalConfirmationParams('rpc.fs.write', {
      path: '/srv/app/secrets.txt',
      content: 'super-secret',
    });
    expect(write).toMatchObject({
      action: 'rpc.fs.write',
      path: '/srv/app/secrets.txt',
      size: Buffer.byteLength('super-secret'),
    });
    expect(write).toHaveProperty('sha256');
    expect(JSON.stringify(write)).not.toContain('super-secret');

    expect(canonicalConfirmationParams('rpc.fs.delete', { path: '/tmp/x', recursive: true })).toMatchObject({
      action: 'rpc.fs.delete',
      path: '/tmp/x',
      recursive: true,
    });
    expect(canonicalConfirmationParams('rpc.git.write', { verb: 'push', refSpec: 'HEAD:main' })).toMatchObject({
      action: 'rpc.git.write',
      verb: 'push',
      refSpec: 'HEAD:main',
    });
  });

  it('requires distinct approval, mints a hashed single-use token, and binds redemption to exact params', () => {
    const store = createConfirmationChallengeStore({
      now: () => NOW,
      randomToken: () => 'raw-token',
      randomId: () => 'challenge-1',
    });
    const challenge = store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: canonicalConfirmationParams('rpc.fs.write', {
        cwd: '/srv/app',
        path: 'secrets.txt',
        content: 'hello',
      }),
    });

    const sameSession = store.approveChallenge({
      challengeId: challenge.challengeId,
      approverAuthSessionHash: 'requester-session',
      decision: 'approve',
      now: NOW,
    });
    expect(sameSession.ok).toBe(false);
    if (!sameSession.ok) expect(sameSession.reasonCode).toBe('CONFIRMATION_SAME_SESSION');

    const approved = store.approveChallenge({
      challengeId: challenge.challengeId,
      approverAuthSessionHash: 'approver-session',
      approverDisplayName: 'second browser',
      decision: 'approve',
      now: NOW,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error('expected approval');
    expect(approved.confirmationToken).toBe('raw-token');
    expect(approved.challenge.tokenHash).not.toBe('raw-token');
    expect(approved.challenge.approverAuthSessionHash).toBe('approver-session');

    const mismatch = store.redeemToken({
      token: 'raw-token',
      requesterAuthSessionHash: 'requester-session',
      decision: challengeDecision(),
      canonicalParams: canonicalConfirmationParams('rpc.fs.write', {
        cwd: '/srv/app',
        path: 'secrets.txt',
        content: 'tampered',
      }),
      now: NOW,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reasonCode).toBe('CONFIRMATION_PARAM_MISMATCH');

    const redeemed = store.redeemToken({
      token: 'raw-token',
      requesterAuthSessionHash: 'requester-session',
      decision: challengeDecision(),
      canonicalParams: canonicalConfirmationParams('rpc.fs.write', {
        cwd: '/srv/app',
        path: 'secrets.txt',
        content: 'hello',
      }),
      now: NOW,
    });
    expect(redeemed.ok).toBe(true);

    const usedAgain = store.redeemToken({
      token: 'raw-token',
      requesterAuthSessionHash: 'requester-session',
      decision: challengeDecision(),
      canonicalParams: canonicalConfirmationParams('rpc.fs.write', {
        cwd: '/srv/app',
        path: 'secrets.txt',
        content: 'hello',
      }),
      now: NOW,
    });
    expect(usedAgain.ok).toBe(false);
    if (!usedAgain.ok) expect(usedAgain.reasonCode).toBe('CONFIRMATION_ALREADY_USED');
  });

  it('expires, denies, deny+revokes, and caps failed mismatches with operator-readable reason codes', () => {
    const store = createConfirmationChallengeStore({
      now: () => NOW,
      randomToken: () => 'raw-token',
      randomId: () => 'challenge-1',
      challengeTtlMs: 1_000,
      tokenTtlMs: 1_000,
      maxFailedRedemptions: 2,
    });
    const canonicalParams = canonicalConfirmationParams('rpc.fs.write', { path: '/srv/app/a', content: 'a' });
    const challenge = store.createChallenge(challengeDecision({ params: canonicalParams }), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams,
    });

    expect(
      store.approveChallenge({
        challengeId: challenge.challengeId,
        approverAuthSessionHash: 'approver-session',
        decision: 'approve',
        now: new Date(NOW.getTime() + 1_001),
      })
    ).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_EXPIRED' });

    const denied = store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: challengeDecision().params as ReturnType<typeof canonicalConfirmationParams>,
    });
    expect(
      store.approveChallenge({
        challengeId: denied.challengeId,
        approverAuthSessionHash: 'approver-session',
        decision: 'deny',
        now: NOW,
      })
    ).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_DENIED' });

    const revoked = store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: challengeDecision().params as ReturnType<typeof canonicalConfirmationParams>,
    });
    expect(
      store.approveChallenge({
        challengeId: revoked.challengeId,
        approverAuthSessionHash: 'approver-session',
        decision: 'deny_revoke',
        now: NOW,
      })
    ).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_DENIED_REVOKE' });

    const capped = store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: challengeDecision().params as ReturnType<typeof canonicalConfirmationParams>,
    });
    const approved = store.approveChallenge({
      challengeId: capped.challengeId,
      approverAuthSessionHash: 'approver-session',
      decision: 'approve',
      now: NOW,
    });
    expect(approved.ok).toBe(true);
    const wrongParams = canonicalConfirmationParams('rpc.fs.write', { path: '/srv/app/a', content: 'wrong' });
    for (let i = 0; i < 2; i += 1) {
      const result = store.redeemToken({
        token: 'raw-token',
        requesterAuthSessionHash: 'requester-session',
        decision: challengeDecision(),
        canonicalParams: wrongParams,
        now: NOW,
      });
      expect(result).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_PARAM_MISMATCH' });
    }
    expect(store.getChallenge(capped.challengeId)?.status).toBe('invalidated');
  });

  it('expires stale list entries and bounds stored terminal challenges', () => {
    let current = NOW;
    let nextId = 0;
    const store = createConfirmationChallengeStore({
      now: () => current,
      randomId: () => `challenge-${++nextId}`,
      randomToken: () => `raw-token-${nextId}`,
      challengeTtlMs: 1_000,
      tokenTtlMs: 1_000,
      maxChallenges: 2,
    });
    const params = challengeDecision().params as ReturnType<typeof canonicalConfirmationParams>;
    const first = store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: params,
    });
    current = new Date(NOW.getTime() + 1_001);
    expect(store.listChallenges()).toEqual([
      expect.objectContaining({ challengeId: first.challengeId, status: 'expired' }),
    ]);

    current = new Date(NOW.getTime() + 2_100);
    store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: params,
    });
    store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: params,
    });
    const visible = store.listChallenges();
    expect(visible).toHaveLength(2);
    expect(visible.map((challenge) => challenge.challengeId)).not.toContain(first.challengeId);
  });
});

