import React from 'react';
import type { AgentTurnV2 } from '../../../../shared/agent-chat-protocol-v2.js';

interface TurnFooterProps {
  turn: AgentTurnV2;
}

/** Format a timestamp as HH:MM:SS (24-hour, zero-padded) per chat.html literal format "10:42:18". */
function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Format duration in ms as "Ns" or "Nm Ns" per chat.html "8s elapsed". */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function statusLabel(status: AgentTurnV2['status']): string {
  switch (status) {
    case 'completed':
      return 'finished';
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return 'failed';
    default:
      return status;
  }
}

export const TurnFooter: React.FC<TurnFooterProps> = ({ turn }) => {
  // Hide while running per spec: "Hide entirely while running."
  if (turn.status === 'running' || turn.status === 'waiting') return null;
  if (!turn.completedAt) return null;

  const label = statusLabel(turn.status);
  const timeStr = formatTime(turn.completedAt);
  const durationStr = turn.durationMs != null ? formatDuration(turn.durationMs) : null;
  const meta = durationStr ? `${timeStr} · ${durationStr} elapsed` : timeStr;

  return (
    <div className="turn-footer">
      <span className="lbl">{label}</span>
      <span className="meta">{meta}</span>
    </div>
  );
};

export default TurnFooter;
