import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.deepStrictEqual(getAction('session.new-agent'), action);
  });

  it('registerGlobal with duplicate ID throws', () => {
    const action = makeAction({ id: 'session.new-agent' });
    registerGlobal([action]);
    assert.throws(
      () => registerGlobal([makeAction({ id: 'session.new-agent' })]),
      /already registered/
    );
  });

  it('registerContextual + unregisterContextual lifecycle', () => {
    const action = makeAction({ id: 'ctx.temp' });
    registerContextual([action]);
    assert.deepStrictEqual(getAction('ctx.temp'), action);
    unregisterContextual(['ctx.temp']);
    assert.strictEqual(getAction('ctx.temp'), undefined);
  });

  it('unregister action that was never registered is a no-op', () => {
    assert.doesNotThrow(() => unregisterContextual(['nonexistent']));
  });

  it('getAction returns undefined for unknown ID', () => {
    assert.strictEqual(getAction('nope'), undefined);
  });

  it('getAllActions returns global + contextual', () => {
    registerGlobal([makeAction({ id: 'a' })]);
    registerContextual([makeAction({ id: 'b' })]);
    const all = getAllActions();
    assert.strictEqual(all.length, 2);
    assert.ok(all.some((a: Action) => a.id === 'a'));
    assert.ok(all.some((a: Action) => a.id === 'b'));
  });

  it('getActionsByCategory filters correctly', () => {
    registerGlobal([
      makeAction({ id: 'session.a', category: 'session' }),
      makeAction({ id: 'pr.b', category: 'pr' }),
      makeAction({ id: 'session.c', category: 'session' }),
    ]);
    const sessions = getActionsByCategory('session');
    assert.strictEqual(sessions.length, 2);
    assert.ok(sessions.every((a: Action) => a.category === 'session'));
  });
});
