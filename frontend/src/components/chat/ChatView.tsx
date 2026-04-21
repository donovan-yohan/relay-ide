import React, { useCallback, useMemo } from 'react';
import './ChatView.css';
import { useChatSocket } from '../../hooks/useChatSocket.js';
import { MessageTimeline } from './MessageTimeline.js';
import { Composer } from './Composer.js';
import type { SessionStatusEvent } from '../../../../shared/chat-events.js';

interface ChatViewProps {
  sessionId: string | null;
}

export const ChatView: React.FC<ChatViewProps> = ({ sessionId }) => {
  const { events, sendMessage, interrupt, approve } = useChatSocket(sessionId);

  // Determine if agent is active by looking at the latest session-status event
  const isActive = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && e.type === 'chat:session-status') {
        const status = (e as SessionStatusEvent).status;
        return status === 'active';
      }
    }
    return false;
  }, [events]);

  const handleSend = useCallback(
    (content: string) => {
      const turnId = crypto.randomUUID();
      sendMessage(turnId, content);
    },
    [sendMessage]
  );

  const handleInterrupt = useCallback(() => {
    // Find the latest active turnId — skip if none found
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (
        e &&
        'turnId' in e &&
        typeof (e as { turnId?: string }).turnId === 'string' &&
        (e as { turnId: string }).turnId.length > 0
      ) {
        interrupt((e as { turnId: string }).turnId);
        return;
      }
    }
  }, [events, interrupt]);

  return (
    <div className="chat-view" role="main" aria-label="chat">
      <MessageTimeline events={events} onApprove={approve} />
      <Composer
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        isActive={isActive}
      />
    </div>
  );
};

export default ChatView;
