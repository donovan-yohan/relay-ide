import React, { useEffect, useState } from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../../../shared/channel-chat-protocol.js';
import { AssistantMarkdown } from './AssistantMarkdown.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import { respondChannelApproval } from '../../lib/api.js';

/** DESIGN.md motion effect 4: solid while text is actively arriving, blinks
 * after 530ms of no change. Returns true when the cursor should blink. */
function useIdleBlink(signal: string, active: boolean): boolean {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (!active) {
      setBlinking(false);
      return;
    }
    setBlinking(false);
    const timer = setTimeout(() => setBlinking(true), 530);
    return () => clearTimeout(timer);
  }, [signal, active]);
  return blinking;
}

interface ChannelMessageRowProps {
  message: ChannelMessage;
  channelId: string;
  variant?: 'default' | 'system';
  replyCount?: number;
  lastReplyHint?: string;
  onOpenThread?: (rootId: ChannelMessageId) => void;
}

export const ChannelMessageRow: React.FC<ChannelMessageRowProps> = ({
  message,
  channelId,
  variant = 'default',
  replyCount = 0,
  lastReplyHint,
  onOpenThread,
}) => {
  const streaming = message.status === 'streaming';
  const blinking = useIdleBlink(message.body.text, streaming);

  if (variant === 'system' || message.kind === 'system') {
    // System rows carry actionable payloads in `meta` (#1167). An approval
    // request renders approve/deny controls that call the per-agent approvals
    // endpoint; errors are swallowed (the row heals when the agent re-emits).
    const approvalRequestId = message.meta?.approvalRequestId;
    const hasApproval = typeof approvalRequestId === 'string';
    return (
      <div
        className="ch-system-msg"
        role="note"
        data-channel-message-seq={message.seq}
      >
        <span className="ch-system-msg__label">{message.body.text}</span>
        {hasApproval ? (
          <span className="ch-system-msg__actions">
            <button
              type="button"
              className="ch-system-msg__btn ch-system-msg__btn--approve"
              onClick={() =>
                void respondChannelApproval(
                  channelId,
                  String(message.meta?.agentId),
                  String(message.meta?.approvalRequestId),
                  { kind: 'accept', scope: 'once' }
                ).catch(() => {})
              }
            >
              approve
            </button>
            <button
              type="button"
              className="ch-system-msg__btn ch-system-msg__btn--deny"
              onClick={() =>
                void respondChannelApproval(
                  channelId,
                  String(message.meta?.agentId),
                  String(message.meta?.approvalRequestId),
                  { kind: 'decline' }
                ).catch(() => {})
              }
            >
              deny
            </button>
          </span>
        ) : null}
      </div>
    );
  }

  const isHuman = message.sender.kind === 'human';
  const rowClasses = [
    'ch-msg',
    isHuman ? 'ch-msg--user' : null,
    message.status === 'streaming' ? 'ch-msg--streaming' : null,
    message.status === 'interrupted' ? 'ch-msg--interrupted' : null,
    message.status === 'failed' ? 'ch-msg--failed' : null,
  ]
    .filter(Boolean)
    .join(' ');

  const streamStyle =
    streaming && !isHuman
      ? ({
          borderLeftColor: resolveSenderIdentity(message.sender).colorVar,
        } as React.CSSProperties)
      : undefined;

  const body =
    message.body.format === 'markdown' ? (
      <div className="ch-msg__body">
        <AssistantMarkdown text={message.body.text} keyPrefix={message.id} />
      </div>
    ) : (
      <pre className="ch-msg__text ch-msg__body">{message.body.text}</pre>
    );

  return (
    <div
      className={rowClasses}
      style={streamStyle}
      data-channel-message-seq={message.seq}
    >
      {message.body.format === 'markdown' ? (
        <div className="ch-msg__body-wrap">
          {body}
          {streaming ? (
            <span
              className={`ch-msg__cursor${blinking ? ' ch-msg__cursor--blinking' : ''}`}
              aria-hidden="true"
            >
              █
            </span>
          ) : null}
        </div>
      ) : (
        body
      )}
      {message.status === 'interrupted' ? (
        <span className="ch-msg__tag ch-msg__tag--interrupted">
          interrupted
        </span>
      ) : null}
      {message.status === 'failed' ? (
        <span className="ch-msg__tag ch-msg__tag--failed">failed</span>
      ) : null}
      {message.truncated ? (
        <span className="ch-msg__tag ch-msg__tag--truncated">
          truncated · 256kb limit
        </span>
      ) : null}
      {message.threadId === null && replyCount > 0 && onOpenThread ? (
        <button
          type="button"
          className="ch-msg__thread-chip"
          onClick={() => onOpenThread(message.id)}
          aria-label={`${replyCount} repl${replyCount === 1 ? 'y' : 'ies'} — open thread`}
        >
          <span className="ch-msg__thread-chip__count">
            {replyCount} repl{replyCount === 1 ? 'y' : 'ies'}
          </span>
          {lastReplyHint ? (
            <span className="ch-msg__thread-chip__hint">{lastReplyHint}</span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
};

export default ChannelMessageRow;
