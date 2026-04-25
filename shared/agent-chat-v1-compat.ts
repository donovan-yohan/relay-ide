// This is a temporary Agent Chat Protocol v1 compatibility bridge.
// Remove this module in Task 9 after web-session migration code and tests no
// longer need legacy ChatEvent replay. New provider adapters must not import it.

import type { AgentItemV2, AgentPatchV2 } from './agent-chat-protocol-v2.js';
import type {
  ChatEvent,
  ChatEventSource,
  MessageCompleteEvent,
} from './chat-events.js';

export function mapChatEventToAgentPatchV2(event: ChatEvent): AgentPatchV2[] {
  switch (event.type) {
    case 'chat:turn-started':
      return [
        {
          type: 'agent-turn-started-v2',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          turn: {
            id: event.turnId,
            status: 'running',
            inputMessageId: `user-${event.turnId}`,
            items: [],
            startedAt: event.timestamp,
          },
        },
      ];

    case 'chat:text-delta':
      return [
        {
          type: 'agent-item-delta-v2',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          turnId: event.turnId,
          itemId: event.messageId,
          delta: { text: event.delta },
        },
      ];

    case 'chat:message-complete':
      return [
        {
          type: 'agent-item-updated-v2',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          turnId: event.turnId,
          item: messageCompleteToItem(event),
        },
      ];

    case 'chat:approval-request':
      return [
        {
          type: 'agent-item-started-v2',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          turnId: event.turnId,
          item: approvalRequestToItem(event),
        },
        {
          type: 'agent-live-state-updated-v2',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          live: {
            status: 'waiting',
            activeTurnId: event.turnId,
            waitingOn: 'approval',
            activeRequestIds: [event.requestId],
          },
        },
      ];

    case 'chat:approval-response':
      return [
        {
          type: 'agent-item-updated-v2',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          turnId: event.turnId,
          item: {
            type: 'approval',
            id: approvalItemId(event.requestId),
            requestId: event.requestId,
            kind: 'permission',
            description: '',
            target: '',
            decision: event.decision,
            respondedBy: event.respondedBy,
            status: 'completed',
            metadata: { source: event.source },
          },
        },
      ];

    default:
      return [];
  }
}

export function mapAgentPatchV2ToChatEvents(patch: AgentPatchV2): ChatEvent[] {
  switch (patch.type) {
    case 'agent-item-delta-v2':
      if (patch.delta.text === undefined) {
        return [];
      }

      return [
        {
          type: 'chat:text-delta',
          sessionId: patch.sessionId,
          timestamp: patch.timestamp,
          source: sourceFromPatch(patch),
          turnId: patch.turnId,
          messageId: patch.itemId,
          delta: patch.delta.text,
        },
      ];

    case 'agent-item-updated-v2':
      return itemUpdateToChatEvents(patch);

    default:
      return [];
  }
}

function approvalRequestToItem(
  event: Extract<ChatEvent, { type: 'chat:approval-request' }>
): AgentItemV2 {
  const item: AgentItemV2 = {
    type: 'approval',
    id: approvalItemId(event.requestId),
    requestId: event.requestId,
    kind: event.kind,
    description: event.description,
    target: event.target,
    status: 'pending',
    metadata: compactMetadata({
      source: event.source,
      toolName: event.toolName,
      timeoutMs: event.timeoutMs,
    }),
  };

  if (event.detail !== undefined) {
    item.detail = event.detail;
  }

  return item;
}

function messageCompleteToItem(event: MessageCompleteEvent): AgentItemV2 {
  const common = {
    id: event.messageId,
    text: event.content,
    status: 'completed' as const,
    completedAt: event.timestamp,
    metadata: { source: event.source },
  };

  if (event.role === 'user') {
    return {
      type: 'userMessage',
      ...common,
    };
  }

  return {
    type: 'assistantMessage',
    ...common,
    phase: null,
    providerMessageId: event.messageId,
  };
}

function itemUpdateToChatEvents(
  patch: Extract<AgentPatchV2, { type: 'agent-item-updated-v2' }>
): ChatEvent[] {
  if (
    patch.item.type !== 'assistantMessage' &&
    patch.item.type !== 'userMessage'
  ) {
    return [];
  }

  return [
    {
      type: 'chat:message-complete',
      sessionId: patch.sessionId,
      timestamp: patch.timestamp,
      source: sourceFromItem(patch.item),
      turnId: patch.turnId,
      messageId: patch.item.id,
      role: patch.item.type === 'userMessage' ? 'user' : 'assistant',
      content: patch.item.text,
    },
  ];
}

function sourceFromPatch(patch: AgentPatchV2): ChatEventSource {
  const maybeSource = (patch as { source?: unknown }).source;
  if (isChatEventSource(maybeSource)) {
    return maybeSource;
  }

  const maybeProvider = (patch as { provider?: unknown }).provider;
  if (isChatEventSource(maybeProvider)) {
    return maybeProvider;
  }

  return 'mock';
}

function sourceFromItem(item: AgentItemV2): ChatEventSource {
  const maybeSource = item.metadata?.source;
  if (isChatEventSource(maybeSource)) {
    return maybeSource;
  }

  const maybeProvider = item.metadata?.provider;
  if (isChatEventSource(maybeProvider)) {
    return maybeProvider;
  }

  return 'mock';
}

function isChatEventSource(value: unknown): value is ChatEventSource {
  return (
    value === 'codex' ||
    value === 'opencode' ||
    value === 'claude' ||
    value === 'mock' ||
    value === 'hermes'
  );
}

function approvalItemId(requestId: string): string {
  return `approval-${requestId}`;
}

function compactMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  );
}
