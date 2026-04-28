import React from 'react';
import type { AgentProviderExtensionItemV2 } from '../../../../../../shared/agent-chat-protocol-v2.js';

interface EnteredReviewModeCardProps {
  item: AgentProviderExtensionItemV2;
}

export const EnteredReviewModeCard: React.FC<EnteredReviewModeCardProps> = ({
  item,
}) => {
  const review =
    typeof item.payload.review === 'string' ? item.payload.review : null;

  return (
    <details
      className="provider-extension provider-extension--codex provider-extension--codex-enteredReviewMode"
      role="article"
    >
      <summary className="provider-extension__h">
        codex.enteredReviewMode
      </summary>
      <div className="provider-extension__body">
        {review !== null && (
          <div className="provider-extension__field">
            <span className="provider-extension__label">review</span>
            <span className="provider-extension__value">{review}</span>
          </div>
        )}
        <div className="provider-extension__chip">review mode active</div>
      </div>
    </details>
  );
};

export default EnteredReviewModeCard;
