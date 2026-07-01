import { useMemo } from 'react';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { scopedSessionKey } from '../lib/session-keys.js';
import { openTopicTaskRoom } from '../lib/topic-task-room.js';
import { ActiveWorkEmpty } from './ActiveWorkSurface.js';
import './ChatHome.css';

export interface ChatHomeProps {
  onSelectSession: (id: string) => void;
}

/**
 * #1058: the chat/topic spine is the default no-session/no-repo landing —
 * replacing the WorkContext cockpit as the first thing an operator sees. The
 * topic sidebar stays primary; this main-pane empty state reuses the
 * cockpit's `ActiveWorkEmpty` panel/CTA pattern so the two surfaces stay
 * visually consistent, and offers a one-tap resume of the most recently
 * active session when one exists. The full cockpit remains reachable via the
 * "open work cockpit" command-palette action.
 */
export default function ChatHome({ onSelectSession }: ChatHomeProps) {
  const sessions = useSessionsStore((s) => s.sessions);

  const mostRecentSession = useMemo(() => {
    let best: (typeof sessions)[number] | undefined;
    for (const session of sessions) {
      if (!best || session.lastActivity > best.lastActivity) best = session;
    }
    return best;
  }, [sessions]);

  const resume = mostRecentSession
    ? {
        label: `resume "${mostRecentSession.displayName}"`,
        onResume: () => onSelectSession(scopedSessionKey(mostRecentSession)),
      }
    : undefined;

  return (
    <div className="chat-home" aria-label="chat and topic home">
      <ActiveWorkEmpty
        onStartTopic={openTopicTaskRoom}
        title="start a topic"
        lede={
          <>
            chat with an agent, launch a terminal, or review artifacts — each
            topic runs in its own node and repo. topics, sessions, and
            workspaces live in the sidebar; open the work cockpit from the
            command palette for cross-node prs, tickets, nodes, and audit.
          </>
        }
        {...(resume ? { resume } : {})}
      />
    </div>
  );
}
