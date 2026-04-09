import React, { useEffect, useMemo, useState } from 'react';
import type { AnalyticsSessionSummary } from '../lib/types.js';
import { fetchAnalyticsSessions } from '../lib/api.js';
import { formatRelativeTimeCompact } from '../lib/utils.js';
import './SessionHistoryPanel.css';

const historySvg = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="square"
    width="14"
    height="14"
  >
    <polyline points="12 8 12 12 16 14" />
    <circle cx="12" cy="12" r="9" />
  </svg>
);

const backSvg = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="square"
    width="14"
    height="14"
  >
    <line x1="19" y1="12" x2="5" y2="12" />
    <polyline points="12 19 5 12 12 5" />
  </svg>
);

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
};

function getAgentDisplayName(agentType: string | null): string {
  if (!agentType) return 'Unknown';
  return AGENT_DISPLAY_NAMES[agentType] ?? agentType;
}

interface GroupedSessions {
  agentType: string;
  displayName: string;
  sessions: AnalyticsSessionSummary[];
}

function groupSessionsByAgent(
  sessions: AnalyticsSessionSummary[]
): GroupedSessions[] {
  const groups = new Map<string, AnalyticsSessionSummary[]>();

  for (const session of sessions) {
    const agent = session.agentType ?? 'unknown';
    const existing = groups.get(agent);
    if (existing) {
      existing.push(session);
    } else {
      groups.set(agent, [session]);
    }
  }

  for (const [agent, agentSessions] of groups) {
    agentSessions.sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    groups.set(agent, agentSessions);
  }

  return Array.from(groups.entries())
    .map(([agentType, sessions]) => ({
      agentType,
      displayName: getAgentDisplayName(agentType),
      sessions,
    }))
    .sort((a, b) => {
      const aLatest = a.sessions[0]?.startedAt ?? '';
      const bLatest = b.sessions[0]?.startedAt ?? '';
      return new Date(bLatest).getTime() - new Date(aLatest).getTime();
    });
}

export interface SessionHistoryPanelProps {
  repoPath: string;
  repoName: string;
  onBack: () => void;
  onSelectSession?: (sessionId: string) => void;
}

export function SessionHistoryPanel({
  repoPath,
  repoName,
  onBack,
  onSelectSession,
}: SessionHistoryPanelProps) {
  const [sessions, setSessions] = useState<AnalyticsSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSessions() {
      try {
        setLoading(true);
        setError(null);
        const response = await fetchAnalyticsSessions({
          repo: repoPath,
          limit: 100,
          sort: 'started_at:desc',
        });
        if (!cancelled) {
          setSessions(response.sessions);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load history'
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadSessions();

    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const groupedSessions = useMemo(
    () => groupSessionsByAgent(sessions),
    [sessions]
  );

  return (
    <div className="session-history-panel">
      <div className="session-history-header">
        <button
          className="back-btn"
          onClick={onBack}
          aria-label="Back to sidebar"
        >
          {backSvg}
          <span>Back</span>
        </button>
        <h3 className="history-title">
          <span className="history-icon">{historySvg}</span>
          Session History: {repoName}
        </h3>
      </div>

      <div className="session-history-content">
        {loading ? (
          <div className="history-loading">Loading history...</div>
        ) : error ? (
          <div className="history-error">{error}</div>
        ) : sessions.length === 0 ? (
          <div className="history-empty">
            <p>No session history found for this repository.</p>
          </div>
        ) : (
          <div className="history-groups">
            {groupedSessions.map((group) => (
              <div key={group.agentType} className="history-group">
                <h4 className="group-header">{group.displayName}</h4>
                <ul className="group-sessions">
                  {group.sessions.map((session) => (
                    <li
                      key={session.sessionId}
                      className="history-session-item"
                      onClick={() => onSelectSession?.(session.sessionId)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          onSelectSession?.(session.sessionId);
                        }
                      }}
                    >
                      <div className="session-primary">
                        <span className="session-name">
                          {session.sessionId.slice(0, 8)}
                        </span>
                        <span className="session-time">
                          {formatRelativeTimeCompact(session.startedAt)}
                        </span>
                      </div>
                      <div className="session-secondary">
                        {session.turnCount > 0 && (
                          <span className="session-stats">
                            {session.turnCount} turns
                          </span>
                        )}
                        {session.durationSeconds !== null &&
                          session.durationSeconds > 0 && (
                            <span className="session-stats">
                              {formatDuration(session.durationSeconds)}
                            </span>
                          )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export default SessionHistoryPanel;
