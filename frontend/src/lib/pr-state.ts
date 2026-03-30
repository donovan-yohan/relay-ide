/**
 * PR Top Bar State Machine (Role-Aware)
 *
 * Pure function that derives the action button state from branch/PR/CI data
 * and the user's role relative to the PR (author or reviewer).
 *
 *   INPUT (branch state)              AUTHOR ACTION          REVIEWER ACTION
 *   ──────────────────────────────────────────────────────────────────────────
 *   No commits ahead                  (none)                 (none)
 *   Commits ahead, no PR              [Create PR]            [Create PR]
 *   PR Draft                          [Ready for Review]     (none)
 *   PR Open + CONFLICTING             [Fix Conflicts]        [Fix Conflicts]
 *   PR Open + CI failing              [Fix Errors N/M]       [CI Failing] (muted)
 *   PR Open + CI pending              [Checks Running...]    [Checks Running...]
 *   PR Open + unresolved comments     [Resolve Comments (N)] [Review] + [Resolve Comments]
 *   PR Open + all clear               [Merge]                [Review]
 *   PR Merged                         [Archive]              [Archive]
 *   PR Closed                         [Archive]              [Archive]
 */

export type PrActionType =
  | 'none'
  | 'create-pr'
  | 'ready-for-review'
  | 'merge-pr'
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
  | 'info'
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
  role?: 'author' | 'reviewer';
}

export interface ActionPromptContext {
  branchName: string;
  baseBranch?: string;
  prNumber?: number;
  unresolvedCommentCount?: number;
}

/** Build PrStateInput from a PullRequest, mapping ciStatus/reviewDecision to the state machine's numeric fields. */
export function buildPrStateInput(pr: { isDraft: boolean; state: string; ciStatus: string | null; mergeable: string | null; reviewDecision: string | null; role?: 'author' | 'reviewer' }): PrStateInput {
  return {
    commitsAhead: 1,
    prState: pr.isDraft ? 'DRAFT' : pr.state as PrStateInput['prState'],
    ciPassing: pr.ciStatus === 'SUCCESS' ? 1 : 0,
    ciFailing: (pr.ciStatus === 'FAILURE' || pr.ciStatus === 'ERROR') ? 1 : 0,
    ciPending: pr.ciStatus === 'PENDING' ? 1 : 0,
    ciTotal: pr.ciStatus ? 1 : 0,
    mergeable: (pr.mergeable as PrStateInput['mergeable']) ?? null,
    // TODO: use actual unresolved count once PullRequest carries it (currently a boolean heuristic)
    unresolvedCommentCount: pr.reviewDecision === 'CHANGES_REQUESTED' ? 1 : 0,
    ...(pr.role ? { role: pr.role } : {}),
  };
}

export function derivePrAction(input: PrStateInput): PrAction {
  const { commitsAhead, prState, ciFailing, ciPending, ciTotal, mergeable, unresolvedCommentCount } = input;
  const role = input.role ?? 'author';

  // No commits ahead of base — nothing to do
  if (commitsAhead <= 0 && prState === null) {
    return { type: 'none', color: 'none', label: '' };
  }

  // No PR exists but there are commits — offer to create
  if (prState === null) {
    return { type: 'create-pr', color: 'accent', label: 'Create PR' };
  }

  // PR is a draft — offer to mark ready (reviewer sees nothing)
  if (prState === 'DRAFT') {
    if (role === 'reviewer') {
      return { type: 'none', color: 'none', label: '' };
    }
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
    // Merge conflicts take priority — same for both roles
    if (mergeable === 'CONFLICTING') {
      return { type: 'fix-conflicts', color: 'error', label: 'Fix Conflicts' };
    }

    // CI checks are failing
    if (ciFailing > 0) {
      if (role === 'reviewer') {
        return { type: 'checks-running', color: 'muted', label: 'CI Failing' };
      }
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
      if (role === 'reviewer') {
        return { type: 'review-pr', color: 'info', label: 'Review' };
      }
      return {
        type: 'resolve-comments',
        color: 'accent',
        label: `Resolve Comments (${unresolvedCommentCount})`,
      };
    }

    // All CI checks passing (or no checks configured) — all clear
    if (role === 'reviewer') {
      return { type: 'review-pr', color: 'info', label: 'Review' };
    }
    return { type: 'merge-pr', color: 'success', label: 'Merge' };
  }

  // Fallback — should not reach here
  return { type: 'none', color: 'none', label: '' };
}

export function deriveSecondaryAction(primary: PrAction, input: PrStateInput): PrAction | null {
  const role = input.role ?? 'author';

  // Author primary = resolve-comments → secondary = review-pr (muted)
  if (primary.type === 'resolve-comments') {
    return { type: 'review-pr', color: 'muted', label: 'Review PR' };
  }

  // Reviewer primary = review-pr + unresolved comments → secondary = resolve-comments
  if (primary.type === 'review-pr' && role === 'reviewer' && input.unresolvedCommentCount > 0) {
    return {
      type: 'resolve-comments',
      color: 'accent',
      label: `Resolve Comments (${input.unresolvedCommentCount})`,
    };
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
    case 'merge-pr':
      return null; // Merge is a GitHub UI action (link to PR), not a Claude prompt
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
    case 'info': return 'var(--status-info)';
    case 'none': return 'transparent';
  }
}

export function shouldUseDarkText(color: StatusColor): boolean {
  return color === 'success' || color === 'warning';
}
