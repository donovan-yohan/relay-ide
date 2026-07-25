import { describe, expect, it } from 'vitest';
import {
  capAgentSessionTranscriptV2,
  emptyAgentSessionV2,
  MAX_ITEM_BYTES,
  MAX_TRANSCRIPT_BYTES,
  type AgentItemV2,
  type AgentSessionV2,
  type AgentTurnV2,
} from '../shared/agent-chat-protocol-v2.js';

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function commandItem(id: string, outputBytes: number): AgentItemV2 {
  return {
    type: 'commandExecution',
    id,
    command: 'echo',
    output: 'x'.repeat(outputBytes),
    status: 'completed',
    startedAt: '2026-07-22T00:00:00.000Z',
    completedAt: '2026-07-22T00:00:01.000Z',
  };
}

function turn(id: string, items: AgentItemV2[]): AgentTurnV2 {
  return {
    id,
    status: 'completed',
    inputMessageId: `${id}-input`,
    items,
    startedAt: '2026-07-22T00:00:00.000Z',
    completedAt: '2026-07-22T00:00:02.000Z',
  };
}

function sessionWith(
  turns: AgentTurnV2[],
  activeTurnId: string | null = null
): AgentSessionV2 {
  const session = emptyAgentSessionV2({
    id: 'cap-test',
    provider: 'claude',
    cwd: '/repo',
  });
  session.turns = turns;
  session.live.activeTurnId = activeTurnId;
  return session;
}

describe('capAgentSessionTranscriptV2', () => {
  it('returns the same reference when already within budget', () => {
    const session = sessionWith([turn('t1', [commandItem('i1', 100)])]);
    const capped = capAgentSessionTranscriptV2(session);
    expect(capped).toBe(session);
  });

  it('trims an over-budget transcript to the most-recent turns (FIFO)', () => {
    // 8 turns of ~100KB each = ~800KB, over the 512KB budget.
    const turns = Array.from({ length: 8 }, (_, i) =>
      turn(`t${i}`, [commandItem(`t${i}-item`, 100_000)])
    );
    const session = sessionWith(turns);

    const capped = capAgentSessionTranscriptV2(session);

    expect(bytes(capped.turns)).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    // Oldest turns dropped, newest preserved.
    const keptIds = capped.turns.map((t) => t.id);
    expect(keptIds).toContain('t7');
    expect(keptIds).not.toContain('t0');
    // FIFO: retained ids are a contiguous most-recent suffix.
    expect(keptIds).toEqual([...keptIds].sort());
    expect(keptIds[keptIds.length - 1]).toBe('t7');
  });

  it('truncates an oversized single item in place before FIFO eviction', () => {
    // One turn, one item whose output alone exceeds MAX_ITEM_BYTES.
    const session = sessionWith([turn('t1', [commandItem('big', 2_000_000)])]);

    const capped = capAgentSessionTranscriptV2(session);

    // Structure preserved: still one turn, one item, same id/type.
    expect(capped.turns).toHaveLength(1);
    expect(capped.turns[0]!.items).toHaveLength(1);
    const item = capped.turns[0]!.items[0]!;
    expect(item.id).toBe('big');
    expect(item.type).toBe('commandExecution');
    expect(bytes(item)).toBeLessThanOrEqual(MAX_ITEM_BYTES);
    expect((item as { output: string }).output).toMatch(/truncated \d+ bytes/);
    expect(bytes(capped.turns)).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
  });

  it('never leaves a retained turn with zero items', () => {
    const turns = Array.from({ length: 6 }, (_, i) =>
      turn(`t${i}`, [
        commandItem(`t${i}-a`, 60_000),
        commandItem(`t${i}-b`, 60_000),
        commandItem(`t${i}-c`, 60_000),
      ])
    );
    const session = sessionWith(turns);

    const capped = capAgentSessionTranscriptV2(session);

    for (const t of capped.turns) {
      expect(t.items.length).toBeGreaterThan(0);
    }
    expect(bytes(capped.turns)).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
  });

  it('preserves the active turn even when it is the oldest', () => {
    // Active turn t0 is oldest; budget forces eviction, but t0 must survive.
    const turns = [
      turn('t0', [commandItem('t0-item', 300_000)]),
      turn('t1', [commandItem('t1-item', 300_000)]),
      turn('t2', [commandItem('t2-item', 300_000)]),
    ];
    const session = sessionWith(turns, 't0');

    const capped = capAgentSessionTranscriptV2(session);

    expect(capped.turns.map((t) => t.id)).toContain('t0');
  });

  it('bounds a single huge active turn by trimming its oldest items', () => {
    // One active turn with many items far exceeding the budget: item-level FIFO
    // must keep the tail and stay under budget.
    const items = Array.from({ length: 40 }, (_, i) =>
      commandItem(`item-${i}`, 50_000)
    );
    const session = sessionWith([turn('t1', items)], 't1');

    const capped = capAgentSessionTranscriptV2(session);

    expect(capped.turns).toHaveLength(1);
    expect(bytes(capped.turns)).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    const keptIds = capped.turns[0]!.items.map((i) => i.id);
    // Tail preserved (most-recent item survives), oldest evicted.
    expect(keptIds).toContain('item-39');
    expect(keptIds).not.toContain('item-0');
    expect(capped.turns[0]!.items.length).toBeGreaterThan(0);
  });

  it('leaves provider/live/session identity untouched', () => {
    const turns = Array.from({ length: 8 }, (_, i) =>
      turn(`t${i}`, [commandItem(`t${i}-item`, 100_000)])
    );
    const session = sessionWith(turns);
    session.providerSession = { claudeSessionId: 'resume-abc' };

    const capped = capAgentSessionTranscriptV2(session);

    expect(capped.provider).toBe('claude');
    expect(capped.providerSession).toEqual({ claudeSessionId: 'resume-abc' });
    expect(capped.config.cwd).toBe('/repo');
  });
});
