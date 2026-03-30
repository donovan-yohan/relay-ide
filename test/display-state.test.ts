import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transitionDisplayState, shouldNotify } from '../frontend/src/lib/state/display-state.js';
import type { DisplayState, DisplayEvent } from '../frontend/src/lib/state/display-state.js';

describe('transitionDisplayState', () => {
  const transitionTable: [DisplayState, DisplayEvent, DisplayState, string][] = [
    [
      'initializing',
      { type: 'backend-state-changed', state: 'running' },
      'running',
      'initializing + backend-state-changed(running) → running',
    ],
    [
      'initializing',
      { type: 'backend-state-changed', state: 'idle' },
      'unseen-idle',
      'initializing + backend-state-changed(idle) → unseen-idle',
    ],
    [
      'running',
      { type: 'backend-state-changed', state: 'idle' },
      'unseen-idle',
      'running + backend-state-changed(idle) → unseen-idle',
    ],
    [
      'running',
      { type: 'backend-state-changed', state: 'permission' },
      'permission',
      'running + backend-state-changed(permission) → permission',
    ],
    [
      'unseen-idle',
      { type: 'user-viewed' },
      'seen-idle',
      'unseen-idle + user-viewed → seen-idle',
    ],
    [
      'seen-idle',
      { type: 'backend-state-changed', state: 'running' },
      'running',
      'seen-idle + backend-state-changed(running) → running',
    ],
    [
      'seen-idle',
      { type: 'backend-state-changed', state: 'idle' },
      'seen-idle',
      'seen-idle + backend-state-changed(idle) → seen-idle (CRITICAL INVARIANT)',
    ],
    [
      'permission',
      { type: 'user-viewed' },
      'seen-idle',
      'permission + user-viewed → seen-idle',
    ],
    [
      'permission',
      { type: 'backend-state-changed', state: 'running' },
      'running',
      'permission + backend-state-changed(running) → running',
    ],
    [
      'running',
      { type: 'session-ended' },
      'inactive',
      'running + session-ended → inactive',
    ],
    [
      'unseen-idle',
      { type: 'backend-state-changed', state: 'idle' },
      'unseen-idle',
      'unseen-idle + backend-state-changed(idle) → unseen-idle (idempotent)',
    ],
    [
      'seen-idle',
      { type: 'session-ended' },
      'inactive',
      'seen-idle + session-ended → inactive',
    ],
  ];

  for (const [current, event, expected, description] of transitionTable) {
    it(description, () => {
      const result = transitionDisplayState(current, event);
      assert.equal(result, expected);
    });
  }
});

describe('shouldNotify', () => {
  it('running → unseen-idle → true', () => {
    assert.equal(shouldNotify('running', 'unseen-idle'), true);
  });

  it('running → permission → true', () => {
    assert.equal(shouldNotify('running', 'permission'), true);
  });

  it('initializing → unseen-idle → false', () => {
    assert.equal(shouldNotify('initializing', 'unseen-idle'), false);
  });

  it('seen-idle → seen-idle → false', () => {
    assert.equal(shouldNotify('seen-idle', 'seen-idle'), false);
  });
});
