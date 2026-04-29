import React, { useEffect, useState } from 'react';
import type {
  AgentSessionLiveStateV2,
  AgentTurnV2,
} from '../../../../shared/agent-chat-protocol-v2.js';

interface TurnFooterProps {
  turn: AgentTurnV2;
  live?: AgentSessionLiveStateV2 | undefined;
}

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function statusWord(status: AgentTurnV2['status']): string | null {
  switch (status) {
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

export const TurnFooter: React.FC<TurnFooterProps> = ({ turn, live }) => {
  const isActive =
    live?.activeTurnId === turn.id &&
    (live.status === 'working' || live.status === 'waiting');

  const [now, setNow] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!isActive) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    const spin = setInterval(() => {
      setFrame((f) => (f + 1) % BRAILLE_FRAMES.length);
    }, 80);
    return () => clearInterval(spin);
  }, [isActive]);

  if (isActive) {
    const elapsedMs = now - new Date(turn.startedAt).getTime();
    const stage = live?.waitingOn ? `waiting on ${live.waitingOn}` : live?.status ?? 'working';
    return (
      <div className="turn-footer turn-footer--running" role="status" aria-live="polite">
        <span className="glyph">{BRAILLE_FRAMES[frame]}</span>
        <span className="stage">{stage}</span>
        <span className="meta">
          {formatDuration(elapsedMs)} · {formatTime(new Date(now).toISOString())}
        </span>
      </div>
    );
  }

  if (turn.status === 'running' || turn.status === 'waiting') return null;
  if (!turn.completedAt) return null;

  const word = statusWord(turn.status);
  const timeStr = formatTime(turn.completedAt);
  const durationStr = turn.durationMs != null ? formatDuration(turn.durationMs) : null;
  const tail = durationStr ? `${durationStr} · ${timeStr}` : timeStr;

  return (
    <div className="turn-footer">
      {word && <span className="lbl">{word}</span>}
      <span className="meta">{tail}</span>
    </div>
  );
};

export default TurnFooter;
