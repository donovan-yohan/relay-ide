import { describe, expect, it } from 'vitest';

import {
  applyChannelEventV1,
  initialChannelReducerState,
  isChannelEventV1,
  parseMentions,
  type ChannelEventV1,
  type ChannelMessage,
  type ChannelMessageId,
  type ChannelReducerState,
} from '../shared/channel-chat-protocol.js';

const CHANNEL = 'topic:general';

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    schemaVersion: 1,
    id: 'chm:1' as ChannelMessageId,
    channelId: CHANNEL,
    seq: 1,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'human', id: 'human:operator' },
    body: { text: 'hi', format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function created(m: ChannelMessage): ChannelEventV1 {
  return {
    type: 'channel-message-created-v1',
    channelId: CHANNEL,
    timestamp: 't',
    message: m,
  };
}
function delta(
  messageId: string,
  deltaIndex: number,
  text: string
): ChannelEventV1 {
  return {
    type: 'channel-message-delta-v1',
    channelId: CHANNEL,
    timestamp: 't',
    messageId: messageId as ChannelMessageId,
    deltaIndex,
    delta: { text },
  };
}
function completed(m: ChannelMessage): ChannelEventV1 {
  return {
    type: 'channel-message-completed-v1',
    channelId: CHANNEL,
    timestamp: 't',
    message: m,
  };
}

function reduce(
  state: ChannelReducerState,
  events: ChannelEventV1[]
): ChannelReducerState {
  return events.reduce(applyChannelEventV1, state);
}

describe('isChannelEventV1 validator matrix', () => {
  it('accepts each event variant', () => {
    const snapshot: ChannelEventV1 = {
      type: 'channel-snapshot-v1',
      channelId: CHANNEL,
      timestamp: 't',
      mode: 'full',
      messages: [message()],
      members: [{ kind: 'human', id: 'human:operator', joinedAt: 't' }],
      latestSeq: 1,
      inFlight: [],
      truncated: false,
    };
    expect(isChannelEventV1(snapshot)).toBe(true);
    expect(isChannelEventV1(created(message()))).toBe(true);
    expect(isChannelEventV1(delta('chm:1', 0, 'x'))).toBe(true);
    expect(isChannelEventV1(completed(message()))).toBe(true);
    expect(
      isChannelEventV1({
        type: 'channel-resync-required-v1',
        channelId: CHANNEL,
        timestamp: 't',
        latestSeq: 3,
      })
    ).toBe(true);
  });

  it('rejects malformed / unknown events', () => {
    expect(isChannelEventV1(null)).toBe(false);
    expect(
      isChannelEventV1({ type: 'nope', channelId: CHANNEL, timestamp: 't' })
    ).toBe(false);
    expect(
      isChannelEventV1({
        type: 'channel-message-delta-v1',
        channelId: CHANNEL,
        timestamp: 't',
        messageId: 'chm:1',
        deltaIndex: 'x',
        delta: { text: 'y' },
      })
    ).toBe(false);
    expect(
      isChannelEventV1(
        created({ ...message(), sender: { kind: 'ghost' } as never })
      )
    ).toBe(false);
    expect(
      isChannelEventV1(created({ ...message(), body: { text: 1 } as never }))
    ).toBe(false);
  });
});

describe('applyChannelEventV1 reducer', () => {
  it('appends in-order created events and bumps lastSeq', () => {
    const state = reduce(initialChannelReducerState(CHANNEL), [
      created(message({ id: 'chm:1' as ChannelMessageId, seq: 1 })),
      created(message({ id: 'chm:2' as ChannelMessageId, seq: 2 })),
    ]);
    expect(state.lastSeq).toBe(2);
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(state.needsCatchup).toBe(false);
  });

  it('drops a duplicate created as a no-op', () => {
    const first = reduce(initialChannelReducerState(CHANNEL), [
      created(message({ id: 'chm:1' as ChannelMessageId, seq: 1 })),
    ]);
    const again = applyChannelEventV1(
      first,
      created(message({ id: 'chm:1' as ChannelMessageId, seq: 1 }))
    );
    expect(again.messages).toHaveLength(1);
    expect(again.lastSeq).toBe(1);
  });

  it('sets needsCatchup on a seq gap without partial apply', () => {
    const state = reduce(initialChannelReducerState(CHANNEL), [
      created(message({ id: 'chm:1' as ChannelMessageId, seq: 1 })),
      created(message({ id: 'chm:3' as ChannelMessageId, seq: 3 })),
    ]);
    expect(state.needsCatchup).toBe(true);
    expect(state.messages.map((m) => m.seq)).toEqual([1]); // seq 3 NOT applied
    expect(state.lastSeq).toBe(1);
  });

  it('interleaves two concurrent streams with no cross-contamination', () => {
    const a = message({
      id: 'chm:a' as ChannelMessageId,
      seq: 1,
      status: 'streaming',
      body: { text: '', format: 'markdown' },
    });
    const b = message({
      id: 'chm:b' as ChannelMessageId,
      seq: 2,
      status: 'streaming',
      body: { text: '', format: 'markdown' },
    });
    const state = reduce(initialChannelReducerState(CHANNEL), [
      created(a),
      created(b),
      delta('chm:a', 0, 'a1'),
      delta('chm:b', 0, 'b1'),
      delta('chm:a', 1, 'a2'),
      delta('chm:b', 1, 'b2'),
    ]);
    expect(state.byId['chm:a']?.body.text).toBe('a1a2');
    expect(state.byId['chm:b']?.body.text).toBe('b1b2');
  });

  it('quarantines only the out-of-order stream and heals it on completed', () => {
    const a = message({
      id: 'chm:a' as ChannelMessageId,
      seq: 1,
      status: 'streaming',
      body: { text: '', format: 'markdown' },
    });
    const b = message({
      id: 'chm:b' as ChannelMessageId,
      seq: 2,
      status: 'streaming',
      body: { text: '', format: 'markdown' },
    });
    let state = reduce(initialChannelReducerState(CHANNEL), [
      created(a),
      created(b),
      delta('chm:a', 0, 'a0'),
      delta('chm:a', 2, 'a-skip'), // out of order → quarantine A only
      delta('chm:a', 1, 'a-dropped'), // dropped while quarantined
      delta('chm:b', 0, 'b0'), // B unaffected
    ]);
    expect(state.quarantined['chm:a']).toBe(true);
    expect(state.byId['chm:a']?.body.text).toBe('a0'); // frozen after quarantine
    expect(state.byId['chm:b']?.body.text).toBe('b0');
    // completed heals A with the authoritative full body and clears quarantine
    state = applyChannelEventV1(
      state,
      completed(
        message({
          id: 'chm:a' as ChannelMessageId,
          seq: 1,
          status: 'complete',
          body: { text: 'a-full', format: 'markdown' },
        })
      )
    );
    expect(state.quarantined['chm:a']).toBeUndefined();
    expect(state.byId['chm:a']?.body.text).toBe('a-full');
    expect(state.inFlightDelta['chm:a']).toBeUndefined();
  });

  it('drops a delta for an unknown id by requesting catchup', () => {
    const state = applyChannelEventV1(
      initialChannelReducerState(CHANNEL),
      delta('chm:missing', 0, 'x')
    );
    expect(state.needsCatchup).toBe(true);
  });

  it('full snapshot replaces, catchup merges', () => {
    const full: ChannelEventV1 = {
      type: 'channel-snapshot-v1',
      channelId: CHANNEL,
      timestamp: 't',
      mode: 'full',
      messages: [
        message({ id: 'chm:1' as ChannelMessageId, seq: 1 }),
        message({ id: 'chm:2' as ChannelMessageId, seq: 2 }),
      ],
      members: [],
      latestSeq: 2,
      inFlight: [],
      truncated: true,
    };
    let state = applyChannelEventV1(initialChannelReducerState(CHANNEL), full);
    expect(state.messages).toHaveLength(2);
    expect(state.lastSeq).toBe(2);

    const catchup: ChannelEventV1 = {
      type: 'channel-snapshot-v1',
      channelId: CHANNEL,
      timestamp: 't',
      mode: 'catchup',
      messages: [message({ id: 'chm:3' as ChannelMessageId, seq: 3 })],
      members: [],
      latestSeq: 3,
      inFlight: [],
      truncated: false,
    };
    state = applyChannelEventV1(state, catchup);
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(state.lastSeq).toBe(3);
  });

  it('is deterministic under replay', () => {
    const events: ChannelEventV1[] = [
      created(
        message({
          id: 'chm:1' as ChannelMessageId,
          seq: 1,
          status: 'streaming',
          body: { text: '', format: 'markdown' },
        })
      ),
      delta('chm:1', 0, 'foo'),
      delta('chm:1', 1, 'bar'),
      completed(
        message({
          id: 'chm:1' as ChannelMessageId,
          seq: 1,
          status: 'complete',
          body: { text: 'foobar', format: 'markdown' },
        })
      ),
    ];
    const a = reduce(initialChannelReducerState(CHANNEL), events);
    const b = reduce(initialChannelReducerState(CHANNEL), events);
    expect(a).toEqual(b);
    expect(a.byId['chm:1']?.body.text).toBe('foobar');
  });
});

describe('parseMentions', () => {
  const known = ['claude', 'codex', 'hermes'];

  it('resolves known providers case-insensitively and keeps the raw token', () => {
    expect(parseMentions('hey @Claude look', known)).toEqual([
      { raw: '@Claude', providerId: 'claude' },
    ]);
  });

  it('keeps unknown mentions without a providerId', () => {
    expect(parseMentions('ping @bob', known)).toEqual([{ raw: '@bob' }]);
  });

  it('ignores mentions inside fenced and inline code', () => {
    expect(parseMentions('```\n@claude\n```', known)).toEqual([]);
    expect(parseMentions('run `@codex now`', known)).toEqual([]);
  });

  it('ignores emails and a bare @', () => {
    expect(parseMentions('mail foo@bar.com please', known)).toEqual([]);
    expect(parseMentions('meet @ noon', known)).toEqual([]);
  });

  it('dedupes repeated mentions', () => {
    expect(parseMentions('@claude @claude @Claude', known)).toEqual([
      { raw: '@claude', providerId: 'claude' },
    ]);
  });
});
