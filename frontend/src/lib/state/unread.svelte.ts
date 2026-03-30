const UNREAD_STORAGE_KEY = 'claude-remote-unread';

let unreadItems = $state<Set<string>>(loadUnread());

function loadUnread(): Set<string> {
  try {
    const stored = localStorage.getItem(UNREAD_STORAGE_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch { return new Set(); }
}

function saveUnread(): void {
  try {
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify([...unreadItems]));
  } catch { /* localStorage unavailable */ }
}

export function isUnread(itemId: string): boolean {
  return unreadItems.has(itemId);
}

export function markUnread(itemId: string): void {
  if (!unreadItems.has(itemId)) {
    unreadItems.add(itemId);
    saveUnread();
  }
}

export function markRead(itemId: string): void {
  if (unreadItems.has(itemId)) {
    unreadItems.delete(itemId);
    saveUnread();
  }
}

export function pruneUnread(validIds: Set<string>): void {
  let pruned = false;
  for (const id of unreadItems) {
    if (!validIds.has(id)) {
      unreadItems.delete(id);
      pruned = true;
    }
  }
  if (pruned) saveUnread();
}
