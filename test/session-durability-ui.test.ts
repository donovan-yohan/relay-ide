import { describe, expect, it } from 'vitest';
import {
  durabilityToBadge,
  durabilityDisabledReason,
} from '../frontend/src/lib/session-durability.js';
import { SESSION_DURABILITY_STATES } from '../shared/session-durability.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import type {
  WorkContextActiveGroup,
  WorkContextSessionSummary,
} from '../frontend/src/lib/types.js';
import { activeWorkMobileControlState } from '../frontend/src/lib/active-work-control.js';

const session = (
  overrides: Partial<WorkContextSessionSummary> = {}
): WorkContextSessionSummary => ({
  id: 's1',
  nodeId: DEFAULT_LOCAL_NODE_ID,
  tabKind: 'terminal',
  type: 'agent',
  mode: 'pty',
  agent: 'codex',
  cwd: '/repo/relay-ide',
  status: 'active',
  agentState: 'processing',
  controlMode: 'agent-driven',
  controlFreshness: 'fresh',
  relationship: 'primary',
  associatedAt: '2026-05-17T00:00:00.000Z',
  live: true,
  ...overrides,
});

const onlineGroup = (
  sessions: WorkContextSessionSummary[]
): WorkContextActiveGroup => ({
  id: 'work-1',
  context: null,
  node: {
    nodeId: DEFAULT_LOCAL_NODE_ID,
    status: 'online',
    kind: 'local',
    lastSeenAt: '2026-05-17T00:00:00.000Z',
  },
  sessions,
  staleReadModel: false,
});

describe('durabilityToBadge', () => {
  it('returns a typed badge for every closed-enum member', () => {
    for (const state of SESSION_DURABILITY_STATES) {
      const badge = durabilityToBadge(state);
      expect(badge.label.length).toBeGreaterThan(0);
      expect(badge.statusDot).toBeTruthy();
      expect(typeof badge.severity).toBe('number');
    }
  });

  it('orders permission-needed and error ahead of background states', () => {
    const permission = durabilityToBadge('permission-needed').severity;
    const error = durabilityToBadge('error').severity;
    const live = durabilityToBadge('running-attached').severity;
    expect(permission).toBeLessThan(error);
    expect(error).toBeLessThan(live);
  });
});

describe('durabilityDisabledReason', () => {
  it('disables controls for stale-node, ended, and error states', () => {
    expect(durabilityDisabledReason('stale-node')).toMatch(/stale node/);
    expect(durabilityDisabledReason('ended')).toMatch(/ended/);
    expect(durabilityDisabledReason('error')).toMatch(/error/);
  });

  it('does NOT disable controls for permission-needed', () => {
    // The operator is supposed to answer permission prompts — disabling
    // controls would defeat the entire flow.
    expect(durabilityDisabledReason('permission-needed')).toBeNull();
  });

  it('does not disable controls for happy-path states', () => {
    expect(durabilityDisabledReason('running-attached')).toBeNull();
    expect(durabilityDisabledReason('running-detached')).toBeNull();
    expect(durabilityDisabledReason('awaiting-start')).toBeNull();
    expect(durabilityDisabledReason(undefined)).toBeNull();
  });
});

describe('useSessionsStore.handleDurabilityChanged', () => {
  it('updates the matching session and leaves others alone', async () => {
    const { useSessionsStore } =
      await import('../frontend/src/lib/stores/sessions.js');
    const before = useSessionsStore.getState().sessions;
    useSessionsStore.setState({
      sessions: [
        { id: 'a', durability: 'running-attached' } as never,
        { id: 'b', durability: 'running-attached' } as never,
      ],
    });
    useSessionsStore.getState().handleDurabilityChanged('a', 'stale-node');
    const after = useSessionsStore.getState().sessions;
    expect(after.find((s) => s.id === 'a')?.durability).toBe('stale-node');
    expect(after.find((s) => s.id === 'b')?.durability).toBe(
      'running-attached'
    );
    useSessionsStore.setState({ sessions: before });
  });
});

describe('activeWorkMobileControlState respects durability', () => {
  it('disables live input with a typed reason when durability is stale-node', () => {
    const s = session({ durability: 'stale-node' });
    const state = activeWorkMobileControlState(onlineGroup([s]), s);
    expect(state.smallInputDisabledReason).toMatch(/stale node/);
    expect(state.attachDisabledReason).toMatch(/stale node/);
    expect(state.destructiveDisabledReason).toMatch(/stale node/);
  });

  it('disables live controls when durability is ended even if node is online', () => {
    const s = session({ durability: 'ended' });
    const state = activeWorkMobileControlState(onlineGroup([s]), s);
    expect(state.smallInputDisabledReason).toMatch(/ended/);
  });

  it('leaves controls enabled for running-attached + online node', () => {
    const s = session({ durability: 'running-attached' });
    const state = activeWorkMobileControlState(onlineGroup([s]), s);
    expect(state.smallInputDisabledReason).toBeNull();
    expect(state.attachDisabledReason).toBeNull();
  });
});
