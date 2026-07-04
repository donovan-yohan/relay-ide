import { useMemo } from 'react';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { resolveSessionByKey, scopedSessionKey } from '../lib/session-keys.js';
import { useUiStore } from '../lib/stores/ui.js';
import TopicComposer from './TopicComposer.js';
import ChatView from './chat/ChatView.js';
import './ChatHome.css';

export interface ChatHomeProps {
  onSelectSession: (id: string) => void;
}

/**
 * #1058/#1122: the chat/workspace spine is the default no-session/no-repo landing — and
 * the landing IS the composer. No sidebar clicking: type the first prompt, hit
 * send, and the chat + session are created with that message.
 * (codex-style). One-tap resume of the most recently active session stays as
 * a secondary affordance; the full cockpit remains reachable via the "open
 * work cockpit" command-palette action.
 */
export default function ChatHome({ onSelectSession }: ChatHomeProps) {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const topicComposerOpen = useUiStore((s) => s.topicComposerOpen);
  const activeSession = useMemo(
    () =>
      activeSessionId ? resolveSessionByKey(sessions, activeSessionId) : null,
    [activeSessionId, sessions]
  );

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
    <div className="chat-home" aria-label="chat home">
      {activeSession?.mode === 'web' && !topicComposerOpen ? (
        <ChatView sessionId={activeSession.id} />
      ) : null}
      {activeSession?.mode !== 'web' || topicComposerOpen ? (
        <TopicComposer resume={resume} />
      ) : null}
    </div>
  );
}
