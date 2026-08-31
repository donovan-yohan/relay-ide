import { expect, test } from 'vitest';

import {
  initialFeedbackTarget,
  resolveFeedbackTarget,
} from '../frontend/src/lib/feedback-target.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';

function session(
  id: string,
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id,
    type: 'terminal',
    cwd: '/repo',
    displayName: id,
    createdAt: '2026-05-28T00:00:00.000Z',
    lastActivity: '2026-05-28T00:00:00.000Z',
    idle: false,
    activityState: 'idle',
    ...overrides,
  };
}

test('feedback target selection honors a live preferred target and normalizes it', () => {
  const sessions = [
    session('terminal-a', { nodeId: 'local' }),
    session('terminal-b', { nodeId: 'local' }),
  ];

  expect(initialFeedbackTarget(sessions, 'terminal-a')).toBe(
    'local:terminal-a'
  );
});

test('feedback target selection ignores stale preferred targets and falls back to the first live terminal', () => {
  const sessions = [
    session('terminal-a', { nodeId: 'local' }),
    session('terminal-b', { nodeId: 'remote' }),
  ];

  expect(initialFeedbackTarget(sessions, 'local:dead-terminal')).toBe(
    'local:terminal-a'
  );
});

test('feedback target revalidation preserves a still-live current target', () => {
  const sessions = [
    session('terminal-a', { nodeId: 'local' }),
    session('terminal-b', { nodeId: 'remote' }),
  ];

  expect(
    resolveFeedbackTarget(sessions, 'local:terminal-a', 'remote:terminal-b')
  ).toBe('remote:terminal-b');
});

test('feedback target revalidation retargets to a live preferred target when the current target disappears', () => {
  const sessions = [
    session('terminal-a', { nodeId: 'local' }),
    session('terminal-b', { nodeId: 'remote' }),
  ];

  expect(
    resolveFeedbackTarget(sessions, 'local:terminal-a', 'local:dead-agent')
  ).toBe('local:terminal-a');
});

test('feedback target revalidation retargets to the first terminal when the current and preferred targets disappear', () => {
  const sessions = [
    session('terminal-a', { nodeId: 'local' }),
    session('terminal-b', { nodeId: 'remote' }),
  ];

  expect(
    resolveFeedbackTarget(
      sessions,
      'local:dead-terminal',
      'remote:dead-terminal'
    )
  ).toBe('local:terminal-a');
});

test('feedback target revalidation clears when no live sessions remain', () => {
  expect(
    resolveFeedbackTarget([], 'local:dead-terminal', 'remote:also-dead')
  ).toBe('');
});
