import { isNearBottom } from './scrollNearBottom.js';

export interface TimelineScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function readTimelineScrollMetrics(
  container: HTMLDivElement
): TimelineScrollMetrics {
  return {
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
  };
}

/**
 * #1197 follow-intent guard shared by channel and agent timelines. Moving up
 * always disengages follow; moving down re-engages only near the bottom.
 */
export function deriveFollowIntent(
  metrics: TimelineScrollMetrics,
  lastScrollTop: number
): { atBottom: boolean; movingUp: boolean; follow: boolean } {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const movingUp = metrics.scrollTop < lastScrollTop - 1;
  const atBottom = maxScrollTop === 0 || maxScrollTop - metrics.scrollTop <= 1;
  return {
    atBottom,
    movingUp,
    follow: atBottom || (!movingUp && isNearBottom(metrics)),
  };
}
