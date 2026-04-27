import React from 'react';
import type { AgentProviderExtensionItemV2 } from '../../../../../../shared/agent-chat-protocol-v2.js';

interface FastModeUnavailableCardProps {
  item: AgentProviderExtensionItemV2;
}

export const FastModeUnavailableCard: React.FC<
  FastModeUnavailableCardProps
> = ({ item }) => (
  <div
    className="provider-extension provider-extension--claude"
    role="article"
    aria-label="claude fast mode unavailable"
  >
    <div className="provider-extension__h">claude.fastModeUnavailable</div>
    <pre>{JSON.stringify(item.payload, null, 2)}</pre>
  </div>
);

export default FastModeUnavailableCard;
