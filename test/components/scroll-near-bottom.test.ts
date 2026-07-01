import { describe, expect, it } from 'vitest';
import {
  isNearBottom,
  NEAR_BOTTOM_THRESHOLD_PX,
} from '../../frontend/src/components/chat/scrollNearBottom.js';

describe('isNearBottom', () => {
  it('is true when scrolled all the way to the bottom', () => {
    expect(
      isNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 })
    ).toBe(true);
  });

  it('is true when within the default threshold of the bottom', () => {
    expect(
      isNearBottom({ scrollHeight: 1000, scrollTop: 650, clientHeight: 300 })
    ).toBe(true);
  });

  it('is false when scrolled up beyond the default threshold', () => {
    expect(
      isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 300 })
    ).toBe(false);
  });

  it('respects a custom threshold', () => {
    const metrics = { scrollHeight: 1000, scrollTop: 500, clientHeight: 300 };
    expect(isNearBottom(metrics, 250)).toBe(true);
    expect(isNearBottom(metrics, 199)).toBe(false);
  });

  it('stays false as content grows while the user is scrolled away from the bottom', () => {
    // User scrolled up and stayed put while more content streamed in below —
    // scrollHeight grows but scrollTop/clientHeight don't change.
    const scrolledUp = { scrollTop: 200, clientHeight: 300 };
    expect(isNearBottom({ ...scrolledUp, scrollHeight: 1000 })).toBe(false);
    expect(isNearBottom({ ...scrolledUp, scrollHeight: 2000 })).toBe(false);
  });

  it('exports the documented default threshold', () => {
    expect(NEAR_BOTTOM_THRESHOLD_PX).toBe(150);
  });
});
