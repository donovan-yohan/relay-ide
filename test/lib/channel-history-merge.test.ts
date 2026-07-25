import { describe, expect, it } from 'vitest';
import {
  initialChannelReducerState,
  mergeHistoryPage,
  type ChannelMessage,
  type ChannelMessageId,
  type ChannelReducerState,
} from '../../shared/channel-chat-protocol.js';

function msg(seq: number): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:${seq}` as ChannelMessageId,
    channelId: 'topic:general',
    seq,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: `m${seq}`, format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

function stateWith(seqs: number[], lastSeq: number): ChannelReducerState {
  const messages = seqs.map(msg);
  const byId: Record<string, ChannelMessage> = {};
  for (const m of messages) byId[m.id] = m;
  return {
    ...initialChannelReducerState('topic:general'),
    messages,
    byId,
    lastSeq,
  };
}

describe('mergeHistoryPage', () => {
  it('prepends older messages, keeping seq order and lastSeq unchanged', () => {
    const state = stateWith([3, 4], 4);
    const next = mergeHistoryPage(state, [msg(1), msg(2)]);
    expect(next.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(Object.keys(next.byId).sort()).toEqual([
      'chm:1',
      'chm:2',
      'chm:3',
      'chm:4',
    ]);
    expect(next.lastSeq).toBe(4);
  });

  it('is idempotent for overlapping pages (dedupes by id)', () => {
    const state = stateWith([3, 4], 4);
    const once = mergeHistoryPage(state, [msg(2), msg(3)]);
    const twice = mergeHistoryPage(once, [msg(2), msg(3)]);
    expect(twice.messages.map((m) => m.seq)).toEqual([2, 3, 4]);
  });

  it('returns the same state reference for an empty page', () => {
    const state = stateWith([1], 1);
    expect(mergeHistoryPage(state, [])).toBe(state);
  });

  it('raises lastSeq if the page contains a newer message than current', () => {
    const state = stateWith([1], 1);
    const next = mergeHistoryPage(state, [msg(5)]);
    expect(next.lastSeq).toBe(5);
    expect(next.messages.map((m) => m.seq)).toEqual([1, 5]);
  });
});
