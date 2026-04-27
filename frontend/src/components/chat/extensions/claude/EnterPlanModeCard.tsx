import React from 'react';
import type { AgentProviderExtensionItemV2 } from '../../../../../../shared/agent-chat-protocol-v2.js';

interface EnterPlanModeCardProps {
  item: AgentProviderExtensionItemV2;
}

export const EnterPlanModeCard: React.FC<EnterPlanModeCardProps> = ({
  item,
}) => (
  <div
    className="provider-extension provider-extension--claude"
    role="article"
    aria-label="claude enter plan mode"
  >
    <div className="provider-extension__h">claude.enterPlanMode</div>
    <pre>{JSON.stringify(item.payload, null, 2)}</pre>
  </div>
);

export default EnterPlanModeCard;
