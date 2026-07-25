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
  // Track the (key, source, language) input we last kicked tokenization off
  // for, plus whether that pass has settled. This is the loop guard: registering an
  // entry mutates the store, which re-runs the highlight effect (its dep array
  // includes `entry`). Without this ref the effect would call
  // `setEntry(... null)` again on that re-run — producing a fresh entry object
  // each time and an unbounded setState→render→effect loop (React "maximum
  // update depth exceeded" / minified error #185) that unmounts the app.
  //
  // `settled` distinguishes the two reasons an entry's highlightOutput can be
  // null: still in-flight (don't re-kick — wait for it) vs evicted by GC after
  // having been populated (do re-kick to re-highlight from cached source).
  const kickedRef = useRef<{
    key: string;
    source: string;
    language: string;
    settled: boolean;
  } | null>(null);

  // Touch the tab on mount and whenever the key changes so the GC last-view
  // clock is refreshed. No dep-less effect — that would re-run on every render
  // triggered by touchTab's own store mutation, causing an infinite loop.
  useEffect(() => {
    touchTab(key);
  }, [key, touchTab]);

  // Kick off highlighting when:
  //   (a) the entry doesn't exist yet, or
  //   (b) the source or language changed, or
  //   (c) highlight output was evicted by GC (entry exists, source matches,
  //       but highlightOutput went null after previously being populated).
  useEffect(() => {
    if (!code) return;

    const currentOutput = entry?.highlightOutput ?? null;
    const currentSource = entry?.source;
    const currentLanguage = entry?.language;

    // Already highlighted and the complete input matches — nothing to do.
    if (
      currentOutput !== null &&
      currentSource === code &&
      currentLanguage === language
    ) {
      return;
    }

    // A tokenization pass is already in-flight for this exact input and has
    // not settled yet; the null output just means it has not resolved.
    // Re-registering here would loop — wait for it to call setHighlightOutput.
    const kicked = kickedRef.current;
    const inFlight =
      kicked !== null &&
      kicked.key === key &&
      kicked.source === code &&
      kicked.language === language &&
      !kicked.settled &&
      currentSource === code &&
      currentLanguage === language;
    if (inFlight) return;

    // Register the entry immediately with null output so the GC store has
    // the source cached before the async highlight completes.
    setEntry(key, code, language, null);

    const gen = ++genRef.current;
    const kick = { key, source: code, language, settled: false };
    kickedRef.current = kick;

    tokenizeCode(code, language)
      .then((tokens) => {
        kick.settled = true;
        if (gen !== genRef.current) return; // stale
        setHighlightOutput(key, tokens, { source: code, language });
      })
      .catch(() => {
        // Tokenization failure is non-fatal — plain text stays visible.
        kick.settled = true;
      });
  }, [key, code, language, entry, setEntry, setHighlightOutput]);

  // Never pair token text from a previous source/language with current raw
  // lines. A source update renders current plain text immediately until its
  // own tokenization generation settles.
  const entryMatchesInput =
    entry?.source === code && entry?.language === language;
  const tokens =
    entryMatchesInput &&
    entry?.highlightOutput !== null &&
    entry?.highlightOutput !== undefined
      ? (entry.highlightOutput as ThemedToken[][])
      : null;

  const highlighting =
    code.length > 0 &&
    (!entryMatchesInput ||
      entry === undefined ||
      entry.highlightOutput === null);

  return { tokens, highlighting };
}
