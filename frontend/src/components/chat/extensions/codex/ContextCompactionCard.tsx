import React from 'react';
import type { AgentProviderExtensionItemV2 } from '../../../../../../shared/agent-chat-protocol-v2.js';

interface ContextCompactionCardProps {
  item: AgentProviderExtensionItemV2;
}

export const ContextCompactionCard: React.FC<ContextCompactionCardProps> = ({
  item,
}) => {
  const summary =
    typeof item.payload.summary === 'string' ? item.payload.summary : null;

  return (
    <details
      className="provider-extension provider-extension--codex provider-extension--codex-contextCompaction"
      role="article"
    >
      <summary className="provider-extension__h">
        codex.contextCompaction
      </summary>
      <div className="provider-extension__body">
        <div className="provider-extension__chip">context compacted</div>
        {summary !== null && (
          <div className="provider-extension__field">
            <span className="provider-extension__label">summary</span>
            <span className="provider-extension__value">{summary}</span>
          </div>
        )}
      </div>
    </details>
  );
};

export default ContextCompactionCard;
