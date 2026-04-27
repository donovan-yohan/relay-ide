import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import './ChatView.css';
import { useAgentChatSocket } from '../../hooks/useAgentChatSocket.js';
import { Composer } from './Composer.js';
import { LiveBar } from './LiveBar.js';
import { QueueChips } from './QueueChips.js';
import { Turn } from './Turn.js';

interface ChatViewProps {
  sessionId: string | null;
}

export const ChatView: React.FC<ChatViewProps> = ({ sessionId }) => {
  const { session, sendMessage, interrupt, approve } =
    useAgentChatSocket(sessionId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const itemCount = useMemo(
    () =>
      session?.turns.reduce((count, turn) => count + turn.items.length, 0) ?? 0,
    [session]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      150;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [itemCount]);

  const isActive = useMemo(
    () =>
      session?.live.status === 'working' || session?.live.status === 'waiting',
    [session]
  );

  const latestUsage = useMemo(() => {
    const turns = session?.turns;
    if (!turns || turns.length === 0) return undefined;
    return (
      turns[turns.length - 1]?.usage ??
      [...turns].reverse().find((turn) => turn.usage)?.usage
    );
  }, [session]);

  const handleSend = useCallback(
    (content: string) => {
      const turnId = crypto.randomUUID();
      sendMessage(turnId, content);
    },
    [sendMessage]
  );

  const handleInterrupt = useCallback(() => {
    interrupt(session?.live.activeTurnId ?? undefined);
  }, [interrupt, session]);

  return (
    <div className="chat-view" role="main" aria-label="chat">
      <div
        ref={containerRef}
        className="tl"
        role="log"
        aria-live="polite"
        aria-label="message timeline"
      >
        {!session || session.turns.length === 0 ? (
          <div className="tl-empty">no messages yet</div>
        ) : (
          <>
            {session.turns.map((turn, index) => (
              <Turn
                key={turn.id}
                turn={turn}
                index={index}
                session={session}
                onApprove={approve}
              />
            ))}
            <LiveBar live={session.live} usage={latestUsage} />
            <QueueChips session={session} />
          </>
        )}
        <div ref={bottomRef} />
      </div>
      <Composer
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        isActive={isActive}
        capabilities={session?.capabilities}
        live={session?.live}
        usage={latestUsage}
      />
    </div>
  );
};

export default ChatView;
