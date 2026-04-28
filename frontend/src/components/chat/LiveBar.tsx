import React, { useEffect, useState } from 'react';
import type {
  AgentSessionLiveStateV2,
  AgentUsageV2,
} from '../../../../shared/agent-chat-protocol-v2.js';

interface LiveBarProps {
  live: AgentSessionLiveStateV2;
  usage?: AgentUsageV2 | undefined;
}

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export const LiveBar: React.FC<LiveBarProps> = ({ live, usage }) => {
  const [frame, setFrame] = useState(0);

  const isVisible = live.status !== 'idle' || live.queueLength > 0 || Boolean(live.error);

  useEffect(() => {
    if (!isVisible) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % BRAILLE_FRAMES.length);
    }, 80);
    return () => clearInterval(id);
  }, [isVisible]);

  if (!isVisible) return null;

  const stage = live.waitingOn ? `waiting on ${live.waitingOn}` : live.status;
  const pct = usage?.contextPercent != null ? `${usage.contextPercent}%` : null;

  return (
    <div className="live-bar" role="status" aria-live="polite">
      <span className="glyph">{BRAILLE_FRAMES[frame]}</span>
      <span className="stage">{stage}</span>
      {pct && <span className="pct">{pct}</span>}
    </div>
  );
};

export default LiveBar;
