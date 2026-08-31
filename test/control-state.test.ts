import { describe, expect, it } from 'vitest';
import {
  createLegacyControlStateSummary,
  isControlMode,
  isControlStateSummary,
  normalizeControlActors,
  normalizeControlStateSummary,
} from '../shared/control-state.js';

describe('terminal control-state contract', () => {
  it('validates known control modes and rejects unknown values', () => {
    expect(isControlMode('human-driven')).toBe(true);
    expect(isControlMode('agent-driven')).toBe(true);
    expect(isControlMode('co-driven')).toBe(true);
    expect(isControlMode('unknown')).toBe(false);
    expect(isControlMode('retired-mode')).toBe(false);
    expect(isControlMode(123)).toBe(false);
    expect(isControlMode(null)).toBe(false);
    expect(isControlMode(undefined)).toBe(false);
  });

  it('defaults missing and retired ownership state to a human backfill', () => {
    expect(createLegacyControlStateSummary()).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'local-user' }],
      controlFreshness: 'unknown',
    });
    expect(
      normalizeControlStateSummary({
        controlMode: 'retired-mode',
        activeActors: [{ kind: 'agent', id: 'worker-1' }],
        controlFreshness: 'fresh',
      })
    ).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'local-user' }],
      controlFreshness: 'unknown',
      controlReason: 'legacy-backfill',
    });
    expect(
      normalizeControlStateSummary({
        controlMode: 'human-driven',
        activeActors: [],
        controlFreshness: 'fresh',
      })
    ).toMatchObject({
      controlMode: 'human-driven',
      activeActors: [{ kind: 'human', id: 'local-user' }],
      controlFreshness: 'unknown',
      controlReason: 'legacy-backfill',
    });
  });

  it('preserves a valid summary across supported control modes', () => {
    for (const mode of ['human-driven', 'agent-driven', 'co-driven'] as const) {
      const state = normalizeControlStateSummary({
        controlMode: mode,
        activeActors: [{ kind: 'human', id: 'operator' }],
        controlFreshness: 'fresh',
        lastInterventionAt: null,
        lastInterventionBy: null,
        lastInterventionEventId: null,
      });
      expect(state).toMatchObject({
        controlMode: mode,
        activeActors: [{ kind: 'human', id: 'operator' }],
        controlFreshness: 'fresh',
      });
      expect(isControlStateSummary(state)).toBe(true);
    }
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
