import React from 'react';
import type { AgentProviderExtensionItemV2 } from '../../../../../../shared/agent-chat-protocol-v2.js';

interface TurnDiffCardProps {
  item: AgentProviderExtensionItemV2;
}

export const TurnDiffCard: React.FC<TurnDiffCardProps> = ({ item }) => {
  const threadId =
    typeof item.payload.threadId === 'string' ? item.payload.threadId : null;
  const turnId =
    typeof item.payload.turnId === 'string' ? item.payload.turnId : null;
  const diff =
    typeof item.payload.diff === 'string' ? item.payload.diff : null;

  return (
    <details
      className="provider-extension provider-extension--codex provider-extension--codex-turnDiff"
      role="article"
    >
      <summary className="provider-extension__h">codex.turnDiff</summary>
      <div className="provider-extension__body">
        {threadId !== null && (
          <div className="provider-extension__field">
            <span className="provider-extension__label">thread</span>
            <span className="provider-extension__value">{threadId}</span>
          </div>
        )}
        {turnId !== null && (
          <div className="provider-extension__field">
            <span className="provider-extension__label">turn</span>
            <span className="provider-extension__value">{turnId}</span>
          </div>
        )}
        {diff !== null ? (
          <pre className="provider-extension__pre provider-extension__pre--diff">
            {diff}
          </pre>
        ) : null}
      </div>
    </details>
  );
};

export default TurnDiffCard;
