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

interface ViewportAnchor {
  seq: number;
  offsetTop: number;
  earliestSeqBefore: number | undefined;
}

function scrollMetrics(container: HTMLDivElement) {
  return {
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
  };
}

function captureViewportAnchor(
  container: HTMLDivElement
): ViewportAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const rows = container.querySelectorAll<HTMLElement>(
    '[data-channel-message-seq]'
  );
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom < containerTop) continue;
    const seq = Number(row.dataset.channelMessageSeq);
    if (!Number.isFinite(seq)) continue;
    return {
      seq,
      offsetTop: rect.top - containerTop,
      earliestSeqBefore: undefined,
    };
  }
  return null;
}

interface ChannelTimelineProps {
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
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<ViewportAnchor | null>(null);
  const readerAnchorRef = useRef<ViewportAnchor | null>(null);
  const shouldFollowRef = useRef(true);
  const initializedRef = useRef(false);
  const previousLatestSeqRef = useRef(0);
  const previousFullSnapshotRevisionRef = useRef(fullSnapshotRevision);
  const lastScrollTopRef = useRef(0);
  // Bumped on every loadOlder() settlement (success-with-prepend, empty page,
  // reached-beginning page, OR a swallowed fetch error) so the anchor is always
  // released even when earliestSeq never changes (#1178).
  const [loadSettleTick, setLoadSettleTick] = useState(0);
  const [showResyncButton, setShowResyncButton] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);

  const nodes = useMemo(
    () => buildTimelineNodes(messages, lastReadSeq),
    [messages, lastReadSeq]
  );

  const earliestSeq = messages[0]?.seq;
  const latestSeq = messages[messages.length - 1]?.seq ?? 0;
  const reachedBeginning = !hasMoreOlder && earliestSeq === 1;

  const scrollToBottom = useCallback((): void => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    lastScrollTopRef.current = container.scrollTop;
    shouldFollowRef.current = true;
    setNewMessageCount(0);
  }, []);

  // A full snapshot replaces the whole rendered window. The reader anchor is
  // cached by scroll/resize handling before this commit; a layout-effect
  // cleanup on a function component is too late because child DOM mutations
  // have already landed. Restore the cached row after the replacement, then
  // refresh it from the resulting viewport. If the row fell outside the new
  // window, the unread divider is the deterministic semantic fallback.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = readerAnchorRef.current;
    // An authoritative replacement supersedes an in-flight history prepend,
    // whether the reader is following or browsing history.
    anchorRef.current = null;
    if (container && anchor && !shouldFollowRef.current) {
      const row = container.querySelector<HTMLElement>(
        `[data-channel-message-seq="${anchor.seq}"]`
      );
      const target =
        row ??
        container.querySelector<HTMLElement>('[data-channel-unread-divider]');
      if (target) {
        const offsetTop =
          target.getBoundingClientRect().top -
          container.getBoundingClientRect().top;
        container.scrollTop +=
          row === target ? offsetTop - anchor.offsetTop : offsetTop;
        lastScrollTopRef.current = container.scrollTop;
      }
    }
    readerAnchorRef.current =
      container && !shouldFollowRef.current
        ? captureViewportAnchor(container)
        : null;
  }, [fullSnapshotRevision]);

  // Capture follow intent independently of post-mutation geometry. Rechecking
  // `isNearBottom` only after a large append can turn a previously-bottomed
  // viewport into a false negative and strand it above the new row.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      previousLatestSeqRef.current = latestSeq;
      scrollToBottom();
      return;
    }

    const previousLatestSeq = previousLatestSeqRef.current;
    if (fullSnapshotRevision !== previousFullSnapshotRevisionRef.current) {
      previousFullSnapshotRevisionRef.current = fullSnapshotRevision;
      previousLatestSeqRef.current = latestSeq;
      setNewMessageCount(0);
      if (shouldFollowRef.current) scrollToBottom();
      return;
    }
    if (latestSeq < previousLatestSeq) {
      // An authoritative full snapshot can legitimately reset seq after a
      // channel is recreated under the same id. Reset the append baseline but
      // preserve the reader's follow choice across the resync.
      previousLatestSeqRef.current = latestSeq;
      setNewMessageCount(0);
      if (shouldFollowRef.current && !anchorRef.current) scrollToBottom();
      return;
    }
    if (latestSeq > previousLatestSeq) {
      let appendedCount = 0;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]!.seq <= previousLatestSeq) break;
        appendedCount += 1;
      }
      const latestMessage = messages[messages.length - 1];
      const isOwnMessage =
        latestMessage !== undefined &&
        latestMessage.seq > previousLatestSeq &&
        latestMessage.sender.kind === 'human';
      if (isOwnMessage) {
        // Slack parity: sending while reading history returns to the present.
        // Cancel a pending prepend so its eventual settlement cannot pull the
        // viewport away from the just-posted message.
        anchorRef.current = null;
        readerAnchorRef.current = null;
        scrollToBottom();
      } else if (shouldFollowRef.current && !anchorRef.current) {
        scrollToBottom();
      } else if (appendedCount > 0) {
        setNewMessageCount((count) => count + appendedCount);
      }
    }
    previousLatestSeqRef.current = latestSeq;
  }, [fullSnapshotRevision, latestSeq, messages, scrollToBottom]);

  // Streaming text, responsive layout, viewport rotation, and virtual-keyboard
  // changes all surface as content/container resizes. Preserve bottom anchoring
  // only when the user's last real scroll position opted into follow mode.
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const preserveFollow = (): void => {
      if (anchorRef.current) return;
      if (!shouldFollowRef.current) {
        readerAnchorRef.current = captureViewportAnchor(container);
        return;
      }
      scrollToBottom();
    };

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(preserveFollow);
    observer.observe(content);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollToBottom]);

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
      const row = container.querySelector<HTMLElement>(
        `[data-channel-message-seq="${anchor.seq}"]`
      );
      if (row) {
        const offsetTop =
          row.getBoundingClientRect().top -
          container.getBoundingClientRect().top;
        container.scrollTop += offsetTop - anchor.offsetTop;
        lastScrollTopRef.current = container.scrollTop;
      }
    }
    anchorRef.current = null;
  }, [earliestSeq, loadSettleTick]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const metrics = scrollMetrics(container);
    const scrollTopChanged =
      Math.abs(metrics.scrollTop - lastScrollTopRef.current) > 1;
    const pendingAnchor = anchorRef.current;
    if (pendingAnchor && loadingOlder && scrollTopChanged) {
      const refreshed = captureViewportAnchor(container);
      if (refreshed) {
        anchorRef.current = {
          ...refreshed,
          earliestSeqBefore: pendingAnchor.earliestSeqBefore,
        };
      }
    }

    const maxScrollTop = Math.max(
      0,
      metrics.scrollHeight - metrics.clientHeight
    );
    const movingUp = metrics.scrollTop < lastScrollTopRef.current - 1;
    const atBottom =
      maxScrollTop === 0 || maxScrollTop - metrics.scrollTop <= 1;
    const follow = atBottom || (!movingUp && isNearBottom(metrics));
    shouldFollowRef.current = follow;
    lastScrollTopRef.current = metrics.scrollTop;
    if (follow) {
      readerAnchorRef.current = null;
      setNewMessageCount(0);
    } else {
      readerAnchorRef.current = captureViewportAnchor(container);
    }
    if (
      container.scrollTop < LOAD_OLDER_SCROLL_THRESHOLD_PX &&
      hasMoreOlder &&
      !loadingOlder &&
      messages.length > 0 &&
      !anchorRef.current
    ) {
      const fallbackSeq = earliestSeq;
      if (fallbackSeq === undefined) return;
      const anchor = captureViewportAnchor(container);
      anchorRef.current = anchor
        ? { ...anchor, earliestSeqBefore: earliestSeq }
        : {
            seq: fallbackSeq,
            offsetTop: 0,
            earliestSeqBefore: fallbackSeq,
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
              />
            );
          })}
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
