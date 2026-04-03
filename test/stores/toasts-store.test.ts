import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { useToastStore } from '../../frontend/src/lib/stores/toasts.js';

function resetStore() {
  useToastStore.setState({ toasts: [] });
}

describe('toasts Zustand store', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('showToast', () => {
    it('adds a toast to the list', () => {
      useToastStore.getState().showToast('Something went wrong');
      const { toasts } = useToastStore.getState();
      assert.strictEqual(toasts.length, 1);
      assert.strictEqual(toasts[0]!.message, 'Something went wrong');
    });

    it('defaults to error variant', () => {
      useToastStore.getState().showToast('Error message');
      assert.strictEqual(useToastStore.getState().toasts[0]!.variant, 'error');
    });

    it('accepts info variant', () => {
      useToastStore.getState().showToast('Info message', { variant: 'info' });
      assert.strictEqual(useToastStore.getState().toasts[0]!.variant, 'info');
    });

    it('assigns unique ids to each toast', () => {
      useToastStore.getState().showToast('First');
      useToastStore.getState().showToast('Second');
      const { toasts } = useToastStore.getState();
      assert.strictEqual(toasts.length, 2);
      assert.notStrictEqual(toasts[0]!.id, toasts[1]!.id);
    });

    it('accumulates multiple toasts', () => {
      useToastStore.getState().showToast('A');
      useToastStore.getState().showToast('B');
      useToastStore.getState().showToast('C');
      assert.strictEqual(useToastStore.getState().toasts.length, 3);
    });
  });

  describe('dismissToast', () => {
    it('removes a toast by id', () => {
      useToastStore.getState().showToast('Keep');
      useToastStore.getState().showToast('Remove');
      const toasts = useToastStore.getState().toasts;
      const removeId = toasts[1]!.id;
      useToastStore.getState().dismissToast(removeId);
      const remaining = useToastStore.getState().toasts;
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0]!.message, 'Keep');
    });

    it('is a no-op for unknown id', () => {
      useToastStore.getState().showToast('Only one');
      useToastStore.getState().dismissToast(99999);
      assert.strictEqual(useToastStore.getState().toasts.length, 1);
    });

    it('can dismiss all toasts one by one', () => {
      useToastStore.getState().showToast('A');
      useToastStore.getState().showToast('B');
      const ids = useToastStore.getState().toasts.map((t) => t.id);
      for (const id of ids) {
        useToastStore.getState().dismissToast(id);
      }
      assert.strictEqual(useToastStore.getState().toasts.length, 0);
    });
  });
});
