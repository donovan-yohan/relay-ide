import type { PullRequest } from './types.js';

export function prRoleLabel(pr: PullRequest): string {
  return pr.role === 'author' ? 'by you' : 'review requested';
}

export function priorityTier(pr: PullRequest): number {
  if (pr.reviewDecision === 'CHANGES_REQUESTED' && pr.role === 'author')
    return 0;
  if (pr.role === 'reviewer') return 1;
  if (pr.role === 'author' && !pr.reviewDecision) return 2;
  if (pr.reviewDecision === 'APPROVED' && pr.ciStatus === 'SUCCESS') return 3;
  return 4;
}

export function sortPrs(
  prs: PullRequest[],
  sortBy: string,
  sortDir: 'asc' | 'desc'
): PullRequest[] {
  if (sortBy === 'role') {
    return [...prs].sort((a, b) => {
      const tierDiff = priorityTier(a) - priorityTier(b);
      if (tierDiff !== 0) return sortDir === 'asc' ? tierDiff : -tierDiff;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }
  if (sortBy === 'title') {
    return [...prs].sort((a, b) =>
      sortDir === 'asc'
        ? a.title.localeCompare(b.title)
        : b.title.localeCompare(a.title)
    );
  }
  if (sortBy === 'repo') {
    return [...prs].sort((a, b) =>
      sortDir === 'asc'
        ? (a.repoName ?? '').localeCompare(b.repoName ?? '')
        : (b.repoName ?? '').localeCompare(a.repoName ?? '')
    );
  }
  return [...prs].sort((a, b) =>
    sortDir === 'asc'
      ? a.updatedAt.localeCompare(b.updatedAt)
      : b.updatedAt.localeCompare(a.updatedAt)
  );
}
