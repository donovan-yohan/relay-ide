import { describe, it, beforeEach, expect } from 'vitest';

// Mock localStorage before importing the store
const storage: Record<string, string> = {};
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        for (const key of Object.keys(storage)) delete storage[key];
      },
      get length() {
        return Object.keys(storage).length;
      },
      key: (index: number) => Object.keys(storage)[index] ?? null,
    },
    configurable: true,
  });
}

import { useUnreadStore } from '../../frontend/src/lib/stores/unread.js';

function resetStore() {
  for (const key of Object.keys(storage)) delete storage[key];
  useUnreadStore.setState({ unreadItems: new Set() });
}

describe('unread Zustand store', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('markUnread', () => {
    it('marks an item as unread', () => {
      useUnreadStore.getState().markUnread('item-1');
      expect(useUnreadStore.getState().isUnread('item-1')).toBe(true);
    });

    it('persists to localStorage', () => {
      useUnreadStore.getState().markUnread('item-1');
      const stored = JSON.parse(storage['claude-remote-unread']!);
      expect(stored).toEqual(['item-1']);
    });

    it('is idempotent', () => {
      useUnreadStore.getState().markUnread('item-1');
      useUnreadStore.getState().markUnread('item-1');
      expect(useUnreadStore.getState().unreadItems.size).toBe(1);
    });
  });

  describe('markRead', () => {
    it('marks an item as read', () => {
      useUnreadStore.getState().markUnread('item-1');
      useUnreadStore.getState().markRead('item-1');
      expect(useUnreadStore.getState().isUnread('item-1')).toBe(false);
    });

    it('is a no-op for unknown items', () => {
      useUnreadStore.getState().markRead('nonexistent');
      expect(useUnreadStore.getState().unreadItems.size).toBe(0);
    });

    it('persists removal to localStorage', () => {
      useUnreadStore.getState().markUnread('item-1');
      useUnreadStore.getState().markUnread('item-2');
      useUnreadStore.getState().markRead('item-1');
      const stored = JSON.parse(storage['claude-remote-unread']!) as string[];
      expect(stored.length).toBe(1);
      expect(stored.includes('item-2')).toBeTruthy();
    });
  });

  describe('isUnread', () => {
    it('returns false for items not marked', () => {
      expect(useUnreadStore.getState().isUnread('unknown')).toBe(false);
    });

    it('returns true for marked items', () => {
      useUnreadStore.getState().markUnread('item-1');
      expect(useUnreadStore.getState().isUnread('item-1')).toBe(true);
    });
  });

  describe('pruneUnread', () => {
    it('removes items not in valid set', () => {
      useUnreadStore.getState().markUnread('keep');
      useUnreadStore.getState().markUnread('remove');
      useUnreadStore.getState().pruneUnread(new Set(['keep']));
      expect(useUnreadStore.getState().isUnread('keep')).toBe(true);
      expect(useUnreadStore.getState().isUnread('remove')).toBe(false);
    });

    it('is a no-op when all items are valid', () => {
      useUnreadStore.getState().markUnread('a');
      useUnreadStore.getState().markUnread('b');
      useUnreadStore.getState().pruneUnread(new Set(['a', 'b']));
      expect(useUnreadStore.getState().unreadItems.size).toBe(2);
    });

    it('handles empty valid set', () => {
      useUnreadStore.getState().markUnread('a');
      useUnreadStore.getState().pruneUnread(new Set());
      expect(useUnreadStore.getState().unreadItems.size).toBe(0);
    });

    it('is a no-op when already empty', () => {
      useUnreadStore.getState().pruneUnread(new Set(['a']));
      expect(useUnreadStore.getState().unreadItems.size).toBe(0);
    });
  });
});
