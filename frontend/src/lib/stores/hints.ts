import { create } from 'zustand';

const STORAGE_KEY = 'relay-ide:hints-seen';
const MAX_ACTIVE_HINTS = 2;
export const MIN_GAP_MS = 10_000;

// ── localStorage helpers ───────────────────────────────────────────────────────

function loadSeenHints(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* private browsing or parse error — use in-memory fallback */
  }
  return new Set();
}

function saveSeenHints(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* unavailable — in-memory only */
  }
}

// ── Store interface ────────────────────────────────────────────────────────────

export interface HintsState {
  seenIds: Set<string>;
  activeHintCount: number;
  lastShownAt: number | null;
  markSeen: (id: string) => void;
  isHintSeen: (id: string) => boolean;
  resetAllHints: () => void;
  canShowHint: () => boolean;
  incrementActive: (opts?: { updateTimestamp?: boolean }) => void;
  decrementActive: () => void;
}

export const useHintsStore = create<HintsState>()((set, get) => ({
  seenIds: loadSeenHints(),
  activeHintCount: 0,
  lastShownAt: null,

  markSeen: (id) => {
    const next = new Set(get().seenIds);
    next.add(id);
    saveSeenHints(next);
    set({ seenIds: next });
  },

  isHintSeen: (id) => get().seenIds.has(id),

  resetAllHints: () => {
    const empty = new Set<string>();
    saveSeenHints(empty);
    set({ seenIds: empty, activeHintCount: 0, lastShownAt: null });
  },

  canShowHint: () => {
    const { activeHintCount, lastShownAt } = get();
    if (activeHintCount >= MAX_ACTIVE_HINTS) return false;
    if (lastShownAt !== null && Date.now() - lastShownAt < MIN_GAP_MS)
      return false;
    return true;
  },

  incrementActive: (opts?: { updateTimestamp?: boolean }) =>
    set((s) => ({
      activeHintCount: s.activeHintCount + 1,
      lastShownAt: opts?.updateTimestamp === false ? s.lastShownAt : Date.now(),
    })),

  decrementActive: () =>
    set((s) => ({
      activeHintCount: Math.max(0, s.activeHintCount - 1),
    })),
}));

export default useHintsStore;
