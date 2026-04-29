import React from 'react';
import type { AgentProviderExtensionItemV2 } from '../../../../../../shared/agent-chat-protocol-v2.js';

interface ExitedReviewModeCardProps {
  item: AgentProviderExtensionItemV2;
}

export const ExitedReviewModeCard: React.FC<ExitedReviewModeCardProps> = ({
  item,
}) => {
  const review =
    typeof item.payload.review === 'string' ? item.payload.review : null;

  return (
    <details
      className="provider-extension provider-extension--codex provider-extension--codex-exitedReviewMode"
      role="article"
    >
      <summary className="provider-extension__h">
        codex.exitedReviewMode
      </summary>
      <div className="provider-extension__body">
        {review !== null ? (
          <pre className="provider-extension__pre">{review}</pre>
        ) : null}
      </div>
    </details>
  );
};

export default ExitedReviewModeCard;
