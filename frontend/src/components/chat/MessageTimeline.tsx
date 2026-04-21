import React, { useEffect, useRef, useMemo } from 'react';
import './MessageTimeline.css';
import type {
  ChatEvent,
  ApprovalRequestEvent,
  ApprovalResponseEvent,
  ToolCallEvent,
  ToolResultEvent,
  FileChangeEvent,
  ErrorEvent,
} from '../../../../shared/chat-events.js';
import { ToolCard } from './ToolCard.js';
import { FileChangeCard } from './FileChangeCard.js';
import { ApprovalCard } from './ApprovalCard.js';

interface MessageTimelineProps {
  events: ChatEvent[];
  onApprove: (
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ) => void;
}

interface TurnGroup {
  turnId: string;
  turnIndex: number;
  textByMessageId: Map<string, string>;
  textMessageOrder: string[];
  toolCalls: ToolCallEvent[];
  toolResults: Map<string, ToolResultEvent>;
  fileChanges: FileChangeEvent[];
  approvalRequests: ApprovalRequestEvent[];
  approvalResponses: Map<string, ApprovalResponseEvent>;
  errors: ErrorEvent[];
}

const NO_TURN = '__no_turn__';

function emptyGroup(turnId: string, turnIndex: number): TurnGroup {
  return {
    turnId,
    turnIndex,
    textByMessageId: new Map(),
    textMessageOrder: [],
    toolCalls: [],
    toolResults: new Map(),
    fileChanges: [],
    approvalRequests: [],
    approvalResponses: new Map(),
    errors: [],
  };
}

function getOrCreateGroup(
  groupMap: Map<string, TurnGroup>,
  groupOrder: string[],
  id: string,
  counter: { value: number }
): TurnGroup {
  let group = groupMap.get(id);
  if (!group) {
    group = emptyGroup(id, counter.value++);
    groupMap.set(id, group);
    groupOrder.push(id);
  }
  return group;
}

function routeEvent(
  event: ChatEvent,
  groupMap: Map<string, TurnGroup>,
  groupOrder: string[],
  counter: { value: number }
): void {
  const turnId =
    'turnId' in event ? (event as { turnId?: string }).turnId : undefined;

  switch (event.type) {
    case 'chat:text-delta': {
      const group = getOrCreateGroup(
        groupMap,
        groupOrder,
        event.turnId,
        counter
      );
      if (!group.textByMessageId.has(event.messageId)) {
        group.textByMessageId.set(event.messageId, '');
        group.textMessageOrder.push(event.messageId);
      }
      group.textByMessageId.set(
        event.messageId,
        (group.textByMessageId.get(event.messageId) ?? '') + event.delta
      );
      break;
    }
    case 'chat:tool-call': {
      const group = getOrCreateGroup(
        groupMap,
        groupOrder,
        event.turnId,
        counter
      );
      const existing = group.toolCalls.findIndex(
        (t) => t.toolCallId === event.toolCallId
      );
      if (existing >= 0) group.toolCalls[existing] = event;
      else group.toolCalls.push(event);
      break;
    }
    case 'chat:tool-result': {
      const gid = turnId ?? NO_TURN;
      const group = groupMap.get(gid);
      if (group) {
        group.toolResults.set(event.toolCallId, event);
        const idx = group.toolCalls.findIndex(
          (t) => t.toolCallId === event.toolCallId
        );
        if (idx >= 0)
          group.toolCalls[idx] = {
            ...group.toolCalls[idx]!,
            status: event.status,
          };
      }
      break;
    }
    case 'chat:file-change':
      getOrCreateGroup(
        groupMap,
        groupOrder,
        event.turnId,
        counter
      ).fileChanges.push(event);
      break;
    case 'chat:approval-request':
      getOrCreateGroup(
        groupMap,
        groupOrder,
        event.turnId,
        counter
      ).approvalRequests.push(event);
      break;
    case 'chat:approval-response':
      if (turnId)
        groupMap.get(turnId)?.approvalResponses.set(event.requestId, event);
      break;
    case 'chat:error':
      getOrCreateGroup(
        groupMap,
        groupOrder,
        event.turnId ?? NO_TURN,
        counter
      ).errors.push(event);
      break;
    default:
      break;
  }
}

function buildTurnGroups(events: ChatEvent[]): TurnGroup[] {
  const groupMap = new Map<string, TurnGroup>();
  const groupOrder: string[] = [];
  const counter = { value: 0 };

  // Pre-create groups from turn-started events
  for (const event of events) {
    if (event.type === 'chat:turn-started' && !groupMap.has(event.turnId)) {
      groupMap.set(event.turnId, emptyGroup(event.turnId, event.turnIndex));
      groupOrder.push(event.turnId);
      counter.value = event.turnIndex + 1;
    }
  }

  // Route all events into groups
  for (const event of events) {
    routeEvent(event, groupMap, groupOrder, counter);
  }

  return groupOrder.map((id) => groupMap.get(id)!);
}

export const MessageTimeline: React.FC<MessageTimelineProps> = ({
  events,
  onApprove,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => buildTurnGroups(events), [events]);

  // Auto-scroll only when user is near the bottom (within 150px)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      150;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events.length]);

  if (groups.length === 0) {
    return (
      <div
        className="message-timeline message-timeline--empty"
        role="log"
        aria-live="polite"
        aria-label="message timeline"
      >
        <span className="message-timeline__empty-label">no messages yet</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="message-timeline"
      role="log"
      aria-live="polite"
      aria-label="message timeline"
    >
      {groups.map((group) => (
        <div
          key={group.turnId}
          className="message-timeline__turn"
          role="group"
          aria-label={`turn ${group.turnIndex}`}
        >
          <div className="message-timeline__turn-header">
            turn {group.turnIndex}
          </div>

          {/* Text content */}
          {group.textMessageOrder.map((msgId) => {
            const text = group.textByMessageId.get(msgId) ?? '';
            if (!text) return null;
            return (
              <pre key={msgId} className="message-timeline__text">
                {text}
              </pre>
            );
          })}

          {/* Tool calls */}
          {group.toolCalls.map((tc) => (
            <ToolCard
              key={tc.toolCallId}
              event={tc}
              result={group.toolResults.get(tc.toolCallId)}
            />
          ))}

          {/* File changes */}
          {group.fileChanges.map((fc, i) => (
            <FileChangeCard key={`${fc.toolCallId}-${i}`} event={fc} />
          ))}

          {/* Approval requests */}
          {group.approvalRequests.map((ar) => {
            const response = group.approvalResponses.get(ar.requestId);
            return (
              <ApprovalCard
                key={ar.requestId}
                event={ar}
                onApprove={onApprove}
                responded={response !== undefined}
                decision={response?.decision}
              />
            );
          })}

          {/* Errors */}
          {group.errors.map((err, i) => (
            <div key={i} className="message-timeline__error">
              <span className="message-timeline__error-kind">{err.kind}</span>
              <span className="message-timeline__error-msg">{err.message}</span>
            </div>
          ))}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
};

export default MessageTimeline;
