import { create } from 'zustand';

const UNREAD_STORAGE_KEY = 'claude-remote-unread';

function loadUnread(): Set<string> {
  try {
    const stored = localStorage.getItem(UNREAD_STORAGE_KEY);
    if (!stored) return new Set();
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id: unknown) => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function saveUnread(items: Set<string>): void {
  try {
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify([...items]));
  } catch {
    /* localStorage unavailable */
  }
}

export interface UnreadState {
  unreadItems: Set<string>;
  isUnread: (itemId: string) => boolean;
  markUnread: (itemId: string) => void;
  markRead: (itemId: string) => void;
  pruneUnread: (validIds: Set<string>) => void;
}

export const useUnreadStore = create<UnreadState>()((set, get) => ({
  unreadItems: loadUnread(),

  isUnread: (itemId: string) => get().unreadItems.has(itemId),

  markUnread: (itemId: string) => {
    const { unreadItems } = get();
    if (!unreadItems.has(itemId)) {
      const next = new Set(unreadItems);
      next.add(itemId);
      saveUnread(next);
      set({ unreadItems: next });
    }
  },

  markRead: (itemId: string) => {
    const { unreadItems } = get();
    if (unreadItems.has(itemId)) {
      const next = new Set(unreadItems);
      next.delete(itemId);
      saveUnread(next);
      set({ unreadItems: next });
    }
  },

  pruneUnread: (validIds: Set<string>) => {
    const { unreadItems } = get();
    const next = new Set<string>();
    let pruned = false;
    for (const id of unreadItems) {
      if (validIds.has(id)) {
        next.add(id);
      } else {
        pruned = true;
      }
    }
    if (pruned) {
      saveUnread(next);
      set({ unreadItems: next });
    }
  },
}));

export default useUnreadStore;
