import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPrOverseerStore,
  PrOverseerStoreError,
  type PrOverseerStore,
} from '../server/pr-overseer.js';
import {
  computePrOverseerBlockers,
  derivePrOverseerView,
  parsePrOverseerRegisterInput,
  PrOverseerValidationError,
  type PrObservation,
} from '../shared/pr-overseer.js';
import { createGhPrObserver, type PrOverseerExec } from '../server/pr-overseer-github.js';

const tempRoots: string[] = [];

function makeClock(startMs: number): { now: () => string; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makeStore(now: () => string): PrOverseerStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pr-overseer-'));
  tempRoots.push(root);
  return createPrOverseerStore({ dbPath: path.join(root, 'pr-overseers.db'), now });
}

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

const baseRegister = {
  id: 'pr-overseer:test-1',
  name: 'pr-960-overseer',
  owner: { orchestrator: 'ebi' },
  repoPath: '/repo/relay-ide',
  workContextId: 'wc:960',
  session: { sessionId: 'sess-claude' },
  issue: { number: 960 },
  pr: { ownerRepo: 'donovan-yohan/relay-ide', number: 1234, url: 'https://github.com/donovan-yohan/relay-ide/pull/1234' },
  ttlSeconds: 600,
};

/** A clean, ready-to-merge OPEN PR snapshot. */
function readyObservation(overrides: Partial<PrObservation['pr']> = {}): PrObservation {
  return {
    ok: true,
    fetchedAt: '2026-06-15T00:00:00.000Z',
    pr: {
      number: 1234,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      headSha: HEAD,
      headRefName: 'feat/960',
      baseRefName: 'nightly',
      ...overrides,
    },
    checks: { total: 3, passing: 3, failing: 0, pending: 0, failingNames: [] },
    reviews: { decision: 'APPROVED', changesRequestedBy: [], approvedBy: ['reviewer'], unresolvedThreadCount: 0 },
    botComments: { count: 2, sources: ['coderabbitai[bot]'] },
    closingIssueNumbers: [960],
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('pr overseer store', () => {
  it('registers a link with pending status and no handoff readiness before any observation', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    const record = store.register(baseRegister);
    expect(record).toMatchObject({
      id: 'pr-overseer:test-1',
      name: 'pr-960-overseer',
      status: 'pending',
      version: 1,
      pr: { ownerRepo: 'donovan-yohan/relay-ide', number: 1234 },
      issue: { number: 960 },
      handoff: { ready: false },
    });
    expect(record.requiredNextAction.action).toBe('observe-first');
  });

  it('observe with a clean snapshot derives ready + safe handoff', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const record = store.observe('pr-overseer:test-1', { summary: 'all green' }, readyObservation());
    expect(record.status).toBe('ready');
    expect(record.blockers).toEqual([]);
    expect(record.handoff).toMatchObject({ ready: true, exactHeadEvidenceCurrent: true, evidenceHeadSha: HEAD });
    expect(record.requiredNextAction).toMatchObject({
      action: 'hand-off-to-release-train',
      actor: 'release-train',
    });
  });

  it('successful OPEN observation without review evidence does not derive ready handoff', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const obs = readyObservation();
    delete obs.reviews;

    const record = store.observe('pr-overseer:test-1', { summary: 'partial observer snapshot' }, obs);

    expect(record.status).toBe('observing');
    expect(record.blockers).toEqual(['review-required']);
    expect(record.handoff.ready).toBe(false);
    expect(record.requiredNextAction).toMatchObject({ action: 'await-review', actor: 'release-train' });
  });

  it('successful OPEN observation without check evidence does not derive ready handoff', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const obs = readyObservation();
    delete obs.checks;

    const record = store.observe('pr-overseer:test-1', { summary: 'partial observer snapshot' }, obs);

    expect(record.status).toBe('observing');
    expect(record.blockers).toEqual(['checks-unknown']);
    expect(record.handoff.ready).toBe(false);
    expect(record.requiredNextAction).toMatchObject({ action: 're-observe', actor: 'operator' });
  });

  it('successful OPEN observation with unknown review decision does not derive ready handoff', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const obs = readyObservation();
    obs.reviews = { decision: null, changesRequestedBy: [], approvedBy: [], unresolvedThreadCount: 0 };

    const record = store.observe('pr-overseer:test-1', { summary: 'unknown review evidence' }, obs);

    expect(record.status).toBe('observing');
    expect(record.blockers).toEqual(['review-required']);
    expect(record.handoff.ready).toBe(false);
    expect(record.requiredNextAction).toMatchObject({ action: 'await-review', actor: 'release-train' });
  });

  it('failed checks make the run blocked with a fix-checks action (no handoff)', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const obs = readyObservation();
    obs.checks = { total: 3, passing: 1, failing: 1, pending: 1, failingNames: ['build'] };
    const record = store.observe('pr-overseer:test-1', {}, obs);
    expect(record.status).toBe('blocked');
    expect(record.blockers).toContain('checks-failed');
    expect(record.handoff.ready).toBe(false);
    expect(record.requiredNextAction).toMatchObject({ action: 'fix-checks', actor: 'implementer' });
  });

  it('a review requesting changes is a hard blocker', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const obs = readyObservation();
    obs.reviews = {
      decision: 'CHANGES_REQUESTED',
      changesRequestedBy: ['maintainer'],
      approvedBy: [],
      unresolvedThreadCount: 2,
    };
    const record = store.observe('pr-overseer:test-1', {}, obs);
    expect(record.status).toBe('blocked');
    expect(record.blockers).toContain('review-changes-requested');
    expect(record.blockers).toContain('unresolved-review-threads');
    expect(record.requiredNextAction).toMatchObject({ action: 'address-review', actor: 'implementer' });
    expect(record.handoff.ready).toBe(false);
  });

  it('pending checks keep the run observing (soft) and out of handoff', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const obs = readyObservation();
    obs.checks = { total: 3, passing: 2, failing: 0, pending: 1, failingNames: [] };
    const record = store.observe('pr-overseer:test-1', {}, obs);
    expect(record.status).toBe('observing');
    expect(record.blockers).toEqual(['checks-pending']);
    expect(record.requiredNextAction.action).toBe('await-checks');
    expect(record.handoff.ready).toBe(false);
  });

  it('stale head: an observed head different from the session expected head blocks handoff', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register({ ...baseRegister, expectedHeadSha: OTHER_HEAD });
    // Session believes it pushed OTHER_HEAD, but the PR's live head is HEAD.
    const record = store.observe('pr-overseer:test-1', {}, readyObservation());
    expect(record.status).toBe('blocked');
    expect(record.blockers).toContain('stale-head');
    expect(record.staleHeadRisk).toMatchObject({
      diverged: true,
      observedHeadSha: HEAD,
      expectedHeadSha: OTHER_HEAD,
    });
    expect(record.requiredNextAction).toMatchObject({ action: 'resync-head', actor: 'implementer' });
    expect(record.handoff.ready).toBe(false);
  });

  it('stale head at read time: a caller-asserted currentHeadSha mismatch fails the handoff gate', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    store.observe('pr-overseer:test-1', {}, readyObservation()); // evidence covers HEAD
    // Plain get → ready.
    expect(store.get('pr-overseer:test-1')?.status).toBe('ready');
    // A release agent asks about a DIFFERENT head → must not read as ready.
    const mismatched = store.get('pr-overseer:test-1', { currentHeadSha: OTHER_HEAD });
    expect(mismatched?.status).toBe('blocked');
    expect(mismatched?.blockers).toContain('stale-head');
    expect(mismatched?.handoff.ready).toBe(false);
    expect(mismatched?.handoff.exactHeadEvidenceCurrent).toBe(false);
  });

  it('treats caller-supplied currentHeadSha as case-insensitive', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    store.observe('pr-overseer:test-1', {}, readyObservation());

    const current = store.get('pr-overseer:test-1', { currentHeadSha: HEAD.toUpperCase() });
    expect(current?.status).toBe('ready');
    expect(current?.blockers).not.toContain('stale-head');
    expect(current?.handoff.exactHeadEvidenceCurrent).toBe(true);
  });

  it('treats observe-updated expectedHeadSha as case-insensitive', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);

    const record = store.observe(
      'pr-overseer:test-1',
      { expectedHeadSha: HEAD.toUpperCase() },
      readyObservation()
    );
    expect(record.status).toBe('ready');
    expect(record.blockers).not.toContain('stale-head');
    expect(record.staleHeadRisk.expectedHeadSha).toBe(HEAD);
  });

  it('a merged PR derives merged status', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const obs = readyObservation({ state: 'MERGED' });
    const record = store.observe('pr-overseer:test-1', {}, obs);
    expect(record.status).toBe('merged');
    expect(record.handoff.ready).toBe(false);
    expect(record.requiredNextAction.action).toBe('none');
  });

  it('issue auto-close mismatch: an OPEN PR not referencing the linked issue blocks', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister); // linked issue #960
    const obs = readyObservation();
    obs.closingIssueNumbers = [999]; // PR closes a different issue, not #960
    const record = store.observe('pr-overseer:test-1', {}, obs);
    expect(record.status).toBe('blocked');
    expect(record.blockers).toContain('issue-closeout-mismatch');
    expect(record.requiredNextAction).toMatchObject({ action: 'fix-issue-closeout', actor: 'implementer' });
  });

  it('issue auto-close compares ownerRepo when qualified closeout refs are available', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const obs = readyObservation();
    obs.closingIssueNumbers = [960];
    obs.closingIssueRefs = [{ ownerRepo: 'someone-else/relay-ide', number: 960 }];

    const record = store.observe('pr-overseer:test-1', {}, obs);

    expect(record.status).toBe('blocked');
    expect(record.blockers).toContain('issue-closeout-mismatch');
    expect(record.handoff.ready).toBe(false);
  });

  it('issue auto-close mismatch on a MERGED PR surfaces a verify action', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const obs = readyObservation({ state: 'MERGED' });
    obs.closingIssueNumbers = [];
    const record = store.observe('pr-overseer:test-1', {}, obs);
    expect(record.status).toBe('merged');
    expect(record.blockers).toContain('issue-closeout-mismatch');
    expect(record.requiredNextAction).toMatchObject({ action: 'verify-issue-closeout', actor: 'release-train' });
  });

  it('a failed fetch (gh unavailable) keeps the last good evidence and flags the failure', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    store.observe('pr-overseer:test-1', {}, readyObservation());
    // A later observe where gh failed → ok:false snapshot.
    const failed = store.observe('pr-overseer:test-1', {}, {
      ok: false,
      fetchedAt: clock.now(),
      unavailableReason: 'gh-missing',
    });
    // Last good snapshot is retained; the failed fetch is flagged.
    expect(failed.lastObservation?.snapshot.pr?.headSha).toBe(HEAD);
    expect(failed.staleHeadRisk.lastFetchFailed).toBe(true);
    expect(failed.handoff.ready).toBe(false);
    expect(failed.lastFetch).toMatchObject({ ok: false, unavailableReason: 'gh-missing' });
  });

  it('heartbeat expiry makes a clean PR stale (re-observe) rather than ready', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister); // ttl 600s
    store.observe('pr-overseer:test-1', {}, readyObservation());
    expect(store.get('pr-overseer:test-1')?.status).toBe('ready');
    clock.advance(601_000); // past the heartbeat TTL
    const stale = store.get('pr-overseer:test-1');
    expect(stale?.status).toBe('stale');
    expect(stale?.requiredNextAction.action).toBe('re-observe');
    expect(stale?.handoff.ready).toBe(false);
  });

  it('a hard blocker still surfaces as blocked even when the heartbeat also lapsed', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const obs = readyObservation();
    obs.checks = { total: 1, passing: 0, failing: 1, pending: 0, failingNames: ['ci'] };
    store.observe('pr-overseer:test-1', {}, obs);
    clock.advance(601_000);
    // The block is the more important signal than the stale heartbeat.
    expect(store.get('pr-overseer:test-1')?.status).toBe('blocked');
  });

  it('retire is idempotent and terminal; observe on a retired run fails closed', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const retired = store.retire('pr-overseer:test-1', { reason: 'merged', retiredBy: 'ebi' });
    expect(retired.status).toBe('retired');
    expect(retired.cleanup).toMatchObject({ state: 'retired', reason: 'merged', retiredBy: 'ebi' });
    const versionAfterFirst = retired.version;
    const second = store.retire('pr-overseer:test-1', { reason: 'ignored' });
    expect(second.version).toBe(versionAfterFirst); // no-op
    expect(second.cleanup.reason).toBe('merged');
    expect(() => store.observe('pr-overseer:test-1', {}, readyObservation())).toThrow(PrOverseerStoreError);
  });

  it('re-register is create-or-replace but workContextId is immutable', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const replaced = store.register({ ...baseRegister, name: 'renamed' });
    expect(replaced.name).toBe('renamed');
    expect(replaced.version).toBe(2);
    expect(() => store.register({ ...baseRegister, workContextId: 'wc:other' })).toThrow(
      PrOverseerStoreError
    );
  });

  it('list filters by derived status and excludes retired by default', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register({ ...baseRegister, id: 'pr-overseer:a', workContextId: 'wc:a' });
    store.register({ ...baseRegister, id: 'pr-overseer:b', workContextId: 'wc:b' });
    const failing = readyObservation();
    failing.checks = { total: 1, passing: 0, failing: 1, pending: 0, failingNames: ['x'] };
    store.observe('pr-overseer:a', {}, readyObservation());
    store.observe('pr-overseer:b', {}, failing);
    expect(store.list({ status: 'ready' }).map((r) => r.id)).toEqual(['pr-overseer:a']);
    expect(store.list({ status: 'blocked' }).map((r) => r.id)).toEqual(['pr-overseer:b']);
    store.retire('pr-overseer:a', {});
    expect(store.list({}).map((r) => r.id)).toEqual(['pr-overseer:b']);
    expect(store.list({ includeRetired: true }).length).toBe(2);
  });

  it('exact-head bypass guard: a snapshot with no head + a session expectedHeadSha is blocked, not ready', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register({ ...baseRegister, expectedHeadSha: HEAD });
    // gh returned an OK PR with NO headRefOid (e.g. deleted cross-fork head ref).
    const headless = readyObservation();
    delete headless.pr!.headSha;
    const record = store.observe('pr-overseer:test-1', {}, headless);
    expect(record.status).toBe('blocked');
    expect(record.blockers).toContain('stale-head');
    expect(record.handoff.ready).toBe(false);
    expect(record.staleHeadRisk.diverged).toBe(true);
  });

  it('blocks a successful observation without a confirmed observed head', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister); // no expectedHeadSha
    const headless = readyObservation();
    delete headless.pr!.headSha;
    const record = store.observe('pr-overseer:test-1', {}, headless);
    expect(record.status).toBe('blocked');
    expect(record.blockers).toContain('stale-head');
    expect(record.handoff.ready).toBe(false);
    expect(record.handoff.exactHeadEvidenceCurrent).toBe(false);
    expect(record.staleHeadRisk.diverged).toBe(true);
  });

  it('a closed-without-merge PR derives closed status with a none action', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const record = store.observe('pr-overseer:test-1', {}, readyObservation({ state: 'CLOSED' }));
    expect(record.status).toBe('closed');
    expect(record.blockers).toEqual([]);
    expect(record.handoff.ready).toBe(false);
    expect(record.requiredNextAction.action).toBe('none');
  });

  it('a merge conflict blocks at the status level with a resolve action', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const record = store.observe('pr-overseer:test-1', {}, readyObservation({ mergeable: 'CONFLICTING' }));
    expect(record.status).toBe('blocked');
    expect(record.blockers).toContain('merge-conflict');
    expect(record.requiredNextAction).toMatchObject({ action: 'resolve-merge-conflict', actor: 'implementer' });
  });

  it('soft blockers map to await next-actions (review-required / mergeability-unknown)', () => {
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register({ ...baseRegister, id: 'pr-overseer:rr' });
    const reviewRequired = readyObservation();
    reviewRequired.reviews = { decision: 'REVIEW_REQUIRED', changesRequestedBy: [], approvedBy: [], unresolvedThreadCount: 0 };
    const rr = store.observe('pr-overseer:rr', {}, reviewRequired);
    expect(rr.status).toBe('observing');
    expect(rr.requiredNextAction.action).toBe('await-review');

    store.register({ ...baseRegister, id: 'pr-overseer:mu' });
    const mu = store.observe('pr-overseer:mu', {}, readyObservation({ mergeable: 'UNKNOWN' }));
    expect(mu.status).toBe('observing');
    expect(mu.requiredNextAction.action).toBe('await-mergeability');
  });
});

describe('pr overseer validation', () => {
  it('rejects secret-shaped fields, including compound key names', () => {
    expect(() =>
      parsePrOverseerRegisterInput({ ...baseRegister, token: 'ghp_secret' })
    ).toThrow(PrOverseerValidationError);
    // Compound key names that embed a secret stem must also be rejected.
    expect(() =>
      parsePrOverseerRegisterInput({ ...baseRegister, githubToken: 'ghp_x' })
    ).toThrow(PrOverseerValidationError);
    expect(() =>
      parsePrOverseerRegisterInput({ ...baseRegister, links: { taskRefs: [{ kind: 'github-issue', id: '1', userPassword: 'p' }] } })
    ).toThrow(PrOverseerValidationError);
    // A legitimate key that merely contains an ambiguous short stem (e.g. "author")
    // must NOT be rejected.
    expect(() =>
      parsePrOverseerRegisterInput({ ...baseRegister, name: 'ok', authorNote: 'fine' })
    ).not.toThrow();
  });

  it('requires pr ownerRepo + number', () => {
    expect(() => parsePrOverseerRegisterInput({ name: 'x', owner: { orchestrator: 'ebi' } })).toThrow(
      PrOverseerValidationError
    );
    expect(() =>
      parsePrOverseerRegisterInput({ name: 'x', owner: { orchestrator: 'ebi' }, pr: { ownerRepo: 'bad', number: 1 } })
    ).toThrow(PrOverseerValidationError);
  });

  it('normalizes a head sha and rejects non-hex', () => {
    const parsed = parsePrOverseerRegisterInput({ ...baseRegister, expectedHeadSha: HEAD.toUpperCase() });
    expect(parsed.expectedHeadSha).toBe(HEAD);
    expect(() => parsePrOverseerRegisterInput({ ...baseRegister, expectedHeadSha: 'nothex!!' })).toThrow(
      PrOverseerValidationError
    );
  });
});

describe('computePrOverseerBlockers (pure)', () => {
  it('a conflicting PR is a merge-conflict hard blocker', () => {
    const snapshot = readyObservation({ mergeable: 'CONFLICTING' });
    expect(computePrOverseerBlockers({ snapshot })).toContain('merge-conflict');
  });

  it('a draft PR is a soft blocker', () => {
    const snapshot = readyObservation({ isDraft: true });
    const view = derivePrOverseerView(
      {
        pr: { ownerRepo: 'o/r', number: 1 },
        heartbeat: { expiresAt: '2999-01-01T00:00:00.000Z' },
        lastObservation: { observedAt: '2026-06-15T00:00:00.000Z', snapshot },
        cleanup: { state: 'none' },
      },
      '2026-06-15T00:00:01.000Z'
    );
    expect(view.status).toBe('observing');
    expect(view.blockers).toContain('pr-draft');
  });

  it('unknown review evidence is a soft review-required blocker', () => {
    const missingReviews = readyObservation();
    delete missingReviews.reviews;
    expect(computePrOverseerBlockers({ snapshot: missingReviews })).toContain('review-required');

    const unknownReviewDecision = readyObservation();
    unknownReviewDecision.reviews = {
      decision: null,
      changesRequestedBy: [],
      approvedBy: [],
      unresolvedThreadCount: 0,
    };
    const view = derivePrOverseerView(
      {
        pr: { ownerRepo: 'o/r', number: 1 },
        heartbeat: { expiresAt: '2999-01-01T00:00:00.000Z' },
        lastObservation: { observedAt: '2026-06-15T00:00:00.000Z', snapshot: unknownReviewDecision },
        cleanup: { state: 'none' },
      },
      '2026-06-15T00:00:01.000Z'
    );
    expect(view.status).toBe('observing');
    expect(view.blockers).toEqual(['review-required']);
    expect(view.handoff.ready).toBe(false);
  });
});

describe('gh pr observer', () => {
  const target = { ownerRepo: 'donovan-yohan/relay-ide', number: 1234, repoPath: '/repo' };

  function execReturning(
    viewJson: unknown,
    threads: boolean | Array<{ isResolved?: boolean } | null> = true
  ): PrOverseerExec {
    return async (file, execArgs) => {
      if (file === 'gh' && execArgs[0] === 'pr' && execArgs[1] === 'view') {
        return { stdout: JSON.stringify(viewJson), stderr: '' };
      }
      if (file === 'gh' && execArgs[0] === 'api' && execArgs[1] === 'graphql') {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: Array.isArray(threads) ? threads : [{ isResolved: threads }],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected exec ${file} ${execArgs.join(' ')}`);
    };
  }

  it('maps a gh pr view JSON into a bounded observation', async () => {
    const observer = createGhPrObserver({
      exec: execReturning({
        number: 1234,
        url: 'https://github.com/donovan-yohan/relay-ide/pull/1234',
        state: 'OPEN',
        isDraft: false,
        headRefName: 'feat/960',
        baseRefName: 'nightly',
        headRefOid: HEAD.toUpperCase(),
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'CHANGES_REQUESTED',
        latestReviews: [
          { author: { login: 'maintainer' }, state: 'CHANGES_REQUESTED' },
          { author: { login: 'buddy' }, state: 'APPROVED' },
        ],
        statusCheckRollup: [
          { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'lint' },
          { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE', name: 'test' },
          { __typename: 'CheckRun', status: 'IN_PROGRESS', name: 'build' },
          { __typename: 'StatusContext', state: 'SUCCESS', context: 'ci/legacy' },
        ],
        comments: [{ author: { login: 'coderabbitai[bot]' } }, { author: { login: 'human' } }],
        closingIssuesReferences: [
          {
            number: 960,
            url: 'https://github.com/donovan-yohan/relay-ide/issues/960',
            repository: { name: 'relay-ide', owner: { login: 'donovan-yohan' } },
          },
        ],
        updatedAt: '2026-06-15T00:00:00.000Z',
      }, false),
    });
    const obs = await observer(target);
    expect(obs.ok).toBe(true);
    expect(obs.pr).toMatchObject({ state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE' });
    expect(obs.checks).toMatchObject({ total: 4, passing: 2, failing: 1, pending: 1, failingNames: ['test'] });
    expect(obs.reviews).toMatchObject({ decision: 'CHANGES_REQUESTED', changesRequestedBy: ['maintainer'] });
    expect(obs.reviews?.unresolvedThreadCount).toBe(1);
    expect(obs.botComments).toMatchObject({ count: 1, sources: ['coderabbitai[bot]'] });
    expect(obs.closingIssueNumbers).toEqual([960]);
    expect(obs.closingIssueRefs).toEqual([
      {
        ownerRepo: 'donovan-yohan/relay-ide',
        number: 960,
        url: 'https://github.com/donovan-yohan/relay-ide/issues/960',
      },
    ]);
  });

  it('missing gh statusCheckRollup remains missing check evidence, not observed zero checks', async () => {
    const observer = createGhPrObserver({
      exec: execReturning(
        {
          number: 1234,
          state: 'OPEN',
          isDraft: false,
          headRefOid: HEAD,
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          latestReviews: [{ author: { login: 'reviewer' }, state: 'APPROVED' }],
          comments: [],
          closingIssuesReferences: [{ number: 960 }],
        }
      ),
    });
    const obs = await observer(target);
    expect(obs.ok).toBe(true);
    expect(obs.checks).toBeUndefined();

    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    const record = store.observe('pr-overseer:test-1', {}, obs);
    expect(record.status).toBe('observing');
    expect(record.blockers).toEqual(['checks-unknown']);
    expect(record.handoff.ready).toBe(false);
  });

  it('null GraphQL review-thread nodes fail closed instead of defaulting to zero unresolved threads', async () => {
    const observer = createGhPrObserver({
      exec: execReturning(
        {
          number: 1234,
          state: 'OPEN',
          isDraft: false,
          headRefOid: HEAD,
          mergeable: 'MERGEABLE',
          statusCheckRollup: [],
          latestReviews: [],
          comments: [],
          closingIssuesReferences: [{ number: 960 }],
        },
        [null]
      ),
    });

    const obs = await observer(target);
    expect(obs).toMatchObject({ ok: false, unavailableReason: 'error' });
    expect(obs.reviews).toBeUndefined();
  });

  it('malformed GraphQL review-thread nodes fail closed instead of being counted as resolved', async () => {
    const observer = createGhPrObserver({
      exec: execReturning(
        {
          number: 1234,
          state: 'OPEN',
          isDraft: false,
          headRefOid: HEAD,
          mergeable: 'MERGEABLE',
          statusCheckRollup: [],
          latestReviews: [],
          comments: [],
          closingIssuesReferences: [{ number: 960 }],
        },
        [{}]
      ),
    });

    const obs = await observer(target);
    expect(obs).toMatchObject({ ok: false, unavailableReason: 'error' });
    expect(obs.reviews).toBeUndefined();
  });

  it('null GraphQL review-thread nodes cannot make the store derive a ready handoff', async () => {
    const viewJson = {
      number: 1234,
      state: 'OPEN',
      isDraft: false,
      headRefOid: HEAD,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      latestReviews: [{ author: { login: 'reviewer' }, state: 'APPROVED' }],
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'build' },
      ],
      comments: [],
      closingIssuesReferences: [{ number: 960 }],
    };
    const observer = createGhPrObserver({ exec: execReturning(viewJson, [null]) });
    const failedSnapshot = await observer(target);
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);

    const record = store.observe('pr-overseer:test-1', {}, failedSnapshot);

    expect(record.lastFetch).toMatchObject({ ok: false, unavailableReason: 'error' });
    expect(record.status).not.toBe('ready');
    expect(record.handoff.ready).toBe(false);
    expect(record.lastObservation).toBeUndefined();
  });

  it('GraphQL review-thread failure yields ok:false (fail-closed, not unresolvedThreadCount:0)', async () => {
    const viewJson = {
      number: 1234,
      state: 'OPEN',
      isDraft: false,
      headRefOid: HEAD,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      latestReviews: [{ author: { login: 'reviewer' }, state: 'APPROVED' }],
      statusCheckRollup: [],
      comments: [],
      closingIssuesReferences: [{ number: 960 }],
    };
    const observer = createGhPrObserver({
      exec: async (file, execArgs) => {
        if (file === 'gh' && execArgs[0] === 'pr' && execArgs[1] === 'view') {
          return { stdout: JSON.stringify(viewJson), stderr: '' };
        }
        if (file === 'gh' && execArgs[0] === 'api' && execArgs[1] === 'graphql') {
          throw new Error('GraphQL rate limit exceeded');
        }
        throw new Error(`unexpected exec ${file} ${execArgs.join(' ')}`);
      },
    });
    const obs = await observer(target);
    expect(obs.ok).toBe(false);
    expect(obs.unavailableReason).toBe('error');
    // Must not have a pr payload that could be used to derive ready.
    expect(obs.pr).toBeUndefined();
  });

  it('parseable GraphQL errors fail closed instead of defaulting to zero unresolved threads', async () => {
    const viewJson = {
      number: 1234,
      state: 'OPEN',
      isDraft: false,
      headRefOid: HEAD,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      latestReviews: [{ author: { login: 'reviewer' }, state: 'APPROVED' }],
      statusCheckRollup: [],
      comments: [],
      closingIssuesReferences: [{ number: 960 }],
    };
    const observer = createGhPrObserver({
      exec: async (file, execArgs) => {
        if (file === 'gh' && execArgs[0] === 'pr' && execArgs[1] === 'view') {
          return { stdout: JSON.stringify(viewJson), stderr: '' };
        }
        if (file === 'gh' && execArgs[0] === 'api' && execArgs[1] === 'graphql') {
          return { stdout: JSON.stringify({ errors: [{ message: 'rate limited' }], data: null }), stderr: '' };
        }
        throw new Error(`unexpected exec ${file} ${execArgs.join(' ')}`);
      },
    });

    const obs = await observer(target);
    expect(obs).toMatchObject({ ok: false, unavailableReason: 'error' });
    expect(obs.reviews).toBeUndefined();
  });

  it('missing GraphQL reviewThread nodes fail closed instead of defaulting to zero', async () => {
    const viewJson = {
      number: 1234,
      state: 'OPEN',
      isDraft: false,
      headRefOid: HEAD,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      latestReviews: [{ author: { login: 'reviewer' }, state: 'APPROVED' }],
      statusCheckRollup: [],
      comments: [],
      closingIssuesReferences: [{ number: 960 }],
    };
    const observer = createGhPrObserver({
      exec: async (file, execArgs) => {
        if (file === 'gh' && execArgs[0] === 'pr' && execArgs[1] === 'view') {
          return { stdout: JSON.stringify(viewJson), stderr: '' };
        }
        if (file === 'gh' && execArgs[0] === 'api' && execArgs[1] === 'graphql') {
          return {
            stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: null } } } }),
            stderr: '',
          };
        }
        throw new Error(`unexpected exec ${file} ${execArgs.join(' ')}`);
      },
    });

    const obs = await observer(target);
    expect(obs).toMatchObject({ ok: false, unavailableReason: 'error' });
  });

  it('partial GraphQL review-thread pages fail closed until pagination is supported', async () => {
    const viewJson = {
      number: 1234,
      state: 'OPEN',
      isDraft: false,
      headRefOid: HEAD,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      latestReviews: [{ author: { login: 'reviewer' }, state: 'APPROVED' }],
      statusCheckRollup: [],
      comments: [],
      closingIssuesReferences: [{ number: 960 }],
    };
    const observer = createGhPrObserver({
      exec: async (file, execArgs) => {
        if (file === 'gh' && execArgs[0] === 'pr' && execArgs[1] === 'view') {
          return { stdout: JSON.stringify(viewJson), stderr: '' };
        }
        if (file === 'gh' && execArgs[0] === 'api' && execArgs[1] === 'graphql') {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: true } },
                  },
                },
              },
            }),
            stderr: '',
          };
        }
        throw new Error(`unexpected exec ${file} ${execArgs.join(' ')}`);
      },
    });

    const obs = await observer(target);
    expect(obs).toMatchObject({ ok: false, unavailableReason: 'error' });
  });

  it('GraphQL failure propagates to store as lastFetch failed and handoff.ready:false', async () => {
    const viewJson = {
      number: 1234,
      state: 'OPEN',
      isDraft: false,
      headRefOid: HEAD,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      latestReviews: [{ author: { login: 'reviewer' }, state: 'APPROVED' }],
      statusCheckRollup: [],
      comments: [],
      closingIssuesReferences: [{ number: 960 }],
    };
    const graphqlFails: PrOverseerExec = async (file, execArgs) => {
      if (file === 'gh' && execArgs[0] === 'pr' && execArgs[1] === 'view') {
        return { stdout: JSON.stringify(viewJson), stderr: '' };
      }
      throw new Error('GraphQL unavailable');
    };
    const clock = makeClock(Date.parse('2026-06-15T00:00:00.000Z'));
    const store = makeStore(clock.now);
    store.register(baseRegister);
    // First observe succeeds, putting the run into ready.
    store.observe('pr-overseer:test-1', {}, readyObservation());
    expect(store.get('pr-overseer:test-1')?.status).toBe('ready');
    // Second observe: gh pr view succeeds but GraphQL thread query fails.
    const observer = createGhPrObserver({ exec: graphqlFails });
    const failedSnapshot = await observer(target);
    const record = store.observe('pr-overseer:test-1', {}, failedSnapshot);
    expect(record.lastFetch).toMatchObject({ ok: false, unavailableReason: 'error' });
    expect(record.staleHeadRisk.lastFetchFailed).toBe(true);
    expect(record.handoff.ready).toBe(false);
    expect(record.status).toBe('stale');
    // Last good observation snapshot must be retained.
    expect(record.lastObservation?.snapshot.pr?.headSha).toBe(HEAD);
  });

  it('includeReviewThreads:false skips the GraphQL query; a throwing exec still returns ok:true', async () => {
    const viewJson = {
      number: 1234,
      state: 'OPEN',
      isDraft: false,
      headRefOid: HEAD,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      latestReviews: [],
      statusCheckRollup: [],
      comments: [],
      closingIssuesReferences: [],
    };
    const observer = createGhPrObserver({
      includeReviewThreads: false,
      exec: async (file, execArgs) => {
        if (file === 'gh' && execArgs[0] === 'pr' && execArgs[1] === 'view') {
          return { stdout: JSON.stringify(viewJson), stderr: '' };
        }
        throw new Error('GraphQL must not be called');
      },
    });
    const obs = await observer(target);
    expect(obs.ok).toBe(true);
    expect(obs.reviews?.unresolvedThreadCount).toBe(0);
  });

  it('degrades to ok:false when gh is missing', async () => {
    const observer = createGhPrObserver({
      exec: async () => {
        const err = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    });
    const obs = await observer(target);
    expect(obs).toMatchObject({ ok: false, unavailableReason: 'gh-missing' });
  });

  it('degrades to ok:false with auth reason on a gh auth error', async () => {
    const observer = createGhPrObserver({
      exec: async () => {
        throw Object.assign(new Error('fail'), { stderr: 'gh auth login required: not logged into any GitHub hosts' });
      },
    });
    const obs = await observer(target);
    expect(obs).toMatchObject({ ok: false, unavailableReason: 'auth' });
  });
});
