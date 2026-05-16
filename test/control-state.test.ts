import { describe, expect, it } from 'vitest';
import {
  createLegacyControlStateSummary,
  isControlStateSummary,
  normalizeControlActors,
  normalizeControlStateSummary,
  type ControlStateSummary,
  type TabControlIdentity,
} from '../shared/control-state.js';

const localRepoIdentity: TabControlIdentity = {
  nodeId: 'local',
  sessionId: 'local-session',
  globalSessionId: 'local:local-session',
  cwd: '/repos/relay-ide',
  repoPath: '/repos/relay-ide',
  worktreePath: null,
  repoName: 'relay-ide',
  branchName: 'nightly',
};

const remoteNodeIdentity: TabControlIdentity = {
  nodeId: 'mac-mini',
  sessionId: 'remote-session',
  globalSessionId: 'mac-mini:remote-session',
  cwd: '/Users/dev/relay-ide/.worktrees/feature',
  repoPath: '/Users/dev/relay-ide',
  worktreePath: '/Users/dev/relay-ide/.worktrees/feature',
  repoName: 'relay-ide',
  branchName: 'feature/tab-control',
};

const freeTabIdentity: TabControlIdentity = {
  nodeId: 'local',
  sessionId: 'free-shell',
  globalSessionId: 'local:free-shell',
  cwd: '/tmp',
};

function summary(identity: TabControlIdentity): ControlStateSummary {
  return normalizeControlStateSummary({
    controlMode: 'co-driven',
    activeActors: [
      { kind: 'human', id: 'operator', displayName: 'Operator' },
      {
        kind: 'agent',
        id: 'codex',
        displayName: 'Codex',
        nodeId: identity.nodeId,
        sessionId: identity.sessionId,
      },
    ],
    activeWorker: {
      kind: 'agent',
      id: 'codex',
      displayName: 'Codex',
      nodeId: identity.nodeId,
      sessionId: identity.sessionId,
    },
    lastInterventionAt: '2026-01-02T03:04:05.000Z',
    lastInterventionBy: { kind: 'human', id: 'operator' },
    lastInterventionEventId: `evt-${identity.sessionId}`,
    controlFreshness: 'fresh',
    controlReason: 'operator handoff',
  });
}

describe('control-state contract', () => {
  it('defaults legacy/backfilled sessions to human-driven with unknown freshness', () => {
    expect(createLegacyControlStateSummary()).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'local-user' }],
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
      controlFreshness: 'unknown',
    });
    expect(normalizeControlStateSummary(undefined)).toMatchObject({
      controlMode: 'human-driven',
      controlFreshness: 'unknown',
    });
  });

  it('keeps product controlMode independent from transport mode names', () => {
    const normalized = normalizeControlStateSummary({
      controlMode: 'agent-driven',
      activeActors: [{ kind: 'agent', id: 'worker-1' }],
      controlFreshness: 'fresh',
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
    });

    expect(normalized.controlMode).toBe('agent-driven');
    expect(normalized.controlMode).not.toBe('pty');
    expect(normalized.controlMode).not.toBe('web');
    expect(normalized.controlReason).toBeUndefined();
  });

  it('normalizes malformed non-legacy summaries atomically to legacy control state', () => {
    expect(
      normalizeControlStateSummary({
        controlMode: 'agent-driven',
        controlFreshness: 'fresh',
        lastInterventionAt: null,
        lastInterventionBy: null,
        lastInterventionEventId: null,
      })
    ).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'local-user' }],
      controlFreshness: 'unknown',
      controlReason: 'legacy-backfill',
    });
  });

  it('preserves valid non-legacy summaries without inventing a control reason', () => {
    const normalized = normalizeControlStateSummary({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'operator' }],
      controlFreshness: 'fresh',
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
    });

    expect(normalized).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'operator' }],
      controlFreshness: 'fresh',
    });
    expect(normalized.controlReason).toBeUndefined();
  });

  it('dedupes actors with collision-safe tuple identity keys', () => {
    expect(
      normalizeControlActors([
        { kind: 'agent', id: 'agent:node', nodeId: 'session' },
        { kind: 'agent', id: 'agent', nodeId: 'node:session' },
        { kind: 'agent', id: 'agent:node', nodeId: 'session' },
      ])
    ).toEqual([
      { kind: 'agent', id: 'agent:node', nodeId: 'session' },
      { kind: 'agent', id: 'agent', nodeId: 'node:session' },
    ]);
  });

  it.each([
    ['local repo tab', localRepoIdentity],
    ['remote node tab', remoteNodeIdentity],
    ['free non-git tab', freeTabIdentity],
  ])('supports %s identity plus valid summary fields', (_label, identity) => {
    const state = summary(identity);

    expect(identity.nodeId).toBeTruthy();
    expect(identity.sessionId).toBeTruthy();
    expect(identity.cwd).toBeTruthy();
    expect(isControlStateSummary(state)).toBe(true);
    expect(state.activeWorker).toMatchObject({
      kind: 'agent',
      nodeId: identity.nodeId,
      sessionId: identity.sessionId,
    });
  });

  it('documents the reserved event envelope names', () => {
    const intervention = {
      eventId: 'evt-intervention-1',
      type: 'tab.intervention' as const,
      occurredAt: '2026-01-02T03:04:05.000Z',
      identity: localRepoIdentity,
      actor: { kind: 'human' as const, id: 'operator' },
      controlMode: 'human-driven' as const,
      reason: 'operator took keyboard',
    };
    const modeChanged = {
      eventId: 'evt-mode-1',
      type: 'tab.mode-changed' as const,
      occurredAt: '2026-01-02T03:04:06.000Z',
      identity: remoteNodeIdentity,
      actor: { kind: 'system' as const, id: 'scheduler' },
      previousControlMode: 'agent-driven' as const,
      controlMode: 'co-driven' as const,
    };

    expect(intervention.type).toBe('tab.intervention');
    expect(modeChanged.type).toBe('tab.mode-changed');
    expect(intervention.identity.nodeId).toBe('local');
    expect(modeChanged.identity.nodeId).toBe('mac-mini');
  });
});
