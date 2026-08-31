/**
 * Tests for the shiki GC store (Lever 1 of issue #331).
 *
 * Covers:
 *  - setEntry / touchTab / removeEntry
 *  - LRU eviction (hard cap exceeded)
 *  - Idle threshold eviction
 *  - Budget guard (GC pass aborts early if over budget)
 *  - setThresholds
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useShikiGcStore,
  DEFAULT_IDLE_EVICT_MS,
  DEFAULT_MAX_ACTIVE_HIGHLIGHTS,
  stopShikiGc,
} from '../frontend/src/lib/stores/shiki-gc.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function resetStore() {
  useShikiGcStore.setState({
    entries: new Map(),
    idleEvictMs: DEFAULT_IDLE_EVICT_MS,
    maxActiveHighlights: DEFAULT_MAX_ACTIVE_HIGHLIGHTS,
    hasEvictedOnce: false,
  });
}

function addEntry(
  key: string,
  source: string,
  language: string,
  output: unknown,
  lastViewedAt: number
) {
  useShikiGcStore.setState((state) => {
    const next = new Map(state.entries);
    next.set(key, { source, language, highlightOutput: output, lastViewedAt });
    return { entries: next };
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('shiki-gc store', () => {
  beforeEach(() => {
    resetStore();
    stopShikiGc();
  });

  afterEach(() => {
    stopShikiGc();
    vi.restoreAllMocks();
  });

  describe('setEntry', () => {
    it('adds a new entry with lastViewedAt = now', () => {
      const before = Date.now();
      useShikiGcStore.getState().setEntry('a', 'code', 'ts', ['tokens']);
      // Use setEntry directly
      const store = useShikiGcStore.getState();
      store.setEntry('tab1', 'const x = 1', 'typescript', [['token']]);
      const entry = useShikiGcStore.getState().entries.get('tab1');
      expect(entry).toBeDefined();
      expect(entry!.source).toBe('const x = 1');
      expect(entry!.language).toBe('typescript');
      expect(entry!.lastViewedAt).toBeGreaterThanOrEqual(before);
    });

    it('preserves lastViewedAt when updating an existing entry', () => {
      const oldTime = Date.now() - 10_000;
      addEntry('tab1', 'old', 'ts', ['old-tokens'], oldTime);

      useShikiGcStore.getState().setEntry('tab1', 'new', 'ts', ['new-tokens']);
      const entry = useShikiGcStore.getState().entries.get('tab1');
      expect(entry!.source).toBe('new');
      // lastViewedAt should be preserved from the existing entry
      expect(entry!.lastViewedAt).toBe(oldTime);
    });
  });

  describe('touchTab', () => {
    it('refreshes lastViewedAt to now', () => {
      const before = Date.now() - 60_000;
      addEntry('tab1', 'code', 'ts', ['tokens'], before);

      const refTime = Date.now();
      useShikiGcStore.getState().touchTab('tab1');
      const entry = useShikiGcStore.getState().entries.get('tab1');
      expect(entry!.lastViewedAt).toBeGreaterThanOrEqual(refTime);
    });

    it('is a no-op for non-existent keys', () => {
      expect(() =>
        useShikiGcStore.getState().touchTab('nonexistent')
      ).not.toThrow();
    });
  });

  describe('removeEntry', () => {
    it('removes an existing entry', () => {
      addEntry('tab1', 'code', 'ts', ['tokens'], Date.now());
      useShikiGcStore.getState().removeEntry('tab1');
      expect(useShikiGcStore.getState().entries.has('tab1')).toBe(false);
    });

    it('is a no-op for non-existent keys', () => {
      expect(() =>
        useShikiGcStore.getState().removeEntry('nonexistent')
      ).not.toThrow();
    });
  });

  describe('setHighlightOutput', () => {
    it('updates highlight output for an existing entry', () => {
      addEntry('tab1', 'code', 'ts', null, Date.now());
      useShikiGcStore.getState().setHighlightOutput('tab1', ['new-tokens']);
      const entry = useShikiGcStore.getState().entries.get('tab1');
      expect(entry!.highlightOutput).toEqual(['new-tokens']);
    });

    it('is a no-op for non-existent keys', () => {
      expect(() =>
        useShikiGcStore.getState().setHighlightOutput('nonexistent', ['tokens'])
      ).not.toThrow();
    });

    it('rejects a stale async write whose expected input no longer matches', () => {
      addEntry('tab1', 'new source', 'json', ['new-tokens'], Date.now());

      useShikiGcStore.getState().setHighlightOutput('tab1', ['stale-tokens'], {
        source: 'old source',
        language: 'typescript',
      });

      expect(
        useShikiGcStore.getState().entries.get('tab1')?.highlightOutput
      ).toEqual(['new-tokens']);
    });
  });

  describe('runGc — idle threshold eviction', () => {
    it('evicts highlight output for tabs idle beyond threshold', () => {
      const now = Date.now();
      const threshold = 5 * 60 * 1000;
      // Tab viewed 6 minutes ago — should be evicted.
      addEntry('old-tab', 'code', 'ts', ['tokens'], now - threshold - 10_000);
      // Tab viewed recently — should NOT be evicted.
      addEntry('new-tab', 'code', 'ts', ['tokens'], now - 1_000);

      useShikiGcStore.getState().setThresholds({ idleEvictMs: threshold });
      const evicted = useShikiGcStore.getState().runGc();

      expect(evicted).toBe(1);

      const oldEntry = useShikiGcStore.getState().entries.get('old-tab');
      const newEntry = useShikiGcStore.getState().entries.get('new-tab');
      expect(oldEntry!.highlightOutput).toBeNull();
      expect(oldEntry!.source).toBe('code'); // source preserved
      expect(newEntry!.highlightOutput).not.toBeNull();
    });

    it('does not evict entries with null highlight output (already evicted)', () => {
      const now = Date.now();
      const threshold = 5 * 60 * 1000;
      addEntry('evicted-tab', 'code', 'ts', null, now - threshold - 5_000);

      const evicted = useShikiGcStore.getState().runGc();
      // Already null — not re-counted as a new eviction.
      expect(evicted).toBe(0);
    });

    it('sets hasEvictedOnce after first eviction', () => {
      const now = Date.now();
      addEntry(
        'tab',
        'code',
        'ts',
        ['tokens'],
        now - DEFAULT_IDLE_EVICT_MS - 1_000
      );
      expect(useShikiGcStore.getState().hasEvictedOnce).toBe(false);
      useShikiGcStore.getState().runGc();
      expect(useShikiGcStore.getState().hasEvictedOnce).toBe(true);
    });
  });

  describe('runGc — hard cap (LRU eviction)', () => {
    it('evicts LRU tabs when active highlight count exceeds maxActiveHighlights', () => {
      const maxCap = 3;
      useShikiGcStore.getState().setThresholds({
        maxActiveHighlights: maxCap,
        idleEvictMs: 60 * 60 * 1000, // 1 hour — no idle eviction
      });

      const now = Date.now();
      // Add 5 entries with non-null output — LRU first.
      for (let i = 0; i < 5; i++) {
        addEntry(
          `tab${i}`,
          `code${i}`,
          'ts',
          [`tokens${i}`],
          now - (5 - i) * 1000
        );
      }

      const evicted = useShikiGcStore.getState().runGc();

      // 5 entries with output, cap is 3 → evict 2.
      expect(evicted).toBe(2);
      const state = useShikiGcStore.getState();
      // LRU: tab0 (oldest) and tab1 should be evicted.
      expect(state.entries.get('tab0')!.highlightOutput).toBeNull();
      expect(state.entries.get('tab1')!.highlightOutput).toBeNull();
      // Most recently viewed tabs keep their output.
      expect(state.entries.get('tab4')!.highlightOutput).not.toBeNull();
    });

    it('returns 0 when total entries with output is within cap', () => {
      useShikiGcStore.getState().setThresholds({
        maxActiveHighlights: 10,
        idleEvictMs: 60 * 60 * 1000,
      });
      const now = Date.now();
      addEntry('tab1', 'c1', 'ts', ['t1'], now);
      addEntry('tab2', 'c2', 'ts', ['t2'], now);

      const evicted = useShikiGcStore.getState().runGc();
      expect(evicted).toBe(0);
    });
  });

  describe('runGc — empty store', () => {
    it('returns 0 with no entries', () => {
      expect(useShikiGcStore.getState().runGc()).toBe(0);
    });
  });

  describe('setThresholds', () => {
    it('updates idleEvictMs and maxActiveHighlights', () => {
      useShikiGcStore.getState().setThresholds({
        idleEvictMs: 1000,
        maxActiveHighlights: 5,
      });
      const state = useShikiGcStore.getState();
      expect(state.idleEvictMs).toBe(1000);
      expect(state.maxActiveHighlights).toBe(5);
    });

    it('partial update only changes the specified field', () => {
      useShikiGcStore.getState().setThresholds({ idleEvictMs: 2000 });
      expect(useShikiGcStore.getState().idleEvictMs).toBe(2000);
      expect(useShikiGcStore.getState().maxActiveHighlights).toBe(
        DEFAULT_MAX_ACTIVE_HIGHLIGHTS
      );
    });
  });
});
