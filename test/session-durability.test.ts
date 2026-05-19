import { describe, expect, it } from 'vitest';
import {
  SESSION_DURABILITY_STATES,
  deriveSessionDurability,
  isSessionDurabilityState,
} from '../shared/session-durability.js';

describe('deriveSessionDurability', () => {
  it('maps an active attached session to running-attached', () => {
    expect(
      deriveSessionDurability({
        status: 'active',
        agentState: 'processing',
        idle: false,
      })
    ).toBe('running-attached');
  });

  it('maps disconnected to running-detached', () => {
    expect(
      deriveSessionDurability({
        status: 'disconnected',
        agentState: 'processing',
        idle: false,
      })
    ).toBe('running-detached');
  });

  it('maps an active session with explicit hasLiveAttach=false to running-detached', () => {
    expect(
      deriveSessionDurability({
        status: 'active',
        agentState: 'processing',
        idle: false,
        hasLiveAttach: false,
      })
    ).toBe('running-detached');
  });

  it('maps initializing+idle to awaiting-start', () => {
    expect(
      deriveSessionDurability({
        status: 'active',
        agentState: 'initializing',
        idle: true,
      })
    ).toBe('awaiting-start');
  });

  it('promotes initializing to running-attached once output is flowing', () => {
    // `idle: false` means the session has already produced or is consuming
    // input — the awaiting-start branch only applies while idle.
    expect(
      deriveSessionDurability({
        status: 'active',
        agentState: 'initializing',
        idle: false,
      })
    ).toBe('running-attached');
  });

  it('maps permission-prompt to permission-needed regardless of status', () => {
    expect(
      deriveSessionDurability({
        status: 'active',
        agentState: 'permission-prompt',
        idle: false,
      })
    ).toBe('permission-needed');
    expect(
      deriveSessionDurability({
        status: 'disconnected',
        agentState: 'permission-prompt',
        idle: true,
      })
    ).toBe('permission-needed');
  });

  it('maps agentState=error to error', () => {
    expect(
      deriveSessionDurability({
        status: 'active',
        agentState: 'error',
        idle: true,
      })
    ).toBe('error');
  });

  it('maps PTY cleanedUp to ended', () => {
    expect(
      deriveSessionDurability({
        status: 'disconnected',
        agentState: 'idle',
        idle: true,
        cleanedUp: true,
      })
    ).toBe('ended');
  });

  it('prefers stale-node when the hub reports the node is unhealthy', () => {
    // Even an `active` session must surface as stale when the hub cannot
    // prove the node is alive; the local last-known process state is not
    // authority for reattach safety.
    for (const status of ['stale', 'offline', 'revoked'] as const) {
      expect(
        deriveSessionDurability({
          status: 'active',
          agentState: 'processing',
          idle: false,
          nodeStatus: status,
        })
      ).toBe('stale-node');
    }
  });

  it('does not downgrade to stale-node when nodeStatus is online or null', () => {
    expect(
      deriveSessionDurability({
        status: 'active',
        agentState: 'processing',
        idle: false,
        nodeStatus: 'online',
      })
    ).toBe('running-attached');
    expect(
      deriveSessionDurability({
        status: 'active',
        agentState: 'processing',
        idle: false,
        nodeStatus: null,
      })
    ).toBe('running-attached');
  });

  it('prioritises stale-node above ended', () => {
    // A node we cannot reach should not be reported as `ended` from cached
    // cleanup state — that would lie about reattach impossibility when the
    // process may actually still be alive on the node.
    expect(
      deriveSessionDurability({
        status: 'disconnected',
        agentState: 'idle',
        idle: true,
        cleanedUp: true,
        nodeStatus: 'offline',
      })
    ).toBe('stale-node');
  });

  it('every output is a member of the closed enum', () => {
    const samples = [
      deriveSessionDurability({
        status: 'active',
        agentState: 'processing',
        idle: false,
      }),
      deriveSessionDurability({
        status: 'disconnected',
        agentState: 'idle',
        idle: true,
      }),
      deriveSessionDurability({
        status: 'active',
        agentState: 'error',
        idle: true,
      }),
    ];
    for (const value of samples) {
      expect(isSessionDurabilityState(value)).toBe(true);
    }
  });

  it('isSessionDurabilityState rejects unknown values', () => {
    expect(isSessionDurabilityState('running')).toBe(false);
    expect(isSessionDurabilityState(undefined)).toBe(false);
    expect(isSessionDurabilityState(42)).toBe(false);
  });

  it('exposes the canonical state list for consumers', () => {
    expect(SESSION_DURABILITY_STATES).toEqual([
      'running-attached',
      'running-detached',
      'awaiting-start',
      'stale-node',
      'ended',
      'error',
      'permission-needed',
    ]);
  });
});
