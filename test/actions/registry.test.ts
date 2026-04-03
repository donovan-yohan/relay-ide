import { describe, it, beforeEach, expect } from 'vitest';
import {
  registerGlobal,
  registerContextual,
  unregisterContextual,
  getAction,
  getAllActions,
  getActionsByCategory,
  _resetForTesting,
} from '../../frontend/src/lib/actions/registry.js';
import type { Action } from '../../frontend/src/lib/actions/types.js';

function makeAction(overrides: Partial<Action> & { id: string }): Action {
  return {
    label: overrides.id,
    category: 'session',
    handler: () => {},
    ...overrides,
  };
}

describe('ActionRegistry', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('registerGlobal adds actions retrievable via getAction', () => {
    const action = makeAction({ id: 'session.new-agent' });
    registerGlobal([action]);
    expect(getAction('session.new-agent')).toEqual(action);
  });

  it('registerGlobal with duplicate ID overwrites (idempotent for HMR)', () => {
    const action1 = makeAction({ id: 'session.new-agent', label: 'v1' });
    registerGlobal([action1]);
    const action2 = makeAction({ id: 'session.new-agent', label: 'v2' });
    registerGlobal([action2]);
    expect(getAction('session.new-agent')?.label).toBe('v2');
  });

  it('registerContextual + unregisterContextual lifecycle', () => {
    const action = makeAction({ id: 'session.temp' });
    registerContextual([action]);
    expect(getAction('session.temp')).toEqual(action);
    unregisterContextual(['session.temp']);
    expect(getAction('session.temp')).toBe(undefined);
  });

  it('unregister action that was never registered is a no-op', () => {
    expect(() => unregisterContextual(['nonexistent'])).not.toThrow();
  });

  it('getAction returns undefined for unknown ID', () => {
    expect(getAction('nope')).toBe(undefined);
  });

  it('getAllActions returns global + contextual', () => {
    registerGlobal([makeAction({ id: 'session.a' })]);
    registerContextual([makeAction({ id: 'session.b' })]);
    const all = getAllActions();
    expect(all.length).toBe(2);
    expect(all.some((a: Action) => a.id === 'session.a')).toBe(true);
    expect(all.some((a: Action) => a.id === 'session.b')).toBe(true);
  });

  it('getActionsByCategory filters correctly', () => {
    registerGlobal([
      makeAction({ id: 'session.a', category: 'session' }),
      makeAction({ id: 'pr.b', category: 'pr' }),
      makeAction({ id: 'session.c', category: 'session' }),
    ]);
    const sessions = getActionsByCategory('session');
    expect(sessions.length).toBe(2);
    expect(
      sessions.every((a: Action) => a.category === 'session')
    ).toBeTruthy();
  });
});
