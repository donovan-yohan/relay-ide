import { expect, test } from 'vitest';

import {
  initialFeedbackTarget,
  resolveFeedbackTarget,
} from '../frontend/src/lib/feedback-target.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';

function session(
  id: string,
  type: SessionSummary['type'],
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id,
    type,
    agent: type === 'agent' ? 'claude' : 'shell',
    cwd: '/repo',
    displayName: id,
    createdAt: '2026-05-28T00:00:00.000Z',
    lastActivity: '2026-05-28T00:00:00.000Z',
    idle: false,
    ...overrides,
  };
}

test('feedback target selection honors a live preferred target and normalizes it', () => {
  const sessions = [
    session('terminal-a', 'terminal', { nodeId: 'local' }),
    session('agent-a', 'agent', { nodeId: 'local' }),
  ];

  expect(initialFeedbackTarget(sessions, 'terminal-a')).toBe(
    'local:terminal-a'
  );
});

test('feedback target selection ignores stale preferred targets and falls back to the first live agent', () => {
  const sessions = [
    session('terminal-a', 'terminal', { nodeId: 'local' }),
    session('agent-a', 'agent', { nodeId: 'remote' }),
  ];

  expect(initialFeedbackTarget(sessions, 'local:dead-agent')).toBe(
    'remote:agent-a'
  );
});

test('feedback target revalidation preserves a still-live current target', () => {
  const sessions = [
    session('agent-a', 'agent', { nodeId: 'local' }),
    session('agent-b', 'agent', { nodeId: 'remote' }),
  ];

  expect(
    resolveFeedbackTarget(sessions, 'local:agent-a', 'remote:agent-b')
  ).toBe('remote:agent-b');
});

test('feedback target revalidation retargets to a live preferred target when the current target disappears', () => {
  const sessions = [
    session('terminal-a', 'terminal', { nodeId: 'local' }),
    session('agent-a', 'agent', { nodeId: 'remote' }),
  ];

  expect(
    resolveFeedbackTarget(sessions, 'local:terminal-a', 'local:dead-agent')
  ).toBe('local:terminal-a');
});

test('feedback target revalidation retargets to the first agent when the current and preferred targets disappear', () => {
  const sessions = [
    session('terminal-a', 'terminal', { nodeId: 'local' }),
    session('agent-a', 'agent', { nodeId: 'remote' }),
  ];

  expect(
    resolveFeedbackTarget(sessions, 'local:dead-agent', 'remote:dead-agent')
  ).toBe('remote:agent-a');
});

test('feedback target revalidation clears when no live sessions remain', () => {
  expect(
    resolveFeedbackTarget([], 'local:dead-agent', 'remote:also-dead')
  ).toBe('');
});
