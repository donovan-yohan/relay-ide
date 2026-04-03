import { describe, it, expect, beforeEach } from 'vitest';

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
    expect(state.toasts).toEqual([]);
  });

  it('showToast adds a toast to the store', () => {
    showToast('Test message', 'error');
    const state = useToastStore.getState();
    expect(state.toasts.length).toBe(1);
    expect(state.toasts[0]?.message).toBe('Test message');
    expect(state.toasts[0]?.variant).toBe('error');
  });

  it('showToast uses default variant', () => {
    showToast('Default test');
    const state = useToastStore.getState();
    expect(state.toasts[0]?.variant).toBe('error');
  });

  it('showToast supports info variant', () => {
    showToast('Info message', 'info');
    const state = useToastStore.getState();
    expect(state.toasts[0]?.variant).toBe('info');
  });

  it('dismissToast removes a toast by id', () => {
    showToast('First', 'error');
    showToast('Second', 'info');

    let state = useToastStore.getState();
    expect(state.toasts.length).toBe(2);

    const firstId = state.toasts[0]?.id;
    if (firstId !== undefined) {
      dismissToast(firstId);
    }

    state = useToastStore.getState();
    expect(state.toasts.length).toBe(1);
    expect(state.toasts[0]?.message).toBe('Second');
  });

  it('getToasts returns current toasts array', () => {
    showToast('Toast 1');
    showToast('Toast 2');
    const toasts = getToasts();
    expect(toasts.length).toBe(2);
  });

  it('toast ids are unique', () => {
    showToast('First');
    showToast('Second');
    showToast('Third');

    const state = useToastStore.getState();
    const ids = state.toasts.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
