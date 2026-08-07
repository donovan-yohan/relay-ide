import type { TaskRef } from '../../../shared/work-context.js';

export function taskRefFromDraft(
  value: string,
  title: string
): TaskRef | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  let issueId: string | undefined;
  const pureIssueIdMatch = trimmed.match(/^\d+$/);
  if (pureIssueIdMatch) issueId = pureIssueIdMatch[0];

  const hashIssueMatch = trimmed.match(/^#(\d+)$/);
  if (!issueId && hashIssueMatch) issueId = hashIssueMatch[1];

  const issuePathMatch = trimmed.match(/(?:^|\/)issues\/(\d+)(?=$|[/?#])/i);
  const githubIssueUrl =
    /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+(?:[/?#].*)?$/i.test(
      trimmed
    );
  if (
    !issueId &&
    issuePathMatch &&
    (trimmed.startsWith('issues/') || githubIssueUrl)
  ) {
    issueId = issuePathMatch[1];
  }

  if (!issueId) {
    return { kind: 'external', id: trimmed, title };
  }

  return {
    kind: 'github-issue',
    id: issueId,
    title,
    ...(trimmed.startsWith('http') ? { url: trimmed } : {}),
  };
}
