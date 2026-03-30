import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { derivePrDotStatus } from '../frontend/src/lib/pr-status.js';
import type { PullRequest } from '../frontend/src/lib/types.js';

function makePr(overrides: Partial<PullRequest>): PullRequest {
  return {
    number: 1,
    title: 'Test',
    url: '',
    headRefName: '',
    baseRefName: '',
    state: 'OPEN',
    author: 'user',
    role: 'author',
    updatedAt: '',
    additions: 0,
    deletions: 0,
    reviewDecision: null,
    mergeable: null,
    isDraft: false,
    ciStatus: null,
    ...overrides,
  };
}

describe('derivePrDotStatus', () => {
  it('returns merged for MERGED state', () => {
    assert.equal(derivePrDotStatus(makePr({ state: 'MERGED' })), 'merged');
  });

  it('returns closed for CLOSED state', () => {
    assert.equal(derivePrDotStatus(makePr({ state: 'CLOSED' })), 'closed');
  });

  it('returns draft for isDraft PRs', () => {
    assert.equal(derivePrDotStatus(makePr({ isDraft: true })), 'draft');
  });

  it('returns changes-requested when reviewDecision is CHANGES_REQUESTED', () => {
    assert.equal(derivePrDotStatus(makePr({ reviewDecision: 'CHANGES_REQUESTED' })), 'changes-requested');
  });

  it('returns approved when reviewDecision is APPROVED', () => {
    assert.equal(derivePrDotStatus(makePr({ reviewDecision: 'APPROVED' })), 'approved');
  });

  it('returns review-requested for reviewers', () => {
    assert.equal(derivePrDotStatus(makePr({ role: 'reviewer' })), 'review-requested');
  });

  it('returns open for plain open PRs', () => {
    assert.equal(derivePrDotStatus(makePr({})), 'open');
  });

  it('draft takes priority over changes-requested', () => {
    assert.equal(derivePrDotStatus(makePr({ isDraft: true, reviewDecision: 'CHANGES_REQUESTED' })), 'draft');
  });

  it('merged takes priority over everything', () => {
    assert.equal(derivePrDotStatus(makePr({ state: 'MERGED', isDraft: true, reviewDecision: 'APPROVED', role: 'reviewer' })), 'merged');
  });
});
