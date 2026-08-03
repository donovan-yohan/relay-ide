// #1308 slice 5 item 1 — notify-signal derivation + gating.
//
// Everything here is pure: no Notification API, no DOM, no stores. The gate's
// clock and visibility are injected through `NotifyGateContext`, so the
// rate-limit cases are deterministic rather than timer-driven.
import { describe, it, expect } from 'vitest';
import {
  createNotifyGate,
  deriveMessageSignal,
  deriveTurnCompleteSignal,
  notifyChannelFromNavItem,
  notifyChannelFromTopic,
  notifyRowFromMessage,
  NOTIFY_OS_BURST_LIMIT,
  NOTIFY_OS_BURST_WINDOW_MS,
  NOTIFY_OS_RATE_LIMIT_MS,
  type NotifyChannel,
  type NotifyGateContext,
  type NotifyMessageRow,
  type NotifySignal,
} from '../../frontend/src/lib/notify/signals.js';
import { DEFAULT_NOTIFY_SETTINGS } from '../../frontend/src/lib/stores/notify-settings.js';
import { dmChannelTopicId } from '../../shared/dm-channels.js';
import type { ChannelMessage } from '../../shared/channel-chat-protocol.js';
import type { WorkspaceTopic } from '../../shared/workspace-topics.js';

const OPERATOR_ID = 'human:operator';
const CLAUDE_PROFILE = 'agent-profile:claude:default';
const NOW = 1_800_000_000_000;

const channel: NotifyChannel = {
  id: 'topic:impl-1308',
  title: 'impl 1308',
  isDm: false,
};
const dmChannel: NotifyChannel = {
  id: dmChannelTopicId('claude', null),
  title: 'claude',
  isDm: true,
};

function agentRow(overrides: Partial<NotifyMessageRow> = {}): NotifyMessageRow {
  return {
    seq: 10,
    senderId: CLAUDE_PROFILE,
    senderKind: 'agent',
    senderDisplayName: 'claude',
    providerId: 'claude',
    preview: 'pushed the branch',
    ...overrides,
  };
}

function gateContext(
  overrides: Partial<NotifyGateContext> = {}
): NotifyGateContext {
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS },
    activeChannelId: null,
    documentHidden: true,
    windowFocused: false,
    now: NOW,
    ...overrides,
  };
}

function messageSignal(overrides: Partial<NotifySignal> = {}): NotifySignal {
  return {
    reason: 'mention',
    channel,
    seq: 10,
    senderLabel: 'claude',
    at: NOW,
    ...overrides,
  };
}

describe('deriveMessageSignal — MENTION', () => {
  it('raises a mention from server-resolved mention refs', () => {
    const signal = deriveMessageSignal(
      agentRow({ mentions: [{ raw: '@operator' }] }),
      channel,
      NOW
    );
    expect(signal).toMatchObject({
      reason: 'mention',
      seq: 10,
      senderLabel: 'claude',
    });
    expect(signal?.channel.id).toBe(channel.id);
  });

  it('matches the mention token case-insensitively', () => {
    const signal = deriveMessageSignal(
      agentRow({ mentions: [{ raw: '@Operator' }] }),
      channel,
      NOW
    );
    expect(signal?.reason).toBe('mention');
  });

  it('falls back to parsing the preview when the payload carries no refs', () => {
    const signal = deriveMessageSignal(
      agentRow({ preview: 'blocked on the migration @operator' }),
      channel,
      NOW
    );
    expect(signal?.reason).toBe('mention');
  });

  it('does not fire for an @operator inside a code span', () => {
    // Proves the SHARED tokenizer is doing the work — a lane-local regex would
    // notify on a transcript that merely quotes the token.
    const signal = deriveMessageSignal(
      agentRow({ preview: 'the docs say `@operator` is the mention target' }),
      channel,
      NOW
    );
    expect(signal).toBeNull();
  });

  it('never notifies on the operator own echoed post', () => {
    const signal = deriveMessageSignal(
      agentRow({
        senderId: OPERATOR_ID,
        senderKind: 'human',
        mentions: [{ raw: '@operator' }],
      }),
      channel,
      NOW
    );
    expect(signal).toBeNull();
  });

  it('ignores system rows', () => {
    const signal = deriveMessageSignal(
      agentRow({
        senderId: 'system',
        senderKind: 'system',
        mentions: [{ raw: '@operator' }],
      }),
      channel,
      NOW
    );
    expect(signal).toBeNull();
  });
});

describe('deriveMessageSignal — DM REPLY', () => {
  it('raises a dm-reply for an agent message in a DM channel', () => {
    const signal = deriveMessageSignal(agentRow(), dmChannel, NOW);
    expect(signal).toMatchObject({ reason: 'dm-reply', senderLabel: 'claude' });
  });

  it('does not raise a dm-reply in a regular channel', () => {
    expect(deriveMessageSignal(agentRow(), channel, NOW)).toBeNull();
  });

  it('does not raise a dm-reply for a human row', () => {
    const signal = deriveMessageSignal(
      agentRow({ senderId: 'human:pair', senderKind: 'human' }),
      dmChannel,
      NOW
    );
    expect(signal).toBeNull();
  });

  it('prefers MENTION over DM REPLY so one row is one event', () => {
    const signal = deriveMessageSignal(
      agentRow({ mentions: [{ raw: '@operator' }] }),
      dmChannel,
      NOW
    );
    expect(signal?.reason).toBe('mention');
  });
});

describe('deriveTurnCompleteSignal', () => {
  it.each(['thinking', 'streaming', 'waiting'] as const)(
    'raises turn-complete on %s -> idle',
    (previous) => {
      const signal = deriveTurnCompleteSignal({
        channel,
        agentLabel: 'claude',
        previous,
        next: 'idle',
        at: NOW,
      });
      expect(signal).toMatchObject({ reason: 'turn-complete', seq: 0 });
    }
  );

  it('does not treat a failed spawn as a completed turn', () => {
    expect(
      deriveTurnCompleteSignal({
        channel,
        agentLabel: 'claude',
        previous: 'spawning',
        next: 'idle',
        at: NOW,
      })
    ).toBeNull();
  });

  it('needs a known previous status (a first-seen idle is not an edge)', () => {
    expect(
      deriveTurnCompleteSignal({
        channel,
        agentLabel: 'claude',
        previous: undefined,
        next: 'idle',
        at: NOW,
      })
    ).toBeNull();
  });

  it('ignores transitions that do not land on idle', () => {
    expect(
      deriveTurnCompleteSignal({
        channel,
        agentLabel: 'claude',
        previous: 'thinking',
        next: 'streaming',
        at: NOW,
      })
    ).toBeNull();
  });
});

describe('channel + row adapters', () => {
  function topic(
    id: string,
    providerId: string
  ): Parameters<typeof notifyChannelFromTopic>[0] {
    return {
      id: id as WorkspaceTopic['id'],
      display: { title: 'claude' },
      workspaceId: null as unknown as WorkspaceTopic['workspaceId'],
      routingDefaults: { providerId },
    };
  }

  it('derives DM-ness from the deterministic id, not a marker', () => {
    expect(
      notifyChannelFromTopic(topic(dmChannelTopicId('claude', null), 'claude'))
    ).toEqual({ id: dmChannel.id, title: 'claude', isDm: true });
    expect(notifyChannelFromTopic(topic('topic:impl-1308', 'claude'))).toEqual({
      id: 'topic:impl-1308',
      title: 'claude',
      isDm: false,
    });
  });

  it('reuses the rail nav model DM verdict', () => {
    expect(
      notifyChannelFromNavItem({
        id: dmChannel.id as WorkspaceTopic['id'],
        title: 'claude',
        isDirectMessage: true,
      })
    ).toEqual({ id: dmChannel.id, title: 'claude', isDm: true });
  });

  it('flattens a live channel message onto the shared row shape', () => {
    const message = {
      seq: 42,
      sender: {
        kind: 'agent',
        id: CLAUDE_PROFILE,
        displayName: 'claude',
        providerId: 'claude',
      },
      body: { text: 'done @operator', format: 'markdown' },
      mentions: [{ raw: '@operator' }],
    } as unknown as ChannelMessage;
    expect(notifyRowFromMessage(message)).toEqual({
      seq: 42,
      senderId: CLAUDE_PROFILE,
      senderKind: 'agent',
      senderDisplayName: 'claude',
      providerId: 'claude',
      mentions: [{ raw: '@operator' }],
      preview: 'done @operator',
    });
  });
});

describe('gate — visibility tiers', () => {
  it('fires the OS tier only when the tab is hidden', () => {
    const gate = createNotifyGate();
    const hidden = gate.evaluate(messageSignal(), gateContext());
    expect(hidden).toMatchObject({ os: true, badge: true, count: 1 });

    const visible = createNotifyGate().evaluate(
      messageSignal(),
      gateContext({ documentHidden: false, windowFocused: true })
    );
    expect(visible).toMatchObject({ os: false, badge: true });
  });

  it('suppresses entirely for the channel that is open AND focused', () => {
    const gate = createNotifyGate();
    expect(
      gate.evaluate(
        messageSignal(),
        gateContext({
          activeChannelId: channel.id,
          documentHidden: false,
          windowFocused: true,
        })
      )
    ).toBeNull();
  });

  it('still notifies for the open channel when the tab is hidden', () => {
    const gate = createNotifyGate();
    expect(
      gate.evaluate(
        messageSignal(),
        gateContext({ activeChannelId: channel.id, documentHidden: true })
      )
    ).toMatchObject({ os: true });
  });

  it('still badges the open channel when the window is blurred', () => {
    const gate = createNotifyGate();
    expect(
      gate.evaluate(
        messageSignal(),
        gateContext({
          activeChannelId: channel.id,
          documentHidden: false,
          windowFocused: false,
        })
      )
    ).toMatchObject({ os: false, badge: true });
  });
});

describe('gate — per-channel rate limit and coalescing', () => {
  it('fires once per channel per window and reports the coalesced run', () => {
    const gate = createNotifyGate();
    const first = gate.evaluate(
      messageSignal({ seq: 1 }),
      gateContext({ now: NOW })
    );
    expect(first).toMatchObject({ os: true, count: 1 });

    const second = gate.evaluate(
      messageSignal({ seq: 2 }),
      gateContext({ now: NOW + 1_000 })
    );
    const third = gate.evaluate(
      messageSignal({ seq: 3 }),
      gateContext({ now: NOW + 2_000 })
    );
    // Held back from the OS tier, but the operator still gets an in-app mark.
    expect(second).toMatchObject({ os: false, badge: true, count: 1 });
    expect(third).toMatchObject({ os: false, badge: true, count: 1 });

    const fourth = gate.evaluate(
      messageSignal({ seq: 4 }),
      gateContext({ now: NOW + NOTIFY_OS_RATE_LIMIT_MS })
    );
    expect(fourth).toMatchObject({ os: true, count: 3 });
    // The label rides through to delivery, which is where copy is composed
    // (`notify/copy.ts` renders this run as `… · 3 new`).
    expect(fourth?.senderLabel).toBe('claude');
  });

  it('resets the coalesce count after it is flushed', () => {
    const gate = createNotifyGate();
    gate.evaluate(messageSignal({ seq: 1 }), gateContext({ now: NOW }));
    gate.evaluate(messageSignal({ seq: 2 }), gateContext({ now: NOW + 1 }));
    gate.evaluate(
      messageSignal({ seq: 3 }),
      gateContext({ now: NOW + NOTIFY_OS_RATE_LIMIT_MS })
    );
    const next = gate.evaluate(
      messageSignal({ seq: 4 }),
      gateContext({ now: NOW + 2 * NOTIFY_OS_RATE_LIMIT_MS })
    );
    expect(next).toMatchObject({ os: true, count: 1 });
  });

  it('rate-limits per channel, not globally', () => {
    const gate = createNotifyGate();
    const other: NotifyChannel = { ...channel, id: 'topic:other' };
    expect(
      gate.evaluate(messageSignal({ seq: 1 }), gateContext())
    ).toMatchObject({ os: true });
    expect(
      gate.evaluate(
        messageSignal({ seq: 1, channel: other }),
        gateContext({ now: NOW + 10 })
      )
    ).toMatchObject({ os: true, count: 1 });
  });

  it('keys the coalesce tag per channel', () => {
    const gate = createNotifyGate();
    expect(gate.evaluate(messageSignal(), gateContext())?.key).toBe(
      `relay-channel:${channel.id}`
    );
  });

  it('a visible-tab signal does not consume the OS window', () => {
    const gate = createNotifyGate();
    gate.evaluate(
      messageSignal({ seq: 1 }),
      gateContext({ documentHidden: false, windowFocused: true })
    );
    expect(
      gate.evaluate(messageSignal({ seq: 2 }), gateContext({ now: NOW + 5 }))
    ).toMatchObject({ os: true, count: 1 });
  });
});

describe('gate — global burst budget', () => {
  /** One fresh channel per index, so the PER-CHANNEL limiter never fires. */
  function burstSignal(index: number, seq = 1): NotifySignal {
    return messageSignal({
      seq,
      channel: {
        ...channel,
        id: `topic:burst-${index}`,
        title: `burst ${index}`,
      },
    });
  }

  it('caps simultaneous OS notifications across ALL channels', () => {
    // The reconnect shape: one `/channels` payload, fifteen DM rows, fifteen
    // untouched 60s windows. Without a global budget that is fifteen
    // notification-centre entries at once, none replacing another.
    const gate = createNotifyGate();
    const events = Array.from({ length: 8 }, (_, index) =>
      gate.evaluate(burstSignal(index), gateContext({ now: NOW + index }))
    );
    expect(events.filter((event) => event?.os).length).toBe(
      NOTIFY_OS_BURST_LIMIT
    );
    // The in-app tier is untouched: every held-back channel still earns a badge.
    expect(events.every((event) => event?.badge === true)).toBe(true);
  });

  it('reports the held-back run as a growing collapsed count', () => {
    const gate = createNotifyGate();
    for (let index = 0; index < NOTIFY_OS_BURST_LIMIT; index += 1) {
      expect(
        gate.evaluate(burstSignal(index), gateContext({ now: NOW }))
      ).toMatchObject({ os: true, osOverflow: 0 });
    }
    const first = gate.evaluate(burstSignal(90), gateContext({ now: NOW + 1 }));
    const second = gate.evaluate(
      burstSignal(91),
      gateContext({ now: NOW + 2 })
    );
    expect(first).toMatchObject({ os: false, osOverflow: 1 });
    expect(second).toMatchObject({ os: false, osOverflow: 2 });
  });

  it('does not re-alert the digest for a channel already held back', () => {
    const gate = createNotifyGate();
    for (let index = 0; index < NOTIFY_OS_BURST_LIMIT; index += 1) {
      gate.evaluate(burstSignal(index), gateContext({ now: NOW }));
    }
    expect(
      gate.evaluate(burstSignal(90, 1), gateContext({ now: NOW + 1 }))
    ).toMatchObject({ osOverflow: 1 });
    expect(
      gate.evaluate(burstSignal(90, 2), gateContext({ now: NOW + 2 }))
    ).toMatchObject({ os: false, osOverflow: 0 });
  });

  it('does not count a per-channel repeat as burst overflow', () => {
    // That channel already has a live notification the operator can see; adding
    // it to the digest would describe the same thing twice.
    const gate = createNotifyGate();
    for (let index = 0; index < NOTIFY_OS_BURST_LIMIT; index += 1) {
      gate.evaluate(burstSignal(index), gateContext({ now: NOW }));
    }
    expect(
      gate.evaluate(burstSignal(0, 2), gateContext({ now: NOW + 1 }))
    ).toMatchObject({ os: false, osOverflow: 0 });
  });

  it('opens a fresh budget once the window lapses', () => {
    const gate = createNotifyGate();
    for (let index = 0; index < NOTIFY_OS_BURST_LIMIT; index += 1) {
      gate.evaluate(burstSignal(index), gateContext({ now: NOW }));
    }
    expect(
      gate.evaluate(burstSignal(90), gateContext({ now: NOW + 1 }))
    ).toMatchObject({ os: false });
    expect(
      gate.evaluate(
        burstSignal(91),
        gateContext({ now: NOW + NOTIFY_OS_BURST_WINDOW_MS })
      )
    ).toMatchObject({ os: true });
  });
});

describe('gate — refund for an event that was never shown', () => {
  it('lets the next message in that channel fire again', () => {
    // Permission was `default`, the operator dismissed the prompt, and nothing
    // was displayed. Without a refund the burnt 60s slot swallows the next real
    // message as a silent coalesce increment.
    const gate = createNotifyGate();
    const first = gate.evaluate(messageSignal({ seq: 1 }), gateContext());
    expect(first).toMatchObject({ os: true, count: 1 });
    gate.refundOs(first!);
    expect(
      gate.evaluate(messageSignal({ seq: 2 }), gateContext({ now: NOW + 10 }))
    ).toMatchObject({ os: true });
  });

  it('ADDS the undelivered run to the signals that piled up meanwhile', () => {
    // `deliver` is asynchronous on the lazy-permission path — the long one. The
    // operator leaves the prompt up while two more messages land in the same
    // channel and coalesce behind it. Assigning the refund would destroy those
    // two, and the next fire would undercount the run nobody saw.
    const gate = createNotifyGate();
    const first = gate.evaluate(messageSignal({ seq: 1 }), gateContext());
    expect(first).toMatchObject({ os: true, count: 1 });
    gate.evaluate(messageSignal({ seq: 2 }), gateContext({ now: NOW + 1 }));
    gate.evaluate(messageSignal({ seq: 3 }), gateContext({ now: NOW + 2 }));
    // The prompt is finally dismissed; nothing was ever shown.
    gate.refundOs(first!);
    expect(
      gate.evaluate(messageSignal({ seq: 4 }), gateContext({ now: NOW + 3 }))
    ).toMatchObject({ os: true, count: 4 });
  });

  it('refunds only the charge it actually made', () => {
    // A dismissal can land minutes after its event was evaluated. By then a
    // LATER message in the same channel may have fired for real and written a
    // fresh window — clearing that one would let the channel notify twice
    // inside its 60s limit.
    const gate = createNotifyGate();
    const stale = gate.evaluate(messageSignal({ seq: 1 }), gateContext());
    expect(
      gate.evaluate(
        messageSignal({ seq: 2 }),
        gateContext({ now: NOW + NOTIFY_OS_RATE_LIMIT_MS + 1 })
      )
    ).toMatchObject({ os: true });
    gate.refundOs(stale!);
    expect(
      gate.evaluate(
        messageSignal({ seq: 3 }),
        gateContext({ now: NOW + NOTIFY_OS_RATE_LIMIT_MS + 2 })
      )
    ).toMatchObject({ os: false });
  });

  it('gives back its OWN burst slot, not the newest one', () => {
    // Popping the newest grant leaves the REFUNDED event's timestamp in the
    // ledger and drops a live one's. The count is right for the moment, but the
    // window edges are now somebody else's: the stale entry ages out early and
    // frees a slot that a still-live grant should have been holding, so the
    // budget lets a fourth notification through inside one 10s window.
    const gate = createNotifyGate();
    const grant = (id: string, now: number) =>
      gate.evaluate(
        messageSignal({ seq: 1, channel: { ...channel, id } }),
        gateContext({ now })
      );
    const stale = grant('topic:burst-a', NOW);
    expect(stale).toMatchObject({ os: true });
    // Two more grants land near the END of the window, so they outlive the
    // first by nine seconds.
    expect(grant('topic:burst-b', NOW + 9_000)).toMatchObject({ os: true });
    expect(grant('topic:burst-c', NOW + 9_000)).toMatchObject({ os: true });
    // The first was never shown; refunding it reopens exactly one slot.
    gate.refundOs(stale!);
    expect(grant('topic:burst-d', NOW + 9_500)).toMatchObject({ os: true });
    // Three live grants (b, c, d) still sit inside the window here, so the
    // budget is spent. Only a's expired ghost could open a fourth.
    expect(
      grant('topic:burst-e', NOW + NOTIFY_OS_BURST_WINDOW_MS + 1)
    ).toMatchObject({ os: false });
  });

  it('is a no-op for an event that never charged anything', () => {
    // A visible-tab event holds no window and no burst slot, so crediting a
    // coalesce pile for it would inflate the next fire's count.
    const gate = createNotifyGate();
    const visible = gate.evaluate(
      messageSignal({ seq: 1 }),
      gateContext({ documentHidden: false })
    );
    expect(visible).toMatchObject({ os: false });
    gate.refundOs(visible!);
    expect(
      gate.evaluate(messageSignal({ seq: 2 }), gateContext({ now: NOW + 1 }))
    ).toMatchObject({ os: true, count: 1 });
  });

  it('hands the burst slot back too', () => {
    const gate = createNotifyGate();
    const events = Array.from({ length: NOTIFY_OS_BURST_LIMIT }, (_, index) =>
      gate.evaluate(
        messageSignal({
          seq: 1,
          channel: { ...channel, id: `topic:burst-${index}` },
        }),
        gateContext({ now: NOW })
      )
    );
    gate.refundOs(events.at(-1)!);
    expect(
      gate.evaluate(
        messageSignal({ seq: 1, channel: { ...channel, id: 'topic:burst-x' } }),
        gateContext({ now: NOW + 1 })
      )
    ).toMatchObject({ os: true });
  });

  it('does NOT refund the replay guard — the row still earned its badge', () => {
    const gate = createNotifyGate();
    const first = gate.evaluate(messageSignal({ seq: 5 }), gateContext());
    gate.refundOs(first!);
    expect(
      gate.evaluate(messageSignal({ seq: 5 }), gateContext({ now: NOW + 10 }))
    ).toBeNull();
  });
});

describe('gate — operator settings', () => {
  it('is off for turn-complete by default', () => {
    const gate = createNotifyGate();
    expect(
      gate.evaluate(
        messageSignal({ reason: 'turn-complete', seq: 0 }),
        gateContext()
      )
    ).toBeNull();
  });

  it('fires turn-complete once the operator opts in', () => {
    const gate = createNotifyGate();
    expect(
      gate.evaluate(
        messageSignal({
          reason: 'turn-complete',
          seq: 0,
          senderLabel: 'codex',
        }),
        gateContext({
          settings: { ...DEFAULT_NOTIFY_SETTINGS, turnComplete: true },
        })
      )
    ).toMatchObject({
      os: true,
      reason: 'turn-complete',
      senderLabel: 'codex',
    });
  });

  it('gates mentions off', () => {
    const gate = createNotifyGate();
    expect(
      gate.evaluate(
        messageSignal(),
        gateContext({
          settings: { ...DEFAULT_NOTIFY_SETTINGS, mentions: false },
        })
      )
    ).toBeNull();
  });

  it('gates dm replies off', () => {
    const gate = createNotifyGate();
    expect(
      gate.evaluate(
        messageSignal({ reason: 'dm-reply', channel: dmChannel }),
        gateContext({
          settings: { ...DEFAULT_NOTIFY_SETTINGS, dmReplies: false },
        })
      )
    ).toBeNull();
  });
});

describe('gate — replay guard and read position', () => {
  it('refuses a seq it has already evaluated', () => {
    const gate = createNotifyGate();
    expect(
      gate.evaluate(messageSignal({ seq: 7 }), gateContext())
    ).not.toBeNull();
    expect(gate.evaluate(messageSignal({ seq: 7 }), gateContext())).toBeNull();
    expect(gate.evaluate(messageSignal({ seq: 6 }), gateContext())).toBeNull();
  });

  it('refuses a row the operator already read (possibly on another device)', () => {
    const gate = createNotifyGate();
    expect(
      gate.evaluate(messageSignal({ seq: 7 }), gateContext({ lastReadSeq: 7 }))
    ).toBeNull();
    expect(
      gate.evaluate(messageSignal({ seq: 8 }), gateContext({ lastReadSeq: 7 }))
    ).not.toBeNull();
  });

  it('does not apply the seq guard to status-only signals', () => {
    const gate = createNotifyGate();
    const settings = { ...DEFAULT_NOTIFY_SETTINGS, turnComplete: true };
    const turn = messageSignal({ reason: 'turn-complete', seq: 0 });
    expect(gate.evaluate(turn, gateContext({ settings }))).not.toBeNull();
    expect(
      gate.evaluate(
        turn,
        gateContext({ settings, now: NOW + NOTIFY_OS_RATE_LIMIT_MS })
      )
    ).not.toBeNull();
  });

  it('forgets every ledger on reset', () => {
    const gate = createNotifyGate();
    gate.evaluate(messageSignal({ seq: 7 }), gateContext());
    gate.reset();
    expect(
      gate.evaluate(messageSignal({ seq: 7 }), gateContext())
    ).toMatchObject({ os: true, count: 1 });
  });
});

// Copy itself is delivery (item 2) and is covered by `notify-copy.test.ts`.
// What the gate still owes the delivery lane is the RAW MATERIAL: the channel
// title verbatim, the sender label, and the coalesce count.
describe('event payload handed to delivery', () => {
  it('carries the operator channel title verbatim', () => {
    const gate = createNotifyGate();
    const event = gate.evaluate(
      messageSignal({ channel: { ...channel, title: 'Impl 1308' } }),
      gateContext()
    );
    expect(event?.channelTitle).toBe('Impl 1308');
  });

  it('carries the sender label for every reason', () => {
    expect(
      createNotifyGate().evaluate(
        messageSignal({ reason: 'dm-reply', channel: dmChannel, seq: 1 }),
        gateContext()
      )
    ).toMatchObject({ reason: 'dm-reply', senderLabel: 'claude', count: 1 });
    expect(
      createNotifyGate().evaluate(
        messageSignal({ reason: 'turn-complete', seq: 0 }),
        gateContext({
          settings: { ...DEFAULT_NOTIFY_SETTINGS, turnComplete: true },
        })
      )
    ).toMatchObject({ reason: 'turn-complete', senderLabel: 'claude' });
  });

  it('never carries message text', () => {
    const event = createNotifyGate().evaluate(
      messageSignal({ seq: 1 }),
      gateContext()
    );
    expect(JSON.stringify(event)).not.toContain('pushed the branch');
  });
});
