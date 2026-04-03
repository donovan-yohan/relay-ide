import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock localStorage before importing the store
const storage: Record<string, string> = {};
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => { storage[key] = value; },
      removeItem: (key: string) => { delete storage[key]; },
      clear: () => { for (const key of Object.keys(storage)) delete storage[key]; },
      get length() { return Object.keys(storage).length; },
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
      assert.strictEqual(useUnreadStore.getState().isUnread('item-1'), true);
    });

    it('persists to localStorage', () => {
      useUnreadStore.getState().markUnread('item-1');
      const stored = JSON.parse(storage['claude-remote-unread']!);
      assert.deepStrictEqual(stored, ['item-1']);
    });

    it('is idempotent', () => {
      useUnreadStore.getState().markUnread('item-1');
      useUnreadStore.getState().markUnread('item-1');
      assert.strictEqual(useUnreadStore.getState().unreadItems.size, 1);
    });
  });

  describe('markRead', () => {
    it('marks an item as read', () => {
      useUnreadStore.getState().markUnread('item-1');
      useUnreadStore.getState().markRead('item-1');
      assert.strictEqual(useUnreadStore.getState().isUnread('item-1'), false);
    });

    it('is a no-op for unknown items', () => {
      useUnreadStore.getState().markRead('nonexistent');
      assert.strictEqual(useUnreadStore.getState().unreadItems.size, 0);
    });

    it('persists removal to localStorage', () => {
      useUnreadStore.getState().markUnread('item-1');
      useUnreadStore.getState().markUnread('item-2');
      useUnreadStore.getState().markRead('item-1');
      const stored = JSON.parse(storage['claude-remote-unread']!) as string[];
      assert.strictEqual(stored.length, 1);
      assert.ok(stored.includes('item-2'));
    });
  });

  describe('isUnread', () => {
    it('returns false for items not marked', () => {
      assert.strictEqual(useUnreadStore.getState().isUnread('unknown'), false);
    });

    it('returns true for marked items', () => {
      useUnreadStore.getState().markUnread('item-1');
      assert.strictEqual(useUnreadStore.getState().isUnread('item-1'), true);
    });
  });

  describe('pruneUnread', () => {
    it('removes items not in valid set', () => {
      useUnreadStore.getState().markUnread('keep');
      useUnreadStore.getState().markUnread('remove');
      useUnreadStore.getState().pruneUnread(new Set(['keep']));
      assert.strictEqual(useUnreadStore.getState().isUnread('keep'), true);
      assert.strictEqual(useUnreadStore.getState().isUnread('remove'), false);
    });

    it('is a no-op when all items are valid', () => {
      useUnreadStore.getState().markUnread('a');
      useUnreadStore.getState().markUnread('b');
      useUnreadStore.getState().pruneUnread(new Set(['a', 'b']));
      assert.strictEqual(useUnreadStore.getState().unreadItems.size, 2);
    });

    it('handles empty valid set', () => {
      useUnreadStore.getState().markUnread('a');
      useUnreadStore.getState().pruneUnread(new Set());
      assert.strictEqual(useUnreadStore.getState().unreadItems.size, 0);
    });

    it('is a no-op when already empty', () => {
      useUnreadStore.getState().pruneUnread(new Set(['a']));
      assert.strictEqual(useUnreadStore.getState().unreadItems.size, 0);
    });
  });
});
