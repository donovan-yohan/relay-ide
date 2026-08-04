import { beforeEach, describe, expect, it } from 'vitest';

import {
  channelAgentStatusKey,
  resolveEffectiveAgentStatus,
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
