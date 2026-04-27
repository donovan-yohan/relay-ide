import React from 'react';
import type { AgentTurnV2 } from '../../../../shared/agent-chat-protocol-v2.js';

interface TurnFooterProps {
  turn: AgentTurnV2;
}

export const TurnFooter: React.FC<TurnFooterProps> = ({ turn }) => {
  const usage = turn.usage;
  const parts: string[] = [];
  if (turn.durationMs != null) parts.push(`${turn.durationMs}ms`);
  if (usage?.inputTokens != null) parts.push(`${usage.inputTokens} in`);
  if (usage?.outputTokens != null) parts.push(`${usage.outputTokens} out`);
  if (usage?.contextPercent != null) parts.push(`${usage.contextPercent}% ctx`);

  if (parts.length === 0 && turn.status === 'running') {
    parts.push('running');
  }

  return <div className="turn-footer">{parts.join(' · ')}</div>;
};

export default TurnFooter;
