import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  channelMessageDeletable,
  channelMessageEditable,
  channelMessageEditedAt,
  channelRetryTarget,
  isChannelMessageDeleted,
  type ChannelMessage,
  type ChannelMessageId,
} from '../../../../shared/channel-chat-protocol.js';
import type { AgentDetailCardStatusV2 } from '../../../../shared/agent-chat-protocol-v2.js';
import { AssistantMarkdown } from './AssistantMarkdown.js';
import { AgentDetailCard } from './AgentDetailCard.js';
import type { ReasoningDetailStateApi } from './ReasoningDetailState.js';
import {
  reasoningTerminalStateForMessage,
  shouldRenderChannelMessage,
} from '../../lib/chat/reasoning-detail.js';
import { ChannelImagePart } from './ChannelImagePart.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import { createLineBreakSubmitGuard } from './composerInput.js';
import { respondChannelApproval } from '../../lib/api.js';
import { buildChannelMessageLink } from '../../lib/url-nav.js';
import { showToast } from '../../lib/stores/toasts.js';
import { useQueuedSendNotice } from '../../lib/stores/channel-queued-sends.js';

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

/** Pencil over a rule — DESIGN.md flat line art, no fill, square caps. */
const EDIT_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M2.5 10.5l7-7 3 3-7 7H2.5v-3zM2.5 14.5h11"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.5"
      strokeLinecap="square"
    />
  </svg>
);

/** Bin outline — DESIGN.md flat line art, no fill, square caps. */
const DELETE_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.75 9h6.5l.75-9M6.5 7v4M9.5 7v4"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.5"
      strokeLinecap="square"
    />
  </svg>
);

/** Open circular arrow — DESIGN.md flat line art, no fill, square caps. */
const RETRY_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M13 8a5 5 0 11-1.6-3.7M13 2v3h-3"
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

/**
 * System rows carry actionable payloads in `meta` (#1167). An approval request
 * renders approve/deny controls that call the per-agent approvals endpoint;
 * errors are swallowed (the row heals when the agent re-emits). Split out of
 * `ChannelMessageRow` so the message row's own branching stays legible.
 */
const ChannelSystemMessageRow: React.FC<{
  message: ChannelMessage;
  channelId: string;
  highlighted: boolean;
}> = ({ message, channelId, highlighted }) => {
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
};

/**
 * Everything the retry affordances need, or `null` when the row cannot be
 * retried. Resolved once by `ChannelMessageRow` so the toolbar button and the
 * inline button can never disagree about disabled/superseded state.
 */
interface RetryAffordance {
  onRetry: () => void;
  /** Request in flight from this row. */
  pending: boolean;
  /** Bound profile is non-idle in this channel. */
  busy: boolean;
  /** A later system row already superseded this one. */
  retried: boolean;
}

function retryTitle(retry: RetryAffordance): string {
  if (retry.retried) return 'already retried';
  return retry.busy ? 'agent is busy' : 'retry';
}

/**
 * Body region of a prose row: markdown or plain text, plus the streaming block
 * cursor. Split out of `ChannelMessageRow` when the in-place editor landed
 * (#1308 item 3) — the row now chooses between "render the body" and "render
 * the editor", and keeping both shapes inline made one function own every
 * branch of both.
 */
const MessageBody: React.FC<{
  message: ChannelMessage;
  isHuman: boolean;
  streaming: boolean;
}> = ({ message, isHuman, streaming }) => {
  const blinking = useIdleBlink(message.body.text, streaming);
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

  if (
    message.body.format !== 'markdown' ||
    !(hasText || (streaming && !message.agentDetail))
  ) {
    return body;
  }
  return (
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
  );
};

/**
 * In-place editor for one of the operator's own rows (#1308 item 3).
 *
 * Replaces the body where it sits rather than opening a modal or hijacking the
 * composer: the surrounding rows keep their position, so the edit reads as a
 * correction to THIS message. Submission rules come from the shared composer
 * primitive (`createLineBreakSubmitGuard`), so the on-screen send key works the
 * same here as it does in the composer — the mobile IME path is the whole
 * reason that primitive exists.
 */
const MessageEditForm: React.FC<{
  initialText: string;
  pending: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}> = ({ initialText, pending, onSave, onCancel }) => {
  const [draft, setDraft] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const guardRef = useRef(createLineBreakSubmitGuard());

  const submit = useCallback(() => {
    const next = draft.trim();
    // An empty edit is a delete, which this slice does not own; an unchanged one
    // is a no-op the server should never be asked to persist.
    if (next.length === 0) return;
    if (next === initialText.trim()) {
      onCancel();
      return;
    }
    onSave(next);
  }, [draft, initialText, onCancel, onSave]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    // Caret at the end, not a full selection: the operator is amending an
    // existing sentence far more often than replacing the whole message.
    el.selectionStart = el.value.length;
    el.selectionEnd = el.value.length;
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const handler = (event: InputEvent): void => {
      if (!guardRef.current.consumesAsSubmit(event)) return;
      event.preventDefault();
      submit();
    };
    el.addEventListener('beforeinput', handler);
    return () => el.removeEventListener('beforeinput', handler);
  }, [submit]);

  return (
    <div className="ch-msg__edit">
      <textarea
        ref={textareaRef}
        className="ch-msg__edit-ta"
        aria-label="edit message text"
        rows={Math.min(8, draft.split('\n').length)}
        value={draft}
        disabled={pending}
        enterKeyHint="done"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          const native = event.nativeEvent as KeyboardEvent;
          if (event.key === 'Enter' && native.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key === 'Enter' && event.shiftKey) {
            guardRef.current.deferNextLineBreak();
            return;
          }
          guardRef.current.reset();
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="ch-msg__edit-bar">
        <button
          type="button"
          className="ch-msg__edit-btn"
          onClick={submit}
          disabled={pending}
        >
          {pending ? 'saving…' : 'save'}
        </button>
        <button
          type="button"
          className="ch-msg__edit-btn"
          onClick={onCancel}
          disabled={pending}
        >
          cancel
        </button>
        <span className="ch-msg__edit-hint">
          <kbd>↵</kbd>save <kbd>esc</kbd>cancel <kbd>⇧↵</kbd>newline
        </span>
      </div>
    </div>
  );
};

/**
 * Two-step delete confirm, inline in the toolbar (#1308 item 4).
 *
 * No `window.confirm`: a native modal is a browser chrome dialog in a product
 * whose whole visual argument is a TUI, it steals focus from the row it is
 * about, and it cannot be tested or styled. The confirm replaces the toolbar's
 * contents in place instead, so the question appears exactly where the operator
 * clicked and the row underneath stays readable — which is the thing being
 * confirmed.
 */
const DeleteConfirmStrip: React.FC<{
  isHuman: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ isHuman, pending, onConfirm, onCancel }) => {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Focus the destructive button, not the row: it makes escape/tab meaningful
  // and it keeps `useRowActionAffordance`'s focus branch true, so the toolbar
  // cannot unmount from under an open question when the pointer wanders off.
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div
      className={`ch-msg__actions ch-msg__confirm${
        isHuman ? ' ch-msg__actions--user' : ''
      }`}
      role="group"
      aria-label="delete message confirmation"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onCancel();
      }}
    >
      <span className="ch-msg__confirm-label">delete?</span>
      <button
        ref={confirmRef}
        type="button"
        className="ch-msg__confirm-btn ch-msg__confirm-btn--danger"
        aria-label="confirm delete message"
        disabled={pending}
        onClick={onConfirm}
      >
        {pending ? 'deleting…' : 'yes'}
      </button>
      <button
        type="button"
        className="ch-msg__confirm-btn"
        aria-label="cancel delete message"
        disabled={pending}
        onClick={onCancel}
      >
        no
      </button>
    </div>
  );
};

/** Compact hover/focus/long-press toolbar (#1308 item 1, retry added in item 2). */
const MessageActionToolbar: React.FC<{
  isHuman: boolean;
  onCopyLink: () => void;
  onCopyText: (() => void) | null;
  onEdit: (() => void) | null;
  onDelete: (() => void) | null;
  retry: RetryAffordance | null;
}> = ({ isHuman, onCopyLink, onCopyText, onEdit, onDelete, retry }) => (
  <div
    className={`ch-msg__actions${isHuman ? ' ch-msg__actions--user' : ''}`}
    role="group"
    aria-label="message actions"
  >
    {onEdit ? (
      <button
        type="button"
        className="ch-msg__action"
        title="edit"
        aria-label="edit message"
        onClick={onEdit}
      >
        {EDIT_ICON}
      </button>
    ) : null}
    <button
      type="button"
      className="ch-msg__action"
      title="copy link"
      aria-label="copy link to message"
      onClick={onCopyLink}
    >
      {LINK_ICON}
    </button>
    {onCopyText ? (
      <button
        type="button"
        className="ch-msg__action"
        title="copy text"
        aria-label="copy message text"
        onClick={onCopyText}
      >
        {COPY_ICON}
      </button>
    ) : null}
    {retry ? (
      <button
        type="button"
        className="ch-msg__action"
        title={retryTitle(retry)}
        aria-label="retry this reply"
        disabled={retry.busy || retry.pending || retry.retried}
        onClick={retry.onRetry}
      >
        {RETRY_ICON}
      </button>
    ) : null}
    {onDelete ? (
      <button
        type="button"
        className="ch-msg__action ch-msg__action--danger"
        title="delete"
        aria-label="delete message"
        onClick={onDelete}
      >
        {DELETE_ICON}
      </button>
    ) : null}
  </div>
);

/**
 * Always-visible recovery on a `failed` row (#1308 item 2). A failed turn is the
 * one terminal state nothing about the operator's own action explains, so it
 * must be reachable without hovering — touch has no hover at all.
 * Interrupted/truncated keep retry in the toolbar, where it adds no permanent
 * chrome to rows the operator already accounted for.
 */
const InlineRetryAffordance: React.FC<{ retry: RetryAffordance }> = ({
  retry,
}) =>
  retry.retried ? (
    <span className="ch-msg__tag ch-msg__tag--retried">retried</span>
  ) : (
    <button
      type="button"
      className="ch-msg__retry"
      disabled={retry.busy || retry.pending}
      onClick={retry.onRetry}
      aria-label="retry this reply"
      title={retryTitle(retry)}
    >
      {RETRY_ICON}
      <span>{retry.pending ? 'retrying…' : 'retry'}</span>
    </button>
  );

/**
 * Everything rendered BELOW a prose row's body: terminal status tags, the
 * always-visible failed-row retry, the truncation label and the thread entry
 * point. Split out of `ChannelMessageRow` when the delete affordance landed
 * (#1308 item 4) — the row function had accumulated one branch per trailing
 * ornament on top of its own body/editor/toolbar decisions.
 *
 * None of it is suppressed on a tombstone: a deleted row keeps its thread chip
 * (it is still the anchor its replies point at), and a human row carries no
 * status tags to begin with.
 */
const MessageRowTrailer: React.FC<{
  message: ChannelMessage;
  retry: RetryAffordance | null;
  replyCount: number;
  lastReplyHint?: string;
  onOpenThread?: (rootId: ChannelMessageId) => void;
  /** #1308 slice 4 item 2a: "queued — <agent> is mid-turn", or null. */
  queuedNotice?: string | null;
}> = ({
  message,
  retry,
  replyCount,
  lastReplyHint,
  onOpenThread,
  queuedNotice = null,
}) => {
  const truncationLabel = truncationLabelForMessage(message);
  const attribution =
    message.sender.kind === 'agent' ? message.agentAttribution : undefined;
  const showThreadChip =
    message.threadId === null && replyCount > 0 && onOpenThread !== undefined;
  return (
    <>
      {attribution ? (
        <span className="ch-msg__attribution" aria-label="agent configuration">
          {attribution.model ? (
            <span className="ch-msg__attribution-part">
              model: {attribution.model}
            </span>
          ) : null}
          {attribution.effort ? (
            <span className="ch-msg__attribution-part">
              effort: {attribution.effort}
            </span>
          ) : null}
        </span>
      ) : null}
      {queuedNotice ? (
        // The one thing the durable row cannot say: this message reached a busy
        // agent and is waiting for its next turn. Steering intent is never
        // persisted, so this is client-side memory of the send — see
        // `channel-queued-sends`.
        <span className="ch-msg__tag ch-msg__tag--queued" role="status">
          {queuedNotice}
        </span>
      ) : null}
      {message.status === 'interrupted' ? (
        <span className="ch-msg__tag ch-msg__tag--interrupted">
          interrupted
        </span>
      ) : null}
      {message.status === 'failed' ? (
        <span className="ch-msg__tag ch-msg__tag--failed">failed</span>
      ) : null}
      {retry && message.status === 'failed' ? (
        <InlineRetryAffordance retry={retry} />
      ) : null}
      {truncationLabel ? (
        <span className="ch-msg__tag ch-msg__tag--truncated">
          {truncationLabel}
        </span>
      ) : null}
      {showThreadChip && onOpenThread ? (
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
    </>
  );
};

const STATUS_ROW_MODIFIERS: Partial<Record<ChannelMessage['status'], string>> =
  {
    streaming: 'ch-msg--streaming',
    truncated: 'ch-msg--truncated',
    interrupted: 'ch-msg--interrupted',
    failed: 'ch-msg--failed',
  };

/** Row modifier classes for a prose row — one table lookup plus two flags. */
function proseRowClassName(
  message: ChannelMessage,
  flags: { deleted: boolean; highlighted: boolean }
): string {
  return [
    'ch-msg',
    message.sender.kind === 'human' ? 'ch-msg--user' : null,
    STATUS_ROW_MODIFIERS[message.status] ?? null,
    flags.deleted ? 'ch-msg--deleted' : null,
    flags.highlighted ? 'ch-msg--jump' : null,
  ]
    .filter(Boolean)
    .join(' ');
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
  /**
   * #1308 item 2. Re-routes the row's ORIGINAL trigger message. Omitted where
   * the surface has no retry lane (isolated fixtures), which also removes the
   * affordance — the row never invents a retry path of its own.
   */
  onRetry?: (message: ChannelMessage) => Promise<unknown>;
  /**
   * #1308 item 3. Rewrites this row's body. Omitted where the surface has no
   * edit lane, which also removes the affordance; the row never invents one.
   * Rejecting the promise keeps the editor open with the operator's draft.
   */
  onEdit?: (message: ChannelMessage, text: string) => Promise<unknown>;
  /**
   * #1308 item 4. Tombstones this row. Omitted where the surface has no delete
   * lane, which also removes the affordance; the row never invents one.
   * Rejecting the promise leaves the confirm open so the operator can retry.
   */
  onDelete?: (message: ChannelMessage) => Promise<unknown>;
  /**
   * The bound profile is non-idle in this channel. Retry stays visible but
   * disabled so a busy agent cannot be stacked with a second turn (storm brake;
   * the server refuses independently).
   */
  retryBusy?: boolean;
  /** A later system row already superseded this one via `meta.retryOfMessageId`. */
  retried?: boolean;
  /** Timeline-owned disclosure overrides survive grouped-row remounts. */
  reasoningViewState?: ReasoningDetailStateApi | undefined;
}

const ChannelMessageRowContent: React.FC<ChannelMessageRowProps> = ({
  message,
  channelId,
  variant = 'default',
  replyCount = 0,
  lastReplyHint,
  onOpenThread,
  highlighted = false,
  onRetry,
  onEdit,
  onDelete,
  retryBusy = false,
  retried = false,
  reasoningViewState,
}) => {
  const streaming = message.status === 'streaming';
  const rowRef = useRef<HTMLDivElement>(null);
  const { actionsVisible, ...affordance } = useRowActionAffordance(rowRef);
  // Read from the store rather than drilled down the timeline: the same row
  // component renders in the main lane and the thread panel, and only one of
  // those two paths would otherwise have been wired (#1308 slice 4 item 2d).
  const queuedNotice = useQueuedSendNotice(message.id);
  const [retryPending, setRetryPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editPending, setEditPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  // Human-authored prose rows only, and only where the surface wired a lane.
  // The predicate is the SHARED one the route enforces, so the button cannot
  // appear on a row the server would refuse. Both predicates already exclude a
  // tombstone, so a deleted row grows neither control.
  const editable = onEdit !== undefined && channelMessageEditable(message);
  const deletable = onDelete !== undefined && channelMessageDeletable(message);
  const deleted = isChannelMessageDeleted(message);

  const handleConfirmDelete = useCallback(() => {
    if (!onDelete || deletePending) return;
    setDeletePending(true);
    void onDelete(message)
      .then(() => setConfirmingDelete(false))
      // Failure keeps the confirm open rather than silently reverting to the
      // toolbar — the operator asked for this and is owed the outcome.
      .catch(() => {})
      .finally(() => setDeletePending(false));
  }, [deletePending, message, onDelete]);

  const handleSaveEdit = useCallback(
    (text: string) => {
      if (!onEdit || editPending) return;
      setEditPending(true);
      void onEdit(message, text)
        .then(() => setEditing(false))
        // Failure keeps the editor (and the draft) open: the operator's words
        // are the one thing this component must never silently discard.
        .catch(() => {})
        .finally(() => setEditPending(false));
    },
    [editPending, message, onEdit]
  );

  const handleRetry = useCallback(() => {
    if (!onRetry || retryPending) return;
    setRetryPending(true);
    void onRetry(message).finally(() => setRetryPending(false));
  }, [message, onRetry, retryPending]);

  // Retry is offered only where the shared contract can name a trigger to
  // re-route (`source.turnId` minted by the binder), so the button and the
  // route agree by construction instead of by convention.
  const retry: RetryAffordance | null =
    onRetry !== undefined && channelRetryTarget(message) !== null
      ? {
          onRetry: handleRetry,
          pending: retryPending,
          busy: retryBusy,
          retried,
        }
      : null;

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

  const reasoningTerminalState = reasoningTerminalStateForMessage(message);

  if (variant === 'system' || message.kind === 'system') {
    return (
      <ChannelSystemMessageRow
        message={message}
        channelId={channelId}
        highlighted={highlighted}
      />
    );
  }

  const isHuman = message.sender.kind === 'human';
  const editedAt = channelMessageEditedAt(message);
  const rowClasses = proseRowClassName(message, { deleted, highlighted });

  const streamStyle =
    streaming && !isHuman
      ? ({
          borderLeftColor: resolveSenderIdentity(message.sender).colorVar,
        } as React.CSSProperties)
      : undefined;

  return (
    <div
      ref={rowRef}
      className={rowClasses}
      style={streamStyle}
      data-channel-message-seq={message.seq}
      data-channel-message-id={message.id}
      {...affordance}
    >
      {confirmingDelete && deletable ? (
        // The confirm occupies the toolbar's own slot, so the question sits
        // where the button the operator just pressed was.
        <DeleteConfirmStrip
          isHuman={isHuman}
          pending={deletePending}
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : actionsVisible && !editing ? (
        <MessageActionToolbar
          isHuman={isHuman}
          onCopyLink={handleCopyLink}
          // A tombstone keeps its deep link — it is still an addressable row and
          // still a thread anchor — but there is nothing left to copy as text.
          onCopyText={deleted ? null : handleCopyText}
          onEdit={editable ? () => setEditing(true) : null}
          onDelete={deletable ? () => setConfirmingDelete(true) : null}
          retry={retry}
        />
      ) : null}
      {message.agentDetail ? (
        <AgentDetailCard
          card={message.agentDetail.card}
          itemId={message.agentDetail.itemId}
          reasoningTerminalState={reasoningTerminalState}
          reasoningViewState={reasoningViewState}
          reasoningStateKey={`${message.id}:${message.agentDetail.itemId}`}
        />
      ) : null}
      {deleted ? (
        // Placeholder, not a removal: the row keeps its slot so grouping, the
        // scroll anchor and any thread chip below stay exactly where they were.
        <span className="ch-msg__deleted">message deleted</span>
      ) : editing ? (
        <MessageEditForm
          initialText={message.body.text}
          pending={editPending}
          onSave={handleSaveEdit}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <MessageBody
          message={message}
          isHuman={isHuman}
          streaming={streaming}
        />
      )}
      {editedAt && !editing && !deleted ? (
        <span className="ch-msg__edited" title={`edited ${editedAt}`}>
          (edited)
        </span>
      ) : null}
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
      <MessageRowTrailer
        message={message}
        retry={retry}
        replyCount={replyCount}
        queuedNotice={queuedNotice}
        {...(lastReplyHint ? { lastReplyHint } : {})}
        {...(onOpenThread ? { onOpenThread } : {})}
      />
    </div>
  );
};

/**
 * A provider may open and terminalize a reasoning item without exposing any
 * summary. Suppress the entire durable timeline row, not just its chevron.
 */
export const ChannelMessageRow: React.FC<ChannelMessageRowProps> = (props) => {
  return shouldRenderChannelMessage(props.message) ? (
    <ChannelMessageRowContent {...props} />
  ) : null;
};

export default ChannelMessageRow;
