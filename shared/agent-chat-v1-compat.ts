// This is a temporary Agent Chat Protocol v1 compatibility bridge.
// Remove this module in Task 9 after web-session migration code and tests no
// longer need legacy ChatEvent replay. New provider adapters must not import it.

import type {
  AgentApprovalDecisionV2,
  AgentApprovalSupportV2,
  AgentItemV2,
  AgentPatchV2,
  AgentSessionLiveStateV2,
} from './agent-chat-protocol-v2.js';
import type {
  ChatEvent,
  ChatEventSource,
  MessageCompleteEvent,
} from './chat-events.js';

type CompatAgentPatchV2 = AgentPatchV2 & {
  metadata?: {
    source?: ChatEventSource;
    provider?: ChatEventSource;
  };
};

/** Legacy OpenCode/Hermes approvals support only once-accept and deny. */
const LEGACY_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once'],
  amendmentTypes: [],
  canCancel: false,
};

function legacyDecisionToV2(
  decision: 'allow' | 'allow-always' | 'deny'
): AgentApprovalDecisionV2 {
  if (decision === 'deny') return { kind: 'decline' };
  if (decision === 'allow-always') return { kind: 'accept', scope: 'permanent' };
  return { kind: 'accept', scope: 'once' };
}

export function mapChatEventToAgentPatchV2(event: ChatEvent): AgentPatchV2[] {
  switch (event.type) {
    case 'chat:session-status':
      return [
        {
          type: 'agent-live-state-updated-v2',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          live: liveStateFromSessionStatus(event),
        },
      ];

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

    case 'chat:turn-completed':
      return [
        {
          type: 'agent-turn-completed-v2',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          turnId: event.turnId,
          status: turnStatusFromCompletionReason(event.reason),
          completedAt: event.timestamp,
          durationMs: event.durationMs,
        },
      ];

    case 'chat:error':
      return [
        {
          type: 'agent-error-v2',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          message: event.message,
        },
        ...(event.turnId
          ? [
              {
                type: 'agent-turn-completed-v2' as const,
                sessionId: event.sessionId,
                timestamp: event.timestamp,
                turnId: event.turnId,
                status: 'failed' as const,
                completedAt: event.timestamp,
                error: event.message,
              },
            ]
          : []),
      ];

    case 'chat:text-delta':
      return [
        withCompatSource(
          {
            type: 'agent-item-delta-v2',
            sessionId: event.sessionId,
            timestamp: event.timestamp,
            turnId: event.turnId,
            itemId: event.messageId,
            delta: { text: event.delta },
          },
          event.source
        ),
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
            supported: LEGACY_APPROVAL_SUPPORT,
            decision: legacyDecisionToV2(event.decision),
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

function liveStateFromSessionStatus(
  event: Extract<ChatEvent, { type: 'chat:session-status' }>
): Partial<AgentSessionLiveStateV2> {
  switch (event.status) {
    case 'active':
      return {
        status: 'working',
        error: null,
      };
    case 'retry':
      return {
        status: 'waiting',
        waitingOn: waitingOnFromSessionStatus(event.waitingOn),
        error: event.error ?? null,
      };
    case 'error':
      return {
        status: 'error',
        error: event.error ?? 'Agent session error',
      };
    case 'disconnected':
    case 'idle':
      return {
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        error: null,
      };
  }
}

function waitingOnFromSessionStatus(
  waitingOn: Extract<ChatEvent, { type: 'chat:session-status' }>['waitingOn']
): AgentSessionLiveStateV2['waitingOn'] {
  if (waitingOn === 'user-input') return 'question';
  return waitingOn ?? 'network';
}

function turnStatusFromCompletionReason(
  reason: Extract<ChatEvent, { type: 'chat:turn-completed' }>['reason']
): 'completed' | 'interrupted' | 'failed' {
  if (reason === 'interrupted') return 'interrupted';
  if (reason === 'failed' || reason === 'error') return 'failed';
  return 'completed';
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
    supported: LEGACY_APPROVAL_SUPPORT,
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
  const maybeMetadataSource = (patch as CompatAgentPatchV2).metadata?.source;
  if (isChatEventSource(maybeMetadataSource)) {
    return maybeMetadataSource;
  }

  const maybeMetadataProvider = (patch as CompatAgentPatchV2).metadata
    ?.provider;
  if (isChatEventSource(maybeMetadataProvider)) {
    return maybeMetadataProvider;
  }

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

function withCompatSource<T extends AgentPatchV2>(
  patch: T,
  source: ChatEventSource
): T {
  return {
    ...patch,
    metadata: { source },
  } as T;
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
