import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldMarkUnread } from '../frontend/src/lib/state/unread-logic.js';

describe('shouldMarkUnread', () => {
  it('running → idle when not viewing → true', () => {
    assert.equal(shouldMarkUnread('running', 'unseen-idle', false), true);
  });

  it('running → idle when viewing → false', () => {
    assert.equal(shouldMarkUnread('running', 'unseen-idle', true), false);
  });

  it('running → permission when not viewing → true', () => {
    assert.equal(shouldMarkUnread('running', 'permission', false), true);
  });

  it('running → error → true', () => {
    assert.equal(shouldMarkUnread('running', 'error', false), true);
  });

  it('idle → idle → false (no change)', () => {
    assert.equal(shouldMarkUnread('seen-idle', 'seen-idle', false), false);
  });

  it('inactive → inactive → false', () => {
    assert.equal(shouldMarkUnread('inactive', 'inactive', false), false);
  });
});
