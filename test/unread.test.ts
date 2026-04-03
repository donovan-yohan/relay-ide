import { describe, it, expect } from 'vitest';
import { shouldMarkUnread } from '../frontend/src/lib/state/unread-logic.js';

describe('shouldMarkUnread', () => {
  it('running → idle when not viewing → true', () => {
    expect(shouldMarkUnread('running', 'unseen-idle', false)).toBe(true);
  });

  it('running → idle when viewing → false', () => {
    expect(shouldMarkUnread('running', 'unseen-idle', true)).toBe(false);
  });

  it('running → permission when not viewing → true', () => {
    expect(shouldMarkUnread('running', 'permission', false)).toBe(true);
  });

  it('running → error → true', () => {
    expect(shouldMarkUnread('running', 'error', false)).toBe(true);
  });

  it('idle → idle → false (no change)', () => {
    expect(shouldMarkUnread('seen-idle', 'seen-idle', false)).toBe(false);
  });

  it('inactive → inactive → false', () => {
    expect(shouldMarkUnread('inactive', 'inactive', false)).toBe(false);
  });
});
