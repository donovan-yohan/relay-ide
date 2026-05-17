import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import type {
  WorkContextActiveGroup,
  WorkContextSessionSummary,
} from '../frontend/src/lib/types.js';
import {
  activeWorkAttentionPriority,
  activeWorkMobileControlState,
  activeWorkStateLabel,
} from '../frontend/src/lib/active-work-control.js';

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

const group = (
  overrides: Partial<WorkContextActiveGroup> = {}
): WorkContextActiveGroup => ({
  id: 'work-1',
  context: null,
  node: {
    nodeId: DEFAULT_LOCAL_NODE_ID,
    status: 'online',
    kind: 'local',
    lastSeenAt: '2026-05-17T00:00:00.000Z',
  },
  sessions: [session()],
  staleReadModel: false,
  ...overrides,
});

describe('active work mobile control helpers', () => {
  it('prioritizes operator prompts before stale/offline/read-only states', () => {
    expect(
      activeWorkAttentionPriority(
        group({ sessions: [session({ agentState: 'permission-prompt' })] })
      )
    ).toBe(0);
    expect(activeWorkStateLabel(group({ sessions: [session({ agentState: 'waiting-for-input' })] }))).toBe('needs input');
    expect(
      activeWorkAttentionPriority(
        group({
          node: { nodeId: 'remote-a', status: 'offline', kind: 'remote' },
          sessions: [session({ nodeId: 'remote-a', live: false })],
        })
      )
    ).toBe(1);
  });

  it('allows audited small input only for fresh live local pty sessions', () => {
    const state = activeWorkMobileControlState(
      group({ sessions: [session({ agentState: 'permission-prompt' })] }),
      session({ agentState: 'permission-prompt' })
    );

    expect(state.smallInputDisabledReason).toBeNull();
    expect(state.promptKind).toBe('approval');
    expect(state.smallInputLabel).toBe('reply to approval');
  });

  it('disables controls for stale/offline read models and reports last-known state reasons', () => {
    const stale = activeWorkMobileControlState(
      group({
        node: { nodeId: 'remote-a', status: 'stale', kind: 'remote' },
        sessions: [session({ nodeId: 'remote-a', live: true })],
      }),
      session({ nodeId: 'remote-a', live: true })
    );
    expect(stale.attachDisabledReason).toBe('stale node');
    expect(stale.smallInputDisabledReason).toBe('stale node');

    const lastKnown = activeWorkMobileControlState(
      group({ sessions: [session({ live: false })] }),
      session({ live: false })
    );
    expect(lastKnown.attachDisabledReason).toBe('last-known session only');
  });

  it('does not enable destructive kill without an explicit mobile allow decision', () => {
    const state = activeWorkMobileControlState(group(), session());
    expect(state.destructiveDisabledReason).toContain('session:control:kill');
  });

  it('does not route remote small input through local-only control paths', () => {
    const state = activeWorkMobileControlState(
      group({
        node: { nodeId: 'remote-a', status: 'online', kind: 'remote' },
        sessions: [session({ nodeId: 'remote-a' })],
      }),
      session({ nodeId: 'remote-a' })
    );
    expect(state.smallInputDisabledReason).toBe(
      'remote small input awaits routed control endpoint'
    );
  });
});
