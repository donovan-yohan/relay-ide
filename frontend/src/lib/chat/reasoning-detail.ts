import type { AgentDetailCardV2 } from '../../../../shared/agent-chat-protocol-v2.js';
import type { ChannelMessage } from '../../../../shared/channel-chat-protocol.js';

export type ReasoningTerminalState =
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'truncated';

export function reasoningTerminalStateForMessage(
  message: ChannelMessage
): ReasoningTerminalState | undefined {
  switch (message.status) {
    case 'complete':
      return 'completed';
    case 'interrupted':
    case 'failed':
    case 'truncated':
      return message.status;
    case 'streaming':
      return undefined;
  }
}

/** Empty live details communicate activity; empty terminal details disappear. */
export function shouldRenderReasoningDetail(
  card: AgentDetailCardV2,
  terminalState?: ReasoningTerminalState
): boolean {
  if (card.content?.trim()) return true;
  if (terminalState) return false;
  return card.status === 'pending' || card.status === 'running';
}

/** Render-only timeline projection: empty terminal reasoning owns no chrome. */
export function shouldRenderChannelMessage(message: ChannelMessage): boolean {
  const card = message.agentDetail?.card;
  return (
    card?.kind !== 'thought' ||
    shouldRenderReasoningDetail(card, reasoningTerminalStateForMessage(message))
  );
}
