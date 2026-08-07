import { describe, expect, it } from 'vitest';
import {
  createLegacyControlStateSummary,
  isControlMode,
  isControlStateSummary,
  normalizeControlActors,
  normalizeControlStateSummary,
} from '../shared/control-state.js';

describe('human terminal control-state contract', () => {
  it('uses human-driven as the only supported terminal ownership mode', () => {
    expect(isControlMode('human-driven')).toBe(true);
    expect(isControlMode('agent-driven')).toBe(false);
    expect(isControlMode('co-driven')).toBe(false);
  });

  it('defaults missing and retired ownership state to a human backfill', () => {
    expect(createLegacyControlStateSummary()).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'local-user' }],
      controlFreshness: 'unknown',
    });
    expect(
      normalizeControlStateSummary({
        controlMode: 'agent-driven',
        activeActors: [{ kind: 'agent', id: 'worker-1' }],
        activeWorker: { kind: 'agent', id: 'worker-1' },
        controlFreshness: 'fresh',
      })
    ).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'local-user' }],
      controlFreshness: 'unknown',
      controlReason: 'legacy-backfill',
    });
  });

  it('preserves a valid human-driven summary', () => {
    const state = normalizeControlStateSummary({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'operator' }],
      controlFreshness: 'fresh',
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
    });
    expect(state).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'operator' }],
      controlFreshness: 'fresh',
    });
    expect(isControlStateSummary(state)).toBe(true);
  });

  it('rejects activeWorker ownership even on an otherwise valid summary', () => {
    expect(
      isControlStateSummary({
        controlMode: 'human-driven',
        activeActors: [{ kind: 'human', id: 'operator' }],
        activeWorker: { kind: 'agent', id: 'worker-1' },
        controlFreshness: 'fresh',
        lastInterventionAt: null,
        lastInterventionBy: null,
        lastInterventionEventId: null,
      })
    ).toBe(false);
  });

  it('keeps actor identities collision-safe for intervention attribution', () => {
    expect(
      normalizeControlActors([
        { kind: 'agent', id: 'agent:node', nodeId: 'session' },
        { kind: 'agent', id: 'agent', nodeId: 'node:session' },
        { kind: 'agent', id: 'agent:node', nodeId: 'session' },
      ])
    ).toHaveLength(2);
  });
});
