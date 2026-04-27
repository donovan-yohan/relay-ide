import React from 'react';
import type {
  AgentSessionLiveStateV2,
  AgentUsageV2,
} from '../../../../shared/agent-chat-protocol-v2.js';

interface LiveBarProps {
  live: AgentSessionLiveStateV2;
  usage?: AgentUsageV2 | undefined;
}

export const LiveBar: React.FC<LiveBarProps> = ({ live, usage }) => {
  if (live.status === 'idle' && live.queueLength === 0 && !live.error)
    return null;

  const stage = live.waitingOn ? `waiting on ${live.waitingOn}` : live.status;

  return (
    <div className="live-bar" role="status" aria-live="polite">
      <span className="glyph">›</span>
      <span className="stage">{stage}</span>
      {live.queueLength > 0 && <span>{live.queueLength} queued</span>}
      {usage?.contextPercent != null && (
        <span className="pct">{usage.contextPercent}% ctx</span>
      )}
    </div>
  );
};

export default LiveBar;
