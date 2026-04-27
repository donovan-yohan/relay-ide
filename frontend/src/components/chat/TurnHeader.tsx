import React from 'react';
import type {
  AgentSessionV2,
  AgentTurnV2,
} from '../../../../shared/agent-chat-protocol-v2.js';

interface TurnHeaderProps {
  turn: AgentTurnV2;
  index: number;
  session: AgentSessionV2;
}

export const TurnHeader: React.FC<TurnHeaderProps> = ({
  turn,
  index,
  session,
}) => {
  const model = session.config.model ?? session.provider;
  const started = new Date(turn.startedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="turn-header">
      <span>turn {index + 1}</span>
      <span>·</span>
      <span>{model}</span>
      <span>·</span>
      <span>{started}</span>
      <span>·</span>
      <span>{turn.status}</span>
    </div>
  );
};

export default TurnHeader;
