import { beforeEach, describe, expect, it } from 'vitest';

import {
  channelAgentStatusKey,
  resolveEffectiveAgentStatus,
  shouldPollRosterForPresence,
  STALE_AGENT_STATUS_MS,
  useChannelAgentStatusStore,
} from '../frontend/src/lib/stores/channel-agent-status.js';

// #1180 P2: stale busy agent-status reconciliation. The socket carries
// transition-only events (no replay on reconnect), so a missed terminal 'idle'
// would pin the header chip busy forever. `resolveEffectiveAgentStatus` lets a
// fresh roster snapshot win over a stale socket status, keyed on timestamps.

describe('resolveEffectiveAgentStatus', () => {
  it('roster wins when its snapshot is newer than the last socket transition', () => {
    // The stuck-busy case: socket streamed at t=100, roster fetched idle at t=200.
    expect(
      resolveEffectiveAgentStatus({
        socketStatus: 'streaming',
        socketUpdatedAt: 100,
        rosterStatus: 'idle',
        rosterUpdatedAt: 200,
        streaming: false,
      })
    ).toBe('idle');
  });

  it('socket wins when its transition is newer than the roster snapshot', () => {
    expect(
      resolveEffectiveAgentStatus({
        socketStatus: 'streaming',
        socketUpdatedAt: 300,
        rosterStatus: 'idle',
        rosterUpdatedAt: 200,
        streaming: false,
      })
    ).toBe('streaming');
  });

  it('a socket transition exactly at the roster snapshot time still wins (>=)', () => {
    expect(
      resolveEffectiveAgentStatus({
        socketStatus: 'thinking',
        socketUpdatedAt: 200,
        rosterStatus: 'idle',
        rosterUpdatedAt: 200,
        streaming: false,
      })
    ).toBe('thinking');
  });

  it('falls back to the roster status when there is no socket entry', () => {
    expect(
      resolveEffectiveAgentStatus({
        socketStatus: undefined,
        socketUpdatedAt: undefined,
        rosterStatus: 'waiting',
        rosterUpdatedAt: 200,
        streaming: false,
      })
    ).toBe('waiting');
  });

  it('resolves to idle when neither socket nor roster reports a status', () => {
    expect(
      resolveEffectiveAgentStatus({
        socketStatus: undefined,
        socketUpdatedAt: undefined,
        rosterStatus: undefined,
        rosterUpdatedAt: 200,
        streaming: false,
      })
    ).toBe('idle');
  });

  // #1307 staleness floor. The server broadcasts a terminal idle on every
  // runtime teardown, but a client that was not listening when it fired keeps a
  // busy status the socket will never correct — and while that status stays
  // newer than the roster snapshot it wins the tie-break forever.
  it('retires a socket-won busy status older than the floor once the roster shows no live binding', () => {
    const socketUpdatedAt = 1_000_000;
    expect(
      resolveEffectiveAgentStatus({
        socketStatus: 'thinking',
        socketUpdatedAt,
        rosterStatus: undefined,
        rosterUpdatedAt: socketUpdatedAt - 1,
        streaming: false,
        rosterHasLiveBinding: false,
        now: socketUpdatedAt + STALE_AGENT_STATUS_MS,
      })
    ).toBe('idle');
  });

  it('keeps a busy status while the roster still shows a live binding, however old the transition', () => {
    // The long-turn guard: an agent that has been thinking for an hour is still
    // bound, and its chip must not blink out from under the operator.
    const socketUpdatedAt = 1_000_000;
    expect(
      resolveEffectiveAgentStatus({
        socketStatus: 'thinking',
        socketUpdatedAt,
        rosterStatus: 'thinking',
        rosterUpdatedAt: socketUpdatedAt - 1,
        streaming: false,
        rosterHasLiveBinding: true,
        now: socketUpdatedAt + STALE_AGENT_STATUS_MS * 6,
      })
    ).toBe('thinking');
  });

  it('keeps a busy status that is younger than the floor even when nothing is bound', () => {
    const socketUpdatedAt = 1_000_000;
    expect(
      resolveEffectiveAgentStatus({
        socketStatus: 'streaming',
        socketUpdatedAt,
        rosterStatus: undefined,
        rosterUpdatedAt: socketUpdatedAt - 1,
        streaming: false,
        rosterHasLiveBinding: false,
        now: socketUpdatedAt + STALE_AGENT_STATUS_MS - 1,
      })
    ).toBe('streaming');
  });

  it('reducer-derived streaming upgrades a resolved idle but never downgrades a live status', () => {
    expect(
      resolveEffectiveAgentStatus({
        socketStatus: 'idle',
        socketUpdatedAt: 300,
        rosterStatus: 'idle',
        rosterUpdatedAt: 200,
        streaming: true,
      })
    ).toBe('streaming');
    expect(
      resolveEffectiveAgentStatus({
        socketStatus: 'streaming',
        socketUpdatedAt: 300,
        rosterStatus: 'idle',
        rosterUpdatedAt: 200,
        streaming: false,
      })
    ).toBe('streaming');
  });
});

describe('useChannelAgentStatusStore — timestamped reconciliation state', () => {
  beforeEach(() => {
    useChannelAgentStatusStore.setState({
      statusByChannelAgent: {},
      runtimeByChannelAgent: {},
      queuedCountByChannelAgent: {},
      queueDrainSeqByChannelAgent: {},
      updatedAtByChannelAgent: {},
    });
  });

  it('recordStatus stamps an updatedAt timestamp alongside the status', () => {
    const before = Date.now();
    useChannelAgentStatusStore
      .getState()
      .recordStatus('c1', 'mock', 'streaming', 's1');
    const key = channelAgentStatusKey('c1', 'mock');
    const state = useChannelAgentStatusStore.getState();
    expect(state.statusByChannelAgent[key]).toBe('streaming');
    expect(state.updatedAtByChannelAgent[key]).toBeGreaterThanOrEqual(before);
  });

  it('clearChannel drops status, session, AND updatedAt for that channel only', () => {
    const s = useChannelAgentStatusStore.getState();
    s.recordStatus('c1', 'mock', 'streaming', 's1');
    s.recordStatus('c2', 'mock', 'thinking', 's2');
    useChannelAgentStatusStore.getState().clearChannel('c1');
    const state = useChannelAgentStatusStore.getState();
    const c1 = channelAgentStatusKey('c1', 'mock');
    const c2 = channelAgentStatusKey('c2', 'mock');
    expect(state.statusByChannelAgent[c1]).toBeUndefined();
    expect(state.runtimeByChannelAgent[c1]).toBeUndefined();
    expect(state.updatedAtByChannelAgent[c1]).toBeUndefined();
    // The other channel is untouched.
    expect(state.statusByChannelAgent[c2]).toBe('thinking');
    expect(state.updatedAtByChannelAgent[c2]).toBeGreaterThan(0);
  });
});

// #1307 roster poll arming. `staleTime` alone never refetches, so a busy socket
// status whose terminal 'idle' never arrived had nothing to reconcile it while
// the view stayed mounted. The poll must arm on that case AND disarm itself once
// a snapshot has landed — nothing writes the reconciled verdict back into the
// store, so arming on the raw status alone would poll every open channel view
// forever.
describe('shouldPollRosterForPresence', () => {
  const CH = 'chan-1';
  const key = channelAgentStatusKey(CH, 'mock');

  it('arms while a busy socket status is still newer than the roster snapshot', () => {
    expect(
      shouldPollRosterForPresence({
        statusByChannelAgent: { [key]: 'thinking' },
        updatedAtByChannelAgent: { [key]: 5_000 },
        channelId: CH,
        rosterUpdatedAt: 4_000,
      })
    ).toBe(true);
  });

  it('disarms once a poll lands: the fresh snapshot outranks the socket transition', () => {
    // Arm → poll → disarm, driven only by `dataUpdatedAt` advancing past the
    // socket's last transition. This is the exact tie-break the resolver uses,
    // so the moment the poll stops the roster is already authoritative for the
    // chip: the status it renders can no longer come from the stale socket entry.
    const armed = {
      statusByChannelAgent: { [key]: 'thinking' as const },
      updatedAtByChannelAgent: { [key]: 5_000 },
      channelId: CH,
      rosterUpdatedAt: 4_000,
    };
    expect(shouldPollRosterForPresence(armed)).toBe(true);
    expect(
      shouldPollRosterForPresence({ ...armed, rosterUpdatedAt: 5_001 })
    ).toBe(false);
    // A fresh live transition re-arms it.
    expect(
      shouldPollRosterForPresence({
        ...armed,
        updatedAtByChannelAgent: { [key]: 6_000 },
        rosterUpdatedAt: 5_001,
      })
    ).toBe(true);
  });

  it('stays disarmed for an idle channel and ignores other channels', () => {
    expect(
      shouldPollRosterForPresence({
        statusByChannelAgent: { [key]: 'idle' },
        updatedAtByChannelAgent: { [key]: 9_000 },
        channelId: CH,
        rosterUpdatedAt: 1_000,
      })
    ).toBe(false);
    expect(
      shouldPollRosterForPresence({
        statusByChannelAgent: {
          [channelAgentStatusKey('other', 'mock')]: 'thinking',
        },
        updatedAtByChannelAgent: {
          [channelAgentStatusKey('other', 'mock')]: 9_000,
        },
        channelId: CH,
        rosterUpdatedAt: 1_000,
      })
    ).toBe(false);
  });
});
