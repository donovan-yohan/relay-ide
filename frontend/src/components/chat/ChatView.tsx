import React, { useCallback, useMemo } from 'react';
import './ChatView.css';
import { useAgentChatSocket } from '../../hooks/useAgentChatSocket.js';
import { AgentTimeline } from '../chat-v2/AgentTimeline.js';
import { Composer } from './Composer.js';

interface ChatViewProps {
  sessionId: string | null;
}

export const ChatView: React.FC<ChatViewProps> = ({ sessionId }) => {
  const { session, sendMessage, interrupt, approve } =
    useAgentChatSocket(sessionId);

  const isActive = useMemo(() => {
    return (
      session?.live.status === 'working' || session?.live.status === 'waiting'
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
      <AgentTimeline session={session} onApprove={approve} />
      <Composer
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        isActive={isActive}
      />
    </div>
  );
};

export default ChatView;
