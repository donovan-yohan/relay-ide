import React, { useEffect, useMemo, useState } from 'react';
import {
  retriedMessageIdFromSystemRow,
  type ChannelMessage,
  type ChannelMessageId,
} from '../../../../shared/channel-chat-protocol.js';
import {
  buildTimelineNodes,
  deriveReplyCounts,
  formatDayLabel,
  selectTopLevel,
} from '../../lib/chat/channel-timeline-layout.js';
import {
  channelPresenceCopy,
  type ChannelAgentPresence,
} from '../../lib/chat/channel-agent-presence.js';
import { AgentBadge } from '../AgentBadge.js';
import { TuiProgress } from '../TuiProgress.js';
import { ChannelMessageGroup } from './ChannelMessageGroup.js';
import { ChannelMessageRow } from './ChannelMessageRow.js';
import { useFollowingScroll } from './useFollowingScroll.js';
import { useLiveReplyGrowth } from './useLiveReplyGrowth.js';

const RESYNC_BUTTON_DELAY_MS = 5_000;

/**
 * How long the jump emphasis stays on the row a deep link landed on. The fade
 * itself is a 400ms ease-out (DESIGN.md motion budget); the extra beat only
 * keeps the class mounted so the animation is never cut mid-flight.
 */
const JUMP_HIGHLIGHT_MS = 600;

/** A deep link asking the timeline to scroll to one message. */
export interface TimelineJumpTarget {
  messageId: ChannelMessageId;
  /**
   * Monotonic per-request token. Two consecutive links to the SAME message must
   * re-run the scroll, and `messageId` alone cannot express that.
   */
  token: number;
}

interface ChannelTimelineProps {
  /** Full reducer lane, including thread replies for live reply-count derivation. */
  messages: ChannelMessage[];
  lastReadSeq: number | null;
  channelId: string;
  channelTitle: string;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  fullSnapshotRevision: number;
  needsCatchup: boolean;
  onResync: () => void;
  replyOnlyBackfillPaused?: boolean;
  onContinueHistory?: () => void;
  onOpenThread?: (rootId: ChannelMessageId) => void;
  /**
   * Busy agents with no live streaming row of their own (#1277). Already
   * filtered by `selectChannelAgentPresence` — the timeline renders what it is
   * given and owns no presence policy.
   */
  agentPresence?: readonly ChannelAgentPresence[];
  /**
   * #1308 item 1. `ChannelView` owns the bounded history walk that guarantees
   * the target row is loaded; by the time a target arrives here it is only a
   * DOM scroll plus the brief jump emphasis.
   */
  jumpTarget?: TimelineJumpTarget | null;
  /**
   * #1308 item 2. Re-routes a failed row's original trigger; `ChannelView` owns
   * the call so the timeline keeps no retry policy of its own.
   */
  onRetryMessage?: (message: ChannelMessage) => Promise<unknown>;
  /**
   * #1308 item 3. Rewrites one of the operator's own rows. `ChannelView` owns
   * the mutation; the timeline only routes the callback to the rows.
   */
  onEditMessage?: (message: ChannelMessage, text: string) => Promise<unknown>;
  /**
   * #1308 item 4. Tombstones one of the operator's own rows. `ChannelView` owns
   * the mutation; the timeline only routes the callback to the rows.
   */
  onDeleteMessage?: (message: ChannelMessage) => Promise<unknown>;
  /** Profile actor ids currently non-idle here — the retry storm brake. */
  busyAgentIds?: ReadonlySet<string>;
}

export const ChannelTimeline: React.FC<ChannelTimelineProps> = ({
  messages,
  lastReadSeq,
  channelId,
  channelTitle,
  hasMoreOlder,
  loadingOlder,
  loadOlder,
  fullSnapshotRevision,
  needsCatchup,
  onResync,
  replyOnlyBackfillPaused = false,
  onContinueHistory,
  onOpenThread,
  agentPresence = [],
  jumpTarget = null,
  onRetryMessage,
  onEditMessage,
  onDeleteMessage,
  busyAgentIds,
}) => {
  const [showResyncButton, setShowResyncButton] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] =
    useState<ChannelMessageId | null>(null);

  // Replies stay in the reducer for gap/catch-up correctness. Every piece of
  // main-lane geometry consumes this render-only projection so hidden reply seqs
  // cannot trigger a pill, move an anchor, or create an inline timeline row.
  const topLevelMessages = useMemo(() => selectTopLevel(messages), [messages]);
  const replyCounts = useMemo(() => deriveReplyCounts(messages), [messages]);

  // #1308 item 2: rows a retry already superseded. Derived from the durable
  // system row the binder writes (`meta.retryOfMessageId`), not from client
  // state, so a reload or a second device sees the same supersede marks.
  const retriedMessageIds = useMemo(() => {
    const ids = new Set<ChannelMessageId>();
    for (const message of messages) {
      const retried = retriedMessageIdFromSystemRow(message);
      if (retried) ids.add(retried);
    }
    return ids;
  }, [messages]);
  const replyGrowth = useLiveReplyGrowth(messages, {
    scopeKey: channelId,
    fullSnapshotRevision,
  });
  const nodes = useMemo(
    () => buildTimelineNodes(topLevelMessages, lastReadSeq),
    [topLevelMessages, lastReadSeq]
  );

  const {
    containerRef,
    contentRef,
    handleScroll,
    scrollToBottom,
    newMessageCount,
  } = useFollowingScroll({
    messages: topLevelMessages,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    fullSnapshotRevision,
  });

  const earliestSeq = topLevelMessages[0]?.seq;
  const reachedBeginning = !hasMoreOlder && earliestSeq === 1;

  // Deep-link jump. Keyed on the request token, never on `messageId`, so a
  // second link to the same row replays the scroll and the emphasis.
  const jumpToken = jumpTarget?.token ?? null;
  const jumpMessageId = jumpTarget?.messageId ?? null;
  useEffect(() => {
    if (jumpToken === null || jumpMessageId === null) return;
    const container = containerRef.current;
    // Attribute equality rather than a `[data-…="…"]` selector: message ids are
    // opaque, and a selector would need escaping the row markup does not owe us.
    const row = container
      ? Array.from(
          container.querySelectorAll<HTMLElement>('[data-channel-message-id]')
        ).find((node) => node.dataset.channelMessageId === jumpMessageId)
      : undefined;
    if (row) {
      // Instant, not smooth: the emphasis is a 400ms fade, so a multi-second
      // smooth scroll would finish after the cue it is supposed to explain.
      row.scrollIntoView({ block: 'center' });
    }
    setHighlightedMessageId(jumpMessageId);
    const timer = setTimeout(
      () => setHighlightedMessageId(null),
      JUMP_HIGHLIGHT_MS
    );
    return () => clearTimeout(timer);
  }, [containerRef, jumpToken, jumpMessageId]);

  useEffect(() => {
    if (!needsCatchup) {
      setShowResyncButton(false);
      return;
    }
    const timer = setTimeout(
      () => setShowResyncButton(true),
      RESYNC_BUTTON_DELAY_MS
    );
    return () => clearTimeout(timer);
  }, [needsCatchup]);

  return (
    <div className="ch-tl-shell">
      <div
        ref={containerRef}
        className="ch-tl"
        role="log"
        aria-live="polite"
        aria-label="channel timeline"
        onScroll={handleScroll}
      >
        {needsCatchup ? (
          <div className="ch-catchup-banner" role="status">
            <span>chat is out of sync — reconnecting…</span>
            {showResyncButton ? (
              <button
                type="button"
                className="ch-catchup-banner__btn"
                onClick={onResync}
              >
                resync now
              </button>
            ) : null}
          </div>
        ) : null}
        {replyOnlyBackfillPaused && onContinueHistory ? (
          <div className="ch-history-paused" role="status">
            <span>older channel history is available</span>
            <button
              type="button"
              className="ch-history-continue"
              onClick={onContinueHistory}
            >
              load older channel history
            </button>
          </div>
        ) : null}
        {reachedBeginning ? (
          <div className="ch-top-marker">beginning of #{channelTitle}</div>
        ) : loadingOlder ? (
          <div className="ch-loading-older">loading older messages…</div>
        ) : null}
        <div
          ref={contentRef}
          className={
            // With zero history the presence row is the only content, and `.ch-tl`
            // is a top-anchored flex column — the row would otherwise sit alone in
            // the top-left corner of a full-height blank pane. Bottom-anchor only
            // in that case so the normal scroll model is untouched (#1277 review).
            nodes.length === 0 && agentPresence.length > 0
              ? 'ch-tl-content ch-tl-content--presence-only'
              : 'ch-tl-content'
          }
        >
          {nodes.map((node, index) => {
            if (node.kind === 'day-divider') {
              return (
                <div
                  key={`day-${node.date}-${index}`}
                  className="ch-day-divider"
                  role="separator"
                >
                  <span className="ch-day-divider__label">
                    {formatDayLabel(node.date)}
                  </span>
                </div>
              );
            }
            if (node.kind === 'unread-line') {
              return (
                <div
                  key={`unread-${index}`}
                  className="ch-unread-line"
                  role="separator"
                  aria-label="new messages"
                  data-channel-unread-divider
                >
                  <span className="ch-unread-line__label">new</span>
                </div>
              );
            }
            if (node.kind === 'system') {
              return (
                <ChannelMessageRow
                  key={node.message.id}
                  message={node.message}
                  channelId={channelId}
                  variant="system"
                  highlighted={highlightedMessageId === node.message.id}
                />
              );
            }
            const firstId = node.messages[0]?.id ?? `group-${index}`;
            return (
              <ChannelMessageGroup
                key={firstId}
                sender={node.sender}
                messages={node.messages}
                channelId={channelId}
                replyCounts={replyCounts}
                replyGrowth={replyGrowth}
                highlightedMessageId={highlightedMessageId}
                retriedMessageIds={retriedMessageIds}
                {...(busyAgentIds ? { busyAgentIds } : {})}
                {...(onRetryMessage ? { onRetryMessage } : {})}
                {...(onEditMessage ? { onEditMessage } : {})}
                {...(onDeleteMessage ? { onDeleteMessage } : {})}
                {...(onOpenThread ? { onOpenThread } : {})}
              />
            );
          })}
          {agentPresence.length > 0 ? (
            // Lives INSIDE `.ch-tl-content` on purpose: `useFollowingScroll`
            // observes that element, so the row appearing/disappearing is a
            // content resize the follow model already bottom-anchors. It carries
            // no `data-channel-message-seq`, so it can never become a reader
            // anchor, and it changes no message seq, so the "n new messages"
            // pill cannot be inflated by presence.
            // `role="status"` (implicit polite) makes this the innermost live
            // region, so a transition is announced ONCE here instead of by the
            // enclosing `role="log"`. The spinner is `aria-hidden`: its text
            // mutates every 80ms and is pure decoration — without that, a nested
            // live region would announce ~12x/second per busy agent.
            <div
              className="ch-presence"
              role="status"
              aria-live="polite"
              aria-label="agent presence"
            >
              {agentPresence.map((presence) => (
                <div
                  key={presence.agentId}
                  className={`ch-presence__row ch-presence__row--${presence.status}`}
                  data-channel-presence-agent={presence.agentId}
                  data-channel-presence-status={presence.status}
                >
                  {presence.glyph ? (
                    <span
                      className="ch-presence__glyph"
                      style={{ color: presence.colorVar }}
                      aria-hidden="true"
                    >
                      <AgentBadge agent={presence.glyph} />
                    </span>
                  ) : null}
                  <TuiProgress
                    variant="braille"
                    className="ch-presence__spinner"
                    aria-hidden="true"
                  />
                  <span className="ch-presence__label">
                    {channelPresenceCopy(presence)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {newMessageCount > 0 ? (
        <button
          type="button"
          className="ch-new-messages"
          onClick={scrollToBottom}
        >
          {newMessageCount} new message{newMessageCount === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  );
};

export default ChannelTimeline;
