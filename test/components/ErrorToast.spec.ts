import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('toasts.store', () => {
  let useToastStore: typeof import('../../frontend/src/lib/state/toasts.store.js').useToastStore;
  let showToast: typeof import('../../frontend/src/lib/state/toasts.store.js').showToast;
  let dismissToast: typeof import('../../frontend/src/lib/state/toasts.store.js').dismissToast;
  let getToasts: typeof import('../../frontend/src/lib/state/toasts.store.js').getToasts;

  beforeEach(async () => {
    const store = await import('../../frontend/src/lib/state/toasts.store.js');
    useToastStore = store.useToastStore;
    showToast = store.showToast;
    dismissToast = store.dismissToast;
    getToasts = store.getToasts;
    useToastStore.setState({ toasts: [] });
  });

  it('initializes with empty toasts', () => {
    const state = useToastStore.getState();
    assert.deepStrictEqual(state.toasts, []);
  });

  it('showToast adds a toast to the store', () => {
    showToast('Test message', 'error');
    const state = useToastStore.getState();
    assert.strictEqual(state.toasts.length, 1);
    assert.strictEqual(state.toasts[0]?.message, 'Test message');
    assert.strictEqual(state.toasts[0]?.variant, 'error');
  });

  it('showToast uses default variant', () => {
    showToast('Default test');
    const state = useToastStore.getState();
    assert.strictEqual(state.toasts[0]?.variant, 'error');
  });

  it('showToast supports info variant', () => {
    showToast('Info message', 'info');
    const state = useToastStore.getState();
    assert.strictEqual(state.toasts[0]?.variant, 'info');
  });

  it('dismissToast removes a toast by id', () => {
    showToast('First', 'error');
    showToast('Second', 'info');

    let state = useToastStore.getState();
    assert.strictEqual(state.toasts.length, 2);

    const firstId = state.toasts[0]?.id;
    if (firstId !== undefined) {
      dismissToast(firstId);
    }

    state = useToastStore.getState();
    assert.strictEqual(state.toasts.length, 1);
    assert.strictEqual(state.toasts[0]?.message, 'Second');
  });

  it('getToasts returns current toasts array', () => {
    showToast('Toast 1');
    showToast('Toast 2');
    const toasts = getToasts();
    assert.strictEqual(toasts.length, 2);
  });

  it('toast ids are unique', () => {
    showToast('First');
    showToast('Second');
    showToast('Third');

    const state = useToastStore.getState();
    const ids = state.toasts.map((t) => t.id);
    const uniqueIds = new Set(ids);
    assert.strictEqual(uniqueIds.size, ids.length, 'All toast IDs should be unique');
  });
});