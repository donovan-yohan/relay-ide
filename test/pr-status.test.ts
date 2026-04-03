import { describe, it, expect } from 'vitest';
import { derivePrDotStatus, prGlyph } from '../frontend/src/lib/pr-status.js';
import type { PrDotStatus } from '../frontend/src/lib/pr-status.js';
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
    expect(derivePrDotStatus(makePr({ state: 'MERGED' }))).toBe('merged');
  });

  it('returns closed for CLOSED state', () => {
    expect(derivePrDotStatus(makePr({ state: 'CLOSED' }))).toBe('closed');
  });

  it('returns draft for isDraft PRs', () => {
    expect(derivePrDotStatus(makePr({ isDraft: true }))).toBe('draft');
  });

  it('returns changes-requested when reviewDecision is CHANGES_REQUESTED', () => {
    expect(
      derivePrDotStatus(makePr({ reviewDecision: 'CHANGES_REQUESTED' }))
    ).toBe('changes-requested');
  });

  it('returns approved when reviewDecision is APPROVED', () => {
    expect(derivePrDotStatus(makePr({ reviewDecision: 'APPROVED' }))).toBe(
      'approved'
    );
  });

  it('returns review-requested for reviewers', () => {
    expect(derivePrDotStatus(makePr({ role: 'reviewer' }))).toBe(
      'review-requested'
    );
  });

  it('returns open for plain open PRs', () => {
    expect(derivePrDotStatus(makePr({}))).toBe('open');
  });

  it('draft takes priority over changes-requested', () => {
    expect(
      derivePrDotStatus(
        makePr({ isDraft: true, reviewDecision: 'CHANGES_REQUESTED' })
      )
    ).toBe('draft');
  });

  it('merged takes priority over everything', () => {
    expect(
      derivePrDotStatus(
        makePr({
          state: 'MERGED',
          isDraft: true,
          reviewDecision: 'APPROVED',
          role: 'reviewer',
        })
      )
    ).toBe('merged');
  });
});

describe('prGlyph', () => {
  it('maps each status to a unique character', () => {
    const statuses: PrDotStatus[] = [
      'draft',
      'open',
      'review-requested',
      'changes-requested',
      'approved',
      'merged',
      'closed',
      'unknown',
    ];
    const chars = statuses.map((s) => prGlyph(s).char);
    for (const c of chars) {
      expect(c.length > 0).toBeTruthy();
    }
    // Ensure each status maps to a distinct glyph character
    expect(new Set(chars).size).toBe(statuses.length);
  });

  it('approved is green checkmark', () => {
    const g = prGlyph('approved');
    expect(g.char).toBe('✓');
    expect(g.colorClass).toBe('pr-green');
  });
});
