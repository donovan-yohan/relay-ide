import { createHash } from 'node:crypto';
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
    expect(execA).toMatchObject({
      action: 'pty.exec.arbitrary',
      cwd: '/srv/app',
      commandHash: createHash('sha256').update('npm test').digest('hex'),
      commandByteCount: Buffer.byteLength('npm test'),
      commandCharCount: 'npm test'.length,
      commandClasses: [],
    });
    expect(execA).not.toHaveProperty('command');
    expect(JSON.stringify(execA)).not.toContain('npm test');
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

    const sessionCreateA = canonicalConfirmationParams('sessions.create', {
      type: 'terminal',
      cwd: '/srv/app',
      command: 'npm test',
      initialPrompt: 'ship it',
    });
    const sessionCreateB = canonicalConfirmationParams('sessions.create', {
      type: 'terminal',
      cwd: '/srv/app',
      command: 'npm run build',
      initialPrompt: 'ship it',
    });
    expect(sessionCreateA).toMatchObject({ action: 'sessions.create', type: 'terminal', cwd: '/srv/app' });
    expect(sessionCreateA).toHaveProperty('paramsHash');
    expect(sessionCreateA.paramsHash).not.toBe(sessionCreateB.paramsHash);
    expect(JSON.stringify(sessionCreateA)).not.toContain('ship it');
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
    expect(approved.challenge.requesterToken).toBe('raw-token');
    expect(approved.challenge.approverAuthSessionHash).toBe('approver-session');
    expect(approved.audit.peer.principalHash).toBe('approver-session');
    expect(approved.audit.peer.principalHash).not.toBe('requester-session');
    expect(approved.audit.peer.displayName).toBe('second browser');

    const approverPickup = store.getRequesterToken({
      challengeId: challenge.challengeId,
      requesterAuthSessionHash: 'approver-session',
      now: NOW,
    });
    expect(approverPickup.ok).toBe(false);
    if (!approverPickup.ok) expect(approverPickup.reasonCode).toBe('CONFIRMATION_REQUESTER_MISMATCH');

    const requesterPickup = store.getRequesterToken({
      challengeId: challenge.challengeId,
      requesterAuthSessionHash: 'requester-session',
      now: NOW,
    });
    expect(requesterPickup.ok).toBe(true);
    if (!requesterPickup.ok) throw new Error('expected requester token pickup');
    expect(requesterPickup.confirmationToken).toBe('raw-token');

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
    if (!mismatch.ok) {
      expect(mismatch.reasonCode).toBe('CONFIRMATION_PARAM_MISMATCH');
      expect(mismatch.audit?.peer.principalHash).toBe('requester-session');
    }

    expect(mismatch.challenge).toMatchObject({
      status: 'invalidated',
      failedRedemptions: 1,
      outcome: 'mismatch_denied',
    });
    expect(mismatch.challenge?.tokenHash).toBeUndefined();
    expect(mismatch.challenge?.requesterToken).toBeUndefined();
    expect(store.getChallenge(challenge.challengeId)).toMatchObject({
      status: 'invalidated',
    });
    expect(store.getChallenge(challenge.challengeId)?.tokenHash).toBeUndefined();
    expect(store.getChallenge(challenge.challengeId)?.requesterToken).toBeUndefined();

    const correctAfterMismatch = store.redeemToken({
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
    expect(correctAfterMismatch.ok).toBe(false);
    if (!correctAfterMismatch.ok) {
      expect(correctAfterMismatch.reasonCode).toBe('CONFIRMATION_TOKEN_INVALID');
    }
  });

  it('expires, denies, deny+revokes, and invalidates failed mismatches with operator-readable reason codes', () => {
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
    const deniedResult = store.approveChallenge({
      challengeId: denied.challengeId,
      approverAuthSessionHash: 'approver-session',
      decision: 'deny',
      now: NOW,
    });
    expect(deniedResult).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_DENIED' });
    if (!deniedResult.ok) expect(deniedResult.audit?.peer.principalHash).toBe('approver-session');

    const revoked = store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: challengeDecision().params as ReturnType<typeof canonicalConfirmationParams>,
    });
    const revokedResult = store.approveChallenge({
      challengeId: revoked.challengeId,
      approverAuthSessionHash: 'approver-session',
      decision: 'deny_revoke',
      now: NOW,
    });
    expect(revokedResult).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_DENIED_REVOKE' });
    if (!revokedResult.ok) expect(revokedResult.audit?.peer.principalHash).toBe('approver-session');

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
    const result = store.redeemToken({
      token: 'raw-token',
      requesterAuthSessionHash: 'requester-session',
      decision: challengeDecision(),
      canonicalParams: wrongParams,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reasonCode: 'CONFIRMATION_PARAM_MISMATCH' });
    expect(store.getChallenge(capped.challengeId)).toMatchObject({
      status: 'invalidated',
      failedRedemptions: 1,
    });
    expect(store.getChallenge(capped.challengeId)?.tokenHash).toBeUndefined();
    expect(store.getChallenge(capped.challengeId)?.requesterToken).toBeUndefined();
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

  it('preserves terminal outcomes after TTL expiry and never evicts live challenges for capacity', () => {
    let current = NOW;
    let nextId = 0;
    const store = createConfirmationChallengeStore({
      now: () => current,
      randomId: () => `challenge-${++nextId}`,
      randomToken: () => `raw-token-${nextId}`,
      challengeTtlMs: 1_000,
      tokenTtlMs: 5_000,
      maxChallenges: 2,
    });
    const params = challengeDecision().params as ReturnType<typeof canonicalConfirmationParams>;
    const first = store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: params,
    });
    const approved = store.approveChallenge({
      challengeId: first.challengeId,
      approverAuthSessionHash: 'approver-session',
      decision: 'approve',
      now: current,
    });
    expect(approved.ok).toBe(true);
    const second = store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: params,
    });
    expect(() =>
      store.createChallenge(challengeDecision(), {
        requesterAuthSessionHash: 'requester-session',
        canonicalParams: params,
      })
    ).toThrow('confirmation challenge capacity exhausted');
    expect(store.listChallenges().map((challenge) => challenge.challengeId)).toEqual([
      first.challengeId,
      second.challengeId,
    ]);

    if (!approved.ok) throw new Error('expected approval');
    const redeemed = store.redeemToken({
      token: approved.confirmationToken,
      requesterAuthSessionHash: 'requester-session',
      decision: challengeDecision(),
      canonicalParams: params,
      now: current,
    });
    expect(redeemed.ok).toBe(true);
    current = new Date(NOW.getTime() + 1_001);
    expect(store.getChallenge(first.challengeId)?.status).toBe('redeemed');

    const third = store.createChallenge(challengeDecision(), {
      requesterAuthSessionHash: 'requester-session',
      canonicalParams: params,
    });
    expect(store.listChallenges().map((challenge) => challenge.challengeId)).toEqual([
      second.challengeId,
      third.challengeId,
    ]);
  });
});

describe('canonicalConfirmationParams rpc.fs.write (CRIT-1 security regression)', () => {
  it('reads contentBase64 field and decodes correctly: size and sha256 match the decoded bytes', () => {
    const hello = Buffer.from('hello');
    const contentBase64 = hello.toString('base64');
    const params = canonicalConfirmationParams('rpc.fs.write', {
      contentBase64,
      mode: 'create',
      path: '/x',
    });

    expect(params.size).toBe(5);
    expect(params.path).toBe('/x');
    expect(params.mode).toBe('create');
    // sha256 of 'hello'
    const expectedSha = createHash('sha256').update(hello).digest('hex');
    expect(params.sha256).toBe(expectedSha);
    expect(JSON.stringify(params)).not.toContain('aGVsbG8='); // raw base64 must not leak
  });

  it('two calls with different contentBase64 produce different canonical params', () => {
    const paramsA = canonicalConfirmationParams('rpc.fs.write', {
      contentBase64: Buffer.from('hello').toString('base64'),
      mode: 'create',
      path: '/x',
    });
    const paramsB = canonicalConfirmationParams('rpc.fs.write', {
      contentBase64: Buffer.from('hello world, much longer content!').toString('base64'),
      mode: 'create',
      path: '/x',
    });
    expect(paramsA.sha256).not.toBe(paramsB.sha256);
    expect(paramsA.size).not.toBe(paramsB.size);
  });

  it('empty contentBase64 produces size=0 and sha256 of empty buffer', () => {
    const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    const params = canonicalConfirmationParams('rpc.fs.write', {
      contentBase64: '',
      mode: 'create',
      path: '/empty',
    });
    expect(params.size).toBe(0);
    expect(params.sha256).toBe(emptyHash);
  });

  it('canonical shape includes path, mode, expectedHash, size, sha256 — not raw content', () => {
    const params = canonicalConfirmationParams('rpc.fs.write', {
      contentBase64: Buffer.from('data').toString('base64'),
      mode: 'overwrite',
      path: '/some/file.ts',
      expectedHash: 'abc123',
    });
    expect(Object.keys(params).sort()).toEqual(
      expect.arrayContaining(['action', 'path', 'mode', 'expectedHash', 'size', 'sha256'])
    );
    expect(params).not.toHaveProperty('contentBase64');
    expect(params).not.toHaveProperty('cwd');
  });
});

