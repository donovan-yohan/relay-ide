import { useMemo } from 'react';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { scopedSessionKey } from '../lib/session-keys.js';
import TopicComposer from './TopicComposer.js';
import './ChatHome.css';

export interface ChatHomeProps {
  onSelectSession: (id: string) => void;
}

/**
 * #1058: the chat/topic spine is the default no-session/no-repo landing — and
 * the landing IS the composer. No sidebar clicking: type the first prompt into
 * the main pane and the topic + session are created with that message
 * (codex-style). One-tap resume of the most recently active session stays as
 * a secondary affordance; the full cockpit remains reachable via the "open
 * work cockpit" command-palette action.
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
      <TopicComposer onSelectSession={onSelectSession} resume={resume} />
    </div>
  );
}
