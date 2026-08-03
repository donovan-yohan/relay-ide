import React, { useEffect, useMemo, useState } from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
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
}) => {
  const [showResyncButton, setShowResyncButton] = useState(false);

  // Replies stay in the reducer for gap/catch-up correctness. Every piece of
  // main-lane geometry consumes this render-only projection so hidden reply seqs
  // cannot trigger a pill, move an anchor, or create an inline timeline row.
  const topLevelMessages = useMemo(() => selectTopLevel(messages), [messages]);
  const replyCounts = useMemo(() => deriveReplyCounts(messages), [messages]);
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
        <div ref={contentRef} className="ch-tl-content">
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
            <div className="ch-presence" aria-label="agent presence">
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
