/**
 * Shiki output GC store.
 *
 * Tracks the last-viewed timestamp per tab key and evicts shiki highlight
 * output for tabs that have been idle longer than the configured threshold.
 * File content (the raw source) is never evicted — only the tokenised output.
 *
 * Algorithm
 * ─────────
 * - On every tab view, call `touchTab(key)` to refresh its timestamp.
 * - An idle-callback GC pass runs periodically (requestIdleCallback with a
 *   setTimeout fallback). If over budget the pass aborts early to avoid
 *   stalling input.
 * - Hard cap: at most MAX_ACTIVE_HIGHLIGHTS tabs keep their highlight output.
 *   When exceeded, LRU tabs are evicted first.
 * - Threshold: tabs idle > IDLE_EVICT_MS have their highlight output evicted.
 * - Consumers hold a reference to `highlightOutput` and react when it becomes
 *   null by re-highlighting from cached source.
 */

import { create } from 'zustand';

// ── Constants (configurable via setThresholds) ─────────────────────────────────

/** Default idle threshold before evicting highlight output (5 minutes). */
export const DEFAULT_IDLE_EVICT_MS = 5 * 60 * 1000;

/** Hard cap on number of tabs with active highlight output. */
export const DEFAULT_MAX_ACTIVE_HIGHLIGHTS = 10;

/** GC idle-callback scheduling interval. */
const GC_SCHEDULE_INTERVAL_MS = 60_000;

/** Max budget for a single GC pass (to avoid stalling input). */
const GC_BUDGET_MS = 10;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TabHighlightEntry {
  /** Raw source code — never evicted. */
  source: string;
  /** Tokenized highlight output — may be null after GC eviction. */
  highlightOutput: unknown | null;
  /** Language identifier for re-highlighting. */
  language: string;
  /** Epoch ms of last tab activation. */
  lastViewedAt: number;
}

interface ShikiGcState {
  /** Per-key highlight entries. */
  entries: Map<string, TabHighlightEntry>;
  /** Current idle threshold in ms. */
  idleEvictMs: number;
  /** Max active highlight entries. */
  maxActiveHighlights: number;
  /** Whether at least one eviction has occurred (for one-time toast trigger). */
  hasEvictedOnce: boolean;

  /** Register or update a tab's source + highlight output. */
  setEntry: (
    key: string,
    source: string,
    language: string,
    highlightOutput: unknown | null
  ) => void;
  /** Update highlight output only (after async re-highlighting). */
  setHighlightOutput: (key: string, highlightOutput: unknown | null) => void;
  /** Record that a tab is being viewed now (refreshes lastViewedAt). */
  touchTab: (key: string) => void;
  /** Remove a tab entry entirely (tab closed). */
  removeEntry: (key: string) => void;
  /** Run a GC pass — evict idle / over-cap entries. Returns evicted count. */
  runGc: () => number;
  /** Update thresholds at runtime (config-driven). */
  setThresholds: (opts: {
    idleEvictMs?: number;
    maxActiveHighlights?: number;
  }) => void;
  /** Mark that a toast was already shown for the first eviction. */
  acknowledgeEviction: () => void;
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useShikiGcStore = create<ShikiGcState>((set, get) => ({
  entries: new Map(),
  idleEvictMs: DEFAULT_IDLE_EVICT_MS,
  maxActiveHighlights: DEFAULT_MAX_ACTIVE_HIGHLIGHTS,
  hasEvictedOnce: false,

  setEntry: (key, source, language, highlightOutput) => {
    set((state) => {
      const next = new Map(state.entries);
      const existing = next.get(key);
      next.set(key, {
        source,
        language,
        highlightOutput,
        lastViewedAt: existing?.lastViewedAt ?? Date.now(),
      });
      return { entries: next };
    });
  },

  setHighlightOutput: (key, highlightOutput) => {
    set((state) => {
      const entry = state.entries.get(key);
      if (!entry) return state;
      const next = new Map(state.entries);
      next.set(key, { ...entry, highlightOutput });
      return { entries: next };
    });
  },

  touchTab: (key) => {
    set((state) => {
      const entry = state.entries.get(key);
      if (!entry) return state;
      const next = new Map(state.entries);
      next.set(key, { ...entry, lastViewedAt: Date.now() });
      return { entries: next };
    });
  },

  removeEntry: (key) => {
    set((state) => {
      if (!state.entries.has(key)) return state;
      const next = new Map(state.entries);
      next.delete(key);
      return { entries: next };
    });
  },

  runGc: () => {
    const { entries, idleEvictMs, maxActiveHighlights } = get();
    if (entries.size === 0) return 0;

    const now = Date.now();
    const passStart = Date.now();
    let evicted = 0;

    // Sort entries by lastViewedAt ascending (LRU first).
    const sorted = [...entries.entries()].sort(
      ([, a], [, b]) => a.lastViewedAt - b.lastViewedAt
    );

    // Phase 1: evict entries idle beyond threshold.
    const next = new Map(entries);
    for (const [key, entry] of sorted) {
      if (Date.now() - passStart > GC_BUDGET_MS) break; // budget guard
      if (
        entry.highlightOutput !== null &&
        now - entry.lastViewedAt > idleEvictMs
      ) {
        next.set(key, { ...entry, highlightOutput: null });
        evicted++;
      }
    }

    // Phase 2: enforce hard cap — evict LRU tabs with non-null output.
    if (Date.now() - passStart <= GC_BUDGET_MS) {
      const activeWithOutput = [...next.entries()]
        .filter(([, e]) => e.highlightOutput !== null)
        .sort(([, a], [, b]) => a.lastViewedAt - b.lastViewedAt);

      let overcap = activeWithOutput.length - maxActiveHighlights;
      for (const [key, entry] of activeWithOutput) {
        if (overcap <= 0) break;
        if (Date.now() - passStart > GC_BUDGET_MS) break;
        next.set(key, { ...entry, highlightOutput: null });
        evicted++;
        overcap--;
      }
    }

    if (evicted > 0) {
      set(() => ({
        entries: next,
        hasEvictedOnce: true,
      }));
    }

    return evicted;
  },

  setThresholds: (opts) => {
    set((state) => ({
      idleEvictMs: opts.idleEvictMs ?? state.idleEvictMs,
      maxActiveHighlights:
        opts.maxActiveHighlights ?? state.maxActiveHighlights,
    }));
  },

  acknowledgeEviction: () => {
    // hasEvictedOnce stays true — this just resets so the toast can fire again
    // on the next new eviction cycle. For a one-time hint, callers can track
    // separately via the hints store.
  },
}));

// ── GC scheduler ──────────────────────────────────────────────────────────────

let gcTimer: ReturnType<typeof setTimeout> | null = null;
let gcScheduled = false;

function scheduleGcPass(): void {
  if (gcScheduled) return;
  gcScheduled = true;

  const run = () => {
    gcScheduled = false;
    useShikiGcStore.getState().runGc();
    gcTimer = setTimeout(() => {
      scheduleGcPass();
    }, GC_SCHEDULE_INTERVAL_MS);
  };

  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(
      (deadline) => {
        if (deadline.timeRemaining() > 0) {
          run();
        } else {
          // No idle time right now — retry after a short delay.
          gcScheduled = false;
          gcTimer = setTimeout(() => scheduleGcPass(), 1000);
        }
      },
      { timeout: GC_SCHEDULE_INTERVAL_MS }
    );
  } else {
    // Fallback for environments without requestIdleCallback (tests, SSR).
    gcTimer = setTimeout(run, GC_SCHEDULE_INTERVAL_MS);
  }
}

/** Start the GC scheduler. Safe to call multiple times (idempotent). */
export function startShikiGc(): void {
  if (gcTimer !== null || gcScheduled) return;
  scheduleGcPass();
}

/** Stop the GC scheduler (for tests). */
export function stopShikiGc(): void {
  if (gcTimer !== null) {
    clearTimeout(gcTimer);
    gcTimer = null;
  }
  gcScheduled = false;
}
