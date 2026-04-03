import { describe, it, expect } from 'vitest';
import {
  derivePrAction,
  deriveSecondaryAction,
  getActionPrompt,
  getStatusCssVar,
  shouldUseDarkText,
} from '../frontend/src/lib/pr-state.js';
import type { PrStateInput } from '../frontend/src/lib/pr-state.js';

describe('derivePrAction', () => {
  it('returns none when no commits ahead and no PR', () => {
    const input: PrStateInput = {
      commitsAhead: 0,
      prState: null,
      ciPassing: 0,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 0,
      mergeable: null,
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('none');
    expect(action.color).toBe('none');
    expect(action.label).toBe('');
  });

  it('returns create-pr when commits ahead but no PR', () => {
    const input: PrStateInput = {
      commitsAhead: 3,
      prState: null,
      ciPassing: 0,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 0,
      mergeable: null,
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('create-pr');
    expect(action.color).toBe('accent');
    expect(action.label).toBe('Create PR');
  });

  it('returns ready-for-review for draft PR', () => {
    const input: PrStateInput = {
      commitsAhead: 5,
      prState: 'DRAFT',
      ciPassing: 0,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 0,
      mergeable: null,
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('ready-for-review');
    expect(action.color).toBe('muted');
    expect(action.label).toBe('Ready for Review');
  });

  it('returns merge-pr for open PR with all CI passing (author default)', () => {
    const input: PrStateInput = {
      commitsAhead: 2,
      prState: 'OPEN',
      ciPassing: 5,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 5,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('merge-pr');
    expect(action.color).toBe('success');
    expect(action.label).toBe('Merge');
  });

  it('returns merge-pr for open PR with no CI checks (author default)', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 0,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 0,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('merge-pr');
    expect(action.color).toBe('success');
  });

  it('returns fix-errors for open PR with failing CI', () => {
    const input: PrStateInput = {
      commitsAhead: 2,
      prState: 'OPEN',
      ciPassing: 6,
      ciFailing: 2,
      ciPending: 0,
      ciTotal: 8,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('fix-errors');
    expect(action.color).toBe('error');
    expect(action.label).toBe('Fix Errors 2/8');
  });

  it('returns checks-running for open PR with pending CI', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 3,
      ciFailing: 0,
      ciPending: 2,
      ciTotal: 5,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('checks-running');
    expect(action.color).toBe('warning');
    expect(action.label).toBe('Checks Running...');
  });

  it('prioritizes failing over pending CI', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 3,
      ciFailing: 1,
      ciPending: 1,
      ciTotal: 5,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('fix-errors');
    expect(action.label).toBe('Fix Errors 1/5');
  });

  it('returns archive-merged for merged PR', () => {
    const input: PrStateInput = {
      commitsAhead: 0,
      prState: 'MERGED',
      ciPassing: 5,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 5,
      mergeable: null,
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('archive-merged');
    expect(action.color).toBe('merged');
    expect(action.label).toBe('Archive');
  });

  it('returns archive-closed for closed PR', () => {
    const input: PrStateInput = {
      commitsAhead: 0,
      prState: 'CLOSED',
      ciPassing: 0,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 0,
      mergeable: null,
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('archive-closed');
    expect(action.color).toBe('muted');
    expect(action.label).toBe('Archive');
  });

  it('returns fix-conflicts for open PR with CONFLICTING mergeable', () => {
    const input: PrStateInput = {
      commitsAhead: 2,
      prState: 'OPEN',
      ciPassing: 0,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 0,
      mergeable: 'CONFLICTING',
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('fix-conflicts');
    expect(action.color).toBe('error');
    expect(action.label).toBe('Fix Conflicts');
  });

  it('prioritizes fix-conflicts over fix-errors', () => {
    const input: PrStateInput = {
      commitsAhead: 2,
      prState: 'OPEN',
      ciPassing: 0,
      ciFailing: 3,
      ciPending: 0,
      ciTotal: 3,
      mergeable: 'CONFLICTING',
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('fix-conflicts');
  });

  it('returns resolve-comments when unresolved comments > 0 and CI passing', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 5,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 5,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 3,
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('resolve-comments');
    expect(action.color).toBe('accent');
    expect(action.label).toBe('Resolve Comments (3)');
  });

  // ── Role-aware tests ──

  it('returns merge-pr for author when open + all clear', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 5,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 5,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 0,
      role: 'author',
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('merge-pr');
    expect(action.color).toBe('success');
    expect(action.label).toBe('Merge');
  });

  it('returns review-pr with info color for reviewer when open + all clear', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 5,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 5,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 0,
      role: 'reviewer',
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('review-pr');
    expect(action.color).toBe('info');
    expect(action.label).toBe('Review');
  });

  it('returns muted checks-running for reviewer when CI failing', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 3,
      ciFailing: 2,
      ciPending: 0,
      ciTotal: 5,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 0,
      role: 'reviewer',
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('checks-running');
    expect(action.color).toBe('muted');
    expect(action.label).toBe('CI Failing');
  });

  it('returns none for reviewer on draft PR', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'DRAFT',
      ciPassing: 0,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 0,
      mergeable: null,
      unresolvedCommentCount: 0,
      role: 'reviewer',
    };
    const action = derivePrAction(input);
    expect(action.type).toBe('none');
  });

  it('defaults to author behavior when role omitted', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 5,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 5,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    // Without role, defaults to author → merge-pr
    expect(action.type).toBe('merge-pr');
  });
});

describe('getActionPrompt', () => {
  it('returns prompt for create-pr', () => {
    const prompt = getActionPrompt(
      { type: 'create-pr', color: 'accent', label: 'Create PR' },
      { branchName: 'feat/my-feature' }
    );
    expect(prompt).toBeTruthy();
    expect(prompt!).toContain('feat/my-feature');
    expect(prompt!).toContain('pull request');
  });

  it('returns prompt for fix-errors', () => {
    const prompt = getActionPrompt(
      { type: 'fix-errors', color: 'error', label: 'Fix Errors 2/8' },
      { branchName: 'bugfix/auth' }
    );
    expect(prompt).toBeTruthy();
    expect(prompt!).toContain('bugfix/auth');
    expect(prompt!).toContain('failing');
  });

  it('returns prompt for review-pr', () => {
    const prompt = getActionPrompt(
      { type: 'review-pr', color: 'success', label: 'Review PR' },
      { branchName: 'main', prNumber: 42 }
    );
    expect(prompt).toBeTruthy();
    expect(prompt!).toContain('Review');
  });

  it('returns prompt for fix-conflicts', () => {
    const prompt = getActionPrompt(
      { type: 'fix-conflicts', color: 'error', label: 'Fix Conflicts' },
      { branchName: 'feat/foo', baseBranch: 'main' }
    );
    expect(prompt).toBeTruthy();
    expect(prompt!).toContain('main');
    expect(prompt!).toContain('conflict');
  });

  it('returns prompt for resolve-comments', () => {
    const prompt = getActionPrompt(
      {
        type: 'resolve-comments',
        color: 'accent',
        label: 'Resolve Comments (3)',
      },
      { branchName: 'feat/foo', prNumber: 7, unresolvedCommentCount: 3 }
    );
    expect(prompt).toBeTruthy();
    expect(prompt!).toContain('3');
    expect(prompt!).toContain('#7');
  });

  it('returns null for archive actions', () => {
    expect(
      getActionPrompt(
        { type: 'archive-merged', color: 'merged', label: 'Archive' },
        { branchName: 'main' }
      )
    ).toBe(null);
    expect(
      getActionPrompt(
        { type: 'archive-closed', color: 'muted', label: 'Archive' },
        { branchName: 'main' }
      )
    ).toBe(null);
  });

  it('returns null for none and checks-running', () => {
    expect(
      getActionPrompt(
        { type: 'none', color: 'none', label: '' },
        { branchName: 'main' }
      )
    ).toBe(null);
    expect(
      getActionPrompt(
        {
          type: 'checks-running',
          color: 'warning',
          label: 'Checks Running...',
        },
        { branchName: 'main' }
      )
    ).toBe(null);
  });

  it('returns null for merge-pr (GitHub link action)', () => {
    expect(
      getActionPrompt(
        { type: 'merge-pr', color: 'success', label: 'Merge' },
        { branchName: 'main' }
      )
    ).toBe(null);
  });
});

describe('getStatusCssVar', () => {
  it('maps all colors correctly', () => {
    expect(getStatusCssVar('accent')).toBe('var(--accent)');
    expect(getStatusCssVar('success')).toBe('var(--status-success)');
    expect(getStatusCssVar('error')).toBe('var(--status-error)');
    expect(getStatusCssVar('warning')).toBe('var(--status-warning)');
    expect(getStatusCssVar('merged')).toBe('var(--status-merged)');
    expect(getStatusCssVar('muted')).toBe('var(--border)');
    expect(getStatusCssVar('none')).toBe('transparent');
    expect(getStatusCssVar('info')).toBe('var(--status-info)');
  });
});

describe('shouldUseDarkText', () => {
  it('returns true for success and warning (light backgrounds)', () => {
    expect(shouldUseDarkText('success')).toBe(true);
    expect(shouldUseDarkText('warning')).toBe(true);
  });

  it('returns false for dark backgrounds', () => {
    expect(shouldUseDarkText('accent')).toBe(false);
    expect(shouldUseDarkText('error')).toBe(false);
    expect(shouldUseDarkText('merged')).toBe(false);
    expect(shouldUseDarkText('muted')).toBe(false);
    expect(shouldUseDarkText('none')).toBe(false);
  });
});

describe('deriveSecondaryAction', () => {
  it('returns review-pr secondary for author with unresolved comments', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 5,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 5,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 3,
      role: 'author',
    };
    const primary = derivePrAction(input);
    expect(primary.type).toBe('resolve-comments');
    const secondary = deriveSecondaryAction(primary, input);
    expect(secondary).toBeTruthy();
    expect(secondary!.type).toBe('review-pr');
    expect(secondary!.color).toBe('muted');
  });

  it('returns resolve-comments secondary for reviewer with unresolved comments', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 5,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 5,
      mergeable: 'MERGEABLE',
      unresolvedCommentCount: 3,
      role: 'reviewer',
    };
    const primary = derivePrAction(input);
    expect(primary.type).toBe('review-pr');
    expect(primary.color).toBe('info');
    const secondary = deriveSecondaryAction(primary, input);
    expect(secondary).toBeTruthy();
    expect(secondary!.type).toBe('resolve-comments');
    expect(secondary!.color).toBe('accent');
  });
});
