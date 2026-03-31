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

export interface PrGlyphInfo {
  char: string;
  colorClass: string;
  label: string;
}

export function prGlyph(status: PrDotStatus): PrGlyphInfo {
  switch (status) {
    case 'draft':             return { char: '◌', colorClass: 'pr-gray',   label: 'draft pr' };
    case 'open':              return { char: '○', colorClass: 'pr-blue',   label: 'open pr' };
    case 'review-requested':  return { char: '◎', colorClass: 'pr-yellow', label: 'review requested' };
    case 'changes-requested': return { char: '✕', colorClass: 'pr-red',    label: 'changes requested' };
    case 'approved':          return { char: '✓', colorClass: 'pr-green',  label: 'approved' };
    case 'merged':            return { char: '●', colorClass: 'pr-purple', label: 'merged' };
    case 'closed':            return { char: '⊘', colorClass: 'pr-red',    label: 'closed (not merged)' };
    case 'unknown':           return { char: '?', colorClass: 'pr-gray',   label: 'unknown' };
  }
}

