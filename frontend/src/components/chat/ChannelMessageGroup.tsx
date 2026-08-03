import React from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
  ChannelSenderRef,
} from '../../../../shared/channel-chat-protocol.js';
import { AgentAvatar } from './AgentAvatar.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import {
  displayedReplyCount,
  type DerivedReplyCount,
} from '../../lib/chat/channel-timeline-layout.js';
import { ChannelMessageRow } from './ChannelMessageRow.js';

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
}) => {
  const identity = resolveSenderIdentity(sender);
  const first = messages[0];
  // Human messages carry no name chrome — they are always "you", right-aligned
  // bubbles in a single-operator system (spec §4). Agent/system get a header.
  const showHeader = identity.kind !== 'human';

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
        {messages.map((message) => {
          const derived = replyCounts?.get(message.id);
          return (
            <ChannelMessageRow
              key={message.id}
              message={message}
              channelId={channelId}
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
        })}
      </div>
    </div>
  );
};

export default ChannelMessageGroup;
