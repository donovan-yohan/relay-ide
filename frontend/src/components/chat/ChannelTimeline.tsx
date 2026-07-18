import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChannelMessage } from '../../../../shared/channel-chat-protocol.js';
import {
  buildTimelineNodes,
  formatDayLabel,
} from '../../lib/chat/channel-timeline-layout.js';
import { isNearBottom } from './scrollNearBottom.js';
import { ChannelMessageGroup } from './ChannelMessageGroup.js';
import { ChannelMessageRow } from './ChannelMessageRow.js';

const LOAD_OLDER_SCROLL_THRESHOLD_PX = 80;
const RESYNC_BUTTON_DELAY_MS = 5_000;

interface ChannelTimelineProps {
  messages: ChannelMessage[];
  lastReadSeq: number | null;
  channelTitle: string;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  needsCatchup: boolean;
  onResync: () => void;
}

export const ChannelTimeline: React.FC<ChannelTimelineProps> = ({
  messages,
  lastReadSeq,
  channelTitle,
  hasMoreOlder,
  loadingOlder,
  loadOlder,
  needsCatchup,
  onResync,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{
    heightBefore: number;
    topBefore: number;
    earliestSeqBefore: number | undefined;
  } | null>(null);
  // Bumped on every loadOlder() settlement (success-with-prepend, empty page,
  // reached-beginning page, OR a swallowed fetch error) so the anchor is always
  // released even when earliestSeq never changes (#1178).
  const [loadSettleTick, setLoadSettleTick] = useState(0);
  const [showResyncButton, setShowResyncButton] = useState(false);

  const nodes = useMemo(
    () => buildTimelineNodes(messages, lastReadSeq),
    [messages, lastReadSeq]
  );

  const earliestSeq = messages[0]?.seq;
  const reachedBeginning = !hasMoreOlder && earliestSeq === 1;

  // Follow-bottom signal: grows on new rows AND on streaming text growth.
  const followSignal = useMemo(() => {
    const last = messages[messages.length - 1];
    return `${messages.length}:${last ? last.body.text.length : 0}`;
  }, [messages]);

  // Auto-follow the bottom when already near it (never yanks a user reading
  // history). Reuses the ChatView ResizeObserver pattern verbatim.
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const followIfNearBottom = (): void => {
      if (anchorRef.current) return; // an older-history restore is pending
      if (
        isNearBottom({
          scrollHeight: container.scrollHeight,
          scrollTop: container.scrollTop,
          clientHeight: container.clientHeight,
        })
      ) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    };

    followIfNearBottom();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(followIfNearBottom);
    observer.observe(content);
    return () => observer.disconnect();
  }, [followSignal]);

  // Anchor lifecycle: set before loadOlder(), consumed on the next settlement.
  // Restore scrollTop ONLY when a prepend actually landed (earliestSeq dropped)
  // so the viewport never jumps; but ALWAYS release the anchor afterward. If it
  // is not released on the no-prepend paths (empty page, oldest page already
  // reaching seq 1, or a swallowed fetch error), auto-follow (line ~73) and all
  // further older-history loads (handleScroll's `!anchorRef.current` gate) stay
  // permanently locked until a channel switch (#1178).
  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = anchorRef.current;
    if (!container || !anchor) return;
    if (earliestSeq !== anchor.earliestSeqBefore) {
      container.scrollTop =
        container.scrollHeight - anchor.heightBefore + anchor.topBefore;
    }
    anchorRef.current = null;
  }, [earliestSeq, loadSettleTick]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (
      container.scrollTop < LOAD_OLDER_SCROLL_THRESHOLD_PX &&
      hasMoreOlder &&
      !loadingOlder &&
      messages.length > 0 &&
      !anchorRef.current
    ) {
      anchorRef.current = {
        heightBefore: container.scrollHeight,
        topBefore: container.scrollTop,
        earliestSeqBefore: earliestSeq,
      };
      // The hook swallows its own fetch errors (loadOlder resolves even on a
      // transient failure), but guard against any future reject too so the
      // settle tick — and thus the anchor release — always runs (#1178).
      void loadOlder()
        .catch(() => {})
        .finally(() => setLoadSettleTick((tick) => tick + 1));
    }
  }, [hasMoreOlder, loadingOlder, loadOlder, messages.length, earliestSeq]);

  // Surface a manual "resync now" button only if catch-up is still stuck after
  // a grace period (the hook auto-reconnects in the common case).
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
            />
          );
        })}
      </div>
      <div ref={bottomRef} />
    </div>
  );
};

export default ChannelTimeline;
