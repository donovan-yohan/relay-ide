/**
 * PR Top Bar State Machine
 *
 * Pure function that derives the action button state from branch/PR/CI data.
 *
 *   INPUT (branch state)              ACTION BUTTON
 *   ─────────────────────────────────────────────────
 *   No commits ahead                  (none)
 *   Commits ahead, no PR              [Create PR]
 *   PR Draft                          [Ready for Review]
 *   PR Open + CONFLICTING             [Fix Conflicts]
 *   PR Open + CI failing              [Fix Errors N/M]
 *   PR Open + CI pending              [Checks Running...]
 *   PR Open + unresolved comments     [Resolve Comments (N)] + [Review PR]
 *   PR Open + all clear               [Review PR]
 *   PR Merged                         [Archive]
 *   PR Closed                         [Archive]
 */

export type PrActionType =
  | 'none'
  | 'create-pr'
  | 'ready-for-review'
  | 'review-pr'
  | 'fix-errors'
  | 'fix-conflicts'
  | 'resolve-comments'
  | 'checks-running'
  | 'archive-merged'
  | 'archive-closed';

export type StatusColor =
  | 'accent'
  | 'success'
  | 'error'
  | 'warning'
  | 'merged'
  | 'muted'
  | 'none';

export interface PrAction {
  type: PrActionType;
  color: StatusColor;
  label: string;
}

export interface PrStateInput {
  commitsAhead: number;
  prState: 'OPEN' | 'CLOSED' | 'MERGED' | 'DRAFT' | null;
  ciPassing: number;
  ciFailing: number;
  ciPending: number;
  ciTotal: number;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  unresolvedCommentCount: number;
}

export interface ActionPromptContext {
  branchName: string;
  baseBranch?: string;
  prNumber?: number;
  unresolvedCommentCount?: number;
}

export function derivePrAction(input: PrStateInput): PrAction {
  const { commitsAhead, prState, ciFailing, ciPending, ciTotal, mergeable, unresolvedCommentCount } = input;

  // No commits ahead of base — nothing to do
  if (commitsAhead <= 0 && prState === null) {
    return { type: 'none', color: 'none', label: '' };
  }

  // No PR exists but there are commits — offer to create
  if (prState === null) {
    return { type: 'create-pr', color: 'accent', label: 'Create PR' };
  }

  // PR is a draft — offer to mark ready
  if (prState === 'DRAFT') {
    return { type: 'ready-for-review', color: 'muted', label: 'Ready for Review' };
  }

  // PR is merged — offer cleanup
  if (prState === 'MERGED') {
    return { type: 'archive-merged', color: 'merged', label: 'Archive' };
  }

  // PR is closed (not merged) — offer cleanup
  if (prState === 'CLOSED') {
    return { type: 'archive-closed', color: 'muted', label: 'Archive' };
  }

  // PR is open — check for conflicts first
  if (prState === 'OPEN') {
    // Merge conflicts take priority
    if (mergeable === 'CONFLICTING') {
      return { type: 'fix-conflicts', color: 'error', label: 'Fix Conflicts' };
    }

    // CI checks are failing
    if (ciFailing > 0) {
      return {
        type: 'fix-errors',
        color: 'error',
        label: `Fix Errors ${ciFailing}/${ciTotal}`,
      };
    }

    // CI checks are still running (some pending, none failing)
    if (ciPending > 0) {
      return { type: 'checks-running', color: 'warning', label: 'Checks Running...' };
    }

    // Unresolved review comments
    if (unresolvedCommentCount > 0) {
      return {
        type: 'resolve-comments',
        color: 'accent',
        label: `Resolve Comments (${unresolvedCommentCount})`,
      };
    }

    // All CI checks passing (or no checks configured) — ready for review
    return { type: 'review-pr', color: 'success', label: 'Review PR' };
  }

  // Fallback — should not reach here
  return { type: 'none', color: 'none', label: '' };
}

export function deriveSecondaryAction(primary: PrAction, _input: PrStateInput): PrAction | null {
  if (primary.type === 'resolve-comments') {
    return { type: 'review-pr', color: 'muted', label: 'Review PR' };
  }
  return null;
}

export function getActionPrompt(action: PrAction, ctx: ActionPromptContext): string | null {
  switch (action.type) {
    case 'create-pr':
      return `Create a pull request for the branch "${ctx.branchName}". Write a clear title and description based on the changes.`;
    case 'ready-for-review':
      return `Mark the draft PR for branch "${ctx.branchName}" as ready for review using: gh pr ready`;
    case 'review-pr':
      return `Review the pull request #${ctx.prNumber} for branch "${ctx.branchName}". Read the diff, check for bugs and code quality.`;
    case 'fix-conflicts':
      return `There are merge conflicts with the base branch "${ctx.baseBranch}". Run \`git merge ${ctx.baseBranch}\` and resolve all conflicts.`;
    case 'resolve-comments':
      return `There are ${ctx.unresolvedCommentCount} unresolved review comments on PR #${ctx.prNumber}. Read each comment thread, triage them, and address the feedback.`;
    case 'fix-errors':
      return `The CI checks are failing on branch "${ctx.branchName}". Investigate the failing checks and fix the errors.`;
    case 'archive-merged':
    case 'archive-closed':
      return null; // Archive is a UI action (delete worktree), not a Claude prompt
    case 'checks-running':
    case 'none':
      return null;
  }
}

export function getStatusCssVar(color: StatusColor): string {
  switch (color) {
    case 'accent': return 'var(--accent)';
    case 'success': return 'var(--status-success)';
    case 'error': return 'var(--status-error)';
    case 'warning': return 'var(--status-warning)';
    case 'merged': return 'var(--status-merged)';
    case 'muted': return 'var(--border)';
    case 'none': return 'transparent';
  }
}

export function shouldUseDarkText(color: StatusColor): boolean {
  return color === 'success' || color === 'warning';
}
