import { useMemo } from 'react';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { scopedSessionKey } from '../lib/session-keys.js';
import { useUiStore } from '../lib/stores/ui.js';
import TopicComposer from './TopicComposer.js';
import ChannelView from './chat/ChannelView.js';
import LiveSessionsPanel from './LiveSessionsPanel.js';
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
  const activeChannelId = useUiStore((s) => s.activeChannelId);

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
      {activeChannelId ? (
        // #1166: an open channel (DM or regular) is the primary chat surface.
        // Keyed by id so unread-capture/last-read-write run per channel-open.
        <ChannelView key={activeChannelId} channelId={activeChannelId} />
      ) : (
        <>
          <LiveSessionsPanel
            sessions={sessions}
            activeSessionKey={activeSessionId}
            onSelect={onSelectSession}
          />
          <TopicComposer {...(resume ? { resume } : {})} />
        </>
      )}
    </div>
  );
}
