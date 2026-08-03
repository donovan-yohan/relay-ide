import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../../../shared/channel-chat-protocol.js';
import type { AgentDetailCardStatusV2 } from '../../../../shared/agent-chat-protocol-v2.js';
import { AssistantMarkdown } from './AssistantMarkdown.js';
import { AgentDetailCard } from './AgentDetailCard.js';
import { ChannelImagePart } from './ChannelImagePart.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import { respondChannelApproval } from '../../lib/api.js';
import { buildChannelMessageLink } from '../../lib/url-nav.js';
import { showToast } from '../../lib/stores/toasts.js';

/** Touch hold before the action toolbar pins open, matching `Terminal.tsx`. */
const LONG_PRESS_MS = 500;
/** Finger travel that cancels a pending long press. */
const LONG_PRESS_SLOP_PX = 10;

/**
 * DESIGN.md icon law: flat SVG line art, 1.5px stroke, square caps, no fill.
 * Sized 12px to sit inside the compact action button without changing row
 * metrics (the toolbar is absolutely positioned, so it never reflows the lane).
 */
const LINK_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M6.5 9.5l3-3M7 4.5L8.75 2.75a2.5 2.5 0 013.5 3.5L10.5 8M5.5 8L3.75 9.75a2.5 2.5 0 003.5 3.5L9 11.5"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.5"
      strokeLinecap="square"
    />
  </svg>
);

const COPY_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <rect
      x="5.5"
      y="5.5"
      width="8"
      height="8"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.5"
    />
    <path
      d="M10.5 2.5h-8v8"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.5"
      strokeLinecap="square"
    />
  </svg>
);

async function writeClipboard(text: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard) throw new Error('clipboard unavailable');
  await clipboard.writeText(text);
}

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

function detailStatusForMessage(
  status: ChannelMessage['status']
): AgentDetailCardStatusV2 {
  if (status === 'streaming') return 'running';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted' || status === 'truncated') return 'cancelled';
  return 'completed';
}

function truncationLabelForMessage(message: ChannelMessage): string | null {
  const reason =
    message.status === 'truncated'
      ? message.meta?.['truncationReason']
      : message.truncated
        ? 'size-limit'
        : undefined;
  if (reason === 'missing-terminal') return 'truncated · missing terminal';
  if (reason === 'restart') return 'truncated · restart';
  if (reason === 'size-limit') return 'truncated · 256kb limit';
  return message.status === 'truncated' ? 'truncated' : null;
}

interface RowActionAffordance {
  actionsVisible: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: (event: React.FocusEvent<HTMLDivElement>) => void;
  onTouchStart: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchMove: (event: React.TouchEvent<HTMLDivElement>) => void;
  onTouchEnd: () => void;
}

/**
 * Reveal rule for the per-message action toolbar (#1308 item 1).
 *
 * Three affordances, one state: pointer hover (desktop), focus anywhere in the
 * row (keyboard — the toolbar buttons themselves are focusable, so tabbing into
 * a row keeps it open), and a long press (touch, where neither of the first two
 * exists). The long press pins the toolbar until the next pointer-down outside
 * the row, which is the only dismissal a touch device can offer.
 */
function useRowActionAffordance(
  rowRef: React.RefObject<HTMLDivElement | null>
): RowActionAffordance {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const pressRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    x: number;
    y: number;
  }>({ timer: null, x: 0, y: 0 });

  const cancelPress = useCallback((): void => {
    const press = pressRef.current;
    if (press.timer !== null) clearTimeout(press.timer);
    press.timer = null;
  }, []);

  useEffect(() => cancelPress, [cancelPress]);

  useEffect(() => {
    if (!pinned) return;
    const dismiss = (event: Event): void => {
      const row = rowRef.current;
      if (row && event.target instanceof Node && row.contains(event.target)) {
        return;
      }
      setPinned(false);
    };
    // Capture phase: a tap on another row must close this one even though that
    // row stops nothing — the listener has to win before any React handler.
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [pinned, rowRef]);

  return {
    actionsVisible: hovered || focused || pinned,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onFocus: () => setFocused(true),
    onBlur: (event) => {
      // Moving focus between the toolbar's own buttons must not close it.
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setFocused(false);
    },
    onTouchStart: (event) => {
      const touch = event.touches[0];
      if (!touch) return;
      cancelPress();
      const press = pressRef.current;
      press.x = touch.clientX;
      press.y = touch.clientY;
      press.timer = setTimeout(() => {
        press.timer = null;
        setPinned(true);
      }, LONG_PRESS_MS);
    },
    onTouchMove: (event) => {
      const press = pressRef.current;
      if (press.timer === null) return;
      const touch = event.touches[0];
      if (!touch) return;
      if (
        Math.abs(touch.clientX - press.x) > LONG_PRESS_SLOP_PX ||
        Math.abs(touch.clientY - press.y) > LONG_PRESS_SLOP_PX
      ) {
        cancelPress();
      }
    },
    onTouchEnd: cancelPress,
  };
}

interface ChannelMessageRowProps {
  message: ChannelMessage;
  channelId: string;
  variant?: 'default' | 'system';
  replyCount?: number;
  lastReplyHint?: string;
  onOpenThread?: (rootId: ChannelMessageId) => void;
  /** #1308 item 1: brief jump emphasis after a deep link lands on this row. */
  highlighted?: boolean;
}

export const ChannelMessageRow: React.FC<ChannelMessageRowProps> = ({
  message,
  channelId,
  variant = 'default',
  replyCount = 0,
  lastReplyHint,
  onOpenThread,
  highlighted = false,
}) => {
  const streaming = message.status === 'streaming';
  const blinking = useIdleBlink(message.body.text, streaming);
  const rowRef = useRef<HTMLDivElement>(null);
  const { actionsVisible, ...affordance } = useRowActionAffordance(rowRef);

  const handleCopyLink = useCallback(() => {
    const origin =
      typeof window !== 'undefined'
        ? window.location.origin
        : 'http://localhost';
    void writeClipboard(
      buildChannelMessageLink(channelId, message.id, origin)
    ).then(
      () => showToast('message link copied', 'info', 2000),
      () => showToast('could not copy the message link')
    );
  }, [channelId, message.id]);

  const handleCopyText = useCallback(() => {
    void writeClipboard(message.body.text).then(
      () => showToast('message text copied', 'info', 2000),
      () => showToast('could not copy the message text')
    );
  }, [message.body.text]);

  if (variant === 'system' || message.kind === 'system') {
    // System rows carry actionable payloads in `meta` (#1167). An approval
    // request renders approve/deny controls that call the per-agent approvals
    // endpoint; errors are swallowed (the row heals when the agent re-emits).
    const approvalRequestId = message.meta?.approvalRequestId;
    const hasApproval = typeof approvalRequestId === 'string';
    return (
      <div
        className={`ch-system-msg${highlighted ? ' ch-msg--jump' : ''}`}
        role="note"
        data-channel-message-seq={message.seq}
        data-channel-message-id={message.id}
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
  const truncationLabel = truncationLabelForMessage(message);
  const rowClasses = [
    'ch-msg',
    isHuman ? 'ch-msg--user' : null,
    message.status === 'streaming' ? 'ch-msg--streaming' : null,
    message.status === 'truncated' ? 'ch-msg--truncated' : null,
    message.status === 'interrupted' ? 'ch-msg--interrupted' : null,
    message.status === 'failed' ? 'ch-msg--failed' : null,
    highlighted ? 'ch-msg--jump' : null,
  ]
    .filter(Boolean)
    .join(' ');

  const streamStyle =
    streaming && !isHuman
      ? ({
          borderLeftColor: resolveSenderIdentity(message.sender).colorVar,
        } as React.CSSProperties)
      : undefined;

  const hasText = message.body.text.length > 0;
  const detailStatus = detailStatusForMessage(message.status);
  const body = hasText ? (
    message.body.format === 'markdown' ? (
      <div className="ch-msg__body">
        <AssistantMarkdown
          text={message.body.text}
          keyPrefix={message.id}
          codeBlockPresentation={isHuman ? 'plain' : 'card'}
          codeBlockStatus={detailStatus}
        />
      </div>
    ) : (
      <pre className="ch-msg__text ch-msg__body">{message.body.text}</pre>
    )
  ) : null;

  return (
    <div
      ref={rowRef}
      className={rowClasses}
      style={streamStyle}
      data-channel-message-seq={message.seq}
      data-channel-message-id={message.id}
      {...affordance}
    >
      {actionsVisible ? (
        <div
          className={`ch-msg__actions${isHuman ? ' ch-msg__actions--user' : ''}`}
          role="group"
          aria-label="message actions"
        >
          <button
            type="button"
            className="ch-msg__action"
            title="copy link"
            aria-label="copy link to message"
            onClick={handleCopyLink}
          >
            {LINK_ICON}
          </button>
          <button
            type="button"
            className="ch-msg__action"
            title="copy text"
            aria-label="copy message text"
            onClick={handleCopyText}
          >
            {COPY_ICON}
          </button>
        </div>
      ) : null}
      {message.agentDetail ? (
        <AgentDetailCard
          card={message.agentDetail.card}
          itemId={message.agentDetail.itemId}
        />
      ) : null}
      {message.body.format === 'markdown' &&
      (hasText || (streaming && !message.agentDetail)) ? (
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
      {message.parts && message.parts.length > 0 ? (
        <div className="ch-msg__parts" aria-label="image attachments">
          {message.parts.map((part, index) => (
            <ChannelImagePart
              key={part.id}
              channelId={channelId}
              part={part}
              ordinal={index + 1}
            />
          ))}
        </div>
      ) : null}
      {message.status === 'interrupted' ? (
        <span className="ch-msg__tag ch-msg__tag--interrupted">
          interrupted
        </span>
      ) : null}
      {message.status === 'failed' ? (
        <span className="ch-msg__tag ch-msg__tag--failed">failed</span>
      ) : null}
      {truncationLabel ? (
        <span className="ch-msg__tag ch-msg__tag--truncated">
          {truncationLabel}
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
