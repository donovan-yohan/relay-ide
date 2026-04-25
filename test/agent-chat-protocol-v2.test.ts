import { describe, expect, it } from 'vitest';
import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  isAgentPatchV2,
} from '../shared/agent-chat-protocol-v2.js';

describe('Agent Chat Protocol v2', () => {
  it('accepts session snapshots and item patches', () => {
    const session = emptyAgentSessionV2({
      id: 's1',
      provider: 'mock',
      cwd: '/tmp/repo',
    });

    expect(
      isAgentPatchV2({
        type: 'agent-item-started-v2',
        sessionId: 's1',
        timestamp: '2026-04-25T00:00:00.000Z',
        turnId: 't1',
        item: { type: 'assistantMessage', id: 'm1', text: '', phase: null },
      })
    ).toBe(true);

    const next = applyAgentPatchV2(session, {
      type: 'agent-turn-started-v2',
      sessionId: 's1',
      timestamp: '2026-04-25T00:00:00.000Z',
      turn: {
        id: 't1',
        status: 'running',
        inputMessageId: 'u1',
        items: [],
        startedAt: '2026-04-25T00:00:00.000Z',
      },
    });

    expect(next.turns).toHaveLength(1);
    expect(next.live.status).toBe('working');
  });
});
