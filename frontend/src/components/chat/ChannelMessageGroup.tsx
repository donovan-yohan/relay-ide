import React from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
  ChannelSenderRef,
} from '../../../../shared/channel-chat-protocol.js';
import { AgentAvatar } from './AgentAvatar.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import { shouldRenderChannelMessage } from '../../lib/chat/reasoning-detail.js';
import {
  displayedReplyCount,
  type DerivedReplyCount,
} from '../../lib/chat/channel-timeline-layout.js';
import { ChannelMessageRow } from './ChannelMessageRow.js';
import type { ReasoningDetailStateApi } from './ReasoningDetailState.js';
import {
  buildAgentActivityFoldNodes,
  formatAgentActivityRunCounts,
  type AgentActivityRun,
} from '../../lib/chat/channel-activity-folding.js';

/** Compact wall-clock time, lowercase (DESIGN.md casing law), e.g. `3:42pm`. */
export function formatGroupTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const meridiem = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes}${meridiem}`;
}

interface ChannelMessageGroupProps {
  sender: ChannelSenderRef;
  messages: ChannelMessage[];
  channelId: string;
  replyCounts?: Map<ChannelMessageId, DerivedReplyCount>;
  replyGrowth?: Map<ChannelMessageId, number>;
  onOpenThread?: (rootId: ChannelMessageId) => void;
  /** #1308 item 1: message a deep link just landed on, if it is in this group. */
  highlightedMessageId?: ChannelMessageId | null;
  /** #1308 item 2: re-route a failed row's original trigger. */
  onRetryMessage?: (message: ChannelMessage) => Promise<unknown>;
  /** #1308 item 3: rewrite the body of one of the operator's own rows. */
  onEditMessage?: (message: ChannelMessage, text: string) => Promise<unknown>;
  /** #1308 item 4: tombstone one of the operator's own rows. */
  onDeleteMessage?: (message: ChannelMessage) => Promise<unknown>;
  /** Profile actor ids currently non-idle in this channel (retry storm brake). */
  busyAgentIds?: ReadonlySet<string>;
  /** Rows a later `meta.retryOfMessageId` system row already superseded. */
  retriedMessageIds?: ReadonlySet<ChannelMessageId>;
  reasoningViewState?: ReasoningDetailStateApi;
  collapseCompletedAgentActivity?: boolean;
  expandedActivityRuns?: ReadonlySet<ChannelMessageId>;
  forceExpandedActivityRunKey?: ChannelMessageId | null;
  onToggleActivityRun?: (runKey: ChannelMessageId) => void;
}

function AgentActivityRunSummary({
  run,
  expanded,
  onToggle,
}: {
  run: AgentActivityRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  const lastSeq = run.messages[run.messages.length - 1]!.seq;
  const firstSeq = run.messages[0]!.seq;
  const countLabel = formatAgentActivityRunCounts(run.counts);
  const eventLabel = `${run.messages.length} agent event${
    run.messages.length === 1 ? '' : 's'
  }`;
  const chevron = expanded ? 'M3.5 10.5 8 6l4.5 4.5' : 'M3.5 5.5 8 10l4.5-4.5';
  return (
    <button
      type="button"
      className="ch-activity-run"
      aria-expanded={expanded}
      aria-label={`${expanded ? 'collapse' : 'expand'} ${eventLabel}: ${countLabel}`}
      data-channel-activity-run={run.runKey}
      data-channel-message-seq={lastSeq}
      data-channel-activity-start-seq={firstSeq}
      data-channel-activity-end-seq={lastSeq}
      onClick={onToggle}
    >
      <svg
        className="ch-activity-run__chevron"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        aria-hidden="true"
        focusable="false"
      >
        <path d={chevron} />
      </svg>
      <span>{eventLabel}</span>
      <span className="ch-activity-run__counts">{countLabel}</span>
    </button>
  );
}

export const ChannelMessageGroup: React.FC<ChannelMessageGroupProps> = ({
  sender,
  messages,
  channelId,
  replyCounts,
  replyGrowth,
  onOpenThread,
  highlightedMessageId = null,
  onRetryMessage,
  onEditMessage,
  onDeleteMessage,
  busyAgentIds,
  retriedMessageIds,
  reasoningViewState,
  collapseCompletedAgentActivity = false,
  expandedActivityRuns,
  forceExpandedActivityRunKey = null,
  onToggleActivityRun,
}) => {
  const visibleMessages = messages.filter(shouldRenderChannelMessage);
  if (visibleMessages.length === 0) return null;
  const identity = resolveSenderIdentity(sender);
  const first = visibleMessages[0];
  // Human messages carry no name chrome — they are always "you", right-aligned
  // bubbles in a single-operator system (spec §4). Agent/system get a header.
  const showHeader = identity.kind !== 'human';
  const foldNodes = buildAgentActivityFoldNodes(
    visibleMessages,
    collapseCompletedAgentActivity
  );

  function renderMessage(message: ChannelMessage): React.ReactElement {
    const derived = replyCounts?.get(message.id);
    return (
      <ChannelMessageRow
        key={message.id}
        message={message}
        channelId={channelId}
        reasoningViewState={reasoningViewState}
        highlighted={highlightedMessageId === message.id}
        retryBusy={busyAgentIds?.has(message.sender.id) ?? false}
        retried={retriedMessageIds?.has(message.id) ?? false}
        {...(onRetryMessage ? { onRetry: onRetryMessage } : {})}
        {...(onEditMessage ? { onEdit: onEditMessage } : {})}
        {...(onDeleteMessage ? { onDelete: onDeleteMessage } : {})}
        replyCount={displayedReplyCount(
          message,
          derived,
          replyGrowth?.get(message.id) ?? 0
        )}
        {...(derived?.lastReplyAt
          ? { lastReplyHint: formatGroupTime(derived.lastReplyAt) }
          : {})}
        {...(onOpenThread ? { onOpenThread } : {})}
      />
    );
  }

  return (
    <div className="ch-group">
      {showHeader && first ? (
        <div className="ch-group__header">
          {identity.kind === 'agent' ? (
            // Author slot: the initials-avatar carries per-profile identity;
            // color comes straight from `resolveSenderIdentity` so a default
            // profile keeps its curated vendor token (#1234).
            <AgentAvatar
              className="ch-group__avatar"
              identity={identity}
              name={identity.label}
              size={20}
            />
          ) : null}
          <span className="ch-group__name" style={{ color: identity.colorVar }}>
            {identity.label}
          </span>
          <span className="ch-group__time">
            {formatGroupTime(first.createdAt)}
          </span>
        </div>
      ) : null}
      <div className="ch-group__messages">
        {foldNodes.flatMap((node) => {
          if (node.kind === 'agent-activity-run') {
            const expanded =
              expandedActivityRuns?.has(node.runKey) === true ||
              forceExpandedActivityRunKey === node.runKey;
            const summary = (
              <AgentActivityRunSummary
                key={`activity-${node.runKey}`}
                run={node}
                expanded={expanded}
                onToggle={() => onToggleActivityRun?.(node.runKey)}
              />
            );
            return expanded
              ? [
                  summary,
                  ...node.messages.map((message) => renderMessage(message)),
                ]
              : [summary];
          }
          return [renderMessage(node.message)];
        })}
      </div>
    </div>
  );
};

export default ChannelMessageGroup;
