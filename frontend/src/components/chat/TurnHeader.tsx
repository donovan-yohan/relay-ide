import React from 'react';
import type { AgentTurnV2 } from '../../../../shared/agent-chat-protocol-v2.js';

interface TurnHeaderProps {
  turn: AgentTurnV2;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export const TurnHeader: React.FC<TurnHeaderProps> = ({ turn }) => {
  return (
    <div className="turn-header">
      <span className="meta">{formatTime(turn.startedAt)}</span>
    </div>
  );
};

export default TurnHeader;
