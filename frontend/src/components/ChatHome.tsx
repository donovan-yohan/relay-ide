import { useMemo } from 'react';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { resolveSessionByKey, scopedSessionKey } from '../lib/session-keys.js';
import { useUiStore } from '../lib/stores/ui.js';
import TopicComposer from './TopicComposer.js';
import ChannelView from './chat/ChannelView.js';
import EmptyState from './EmptyState.js';
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
  const setActiveSessionId = useSessionsStore((s) => s.setActiveSessionId);
  const topicComposerOpen = useUiStore((s) => s.topicComposerOpen);
  const activeChannelId = useUiStore((s) => s.activeChannelId);
  const activeSession = useMemo(
    () =>
      activeSessionId ? resolveSessionByKey(sessions, activeSessionId) : null,
    [activeSessionId, sessions]
  );

  // Live PTY agent/terminal sessions (Claude/Codex/Hermes TUIs, bare
  // terminals). Web-mode rows are excluded here — the retired web-chat surface
  // (#1224) resolves to an archived-state tombstone, never this live list, so
  // this set is exactly what routes to the terminal view when selected.
  const liveSessions = useMemo(
    () => sessions.filter((session) => session.mode !== 'web'),
    [sessions]
  );

  // "Resume" must never resurrect the retired per-session web-chat surface, so
  // it iterates the same web-excluded set LiveSessionsPanel shows (#1166).
  const mostRecentSession = useMemo(() => {
    let best: (typeof liveSessions)[number] | undefined;
    for (const session of liveSessions) {
      if (!best || session.lastActivity > best.lastActivity) best = session;
    }
    return best;
  }, [liveSessions]);

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
      ) : activeSession?.mode === 'web' && !topicComposerOpen ? (
        // #1224: the legacy per-session web-chat surface (ChatView/Turn) is
        // retired. Pre-existing `mode:'web'` session rows are no longer
        // silently dropped — they resolve to an explicit archived-state
        // tombstone whose only action clears the persisted active-session
        // selection and returns the operator to the channel-first landing.
        <div
          className="chat-home__retired-session"
          aria-label="archived session"
        >
          <EmptyState
            icon="⌁"
            heading="This chat session has been archived"
            description="The legacy per-session web chat surface has been retired. Its transcript is preserved, and new work happens in channels."
            actionLabel="go to chat"
            onAction={() => setActiveSessionId(null)}
          />
        </div>
      ) : (
        <>
          <LiveSessionsPanel
            sessions={liveSessions}
            activeSessionKey={activeSessionId}
            onSelect={onSelectSession}
          />
          <TopicComposer {...(resume ? { resume } : {})} />
        </>
      )}
    </div>
  );
}
