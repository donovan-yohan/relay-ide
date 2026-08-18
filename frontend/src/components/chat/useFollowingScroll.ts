import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { ChannelMessage } from '../../../../shared/channel-chat-protocol.js';
import {
  deriveFollowIntent,
  readTimelineScrollMetrics,
} from './followingScrollPrimitives.js';

const LOAD_OLDER_SCROLL_THRESHOLD_PX = 80;

interface ViewportAnchor {
  seq: number;
  offsetTop: number;
  earliestSeqBefore: number | undefined;
}

function anchorElementForSeq(
  container: HTMLDivElement,
  seq: number
): HTMLElement | null {
  const activitySummary = Array.from(
    container.querySelectorAll<HTMLElement>('[data-channel-activity-run]')
  ).find((summary) => {
    const start = Number(summary.dataset.channelActivityStartSeq);
    const end = Number(summary.dataset.channelActivityEndSeq);
    return (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      seq >= start &&
      seq <= end
    );
  });
  if (activitySummary) return activitySummary;
  return container.querySelector<HTMLElement>(
    `[data-channel-message-seq="${seq}"]`
  );
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

interface UseFollowingScrollOptions {
  messages: ChannelMessage[];
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  /** Increment only when an authoritative snapshot replaces the visible window. */
  fullSnapshotRevision?: number;
}

interface FollowingScrollState {
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  handleScroll: () => void;
  scrollToBottom: () => void;
  newMessageCount: number;
}

/**
 * Shared Slack-style follow/anchor model for the channel lane and thread panel.
 * The message list is the rendered projection, not the reducer's full seq lane.
 */
export function useFollowingScroll({
  messages,
  hasMoreOlder,
  loadingOlder,
  loadOlder,
  fullSnapshotRevision = 0,
}: UseFollowingScrollOptions): FollowingScrollState {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<ViewportAnchor | null>(null);
  const readerAnchorRef = useRef<ViewportAnchor | null>(null);
  const shouldFollowRef = useRef(true);
  const initializedRef = useRef(false);
  const previousLatestSeqRef = useRef(0);
  const previousFullSnapshotRevisionRef = useRef(fullSnapshotRevision);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const [loadSettleTick, setLoadSettleTick] = useState(0);
  const [newMessageCount, setNewMessageCount] = useState(0);

  const earliestSeq = messages[0]?.seq;
  const latestSeq = messages[messages.length - 1]?.seq ?? 0;

  const scrollToBottom = useCallback((): void => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    lastScrollTopRef.current = container.scrollTop;
    lastScrollHeightRef.current = container.scrollHeight;
    shouldFollowRef.current = true;
    setNewMessageCount(0);
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = readerAnchorRef.current;
    anchorRef.current = null;
    if (container && anchor && !shouldFollowRef.current) {
      const row = anchorElementForSeq(container, anchor.seq);
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

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    let toggleFrame: number | null = null;

    const preserveFollow = (): void => {
      if (anchorRef.current) return;
      if (!shouldFollowRef.current) {
        const anchor = readerAnchorRef.current;
        if (anchor) {
          const row = anchorElementForSeq(container, anchor.seq);
          if (row) {
            const offsetTop =
              row.getBoundingClientRect().top -
              container.getBoundingClientRect().top;
            container.scrollTop += offsetTop - anchor.offsetTop;
            lastScrollTopRef.current = container.scrollTop;
          }
        }
        readerAnchorRef.current = captureViewportAnchor(container);
        return;
      }
      scrollToBottom();
    };

    const preserveFollowAfterCardToggle = (event: MouseEvent): void => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.ch-agent-card__toggle') ||
        !shouldFollowRef.current ||
        anchorRef.current
      ) {
        return;
      }
      if (toggleFrame !== null) cancelAnimationFrame(toggleFrame);
      toggleFrame = requestAnimationFrame(() => {
        toggleFrame = null;
        scrollToBottom();
      });
    };

    content.addEventListener('click', preserveFollowAfterCardToggle);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(preserveFollow);
    observer?.observe(content);
    observer?.observe(container);
    return () => {
      content.removeEventListener('click', preserveFollowAfterCardToggle);
      observer?.disconnect();
      if (toggleFrame !== null) cancelAnimationFrame(toggleFrame);
    };
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = anchorRef.current;
    if (!container || !anchor) return;
    if (earliestSeq !== anchor.earliestSeqBefore) {
      const row = anchorElementForSeq(container, anchor.seq);
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
    const metrics = readTimelineScrollMetrics(container);
    const scrollTopChanged =
      Math.abs(metrics.scrollTop - lastScrollTopRef.current) > 1;
    const contentGrewBeforeResizeObserver =
      metrics.scrollHeight > lastScrollHeightRef.current + 1;
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

    // A card/code block expansion can emit `scroll` after layout grows but
    // before ResizeObserver restores the bottom. Preserve the prior follow
    // intent only when the viewport itself stayed put; real reader movement
    // still disengages follow through deriveFollowIntent below.
    if (
      shouldFollowRef.current &&
      contentGrewBeforeResizeObserver &&
      !scrollTopChanged &&
      !pendingAnchor
    ) {
      scrollToBottom();
      return;
    }

    const { follow } = deriveFollowIntent(metrics, lastScrollTopRef.current);
    shouldFollowRef.current = follow;
    lastScrollTopRef.current = metrics.scrollTop;
    lastScrollHeightRef.current = metrics.scrollHeight;
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
      void loadOlder()
        .catch(() => {})
        .finally(() => setLoadSettleTick((tick) => tick + 1));
    }
  }, [
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    messages.length,
    earliestSeq,
    scrollToBottom,
  ]);

  return {
    containerRef,
    contentRef,
    handleScroll,
    scrollToBottom,
    newMessageCount,
  };
}
