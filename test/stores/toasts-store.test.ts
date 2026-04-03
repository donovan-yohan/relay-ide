import { describe, it, beforeEach, expect } from 'vitest';

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
      expect(toasts.length).toBe(1);
      expect(toasts[0]!.message).toBe('Something went wrong');
    });

    it('defaults to error variant', () => {
      useToastStore.getState().showToast('Error message');
      expect(useToastStore.getState().toasts[0]!.variant).toBe('error');
    });

    it('accepts info variant', () => {
      useToastStore.getState().showToast('Info message', { variant: 'info' });
      expect(useToastStore.getState().toasts[0]!.variant).toBe('info');
    });

    it('assigns unique ids to each toast', () => {
      useToastStore.getState().showToast('First');
      useToastStore.getState().showToast('Second');
      const { toasts } = useToastStore.getState();
      expect(toasts.length).toBe(2);
      expect(toasts[0]!.id).not.toBe(toasts[1]!.id);
    });

    it('accumulates multiple toasts', () => {
      useToastStore.getState().showToast('A');
      useToastStore.getState().showToast('B');
      useToastStore.getState().showToast('C');
      expect(useToastStore.getState().toasts.length).toBe(3);
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
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.message).toBe('Keep');
    });

    it('is a no-op for unknown id', () => {
      useToastStore.getState().showToast('Only one');
      useToastStore.getState().dismissToast(99999);
      expect(useToastStore.getState().toasts.length).toBe(1);
    });

    it('can dismiss all toasts one by one', () => {
      useToastStore.getState().showToast('A');
      useToastStore.getState().showToast('B');
      const ids = useToastStore.getState().toasts.map((t) => t.id);
      for (const id of ids) {
        useToastStore.getState().dismissToast(id);
      }
      expect(useToastStore.getState().toasts.length).toBe(0);
    });
  });
});
