<script lang="ts">
  import { parse } from 'diff2html';
  import type { DiffFile } from 'diff2html/lib/types';
  import { tokenizeCode, detectLanguage, type ThemedToken } from '../lib/shiki.js';

  let {
    diff,
    filePath,
    loading = false,
    mode = 'unified',
    onHunkCount,
  }: {
    diff: string;
    filePath: string;
    loading?: boolean;
    mode?: 'unified' | 'side-by-side';
    onHunkCount?: (count: number) => void;
  } = $props();

  interface RawLine {
    type: 'add' | 'delete' | 'context';
    oldNumber?: number;
    newNumber?: number;
    content: string;
  }

  interface HighlightedLine extends RawLine {
    tokens: ThemedToken[] | null;
  }

  interface SbsHalfLeft {
    number?: number | undefined;
    content: string;
    type: 'delete' | 'context' | 'empty';
    tokens: ThemedToken[] | null;
  }

  interface SbsHalfRight {
    number?: number | undefined;
    content: string;
    type: 'add' | 'context' | 'empty';
    tokens: ThemedToken[] | null;
  }

  interface SideBySidePair {
    left: SbsHalfLeft;
    right: SbsHalfRight;
    hunkHeader?: string | undefined;
  }

  interface ParsedDiff {
    rawLines: RawLine[];
    hunkHeaderMap: Map<number, string>;
    lang: string;
  }

  // Synchronous parse — safe for $derived.by (async result handled in $effect below)
  const parsed = $derived.by<ParsedDiff>(() => {
    if (!diff) return { rawLines: [], hunkHeaderMap: new Map(), lang: 'javascript' };

    const files: DiffFile[] = parse(diff);
    if (files.length === 0) return { rawLines: [], hunkHeaderMap: new Map(), lang: 'javascript' };

    const file = files[0]!;
    const lang = detectLanguage(filePath);
    const rawLines: RawLine[] = [];
    const hunkHeaderMap = new Map<number, string>();

    for (const block of file.blocks) {
      hunkHeaderMap.set(rawLines.length, block.header);
      for (const line of block.lines) {
        const type = line.type === 'insert' ? 'add' as const
          : line.type === 'delete' ? 'delete' as const
          : 'context' as const;
        const rawLine: RawLine = {
          type,
          content: line.content.slice(1), // strip leading +/-/space
        };
        if (line.oldNumber !== undefined) rawLine.oldNumber = line.oldNumber;
        if (line.newNumber !== undefined) rawLine.newNumber = line.newNumber;
        rawLines.push(rawLine);
      }
    }

    return { rawLines, hunkHeaderMap, lang };
  });

  function buildPairs(hlines: HighlightedLine[], hunkHeaders?: Map<number, string>): SideBySidePair[] {
    const pairs: SideBySidePair[] = [];
    let i = 0;
    while (i < hlines.length) {
      // Emit hunk header before this line if one exists at this index
      const header = hunkHeaders?.get(i);
      if (header) {
        pairs.push({
          left: { content: '', type: 'empty', tokens: null },
          right: { content: '', type: 'empty', tokens: null },
          hunkHeader: header,
        });
      }
      const line = hlines[i]!;
      if (line.type === 'context') {
        pairs.push({
          left: { ...(line.oldNumber !== undefined ? { number: line.oldNumber } : {}), content: line.content, type: 'context', tokens: line.tokens },
          right: { ...(line.newNumber !== undefined ? { number: line.newNumber } : {}), content: line.content, type: 'context', tokens: line.tokens },
        });
        i++;
      } else {
        const deletes: HighlightedLine[] = [];
        const inserts: HighlightedLine[] = [];
        while (i < hlines.length && hlines[i]!.type === 'delete') {
          deletes.push(hlines[i]!);
          i++;
        }
        while (i < hlines.length && hlines[i]!.type === 'add') {
          inserts.push(hlines[i]!);
          i++;
        }
        const max = Math.max(deletes.length, inserts.length);
        for (let j = 0; j < max; j++) {
          const del = deletes[j];
          const ins = inserts[j];
          pairs.push({
            left: del
              ? { ...(del.oldNumber !== undefined ? { number: del.oldNumber } : {}), content: del.content, type: 'delete', tokens: del.tokens }
              : { content: '', type: 'empty', tokens: null },
            right: ins
              ? { ...(ins.newNumber !== undefined ? { number: ins.newNumber } : {}), content: ins.content, type: 'add', tokens: ins.tokens }
              : { content: '', type: 'empty', tokens: null },
          });
        }
      }
    }
    return pairs;
  }

  // Highlighted lines — starts as plain, updated asynchronously by $effect
  let lines = $state<HighlightedLine[]>([]);
  let pairedLines = $state<SideBySidePair[]>([]);
  let tokenGeneration = 0;

  const TRUNCATION_LIMIT = 5000;
  let showAll = $state(false);

  let displayLines = $derived(
    !showAll && lines.length > TRUNCATION_LIMIT
      ? lines.slice(0, TRUNCATION_LIMIT)
      : lines
  );

  let displayPairs = $derived(
    !showAll && pairedLines.length > TRUNCATION_LIMIT
      ? pairedLines.slice(0, TRUNCATION_LIMIT)
      : pairedLines
  );

  let isTruncated = $derived(
    !showAll && (lines.length > TRUNCATION_LIMIT || pairedLines.length > TRUNCATION_LIMIT)
  );

  $effect(() => {
    const { rawLines, hunkHeaderMap, lang } = parsed;
    const gen = ++tokenGeneration;
    showAll = false;

    // Immediately render without syntax highlighting
    const plain = rawLines.map(l => ({ ...l, tokens: null as ThemedToken[] | null }));
    lines = plain;
    pairedLines = buildPairs(plain, hunkHeaderMap);

    if (onHunkCount) onHunkCount(hunkHeaderMap.size);
    if (rawLines.length === 0) return;

    // Asynchronously apply Shiki tokens — guard against stale resolutions
    const codeStr = rawLines.map(l => l.content).join('\n');
    tokenizeCode(codeStr, lang).then((tokenLines) => {
      if (gen !== tokenGeneration) return; // stale — newer parse already in flight
      const highlighted = rawLines.map((line, i) => ({
        ...line,
        tokens: tokenLines[i] ?? null,
      }));
      lines = highlighted;
      pairedLines = buildPairs(highlighted, hunkHeaderMap);
    }).catch((err: unknown) => {
      console.warn('[DiffViewer] Shiki tokenization failed:', err);
    });
  });
</script>

<div class="diff-viewer" role="region" aria-label="File diff">
  {#if loading}
    <div class="diff-loading">loading diff...</div>
  {:else if lines.length === 0}
    <div class="diff-empty">no changes</div>
  {:else if mode === 'side-by-side'}
    <div class="diff-content-sbs">
      {#each displayPairs as pair, i (i)}
        {#if pair.hunkHeader}
          <div class="hunk-header sbs-hunk" id="sbs-hunk-{i}">{pair.hunkHeader}</div>
        {/if}
        <div class="sbs-row">
          <div class="sbs-half {pair.left.type}">
            <span class="line-number">{pair.left.number ?? ''}</span>
            <span class="line-prefix">{pair.left.type === 'delete' ? '-' : pair.left.type === 'context' ? ' ' : ''}</span>
            <span class="line-content">{#if pair.left.tokens}{#each pair.left.tokens as token, j (j)}<span style="color: {token.color ?? '#e0e0e0'}">{token.content}</span>{/each}{:else}{pair.left.content}{/if}</span>
          </div>
          <div class="sbs-half {pair.right.type}">
            <span class="line-number">{pair.right.number ?? ''}</span>
            <span class="line-prefix">{pair.right.type === 'add' ? '+' : pair.right.type === 'context' ? ' ' : ''}</span>
            <span class="line-content">{#if pair.right.tokens}{#each pair.right.tokens as token, j (j)}<span style="color: {token.color ?? '#e0e0e0'}">{token.content}</span>{/each}{:else}{pair.right.content}{/if}</span>
          </div>
        </div>
      {/each}
    </div>
    {#if isTruncated}
      <div class="truncation-notice">
        <span>showing {TRUNCATION_LIMIT} of {pairedLines.length} lines</span>
        <button class="show-more-btn" onclick={() => { showAll = true; }}>[show all]</button>
      </div>
    {/if}
  {:else}
    <div class="diff-content">
      {#each displayLines as line, i (i)}
        {#if parsed.hunkHeaderMap.has(i)}
          <div class="hunk-header" id="hunk-{i}">{parsed.hunkHeaderMap.get(i) ?? ''}</div>
        {/if}
        <div
          class="diff-line {line.type}"
          data-old={line.oldNumber ?? ''}
          data-new={line.newNumber ?? ''}
        >
          <span class="line-number old">{line.oldNumber ?? ''}</span>
          <span class="line-number new">{line.newNumber ?? ''}</span>
          <span class="line-prefix">{line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}</span>
          <span class="line-content">{#if line.tokens}{#each line.tokens as token, j (j)}<span style="color: {token.color ?? '#e0e0e0'}">{token.content}</span>{/each}{:else}{line.content}{/if}</span>
        </div>
      {/each}
    </div>
    {#if isTruncated}
      <div class="truncation-notice">
        <span>showing {TRUNCATION_LIMIT} of {lines.length} lines</span>
        <button class="show-more-btn" onclick={() => { showAll = true; }}>[show all]</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .diff-viewer {
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    line-height: 1.5;
    max-height: 400px;
    overflow: auto;
    border: 1px solid var(--border, #333);
    background: transparent;
  }

  .diff-loading, .diff-empty {
    padding: 12px;
    color: var(--text-muted, #888);
  }

  .diff-content {
    min-width: max-content;
  }

  .diff-line {
    display: flex;
    white-space: pre;
    min-height: 1.5em;
  }

  .diff-line.add {
    background: rgba(74, 222, 128, 0.08);
  }

  .diff-line.add .line-content,
  .diff-line.add .line-prefix {
    color: var(--status-success, #4ade80);
  }

  .diff-line.delete {
    background: rgba(248, 113, 113, 0.08);
  }

  .diff-line.delete .line-content,
  .diff-line.delete .line-prefix {
    color: var(--status-error, #f87171);
  }

  .line-number {
    display: inline-block;
    width: 3.5em;
    text-align: right;
    padding-right: 0.5em;
    color: #888888;
    user-select: none;
    flex-shrink: 0;
  }

  .line-prefix {
    display: inline-block;
    width: 1.5em;
    text-align: center;
    user-select: none;
    flex-shrink: 0;
  }

  .line-content {
    flex: 1;
    padding-right: 1em;
  }

  .hunk-header {
    padding: 4px 12px;
    color: var(--accent, #d97757);
    background: rgba(217, 119, 87, 0.05);
    font-style: italic;
    border-top: 1px solid var(--border, #333);
    border-bottom: 1px solid var(--border, #333);
    user-select: none;
  }

  .diff-content-sbs {
    min-width: max-content;
  }

  .sbs-row {
    display: flex;
  }

  .sbs-half {
    flex: 1;
    display: flex;
    white-space: pre;
    min-height: 1.5em;
    overflow: hidden;
  }

  .sbs-half + .sbs-half {
    border-left: 1px solid var(--border, #333);
  }

  .sbs-half.add {
    background: rgba(74, 222, 128, 0.08);
  }

  .sbs-half.add .line-content,
  .sbs-half.add .line-prefix {
    color: var(--status-success, #4ade80);
  }

  .sbs-half.delete {
    background: rgba(248, 113, 113, 0.08);
  }

  .sbs-half.delete .line-content,
  .sbs-half.delete .line-prefix {
    color: var(--status-error, #f87171);
  }

  .sbs-half.empty {
    background: rgba(136, 136, 136, 0.03);
  }

  .sbs-half .line-number {
    display: inline-block;
    width: 3em;
    text-align: right;
    padding-right: 0.5em;
    color: #888888;
    user-select: none;
    flex-shrink: 0;
  }

  .sbs-half .line-prefix {
    display: inline-block;
    width: 1.5em;
    text-align: center;
    user-select: none;
    flex-shrink: 0;
  }

  .sbs-half .line-content {
    flex: 1;
    padding-right: 0.5em;
  }

  .truncation-notice {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .show-more-btn {
    background: transparent;
    border: 1px solid var(--border, #333);
    color: var(--accent, #d97757);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
    padding: 1px 6px;
  }

  .show-more-btn:hover {
    background: rgba(217, 119, 87, 0.08);
  }
</style>
