import { describe, expect, it } from 'vitest';
import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  isAgentPatchV2,
} from '../shared/agent-chat-protocol-v2.js';
import type { AgentSessionV2 } from '../shared/agent-chat-protocol-v2.js';

const timestamp = '2026-04-25T00:00:00.000Z';

function makeSession(): AgentSessionV2 {
  return emptyAgentSessionV2({
    id: 's1',
    provider: 'mock',
    cwd: '/tmp/repo',
  });
}

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
        timestamp,
        turnId: 't1',
        item: { type: 'assistantMessage', id: 'm1', text: '', phase: null },
      })
    ).toBe(true);

    const next = applyAgentPatchV2(session, {
      type: 'agent-turn-started-v2',
      sessionId: 's1',
      timestamp,
      turn: {
        id: 't1',
        status: 'running',
        inputMessageId: 'u1',
        items: [],
        startedAt: timestamp,
      },
    });

    expect(next.turns).toHaveLength(1);
    expect(next.live.status).toBe('working');
  });

  it('rejects malformed wire patches', () => {
    expect(
      isAgentPatchV2({
        type: 'agent-turn-completed-v2',
        sessionId: 's1',
        timestamp,
        turnId: 't1',
        status: 'running',
      })
    ).toBe(false);

    expect(
      isAgentPatchV2({
        type: 'agent-session-snapshot-v2',
        sessionId: 's1',
        timestamp,
        session: {
          id: 's1',
          provider: 'mock',
          config: { cwd: '/tmp/repo' },
          turns: [],
        },
      })
    ).toBe(false);

    expect(
      isAgentPatchV2({
        type: 'agent-item-started-v2',
        sessionId: 's1',
        timestamp,
        turnId: 't1',
        item: { type: 'assistantMessage', id: 'm1', text: 42 },
      })
    ).toBe(false);

    expect(
      isAgentPatchV2({
        type: 'agent-item-delta-v2',
        sessionId: 's1',
        timestamp,
        turnId: 't1',
        itemId: 'm1',
        delta: { text: 42, ignored: 'value' },
      })
    ).toBe(false);
  });

  it('applies the reducer full flow with text deltas and turn completion', () => {
    const started = applyAgentPatchV2(makeSession(), {
      type: 'agent-turn-started-v2',
      sessionId: 's1',
      timestamp,
      turn: {
        id: 't1',
        status: 'running',
        inputMessageId: 'u1',
        items: [],
        startedAt: timestamp,
      },
    });

    const withItem = applyAgentPatchV2(started, {
      type: 'agent-item-started-v2',
      sessionId: 's1',
      timestamp,
      turnId: 't1',
      item: {
        type: 'assistantMessage',
        id: 'm1',
        text: '',
        phase: 'thinking',
        providerMessageId: 'provider-message-1',
      },
    });

    const withDelta = applyAgentPatchV2(withItem, {
      type: 'agent-item-delta-v2',
      sessionId: 's1',
      timestamp,
      turnId: 't1',
      itemId: 'm1',
      delta: { text: 'hello' },
    });

    expect(withDelta.turns[0]?.items[0]).toMatchObject({
      id: 'm1',
      text: 'hello',
      providerMessageId: 'provider-message-1',
    });

    const withUpdate = applyAgentPatchV2(withDelta, {
      type: 'agent-item-updated-v2',
      sessionId: 's1',
      timestamp,
      turnId: 't1',
      item: {
        type: 'assistantMessage',
        id: 'm1',
        text: 'final',
        phase: null,
      },
    });

    expect(withUpdate.turns[0]?.items[0]).toEqual({
      type: 'assistantMessage',
      id: 'm1',
      text: 'final',
      phase: null,
    });

    const completed = applyAgentPatchV2(withUpdate, {
      type: 'agent-turn-completed-v2',
      sessionId: 's1',
      timestamp,
      turnId: 't1',
      status: 'completed',
      completedAt: timestamp,
      durationMs: 12,
    });

    expect(completed.turns[0]).toMatchObject({
      id: 't1',
      status: 'completed',
      completedAt: timestamp,
      durationMs: 12,
    });
    expect(completed.live.status).toBe('idle');
    expect(completed.live.activeTurnId).toBeNull();
  });

  it('does not change live state when completing a non-active turn', () => {
    const firstTurn = applyAgentPatchV2(makeSession(), {
      type: 'agent-turn-started-v2',
      sessionId: 's1',
      timestamp,
      turn: {
        id: 't1',
        status: 'running',
        inputMessageId: 'u1',
        items: [],
        startedAt: timestamp,
      },
    });

    const secondTurn = applyAgentPatchV2(firstTurn, {
      type: 'agent-turn-started-v2',
      sessionId: 's1',
      timestamp,
      turn: {
        id: 't2',
        status: 'running',
        inputMessageId: 'u2',
        items: [],
        startedAt: timestamp,
      },
    });

    const completedOldTurn = applyAgentPatchV2(secondTurn, {
      type: 'agent-turn-completed-v2',
      sessionId: 's1',
      timestamp,
      turnId: 't1',
      status: 'completed',
      completedAt: timestamp,
    });

    expect(completedOldTurn.turns[0]?.status).toBe('completed');
    expect(completedOldTurn.live).toEqual(secondTurn.live);
  });

  it('replaces updated items instead of keeping stale optional fields', () => {
    const withTurn = applyAgentPatchV2(makeSession(), {
      type: 'agent-turn-started-v2',
      sessionId: 's1',
      timestamp,
      turn: {
        id: 't1',
        status: 'running',
        inputMessageId: 'u1',
        items: [],
        startedAt: timestamp,
      },
    });

    const withItem = applyAgentPatchV2(withTurn, {
      type: 'agent-item-started-v2',
      sessionId: 's1',
      timestamp,
      turnId: 't1',
      item: {
        type: 'assistantMessage',
        id: 'm1',
        text: 'draft',
        providerMessageId: 'provider-message-1',
        status: 'running',
      },
    });

    const updated = applyAgentPatchV2(withItem, {
      type: 'agent-item-updated-v2',
      sessionId: 's1',
      timestamp,
      turnId: 't1',
      item: {
        type: 'assistantMessage',
        id: 'm1',
        text: 'final',
      },
    });

    expect(updated.turns[0]?.items[0]).toEqual({
      type: 'assistantMessage',
      id: 'm1',
      text: 'final',
    });
  });
});
