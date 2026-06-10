import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchActiveWork } from '../lib/api.js';
import type {
  WorkContextActiveGroup,
  WorkContextSessionSummary,
} from '../lib/types.js';

export interface WorkspaceEvidenceSessionsSectionProps {
  repoPath: string;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function sessionMatchesRepo(
  session: WorkContextSessionSummary,
  repoPath: string
): boolean {
  if (!repoPath) return false;
  return session.repoPath === repoPath || session.cwd === repoPath;
}

export function WorkspaceEvidenceSessionsSection({
  repoPath,
}: WorkspaceEvidenceSessionsSectionProps) {
  const query = useQuery<WorkContextActiveGroup[]>({
    queryKey: ['active-work'],
    queryFn: fetchActiveWork,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
  });

  const sessions = useMemo(() => {
    const groups = query.data ?? [];
    const matched: WorkContextSessionSummary[] = [];
    for (const group of groups) {
      for (const session of group.sessions) {
        if (sessionMatchesRepo(session, repoPath)) matched.push(session);
      }
    }
    return matched;
  }, [query.data, repoPath]);

  return (
    <section className="dashboard-section" data-track="evidence.sessions">
      <div className="section-heading">sessions</div>
      {query.isLoading ? (
        <div className="section-message">loading…</div>
      ) : sessions.length === 0 ? (
        <div className="section-message">no active sessions for this workspace</div>
      ) : (
        <div className="evidence-sessions">
          {sessions.map((session) => (
            <div key={session.id} className="evidence-session">
              <div className="evidence-session__title">
                <span className="evidence-session__name">
                  {session.displayName ?? shortId(session.id)}
                </span>
                <span className="evidence-session__id">
                  {shortId(session.globalSessionId ?? session.id)}
                </span>
              </div>
              <div className="evidence-session__cwd">{session.cwd}</div>
              <div className="evidence-session__meta">
                {[
                  session.agent ?? session.type ?? session.tabKind,
                  session.controlMode,
                  session.agentState,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default WorkspaceEvidenceSessionsSection;
