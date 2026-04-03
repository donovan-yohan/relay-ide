import { describe, it, expect } from 'vitest';
import {
  transitionDisplayState,
  shouldNotify,
} from '../frontend/src/lib/state/display-state.js';
import type {
  DisplayState,
  DisplayEvent,
} from '../frontend/src/lib/state/display-state.js';

describe('transitionDisplayState', () => {
  const transitionTable: [DisplayState, DisplayEvent, DisplayState, string][] =
    [
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
        'permission',
        'permission + user-viewed → permission (approval must be given, not just viewed)',
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
      [
        'running',
        {
          type: 'backend-state-changed',
          state: 'permission',
          permissionType: 'question',
        },
        'needs-answer',
        'running + backend-state-changed(permission, question) → needs-answer',
      ],
      [
        'running',
        {
          type: 'backend-state-changed',
          state: 'permission',
          permissionType: 'approval',
        },
        'permission',
        'running + backend-state-changed(permission, approval) → permission',
      ],
      [
        'running',
        { type: 'backend-state-changed', state: 'permission' },
        'permission',
        'running + backend-state-changed(permission, no type) → permission (backward compat)',
      ],
      [
        'needs-answer',
        { type: 'user-viewed' },
        'needs-answer',
        'needs-answer + user-viewed → needs-answer (question must be answered, not just viewed)',
      ],
      [
        'needs-answer',
        { type: 'backend-state-changed', state: 'running' },
        'running',
        'needs-answer + backend-state-changed(running) → running',
      ],
      [
        'running',
        { type: 'backend-state-changed', state: 'error' },
        'error',
        'running + backend-state-changed(error) → error',
      ],
      [
        'error',
        { type: 'session-ended' },
        'inactive',
        'error + session-ended → inactive',
      ],
      [
        'error',
        { type: 'user-viewed' },
        'error',
        'error + user-viewed → error (stays — error needs acknowledgment, not just viewing)',
      ],
      [
        'permission',
        { type: 'backend-state-changed', state: 'idle' },
        'unseen-idle',
        'permission + backend-state-changed(idle) → unseen-idle (escape stuck attention state)',
      ],
      [
        'needs-answer',
        { type: 'backend-state-changed', state: 'idle' },
        'unseen-idle',
        'needs-answer + backend-state-changed(idle) → unseen-idle (escape stuck attention state)',
      ],
      [
        'error',
        { type: 'backend-state-changed', state: 'idle' },
        'unseen-idle',
        'error + backend-state-changed(idle) → unseen-idle (escape stuck attention state)',
      ],
    ];

  for (const [current, event, expected, description] of transitionTable) {
    it(description, () => {
      const result = transitionDisplayState(current, event);
      expect(result).toBe(expected);
    });
  }
});

describe('shouldNotify', () => {
  it('running → unseen-idle → true', () => {
    expect(shouldNotify('running', 'unseen-idle')).toBe(true);
  });

  it('running → permission → true', () => {
    expect(shouldNotify('running', 'permission')).toBe(true);
  });

  it('initializing → unseen-idle → false', () => {
    expect(shouldNotify('initializing', 'unseen-idle')).toBe(false);
  });

  it('seen-idle → seen-idle → false', () => {
    expect(shouldNotify('seen-idle', 'seen-idle')).toBe(false);
  });

  it('running → needs-answer → true', () => {
    expect(shouldNotify('running', 'needs-answer')).toBe(true);
  });

  it('running → error → true', () => {
    expect(shouldNotify('running', 'error')).toBe(true);
  });
});
