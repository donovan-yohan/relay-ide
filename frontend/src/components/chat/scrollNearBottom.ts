/** Minimal scroll geometry needed to decide auto-follow behavior. */
export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** Distance (px) from the bottom edge within which auto-scroll should still follow new content. */
export const NEAR_BOTTOM_THRESHOLD_PX = 150;

/**
 * True when the scroll position is within `threshold` px of the bottom.
 * Extracted so stream-growth auto-scroll logic (ResizeObserver-driven) stays
 * unit-testable without asserting real layout/scroll positions in jsdom.
 */
export function isNearBottom(
  metrics: ScrollMetrics,
  threshold: number = NEAR_BOTTOM_THRESHOLD_PX
): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold
  );
}
