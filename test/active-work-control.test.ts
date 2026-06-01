import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import type {
  WorkContextActiveGroup,
  WorkContextSessionSummary,
} from '../frontend/src/lib/types.js';
import {
  activeWorkAttentionPriority,
  activeWorkMobileControlState,
  activeWorkSessionActivationKey,
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
    expect(
      activeWorkStateLabel(
        group({ sessions: [session({ agentState: 'waiting-for-input' })] })
      )
    ).toBe('needs input');
    expect(
      activeWorkAttentionPriority(
        group({
          node: { nodeId: 'remote-a', status: 'offline', kind: 'remote' },
          sessions: [session({ nodeId: 'remote-a', live: false })],
        })
      )
    ).toBe(1);
  });

  it('surfaces error before processing when a work group has mixed session states', () => {
    const mixed = group({
      sessions: [
        session({ id: 'processing-session', agentState: 'processing' }),
        session({ id: 'errored-session', agentState: 'error', live: false }),
      ],
    });

    expect(activeWorkAttentionPriority(mixed)).toBe(3);
    expect(activeWorkStateLabel(mixed)).toBe('error');
  });

  it('allows audited small input for fresh live local and routed pty sessions', () => {
    const state = activeWorkMobileControlState(
      group({ sessions: [session({ agentState: 'permission-prompt' })] }),
      session({ agentState: 'permission-prompt' })
    );

    expect(state.smallInputDisabledReason).toBeNull();
    expect(state.promptKind).toBe('approval');
    expect(state.smallInputLabel).toBe('reply to approval');

    const routed = activeWorkMobileControlState(
      group({
        node: { nodeId: 'remote-a', status: 'online', kind: 'remote' },
        sessions: [session({ nodeId: 'remote-a' })],
      }),
      session({ nodeId: 'remote-a' })
    );
    expect(routed.attachDisabledReason).toBeNull();
    expect(routed.smallInputDisabledReason).toBeNull();

    const routedHumanTerminal = session({
      id: 'remote-terminal-584',
      nodeId: 'mac-node',
      type: 'terminal',
      agent: 'claude',
      controlMode: 'human-driven',
      agentState: 'idle',
      cwd: '/Users/ebi/project',
      globalSessionId: 'mac-node:remote-terminal-584',
    });
    const routedHumanTerminalState = activeWorkMobileControlState(
      group({
        node: { nodeId: 'mac-node', status: 'online', kind: 'remote' },
        sessions: [routedHumanTerminal],
      }),
      routedHumanTerminal
    );
    expect(routedHumanTerminalState.attachDisabledReason).toBeNull();
    expect(routedHumanTerminalState.smallInputDisabledReason).toBeNull();
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

  it('keeps unknown control state disabled but scopes routed attach/input keys', () => {
    const state = activeWorkMobileControlState(
      group({
        node: { nodeId: 'remote-a', status: 'online', kind: 'remote' },
        sessions: [session({ nodeId: 'remote-a', controlFreshness: 'unknown' })],
      }),
      session({ nodeId: 'remote-a', controlFreshness: 'unknown' })
    );
    expect(state.smallInputDisabledReason).toBe('unknown control state');
    expect(
      activeWorkSessionActivationKey(
        session({ id: 'remote-session-1', nodeId: 'remote-a' })
      )
    ).toBe('remote-a:remote-session-1');
    expect(
      activeWorkSessionActivationKey(
        session({
          id: 'remote-session-1',
          nodeId: 'remote-a',
          globalSessionId: 'remote-a:known-global',
        })
      )
    ).toBe('remote-a:known-global');
    expect(
      activeWorkSessionActivationKey(
        session({ id: 'local-session-1', nodeId: DEFAULT_LOCAL_NODE_ID })
      )
    ).toBe('local:local-session-1');
    expect(
      activeWorkSessionActivationKey(session({ id: 'local-session-2' }))
    ).toBe('local:local-session-2');
  });
});
