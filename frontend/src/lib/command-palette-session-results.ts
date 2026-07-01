import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';
import { sessionMatchesTopic } from './state/topic-nav.js';
import type { SessionSummary } from './types.js';

export interface SessionPaletteResult {
  type: 'session';
  id: string;
  label: string;
  sublabel: string;
  data: SessionSummary;
}

function searchableText(session: SessionSummary): string[] {
  return [
    session.displayName,
    session.branchName ?? '',
    session.repoName ?? '',
  ];
}

/** The channel a session lives in, so palette results show where to resume. */
function parentChannelTitle(
  session: SessionSummary,
  topics: WorkspaceTopic[]
): string | null {
  const topic = topics.find((candidate) =>
    sessionMatchesTopic(candidate, session)
  );
  return topic?.display.title ?? null;
}

export function buildSessionPaletteResults(
  query: string,
  sessions: SessionSummary[],
  limit = 5,
  topics: WorkspaceTopic[] = []
): SessionPaletteResult[] {
  const q = query.toLowerCase();
  return sessions
    .filter((session) =>
      searchableText(session).some((value) => value.toLowerCase().includes(q))
    )
    .slice(0, limit)
    .map((session) => ({
      type: 'session',
      id: `sess-${session.id}`,
      label:
        session.displayName ||
        session.branchName ||
        session.repoName ||
        session.cwd ||
        session.id,
      // Prefer the parent channel (topic) so the user sees where to resume;
      // fall back to the repo name.
      sublabel: parentChannelTitle(session, topics) ?? session.repoName ?? '',
      data: session,
    }));
}
