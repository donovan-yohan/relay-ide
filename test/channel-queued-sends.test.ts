import { beforeEach, describe, expect, it } from 'vitest';

import {
  channelAgentStatusKey,
  resolveEffectiveQueuedCount,
  useChannelAgentStatusStore,
} from '../frontend/src/lib/stores/channel-agent-status.js';
import {
  queuedSendCopy,
  queuedSendStillWaiting,
  snapshotQueueDrainSeqs,
  useChannelQueuedSendsStore,
} from '../frontend/src/lib/stores/channel-queued-sends.js';
import {
  channelPresenceCopy,
  selectChannelAgentPresence,
} from '../frontend/src/lib/chat/channel-agent-presence.js';

// #1308 slice 4 item 2. The queued-send chip's whole correctness rests on ONE
// signal: the per-agent "queue observed empty" generation published with
// `channel-agent-status`. These tests pin that generation's edges, because the
// component can only ever be as right as this is.

const CHANNEL = 'topic:ops';
const CLAUDE = 'agent-profile:claude:default';
const KEY = channelAgentStatusKey(CHANNEL, CLAUDE);

function resetStores(): void {
  useChannelAgentStatusStore.setState({
    statusByChannelAgent: {},
    runtimeByChannelAgent: {},
    queuedCountByChannelAgent: {},
    queueDrainSeqByChannelAgent: {},
    updatedAtByChannelAgent: {},
  });
  useChannelQueuedSendsStore.setState({ marksByMessageId: {} });
}

describe('queue drain generation (#1308 slice 4)', () => {
  beforeEach(resetStores);

  it('does not advance while posts are still queued', () => {
    const record = useChannelAgentStatusStore.getState().recordStatus;
    record(CHANNEL, CLAUDE, 'streaming', 'rt:1', 1);
    record(CHANNEL, CLAUDE, 'idle', 'rt:1', 1);
    const state = useChannelAgentStatusStore.getState();
    expect(state.queuedCountByChannelAgent[KEY]).toBe(1);
    expect(state.queueDrainSeqByChannelAgent[KEY] ?? 0).toBe(0);
  });

  it('advances on the drain the binder emits before the next turn starts', () => {
    const record = useChannelAgentStatusStore.getState().recordStatus;
    const seq = (): number =>
      useChannelAgentStatusStore.getState().queueDrainSeqByChannelAgent[KEY] ??
      0;
    // The exact server sequence: enqueue, turn ends, queue spliced out, next
    // turn opens (server/channel-agent-binder finishTurn → pump → sendTurn).
    record(CHANNEL, CLAUDE, 'streaming', 'rt:1', 1);
    record(CHANNEL, CLAUDE, 'idle', 'rt:1', 1);
    expect(seq()).toBe(0);
    // The splice: this is the transition that retires the chip, and it lands
    // BEFORE the consuming turn is announced.
    record(CHANNEL, CLAUDE, 'idle', 'rt:1', 0);
    expect(seq()).toBe(1);
    // The consuming turn also reports an empty queue; a further bump is inert
    // (the mark it would have retired is already gone).
    record(CHANNEL, CLAUDE, 'thinking', 'rt:1', 0);
    expect(seq()).toBe(2);
  });

  it('advances on any empty-queue transition, so a post that never queued still clears', () => {
    // A group-channel message that addresses nobody enqueues nothing at all —
    // there is no `queuedCount 1 → 0` edge to wait for, only the busy agent's
    // own next transition.
    const record = useChannelAgentStatusStore.getState().recordStatus;
    record(CHANNEL, CLAUDE, 'streaming', 'rt:1', 0);
    record(CHANNEL, CLAUDE, 'idle', 'rt:1', 0);
    expect(
      useChannelAgentStatusStore.getState().queueDrainSeqByChannelAgent[KEY]
    ).toBe(2);
  });

  it('clearChannel drops the queue maps for that channel only', () => {
    const record = useChannelAgentStatusStore.getState().recordStatus;
    record(CHANNEL, CLAUDE, 'streaming', 'rt:1', 2);
    record('topic:other', CLAUDE, 'streaming', 'rt:2', 3);
    useChannelAgentStatusStore.getState().clearChannel(CHANNEL);
    const state = useChannelAgentStatusStore.getState();
    expect(state.queuedCountByChannelAgent[KEY]).toBeUndefined();
    expect(state.queueDrainSeqByChannelAgent[KEY]).toBeUndefined();
    expect(
      state.queuedCountByChannelAgent[
        channelAgentStatusKey('topic:other', CLAUDE)
      ]
    ).toBe(3);
  });
});

describe('queued-send marks (#1308 slice 4)', () => {
  beforeEach(resetStores);

  function mark(drainSeqs: Record<string, number>) {
    return {
      channelId: CHANNEL,
      agentIds: [CLAUDE],
      label: queuedSendCopy(['claude']),
      drainSeqs,
    };
  }

  it('stays visible while the snapshotted generation is current', () => {
    useChannelAgentStatusStore
      .getState()
      .recordStatus(CHANNEL, CLAUDE, 'streaming', 'rt:1', 1);
    const snapshot = snapshotQueueDrainSeqs(
      CHANNEL,
      [CLAUDE],
      null,
      useChannelAgentStatusStore.getState().queueDrainSeqByChannelAgent
    );
    expect(
      queuedSendStillWaiting(
        mark(snapshot),
        useChannelAgentStatusStore.getState().queueDrainSeqByChannelAgent
      )
    ).toBe(true);
  });

  it('retires the moment that generation advances', () => {
    const snapshot = snapshotQueueDrainSeqs(CHANNEL, [CLAUDE], null, {});
    useChannelAgentStatusStore
      .getState()
      .recordStatus(CHANNEL, CLAUDE, 'thinking', 'rt:1', 0);
    expect(
      queuedSendStillWaiting(
        mark(snapshot),
        useChannelAgentStatusStore.getState().queueDrainSeqByChannelAgent
      )
    ).toBe(false);
  });

  it('retires when ANY addressed agent drains, not only when all do', () => {
    const hermes = 'agent-profile:hermes:default';
    const record = useChannelAgentStatusStore.getState().recordStatus;
    record(CHANNEL, CLAUDE, 'streaming', 'rt:1', 1);
    record(CHANNEL, hermes, 'streaming', 'rt:2', 1);
    const drainSeqs =
      useChannelAgentStatusStore.getState().queueDrainSeqByChannelAgent;
    const snapshot = snapshotQueueDrainSeqs(
      CHANNEL,
      [CLAUDE, hermes],
      null,
      drainSeqs
    );
    const multi = {
      channelId: CHANNEL,
      agentIds: [CLAUDE, hermes],
      label: queuedSendCopy(['claude', 'hermes']),
      drainSeqs: snapshot,
    };
    record(CHANNEL, hermes, 'idle', 'rt:2', 0);
    expect(
      queuedSendStillWaiting(
        multi,
        useChannelAgentStatusStore.getState().queueDrainSeqByChannelAgent
      )
    ).toBe(false);
  });

  it('never waits on an empty target set', () => {
    expect(
      queuedSendStillWaiting(
        { channelId: CHANNEL, agentIds: [], label: 'x', drainSeqs: {} },
        {}
      )
    ).toBe(false);
  });

  it('clearChannel drops that channel’s marks only', () => {
    const store = useChannelQueuedSendsStore.getState();
    store.markQueuedSend('chm:1', mark({}));
    store.markQueuedSend('chm:2', { ...mark({}), channelId: 'topic:other' });
    useChannelQueuedSendsStore.getState().clearChannel(CHANNEL);
    const marks = useChannelQueuedSendsStore.getState().marksByMessageId;
    expect(marks['chm:1']).toBeUndefined();
    expect(marks['chm:2']).toBeDefined();
  });

  // A daily-driver channel stays mounted for days, and `clearChannel` only
  // fires on switch/unmount, so an append-only map would grow one entry per
  // queued send for the whole session.
  it('sweeps retired marks on every insert so the map stays bounded', () => {
    const record = useChannelAgentStatusStore.getState().recordStatus;
    record(CHANNEL, CLAUDE, 'streaming', 'rt:1', 1);
    const snapshot = snapshotQueueDrainSeqs(
      CHANNEL,
      [CLAUDE],
      null,
      useChannelAgentStatusStore.getState().queueDrainSeqByChannelAgent
    );
    useChannelQueuedSendsStore
      .getState()
      .markQueuedSend('chm:1', mark(snapshot));
    // Still waiting: an insert must not evict a live mark.
    useChannelQueuedSendsStore
      .getState()
      .markQueuedSend('chm:2', mark(snapshot));
    expect(
      Object.keys(useChannelQueuedSendsStore.getState().marksByMessageId).sort()
    ).toEqual(['chm:1', 'chm:2']);

    // The queue drains, retiring both — the next insert is what collects them.
    record(CHANNEL, CLAUDE, 'idle', 'rt:1', 0);
    const fresh = snapshotQueueDrainSeqs(
      CHANNEL,
      [CLAUDE],
      null,
      useChannelAgentStatusStore.getState().queueDrainSeqByChannelAgent
    );
    useChannelQueuedSendsStore.getState().markQueuedSend('chm:3', mark(fresh));
    expect(
      Object.keys(useChannelQueuedSendsStore.getState().marksByMessageId)
    ).toEqual(['chm:3']);
  });

  it('names one busy agent and stays generic for several — lowercase, no emoji', () => {
    expect(queuedSendCopy(['claude'])).toBe('queued — claude is mid-turn');
    expect(queuedSendCopy(['claude', 'hermes'])).toBe(
      'queued — agents are mid-turn'
    );
  });
});

describe('resolveEffectiveQueuedCount (#1308 slice 4)', () => {
  it('socket wins when its transition is at least as new as the roster snapshot', () => {
    expect(
      resolveEffectiveQueuedCount({
        socketQueuedCount: 2,
        socketUpdatedAt: 200,
        rosterQueuedCount: 0,
        rosterUpdatedAt: 200,
      })
    ).toBe(2);
  });

  it('roster wins over a socket count the snapshot has superseded', () => {
    expect(
      resolveEffectiveQueuedCount({
        socketQueuedCount: 3,
        socketUpdatedAt: 100,
        rosterQueuedCount: 0,
        rosterUpdatedAt: 200,
      })
    ).toBe(0);
  });

  it('reads zero from a hub that publishes no count at all', () => {
    expect(
      resolveEffectiveQueuedCount({
        socketQueuedCount: undefined,
        socketUpdatedAt: undefined,
        rosterQueuedCount: undefined,
        rosterUpdatedAt: 200,
      })
    ).toBe(0);
  });
});

describe('presence copy queued suffix (#1308 slice 4 item 2c)', () => {
  const chip = (queuedCount: number) => ({
    agentId: CLAUDE,
    status: 'streaming' as const,
    identity: {
      label: 'claude',
      colorVar: 'var(--sender-claude)',
      glyph: null,
    },
    queuedCount,
  });

  it('appends the depth only when something is waiting', () => {
    const [withQueue] = selectChannelAgentPresence(
      [chip(1)],
      new Set<string>()
    );
    const [without] = selectChannelAgentPresence([chip(0)], new Set<string>());
    expect(withQueue && channelPresenceCopy(withQueue)).toBe(
      'claude is responding… (1 queued)'
    );
    expect(without && channelPresenceCopy(without)).toBe(
      'claude is responding…'
    );
  });

  it('counts past one', () => {
    const [presence] = selectChannelAgentPresence([chip(3)], new Set<string>());
    expect(presence && channelPresenceCopy(presence)).toBe(
      'claude is responding… (3 queued)'
    );
  });
});
