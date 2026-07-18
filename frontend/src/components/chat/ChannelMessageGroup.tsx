import React from 'react';
import type {
  ChannelMessage,
  ChannelSenderRef,
} from '../../../../shared/channel-chat-protocol.js';
import { AgentBadge } from '../AgentBadge.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import { ChannelMessageRow } from './ChannelMessageRow.js';

/** Compact wall-clock time, lowercase (DESIGN.md casing law), e.g. `3:42pm`. */
function formatGroupTime(iso: string): string {
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
}

export const ChannelMessageGroup: React.FC<ChannelMessageGroupProps> = ({
  sender,
  messages,
  channelId,
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
          {identity.glyph ? (
            <span
              className="ch-group__badge"
              style={{ color: identity.colorVar }}
              aria-hidden="true"
            >
              <AgentBadge agent={identity.glyph} />
            </span>
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
        {messages.map((message) => (
          <ChannelMessageRow
            key={message.id}
            message={message}
            channelId={channelId}
          />
        ))}
      </div>
    </div>
  );
};

export default ChannelMessageGroup;
