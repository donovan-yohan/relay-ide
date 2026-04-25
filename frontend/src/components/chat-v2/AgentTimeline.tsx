import React, { useEffect, useRef } from 'react';
import type { AgentSessionV2 } from '../../../../shared/agent-chat-protocol-v2.js';
import { AgentItemRenderer } from './AgentItemRenderer.js';
import '../chat/MessageTimeline.css';

interface AgentTimelineProps {
  session: AgentSessionV2 | null;
  onApprove: (
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ) => void;
}

export const AgentTimeline: React.FC<AgentTimelineProps> = ({
  session,
  onApprove,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemCount =
    session?.turns.reduce((count, turn) => count + turn.items.length, 0) ?? 0;

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

  if (!session || session.turns.length === 0) {
    return (
      <div
        className="message-timeline message-timeline--empty"
        role="log"
        aria-live="polite"
        aria-label="message timeline"
      >
        <span className="message-timeline__empty-label">no messages yet</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="message-timeline"
      role="log"
      aria-live="polite"
      aria-label="message timeline"
    >
      {session.turns.map((turn, index) => (
        <div
          key={turn.id}
          className="message-timeline__turn"
          role="group"
          aria-label={`turn ${index}`}
        >
          <div className="message-timeline__turn-header">
            turn {index} {turn.status !== 'running' ? turn.status : ''}
          </div>
          {turn.items.map((item) => (
            <AgentItemRenderer
              key={item.id}
              item={item}
              onApprove={onApprove}
            />
          ))}
          {turn.error && (
            <div className="message-timeline__error">
              <span className="message-timeline__error-kind">error</span>
              <span className="message-timeline__error-msg">{turn.error}</span>
            </div>
          )}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
};
