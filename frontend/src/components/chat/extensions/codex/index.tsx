import React from 'react';
import './codex.css';
import type { AgentProviderExtensionItemV2 } from '../../../../../../shared/agent-chat-protocol-v2.js';
import { registerProviderExtensionRenderer } from '../registry.js';

export { EnteredReviewModeCard } from './EnteredReviewModeCard.js';
export { ExitedReviewModeCard } from './ExitedReviewModeCard.js';
export { ContextCompactionCard } from './ContextCompactionCard.js';
export { TurnDiffCard } from './TurnDiffCard.js';
export { ModelReroutedCard } from './ModelReroutedCard.js';
export { ModelVerificationCard } from './ModelVerificationCard.js';

import { EnteredReviewModeCard } from './EnteredReviewModeCard.js';
import { ExitedReviewModeCard } from './ExitedReviewModeCard.js';
import { ContextCompactionCard } from './ContextCompactionCard.js';
import { TurnDiffCard } from './TurnDiffCard.js';
import { ModelReroutedCard } from './ModelReroutedCard.js';
import { ModelVerificationCard } from './ModelVerificationCard.js';

function payloadKind(item: AgentProviderExtensionItemV2): string {
  const kind = item.payload.kind;
  const subtype = item.payload.subtype;
  const type = item.payload.type;
  if (typeof kind === 'string') return kind;
  if (typeof subtype === 'string') return subtype;
  if (typeof type === 'string') return type;
  return 'unknown';
}

export function registerCodexRenderers(): void {
  registerProviderExtensionRenderer('codex', (item) => {
    const kind = payloadKind(item);
    switch (kind) {
      case 'enteredReviewMode':
        return <EnteredReviewModeCard item={item} />;
      case 'exitedReviewMode':
        return <ExitedReviewModeCard item={item} />;
      case 'contextCompaction':
        return <ContextCompactionCard item={item} />;
      case 'turnDiff':
        return <TurnDiffCard item={item} />;
      case 'modelRerouted':
        return <ModelReroutedCard item={item} />;
      case 'modelVerification':
        return <ModelVerificationCard item={item} />;
      default:
        return null;
    }
  });
}
