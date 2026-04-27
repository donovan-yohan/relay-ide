import React from 'react';
import type { AgentSessionV2 } from '../../../../shared/agent-chat-protocol-v2.js';

interface QueueChipsProps {
  session: AgentSessionV2;
}

export const QueueChips: React.FC<QueueChipsProps> = ({ session }) => {
  const queueLength = session.live.queueLength;
  if (queueLength <= 0) return null;

  const canCancel = session.capabilities.cancelQueued === true;
  const chips = Array.from({ length: queueLength }, (_, index) => index + 1);

  return (
    <div className="queue" aria-label="queued messages">
      <div className="queue__label">
        <span className="ct">{queueLength} queued</span> · will run after
        current turn finishes
      </div>
      {chips.map((position) => (
        <div className="queue__item" key={position}>
          <div className="queue__bubble">
            {canCancel && (
              <button
                className="queue__cancel"
                type="button"
                aria-label="cancel queued message"
              >
                ×
              </button>
            )}
            <span className="pos">#{position}</span>
            <span>queued message</span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default QueueChips;
