import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { derivePrAction, getActionPrompt, getStatusCssVar, shouldUseDarkText } from '../frontend/src/lib/pr-state.js';
import type { PrStateInput } from '../frontend/src/lib/pr-state.js';

describe('derivePrAction', () => {
  it('returns none when no commits ahead and no PR', () => {
    const input: PrStateInput = {
      commitsAhead: 0,
      prState: null,
      ciPassing: 0, ciFailing: 0, ciPending: 0, ciTotal: 0,
      mergeable: null, unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'none');
    assert.equal(action.color, 'none');
    assert.equal(action.label, '');
  });

  it('returns create-pr when commits ahead but no PR', () => {
    const input: PrStateInput = {
      commitsAhead: 3,
      prState: null,
      ciPassing: 0, ciFailing: 0, ciPending: 0, ciTotal: 0,
      mergeable: null, unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'create-pr');
    assert.equal(action.color, 'accent');
    assert.equal(action.label, 'Create PR');
  });

  it('returns ready-for-review for draft PR', () => {
    const input: PrStateInput = {
      commitsAhead: 5,
      prState: 'DRAFT',
      ciPassing: 0, ciFailing: 0, ciPending: 0, ciTotal: 0,
      mergeable: null, unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'ready-for-review');
    assert.equal(action.color, 'muted');
    assert.equal(action.label, 'Ready for Review');
  });

  it('returns review-pr for open PR with all CI passing', () => {
    const input: PrStateInput = {
      commitsAhead: 2,
      prState: 'OPEN',
      ciPassing: 5, ciFailing: 0, ciPending: 0, ciTotal: 5,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'review-pr');
    assert.equal(action.color, 'success');
    assert.equal(action.label, 'Review PR');
  });

  it('returns review-pr for open PR with no CI checks', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 0, ciFailing: 0, ciPending: 0, ciTotal: 0,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'review-pr');
    assert.equal(action.color, 'success');
  });

  it('returns fix-errors for open PR with failing CI', () => {
    const input: PrStateInput = {
      commitsAhead: 2,
      prState: 'OPEN',
      ciPassing: 6, ciFailing: 2, ciPending: 0, ciTotal: 8,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'fix-errors');
    assert.equal(action.color, 'error');
    assert.equal(action.label, 'Fix Errors 2/8');
  });

  it('returns checks-running for open PR with pending CI', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 3, ciFailing: 0, ciPending: 2, ciTotal: 5,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'checks-running');
    assert.equal(action.color, 'warning');
    assert.equal(action.label, 'Checks Running...');
  });

  it('prioritizes failing over pending CI', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 3, ciFailing: 1, ciPending: 1, ciTotal: 5,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'fix-errors');
    assert.equal(action.label, 'Fix Errors 1/5');
  });

  it('returns archive-merged for merged PR', () => {
    const input: PrStateInput = {
      commitsAhead: 0,
      prState: 'MERGED',
      ciPassing: 5, ciFailing: 0, ciPending: 0, ciTotal: 5,
      mergeable: null, unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'archive-merged');
    assert.equal(action.color, 'merged');
    assert.equal(action.label, 'Archive');
  });

  it('returns archive-closed for closed PR', () => {
    const input: PrStateInput = {
      commitsAhead: 0,
      prState: 'CLOSED',
      ciPassing: 0, ciFailing: 0, ciPending: 0, ciTotal: 0,
      mergeable: null, unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'archive-closed');
    assert.equal(action.color, 'muted');
    assert.equal(action.label, 'Archive');
  });

  it('returns fix-conflicts for open PR with CONFLICTING mergeable', () => {
    const input: PrStateInput = {
      commitsAhead: 2,
      prState: 'OPEN',
      ciPassing: 0, ciFailing: 0, ciPending: 0, ciTotal: 0,
      mergeable: 'CONFLICTING', unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'fix-conflicts');
    assert.equal(action.color, 'error');
    assert.equal(action.label, 'Fix Conflicts');
  });

  it('prioritizes fix-conflicts over fix-errors', () => {
    const input: PrStateInput = {
      commitsAhead: 2,
      prState: 'OPEN',
      ciPassing: 0, ciFailing: 3, ciPending: 0, ciTotal: 3,
      mergeable: 'CONFLICTING', unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'fix-conflicts');
  });

  it('returns resolve-comments when unresolved comments > 0 and CI passing', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 5, ciFailing: 0, ciPending: 0, ciTotal: 5,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 3,
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'resolve-comments');
    assert.equal(action.color, 'accent');
    assert.equal(action.label, 'Resolve Comments (3)');
  });
});

describe('getActionPrompt', () => {
  it('returns prompt for create-pr', () => {
    const prompt = getActionPrompt(
      { type: 'create-pr', color: 'accent', label: 'Create PR' },
      { branchName: 'feat/my-feature' },
    );
    assert.ok(prompt);
    assert.ok(prompt.includes('feat/my-feature'));
    assert.ok(prompt.includes('pull request'));
  });

  it('returns prompt for fix-errors', () => {
    const prompt = getActionPrompt(
      { type: 'fix-errors', color: 'error', label: 'Fix Errors 2/8' },
      { branchName: 'bugfix/auth' },
    );
    assert.ok(prompt);
    assert.ok(prompt.includes('bugfix/auth'));
    assert.ok(prompt.includes('failing'));
  });

  it('returns prompt for review-pr', () => {
    const prompt = getActionPrompt(
      { type: 'review-pr', color: 'success', label: 'Review PR' },
      { branchName: 'main', prNumber: 42 },
    );
    assert.ok(prompt);
    assert.ok(prompt.includes('Review'));
  });

  it('returns prompt for fix-conflicts', () => {
    const prompt = getActionPrompt(
      { type: 'fix-conflicts', color: 'error', label: 'Fix Conflicts' },
      { branchName: 'feat/foo', baseBranch: 'main' },
    );
    assert.ok(prompt);
    assert.ok(prompt.includes('main'));
    assert.ok(prompt.includes('conflict'));
  });

  it('returns prompt for resolve-comments', () => {
    const prompt = getActionPrompt(
      { type: 'resolve-comments', color: 'accent', label: 'Resolve Comments (3)' },
      { branchName: 'feat/foo', prNumber: 7, unresolvedCommentCount: 3 },
    );
    assert.ok(prompt);
    assert.ok(prompt.includes('3'));
    assert.ok(prompt.includes('#7'));
  });

  it('returns null for archive actions', () => {
    assert.equal(
      getActionPrompt({ type: 'archive-merged', color: 'merged', label: 'Archive' }, { branchName: 'main' }),
      null,
    );
    assert.equal(
      getActionPrompt({ type: 'archive-closed', color: 'muted', label: 'Archive' }, { branchName: 'main' }),
      null,
    );
  });

  it('returns null for none and checks-running', () => {
    assert.equal(
      getActionPrompt({ type: 'none', color: 'none', label: '' }, { branchName: 'main' }),
      null,
    );
    assert.equal(
      getActionPrompt({ type: 'checks-running', color: 'warning', label: 'Checks Running...' }, { branchName: 'main' }),
      null,
    );
  });
});

describe('getStatusCssVar', () => {
  it('maps all colors correctly', () => {
    assert.equal(getStatusCssVar('accent'), 'var(--accent)');
    assert.equal(getStatusCssVar('success'), 'var(--status-success)');
    assert.equal(getStatusCssVar('error'), 'var(--status-error)');
    assert.equal(getStatusCssVar('warning'), 'var(--status-warning)');
    assert.equal(getStatusCssVar('merged'), 'var(--status-merged)');
    assert.equal(getStatusCssVar('muted'), 'var(--border)');
    assert.equal(getStatusCssVar('none'), 'transparent');
  });
});

describe('shouldUseDarkText', () => {
  it('returns true for success and warning (light backgrounds)', () => {
    assert.equal(shouldUseDarkText('success'), true);
    assert.equal(shouldUseDarkText('warning'), true);
  });

  it('returns false for dark backgrounds', () => {
    assert.equal(shouldUseDarkText('accent'), false);
    assert.equal(shouldUseDarkText('error'), false);
    assert.equal(shouldUseDarkText('merged'), false);
    assert.equal(shouldUseDarkText('muted'), false);
    assert.equal(shouldUseDarkText('none'), false);
  });
});
