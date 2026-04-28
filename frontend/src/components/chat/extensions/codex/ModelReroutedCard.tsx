import React from 'react';
import type { AgentProviderExtensionItemV2 } from '../../../../../../shared/agent-chat-protocol-v2.js';

interface ModelReroutedCardProps {
  item: AgentProviderExtensionItemV2;
}

export const ModelReroutedCard: React.FC<ModelReroutedCardProps> = ({
  item,
}) => {
  const threadId =
    typeof item.payload.threadId === 'string' ? item.payload.threadId : null;
  const turnId =
    typeof item.payload.turnId === 'string' ? item.payload.turnId : null;
  const fromModel =
    typeof item.payload.fromModel === 'string' ? item.payload.fromModel : null;
  const toModel =
    typeof item.payload.toModel === 'string' ? item.payload.toModel : null;
  const reason =
    typeof item.payload.reason === 'string' ? item.payload.reason : null;

  return (
    <details
      className="provider-extension provider-extension--codex provider-extension--codex-modelRerouted"
      role="article"
    >
      <summary className="provider-extension__h">codex.modelRerouted</summary>
      <div className="provider-extension__body">
        {fromModel !== null && toModel !== null && (
          <div className="provider-extension__field">
            <span className="provider-extension__label">rerouted</span>
            <span className="provider-extension__value">
              {fromModel} → {toModel}
            </span>
          </div>
        )}
        {fromModel !== null && toModel === null && (
          <div className="provider-extension__field">
            <span className="provider-extension__label">from</span>
            <span className="provider-extension__value">{fromModel}</span>
          </div>
        )}
        {toModel !== null && fromModel === null && (
          <div className="provider-extension__field">
            <span className="provider-extension__label">to</span>
            <span className="provider-extension__value">{toModel}</span>
          </div>
        )}
        {reason !== null && (
          <div className="provider-extension__field">
            <span className="provider-extension__label">reason</span>
            <span className="provider-extension__value">{reason}</span>
          </div>
        )}
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
      </div>
    </details>
  );
};

export default ModelReroutedCard;
