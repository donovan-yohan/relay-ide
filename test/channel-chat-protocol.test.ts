import { describe, expect, it } from 'vitest';

import {
  applyChannelEventV1,
  channelAsyncRunMatchesSubscriptionFilter,
  channelMessageMatchesSubscriptionFilter,
  channelSubscriptionFilterValidationError,
  normalizeChannelSubscriptionFilter,
  CHANNEL_DELIVERY_RECEIPT_STATES,
  CHANNEL_SUBSCRIPTION_FILTER_MAX_BYTES,
  CHANNEL_SEARCH_HIGHLIGHT_CLOSE,
  CHANNEL_SEARCH_HIGHLIGHT_OPEN,
  isChannelDeliveryReceipt,
  parseChannelSearchSnippet,
  initialChannelReducerState,
  isChannelEventV1,
  parseMentions,
  type ChannelDeliveryReceiptV1,
  type ChannelEventV1,
  type ChannelAsyncRun,
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
function updated(m: ChannelMessage): ChannelEventV1 {
  return {
    type: 'channel-message-updated-v1',
    channelId: CHANNEL,
    timestamp: 't',
    message: m,
  };
}

function edited(m: ChannelMessage): ChannelEventV1 {
  return {
    type: 'channel-message-edited-v1',
    channelId: CHANNEL,
    timestamp: 't',
    message: m,
  };
}

function deleted(m: ChannelMessage): ChannelEventV1 {
  return {
    type: 'channel-message-deleted-v1',
    channelId: CHANNEL,
    timestamp: 't',
    message: m,
  };
}

/** A row in the shape the delete route produces: body wiped, `deletedAt` set. */
function tombstone(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return message({
    body: { text: '', format: 'markdown' },
    meta: { deletedAt: '2026-08-03T02:00:00.000Z' },
    ...overrides,
  });
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
    expect(
      isChannelEventV1({
        ...snapshot,
        mode: 'catchup',
        stateReplacements: [{ message: message() }],
      })
    ).toBe(true);
    expect(
      isChannelEventV1({
        ...snapshot,
        stateReplacements: [{ message: message() }],
      })
    ).toBe(false);
    expect(
      isChannelEventV1({
        ...snapshot,
        mode: 'catchup',
        stateReplacements: [
          {
            message: message({ status: 'complete' }),
            inFlight: { messageId: 'chm:1', deltaIndex: 0 },
          },
        ],
      })
    ).toBe(false);
    expect(
      isChannelEventV1({
        type: 'channel-run-lifecycle-v1',
        channelId: CHANNEL,
        timestamp: 't',
        run: {
          id: 'chrun:queued',
          channelId: CHANNEL,
          threadId: null,
          requestMessageId: 'chm:request',
          requesterId: 'human:operator',
          state: 'submitted',
          targets: [
            {
              targetId: 'agent-profile:mock:default',
              state: 'queued',
              updatedAt: 't',
            },
          ],
          createdAt: 't',
          updatedAt: 't',
        },
      })
    ).toBe(true);
    expect(isChannelEventV1(created(message()))).toBe(true);
    expect(isChannelEventV1(delta('chm:1', 0, 'x'))).toBe(true);
    expect(isChannelEventV1(updated(message({ status: 'streaming' })))).toBe(
      true
    );
    expect(isChannelEventV1(updated(message({ status: 'complete' })))).toBe(
      false
    );
    expect(isChannelEventV1(completed(message()))).toBe(true);
    expect(
      isChannelEventV1(
        completed(
          message({
            status: 'truncated',
            meta: { truncationReason: 'missing-terminal' },
          })
        )
      )
    ).toBe(true);
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
      isChannelEventV1({
        type: 'channel-run-lifecycle-v1',
        channelId: CHANNEL,
        timestamp: 't',
        run: {
          id: 'chrun:bad-target-state',
          channelId: CHANNEL,
          threadId: null,
          requestMessageId: 'chm:request',
          requesterId: 'human:operator',
          state: 'submitted',
          targets: [
            {
              targetId: 'agent-profile:mock:default',
              state: 'not-a-run-state',
              updatedAt: 't',
            },
          ],
          createdAt: 't',
          updatedAt: 't',
        },
      })
    ).toBe(false);
    expect(
      isChannelEventV1(created({ ...message(), body: { text: 1 } as never }))
    ).toBe(false);
  });

  it('validates image attachment parts without permitting SVG or forged dimensions', () => {
    const valid = message({
      body: { text: '', format: 'markdown' },
      parts: [
        {
          type: 'image',
          id: 'cha:abc123',
          mime: 'image/png',
          w: 320,
          h: 180,
          bytes: 1024,
          alt: 'diagram',
        },
      ],
    });
    expect(isChannelEventV1(created(valid))).toBe(true);
    expect(
      isChannelEventV1(
        created({
          ...valid,
          parts: [{ ...valid.parts![0]!, alt: 'a'.repeat(500) }],
        })
      )
    ).toBe(true);
    expect(
      isChannelEventV1(
        created({
          ...valid,
          parts: [{ ...valid.parts![0]!, alt: 'a'.repeat(501) }],
        })
      )
    ).toBe(false);
    expect(
      isChannelEventV1(
        created({
          ...valid,
          parts: [{ ...valid.parts![0]!, mime: 'image/svg+xml' } as never],
        })
      )
    ).toBe(false);
    expect(
      isChannelEventV1(
        created({
          ...valid,
          parts: [{ ...valid.parts![0]!, w: 0 }],
        })
      )
    ).toBe(false);
    expect(
      isChannelEventV1(
        created({
          ...valid,
          parts: [{ ...valid.parts![0]!, id: 'attachment:abc' } as never],
        })
      )
    ).toBe(false);
  });

  it('validates the typed durable agent-detail contract', () => {
    const valid = message({
      sender: { kind: 'agent', id: 'agent:codex', providerId: 'codex' },
      body: { text: '', format: 'markdown' },
      agentDetail: {
        itemId: 'reason-1',
        card: {
          kind: 'thought',
          title: 'inspect the channel',
          status: 'completed',
          content: 'reasoning content',
          sizeBytes: 17,
        },
      },
    });
    expect(isChannelEventV1(created(valid))).toBe(true);
    expect(
      isChannelEventV1(
        created({
          ...valid,
          agentDetail: {
            ...valid.agentDetail!,
            card: { ...valid.agentDetail!.card, kind: 'provider-secret' },
          } as never,
        })
      )
    ).toBe(false);
    expect(
      isChannelEventV1(
        created({
          ...valid,
          agentDetail: {
            ...valid.agentDetail!,
            card: { ...valid.agentDetail!.card, additions: -1 },
          },
        })
      )
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

  it('replaces an authoritative streaming row by id and rejects seq drift', () => {
    const initial = message({
      status: 'streaming',
      sender: { kind: 'agent', id: 'agent:codex', providerId: 'codex' },
      body: { text: '', format: 'markdown' },
      agentDetail: {
        itemId: 'reason-1',
        card: { kind: 'thought', title: 'thinking', status: 'running' },
      },
    });
    let state = reduce(initialChannelReducerState(CHANNEL), [created(initial)]);
    state = applyChannelEventV1(
      state,
      updated({
        ...initial,
        updatedAt: 'later',
        agentDetail: {
          itemId: 'reason-1',
          card: {
            kind: 'thought',
            title: 'thinking',
            status: 'running',
            content: 'sanitized Codex reasoning delta',
          },
        },
      })
    );
    expect(state.byId[initial.id]?.agentDetail?.card.content).toBe(
      'sanitized Codex reasoning delta'
    );
    const drifted = applyChannelEventV1(
      state,
      updated({ ...initial, seq: 99 })
    );
    expect(drifted.needsCatchup).toBe(true);
    expect(drifted.byId[initial.id]?.seq).toBe(1);
  });

  it('ignores a late streaming update after the row failed', () => {
    const streaming = message({
      status: 'streaming',
      sender: { kind: 'agent', id: 'agent:codex', providerId: 'codex' },
      body: { text: '', format: 'markdown' },
      agentDetail: {
        itemId: 'reason-1',
        card: { kind: 'thought', title: 'thinking', status: 'running' },
      },
    });
    const failed = {
      ...streaming,
      status: 'failed' as const,
      agentDetail: {
        itemId: 'reason-1',
        card: {
          kind: 'thought' as const,
          title: 'thinking',
          status: 'failed' as const,
          content: 'provider failed',
        },
      },
    };
    const lateStreaming = {
      ...streaming,
      updatedAt: 'late',
      agentDetail: {
        itemId: 'reason-1',
        card: {
          kind: 'thought' as const,
          title: 'thinking',
          status: 'running' as const,
          content: 'late stale content',
        },
      },
    };
    const state = reduce(initialChannelReducerState(CHANNEL), [
      created(streaming),
      completed(failed),
      updated(lateStreaming),
    ]);
    expect(state.byId[streaming.id]).toEqual(failed);
    expect(state.needsCatchup).toBe(false);
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

  it('applies catch-up state replacements in place without creating rows or advancing the cursor', () => {
    const streaming = message({
      id: 'chm:streaming' as ChannelMessageId,
      seq: 4,
      status: 'streaming',
      body: { text: 'partial', format: 'markdown' },
    });
    let state = applyChannelEventV1(initialChannelReducerState(CHANNEL), {
      type: 'channel-snapshot-v1',
      channelId: CHANNEL,
      timestamp: 't',
      mode: 'full',
      messages: [streaming],
      members: [],
      latestSeq: 4,
      inFlight: [{ messageId: streaming.id, deltaIndex: 2 }],
      truncated: false,
    });

    const completed = message({
      id: streaming.id,
      seq: 4,
      status: 'complete',
      body: { text: 'complete answer', format: 'markdown' },
    });
    state = applyChannelEventV1(state, {
      type: 'channel-snapshot-v1',
      channelId: CHANNEL,
      timestamp: 't',
      mode: 'catchup',
      messages: [],
      stateReplacements: [
        { message: completed },
        {
          message: message({
            id: 'chm:unknown-replacement' as ChannelMessageId,
            seq: 2,
          }),
        },
      ],
      members: [],
      latestSeq: 4,
      inFlight: [],
      truncated: false,
    });

    expect(state.messages).toHaveLength(1);
    expect(state.byId[streaming.id]).toEqual(completed);
    expect(state.lastSeq).toBe(4);
    expect(state.inFlightDelta[streaming.id]).toBeUndefined();
    expect(state.needsCatchup).toBe(false);
  });

  it('preserves omitted run projections but clears an explicit empty projection', () => {
    const run: ChannelAsyncRun = {
      id: 'chrun:retained',
      channelId: CHANNEL,
      threadId: null,
      requestMessageId: 'chm:request',
      requesterId: 'human:operator',
      state: 'submitted' as const,
      targets: [],
      createdAt: 't',
      updatedAt: 't',
    };
    let state = applyChannelEventV1(initialChannelReducerState(CHANNEL), {
      type: 'channel-run-lifecycle-v1',
      channelId: CHANNEL,
      timestamp: 't',
      run,
    });
    state = applyChannelEventV1(state, {
      type: 'channel-snapshot-v1',
      channelId: CHANNEL,
      timestamp: 't',
      mode: 'full',
      messages: [],
      members: [],
      latestSeq: 0,
      inFlight: [],
      truncated: false,
    });
    expect(state.runs[run.id]).toEqual(run);
    state = applyChannelEventV1(state, {
      type: 'channel-snapshot-v1',
      channelId: CHANNEL,
      timestamp: 't',
      mode: 'full',
      messages: [],
      runs: [],
      members: [],
      latestSeq: 0,
      inFlight: [],
      truncated: false,
    });
    expect(state.runs).toEqual({});
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

// #1308 slice 1 item 3 — operator message edits. The wire variant is separate
// from `channel-message-updated-v1` (a streaming-only refresh), so both the
// validator and the reducer need their own coverage.
describe('channel-message-edited-v1', () => {
  const EDITED_META = { editedAt: '2026-08-03T01:00:00.000Z' };

  it('accepts an edited human row and rejects rows no one may edit', () => {
    expect(isChannelEventV1(edited(message({ meta: EDITED_META })))).toBe(true);
    // Agent rows are a durable record of what a provider said.
    expect(
      isChannelEventV1(
        edited(
          message({
            sender: { kind: 'agent', id: 'agent-profile:mock:default' },
          })
        )
      )
    ).toBe(false);
    // System rows are the hub's own bookkeeping.
    expect(isChannelEventV1(edited(message({ kind: 'system' })))).toBe(false);
    // A live stream is not an editable row.
    expect(isChannelEventV1(edited(message({ status: 'streaming' })))).toBe(
      false
    );
  });

  it('replaces the body in place, preserving id and seq', () => {
    const state = reduce(initialChannelReducerState(CHANNEL), [
      created(message({ id: 'chm:1' as ChannelMessageId, seq: 1 })),
      created(message({ id: 'chm:2' as ChannelMessageId, seq: 2 })),
      edited(
        message({
          id: 'chm:1' as ChannelMessageId,
          seq: 1,
          body: { text: 'corrected', format: 'markdown' },
          meta: EDITED_META,
        })
      ),
    ]);
    expect(state.messages.map((m) => m.id)).toEqual(['chm:1', 'chm:2']);
    expect(state.byId['chm:1']?.body.text).toBe('corrected');
    expect(state.byId['chm:1']?.seq).toBe(1);
    expect(state.byId['chm:1']?.meta).toEqual(EDITED_META);
    expect(state.lastSeq).toBe(2);
    expect(state.needsCatchup).toBe(false);
  });

  it('ignores an edit for a row outside the loaded window WITHOUT a catch-up', () => {
    // An edit adds no seq and closes no gap, so an unknown id means "not loaded
    // here", not "the timeline is broken". Demanding a resync would show the
    // out-of-sync banner for a perfectly healthy client.
    const state = reduce(initialChannelReducerState(CHANNEL), [
      created(message({ id: 'chm:1' as ChannelMessageId, seq: 1 })),
      created(message({ id: 'chm:2' as ChannelMessageId, seq: 2 })),
    ]);
    expect(state.needsCatchup).toBe(false);
    const after = applyChannelEventV1(
      state,
      edited(
        message({
          id: 'chm:older' as ChannelMessageId,
          seq: 0,
          body: { text: 'corrected', format: 'markdown' },
        })
      )
    );
    expect(after.needsCatchup).toBe(false);
    expect(after.messages.map((m) => m.id)).toEqual(['chm:1', 'chm:2']);
  });

  it('never overwrites a live stream and catches up on a seq surprise', () => {
    const streamingRow = message({
      id: 'chm:1' as ChannelMessageId,
      seq: 1,
      status: 'streaming',
      body: { text: 'partial', format: 'markdown' },
    });
    const streaming = reduce(initialChannelReducerState(CHANNEL), [
      created(streamingRow),
    ]);
    const clobbered = applyChannelEventV1(
      streaming,
      edited(
        message({
          id: 'chm:1' as ChannelMessageId,
          seq: 1,
          body: { text: 'rewritten', format: 'markdown' },
        })
      )
    );
    expect(clobbered.byId['chm:1']?.body.text).toBe('partial');

    const settled = reduce(initialChannelReducerState(CHANNEL), [
      created(message({ id: 'chm:1' as ChannelMessageId, seq: 1 })),
    ]);
    const renumbered = applyChannelEventV1(
      settled,
      edited(
        message({
          id: 'chm:1' as ChannelMessageId,
          seq: 9,
          body: { text: 'rewritten', format: 'markdown' },
        })
      )
    );
    expect(renumbered.needsCatchup).toBe(true);
    expect(renumbered.byId['chm:1']?.body.text).toBe('hi');
  });
});

// #1308 slice 1 item 4 — operator message deletion. A tombstone replaces the
// row IN PLACE; nothing may ever splice a row out of the seq log.
describe('channel-message-deleted-v1', () => {
  it('accepts a wiped operator row and rejects anything still carrying a body', () => {
    expect(isChannelEventV1(deleted(tombstone()))).toBe(true);
    // A "deletion" still holding text would leak the very thing the operator
    // asked to erase, so it is dropped at the wire.
    expect(
      isChannelEventV1(
        deleted(tombstone({ body: { text: 'still here', format: 'markdown' } }))
      )
    ).toBe(false);
    // Unmarked rows are not tombstones.
    expect(
      isChannelEventV1(deleted(message({ body: { text: '', format: 'text' } })))
    ).toBe(false);
    // Agent rows are a durable record of what a provider said; system rows are
    // the hub's own bookkeeping.
    expect(
      isChannelEventV1(
        deleted(
          tombstone({ sender: { kind: 'agent', id: 'agent-profile:mock:x' } })
        )
      )
    ).toBe(false);
    expect(isChannelEventV1(deleted(tombstone({ kind: 'system' })))).toBe(
      false
    );
  });

  it('rejects a tombstone arriving on the edit lane', () => {
    // `channelMessageEditable` excludes a deleted row, so a delete cannot be
    // laundered through the edit event to bypass the tombstone shape check.
    expect(isChannelEventV1(edited(tombstone()))).toBe(false);
  });

  it('replaces the row in place, keeping the array length, order and seq', () => {
    const state = reduce(initialChannelReducerState(CHANNEL), [
      created(message({ id: 'chm:1' as ChannelMessageId, seq: 1 })),
      created(message({ id: 'chm:2' as ChannelMessageId, seq: 2 })),
      created(message({ id: 'chm:3' as ChannelMessageId, seq: 3 })),
      deleted(tombstone({ id: 'chm:2' as ChannelMessageId, seq: 2 })),
    ]);
    // Grouping, the unread divider and every scroll anchor read positions out of
    // this array — a splice would move all of them.
    expect(state.messages.map((m) => m.id)).toEqual([
      'chm:1',
      'chm:2',
      'chm:3',
    ]);
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(state.byId['chm:2']?.body.text).toBe('');
    expect(state.byId['chm:2']?.meta?.['deletedAt']).toBe(
      '2026-08-03T02:00:00.000Z'
    );
    expect(state.lastSeq).toBe(3);
    expect(state.needsCatchup).toBe(false);
  });

  it('keeps a deleted thread parent as the anchor its replies point at', () => {
    const root = message({ id: 'chm:root' as ChannelMessageId, seq: 1 });
    const reply = message({
      id: 'chm:reply' as ChannelMessageId,
      seq: 2,
      threadId: 'chm:root' as ChannelMessageId,
      parentMessageId: 'chm:root' as ChannelMessageId,
    });
    const state = reduce(initialChannelReducerState(CHANNEL), [
      created(root),
      created(reply),
      deleted(tombstone({ id: 'chm:root' as ChannelMessageId, seq: 1 })),
    ]);
    expect(state.byId['chm:root']).toBeDefined();
    expect(state.byId['chm:reply']?.threadId).toBe('chm:root');
  });

  it('ignores a row outside the loaded window WITHOUT a catch-up, and guards streams and seq surprises', () => {
    const state = reduce(initialChannelReducerState(CHANNEL), [
      created(message({ id: 'chm:1' as ChannelMessageId, seq: 1 })),
    ]);
    // A deletion adds no seq and closes no gap: an unknown id means "not loaded
    // here", so demanding a resync would raise the banner on a healthy client.
    const unknown = applyChannelEventV1(
      state,
      deleted(tombstone({ id: 'chm:older' as ChannelMessageId, seq: 0 }))
    );
    expect(unknown.needsCatchup).toBe(false);
    expect(unknown.messages.map((m) => m.id)).toEqual(['chm:1']);

    const streaming = reduce(initialChannelReducerState(CHANNEL), [
      created(
        message({
          id: 'chm:1' as ChannelMessageId,
          seq: 1,
          status: 'streaming',
          body: { text: 'partial', format: 'markdown' },
        })
      ),
    ]);
    expect(
      applyChannelEventV1(
        streaming,
        deleted(tombstone({ id: 'chm:1' as ChannelMessageId, seq: 1 }))
      ).byId['chm:1']?.body.text
    ).toBe('partial');

    const renumbered = applyChannelEventV1(
      state,
      deleted(tombstone({ id: 'chm:1' as ChannelMessageId, seq: 9 }))
    );
    expect(renumbered.needsCatchup).toBe(true);
    expect(renumbered.byId['chm:1']?.body.text).toBe('hi');
  });
});

describe('channel-delivery-receipt-v1 (#1442)', () => {
  /**
   * Deliberately permissive overrides: this suite feeds the validator
   * malformed receipts on purpose, so a value can be any shape at all.
   */
  type ReceiptOverrides = {
    [K in keyof ChannelDeliveryReceiptV1]?: unknown;
  } & { [key: string]: unknown };

  function receipt(overrides: ReceiptOverrides = {}): ChannelDeliveryReceiptV1 {
    return {
      messageId: 'chm:1',
      channelId: CHANNEL,
      targetBindingId: `${CHANNEL}\u0000\u0000agent-profile:mock:default`,
      senderProfileId: 'human:operator',
      targetProfileId: 'agent-profile:mock:default',
      state: 'queued',
      ts: '2026-08-25T00:00:00.000Z',
      ...overrides,
    } as ChannelDeliveryReceiptV1;
  }

  function receiptEvent(overrides: ReceiptOverrides = {}): ChannelEventV1 {
    return {
      type: 'channel-delivery-receipt-v1',
      channelId: CHANNEL,
      timestamp: 't',
      receipt: receipt(overrides),
    };
  }

  it('covers every outcome class in the issue table', () => {
    expect([...CHANNEL_DELIVERY_RECEIPT_STATES].sort()).toEqual(
      [
        'queued',
        'delivered_to_runtime',
        'turn_started',
        'completed',
        'held_busy',
        'dropped_queue_full',
        'refused_policy',
        'unreachable_offline',
        'expired_watchdog',
        'failed_runtime',
        'superseded',
      ].sort()
    );
  });

  it('accepts a well-formed receipt event and rejects malformed ones', () => {
    for (const state of CHANNEL_DELIVERY_RECEIPT_STATES) {
      expect(isChannelEventV1(receiptEvent({ state }))).toBe(true);
    }
    expect(isChannelEventV1(receiptEvent())).toBe(true);
    expect(isChannelEventV1(receiptEvent({ senderProfileId: null }))).toBe(
      true
    );
    expect(isChannelEventV1(receiptEvent({ reasonCode: 'queue_cap' }))).toBe(
      true
    );

    expect(isChannelEventV1(null)).toBe(false);
    expect(isChannelEventV1({ type: 'channel-delivery-receipt-v1' })).toBe(
      false
    );
    expect(isChannelEventV1(receiptEvent({ state: 'sorta-fine' }))).toBe(false);
    expect(isChannelEventV1(receiptEvent({ ts: '' }))).toBe(false);
    expect(isChannelEventV1(receiptEvent({ reasonCode: 'made_up' }))).toBe(
      false
    );
  });

  it('is structurally content-free: no body/text field can reach the payload', () => {
    // The validator must reject any key outside the identity/outcome allowlist,
    // at any nesting the payload could carry. These are the leak shapes a
    // careless producer would reach for — same rule walkie-talkie applies to
    // metrics/events.
    const leaks: Array<Record<string, unknown>> = [
      { text: 'secret message body' },
      { body: { text: 'secret message body' } },
      { messageText: 'secret message body' },
      { content: 'secret message body' },
      { delta: { text: 'partial body' } },
      { attachments: [{ type: 'image', id: 'cha:x' }] },
      { parts: [{ type: 'image' }] },
      { prose: 'free-form prose' },
      { meta: { anything: 'goes' } },
      { preview: 'first 80 chars of the body' },
    ];
    for (const leak of leaks) {
      const candidate = { ...receipt(), ...leak };
      expect(isChannelDeliveryReceipt(candidate)).toBe(false);
      expect(isChannelEventV1(receiptEvent(candidate))).toBe(false);
    }
    // Even a deep smuggle under an allowed key's shadow fails closed.
    expect(
      isChannelDeliveryReceipt({
        ...receipt(),
        ts: undefined,
        extra: { nested: { text: 'leak' } },
      })
    ).toBe(false);
  });

  it('reducer treats receipts as observation-only (no timeline mutation)', () => {
    const before = initialChannelReducerState(CHANNEL);
    const withCreated = applyChannelEventV1(before, created(message()));
    const after = applyChannelEventV1(withCreated, receiptEvent());
    expect(after).toEqual(withCreated);
    expect(after.lastSeq).toBe(1);
    expect(Object.keys(after.byId)).toEqual(['chm:1']);
  });
});

describe('ChannelSubscriptionFilter', () => {
  const run = (overrides: Partial<ChannelAsyncRun> = {}): ChannelAsyncRun => ({
    id: 'chrun:review' as ChannelAsyncRun['id'],
    channelId: CHANNEL,
    threadId: null,
    requestMessageId: 'chm:request' as ChannelMessageId,
    requesterId: 'human:operator',
    state: 'completed',
    targets: [],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  });

  it('validates the bounded canonical filter and rejects malformed metadata', () => {
    expect(
      channelSubscriptionFilterValidationError({
        threadId: 'chm:root',
        messageId: 'chm:reply',
        senderId: 'agent-profile:codex:default',
        mentionTargetId: 'codex',
        status: 'complete',
        runId: 'chrun:review',
        terminalOnly: true,
        principalOnly: false,
      })
    ).toBeUndefined();
    for (const filter of [
      { threadId: 'rooted' },
      { messageId: 'message:wrong-prefix' },
      { threadId: 'chm:   ' },
      { messageId: 'chm:\t' },
      { runId: 'run:wrong-prefix' },
      { runId: 'chrun: \n' },
      { status: 'unknown' },
      { terminalOnly: 'true' },
      { extra: true },
      { senderId: 'x'.repeat(513) },
    ]) {
      expect(channelSubscriptionFilterValidationError(filter)).toBeDefined();
    }
    expect(
      channelSubscriptionFilterValidationError({
        threadId: 'chm:root id',
        messageId: 'chm:message id',
        runId: 'chrun:run id',
      })
    ).toBeUndefined();
    // The aggregate runtime ceiling deliberately includes maximum-length
    // CJK/emoji values and their URL/JSON expansion, so schema-valid input
    // cannot be rejected later at the decoded boundary.
    expect(
      channelSubscriptionFilterValidationError({
        threadId: `chm:${'界'.repeat(508)}`,
        messageId: `chm:${'語'.repeat(508)}`,
        senderId: '漢'.repeat(512),
        mentionTargetId: '🧪'.repeat(256),
        runId: `chrun:${'字'.repeat(506)}`,
        terminalOnly: true,
        principalOnly: true,
      })
    ).toBeUndefined();
    expect(
      channelSubscriptionFilterValidationError({
        senderId: 'x'.repeat(CHANNEL_SUBSCRIPTION_FILTER_MAX_BYTES),
      })
    ).toContain('exceeds');
    expect(
      normalizeChannelSubscriptionFilter({
        terminalOnly: false,
        principalOnly: false,
      })
    ).toEqual({});
  });

  it('ANDs message predicates and keeps principal semantics provider-neutral', () => {
    const principal = message({
      id: 'chm:reply' as ChannelMessageId,
      threadId: 'chm:root' as ChannelMessageId,
      sender: { kind: 'agent', id: 'agent-profile:codex:default' },
      mentions: [{ raw: '@Codex', providerId: 'codex' }],
      asyncRun: {
        runId: 'chrun:review' as ChannelAsyncRun['id'],
        targetId: 'agent-profile:codex:default',
      },
    });
    const filter = {
      threadId: 'chm:root' as ChannelMessageId,
      messageId: 'chm:reply' as ChannelMessageId,
      senderId: 'agent-profile:codex:default',
      mentionTargetId: 'codex',
      status: 'complete' as const,
      runId: 'chrun:review' as ChannelAsyncRun['id'],
      terminalOnly: true,
      principalOnly: true,
    };
    expect(channelMessageMatchesSubscriptionFilter(principal, filter)).toBe(
      true
    );
    expect(
      channelMessageMatchesSubscriptionFilter(
        message({
          ...principal,
          agentDetail: { itemId: 'detail', card: {} } as never,
        }),
        filter
      )
    ).toBe(false);
    expect(
      channelMessageMatchesSubscriptionFilter(
        message({ ...principal, status: 'streaming' }),
        filter
      )
    ).toBe(false);
  });

  it('treats root consistently and fail-closes lifecycle projections for message filters', () => {
    const root = message({ id: 'chm:root' as ChannelMessageId });
    const reply = message({
      id: 'chm:reply' as ChannelMessageId,
      threadId: root.id,
    });
    const sibling = message({
      id: root.id,
      threadId: 'chm:other-root' as ChannelMessageId,
    });
    expect(
      channelMessageMatchesSubscriptionFilter(root, { threadId: 'root' })
    ).toBe(true);
    expect(
      channelMessageMatchesSubscriptionFilter(root, {
        threadId: 'chm:root' as ChannelMessageId,
      })
    ).toBe(true);
    expect(
      channelMessageMatchesSubscriptionFilter(reply, { threadId: root.id })
    ).toBe(true);
    expect(
      channelMessageMatchesSubscriptionFilter(sibling, { threadId: root.id })
    ).toBe(false);
    expect(
      channelAsyncRunMatchesSubscriptionFilter(
        run({ requestMessageId: root.id }),
        { threadId: root.id }
      )
    ).toBe(true);
    expect(
      channelAsyncRunMatchesSubscriptionFilter(
        run({
          threadId: root.id,
          requestMessageId: 'chm:other-request' as ChannelMessageId,
        }),
        { threadId: root.id }
      )
    ).toBe(true);
    expect(
      channelAsyncRunMatchesSubscriptionFilter(
        run({
          threadId: 'chm:other-root' as ChannelMessageId,
          requestMessageId: root.id,
        }),
        { threadId: root.id }
      )
    ).toBe(false);
    expect(
      channelAsyncRunMatchesSubscriptionFilter(
        run({ requestMessageId: root.id }),
        { threadId: 'root' }
      )
    ).toBe(true);
    expect(
      channelAsyncRunMatchesSubscriptionFilter(run(), { terminalOnly: true })
    ).toBe(true);
    expect(
      channelAsyncRunMatchesSubscriptionFilter(run(), { principalOnly: false })
    ).toBe(true);
  });

  it('only projects actual principal prose for created, completed, and deleted rows', () => {
    const filter = { principalOnly: true };
    expect(
      channelMessageMatchesSubscriptionFilter(
        message({ status: 'streaming' }),
        filter
      )
    ).toBe(true);
    expect(
      channelMessageMatchesSubscriptionFilter(
        message({ status: 'complete' }),
        filter
      )
    ).toBe(true);
    expect(
      channelMessageMatchesSubscriptionFilter(
        message({
          body: { text: '', format: 'markdown' },
          meta: { deletedAt: '2026-08-12T00:00:00.000Z' },
        }),
        filter
      )
    ).toBe(false);
    expect(
      channelMessageMatchesSubscriptionFilter(
        message({ body: { text: '   ', format: 'markdown' } }),
        filter
      )
    ).toBe(false);
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

describe('search snippet segmentation (#1308 slice 2 item 1)', () => {
  const open = CHANNEL_SEARCH_HIGHLIGHT_OPEN;
  const close = CHANNEL_SEARCH_HIGHLIGHT_CLOSE;

  it('splits a snippet into plain and highlighted runs', () => {
    expect(
      parseChannelSearchSnippet(`…ship the ${open}relay${close} hub today`)
    ).toEqual([
      { text: '…ship the ', highlight: false },
      { text: 'relay', highlight: true },
      { text: ' hub today', highlight: false },
    ]);
  });

  it('carries markup-looking body text through as PLAIN text', () => {
    // The delimiters are Private Use Area code points precisely so a body that
    // itself contains markup is never mistaken for our own highlight marker.
    expect(parseChannelSearchSnippet(`<b>${open}bold${close}</b>`)).toEqual([
      { text: '<b>', highlight: false },
      { text: 'bold', highlight: true },
      { text: '</b>', highlight: false },
    ]);
  });

  it('degrades to one plain run when no marker pair is present', () => {
    expect(parseChannelSearchSnippet('no markers here')).toEqual([
      { text: 'no markers here', highlight: false },
    ]);
    // An unbalanced marker must not silently swallow the tail.
    expect(parseChannelSearchSnippet(`trailing ${open}open`)).toEqual([
      { text: `trailing ${open}open`, highlight: false },
    ]);
  });

  it('returns nothing for an empty snippet', () => {
    expect(parseChannelSearchSnippet('')).toEqual([]);
  });
});
