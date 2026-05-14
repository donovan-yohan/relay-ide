import type { SessionSummary } from './types.js';

export interface SessionPaletteResult {
  type: 'session';
  id: string;
  label: string;
  sublabel: string;
  data: SessionSummary;
}

function searchableText(session: SessionSummary): string[] {
  return [session.displayName, session.branchName ?? '', session.repoName ?? ''];
}

export function buildSessionPaletteResults(
  query: string,
  sessions: SessionSummary[],
  limit = 5
): SessionPaletteResult[] {
  const q = query.toLowerCase();
  return sessions
    .filter((session) => searchableText(session).some((value) => value.toLowerCase().includes(q)))
    .slice(0, limit)
    .map((session) => ({
      type: 'session',
      id: `sess-${session.id}`,
      label: session.displayName || session.branchName || session.repoName || session.cwd || session.id,
      sublabel: session.repoName ?? '',
      data: session,
    }));
}
