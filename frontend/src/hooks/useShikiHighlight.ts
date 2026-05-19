/**
 * useShikiHighlight — shiki tokenization with GC-aware caching.
 *
 * Wraps `tokenizeCode` from lib/shiki.ts and integrates with the shiki-gc
 * store. Consumers call this hook instead of calling tokenizeCode directly.
 *
 * Behaviour
 * ─────────
 * - Renders plain text immediately (tokens = null) while highlighting runs.
 * - When highlight output is evicted by GC, re-triggers tokenization from
 *   the cached source without re-fetching the file.
 * - Calls `touchTab(key)` on every activation so the GC last-view clock is
 *   refreshed.
 */

import { useEffect, useRef } from 'react';
import { tokenizeCode, type ThemedToken } from '../lib/shiki.js';
import { useShikiGcStore } from '../lib/stores/shiki-gc.js';

export interface UseShikiHighlightResult {
  /** Highlight tokens, or null while highlighting / after GC eviction. */
  tokens: ThemedToken[][] | null;
  /** Whether a tokenization pass is currently in-flight. */
  highlighting: boolean;
}

/**
 * @param key    Stable identity for this code block (e.g. `"${workspacePath}:${filePath}"`).
 * @param code   Raw source text.
 * @param language  Language identifier (e.g. "typescript").
 */
export function useShikiHighlight(
  key: string,
  code: string,
  language: string
): UseShikiHighlightResult {
  const setEntry = useShikiGcStore((s) => s.setEntry);
  const setHighlightOutput = useShikiGcStore((s) => s.setHighlightOutput);
  const touchTab = useShikiGcStore((s) => s.touchTab);
  const entry = useShikiGcStore((s) => s.entries.get(key));

  // Track the current tokenization generation to discard stale results.
  const genRef = useRef(0);

  // Touch the tab on every render so GC knows it's actively viewed.
  useEffect(() => {
    touchTab(key);
  });

  // Kick off highlighting when:
  //   (a) the entry doesn't exist yet, or
  //   (b) the source changed, or
  //   (c) highlight output was evicted (entry exists but highlightOutput === null).
  useEffect(() => {
    if (!code) return;

    const currentOutput = entry?.highlightOutput ?? null;
    const currentSource = entry?.source;

    // Already highlighted and source matches — nothing to do.
    if (currentOutput !== null && currentSource === code) return;

    // Register the entry immediately with null output so the GC store has
    // the source cached before the async highlight completes.
    setEntry(key, code, language, null);

    const gen = ++genRef.current;

    tokenizeCode(code, language)
      .then((tokens) => {
        if (gen !== genRef.current) return; // stale
        setHighlightOutput(key, tokens);
      })
      .catch(() => {
        // Tokenization failure is non-fatal — plain text stays visible.
      });
  }, [key, code, language, entry, setEntry, setHighlightOutput]);

  const tokens =
    entry?.highlightOutput !== null && entry?.highlightOutput !== undefined
      ? (entry.highlightOutput as ThemedToken[][])
      : null;

  const highlighting =
    entry === undefined ||
    (entry.source === code && entry.highlightOutput === null);

  return { tokens, highlighting };
}
