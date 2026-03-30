import type { PullRequest } from './types.js';

export type PrDotStatus = 'draft' | 'open' | 'approved' | 'changes-requested' |
  'review-requested' | 'merged' | 'closed' | 'unknown';

export function derivePrDotStatus(pr: PullRequest): PrDotStatus {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  if (pr.reviewDecision === 'APPROVED') return 'approved';
  if (pr.role === 'reviewer') return 'review-requested';
  return 'open';
}

