<script lang="ts">
  import { parse } from 'diff2html';
  import type { DiffFile } from 'diff2html/lib/types';
  import { tokenizeCode, detectLanguage, type ThemedToken } from '../lib/shiki.js';

  let {
    diff,
    filePath,
    loading = false,
  }: {
    diff: string;
    filePath: string;
    loading?: boolean;
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

  interface ParsedDiff {
    rawLines: RawLine[];
    hunkHeaders: Array<{ index: number; content: string }>;
    hunkHeaderMap: Map<number, string>;
    lang: string;
  }

  // Synchronous parse — safe for $derived.by (async result handled in $effect below)
  const parsed = $derived.by<ParsedDiff>(() => {
    if (!diff) return { rawLines: [], hunkHeaders: [], hunkHeaderMap: new Map(), lang: 'javascript' };

    const files: DiffFile[] = parse(diff);
    if (files.length === 0) return { rawLines: [], hunkHeaders: [], hunkHeaderMap: new Map(), lang: 'javascript' };

    const file = files[0]!;
    const lang = detectLanguage(filePath);
    const rawLines: RawLine[] = [];
    const hunkHeaders: Array<{ index: number; content: string }> = [];

    for (const block of file.blocks) {
      hunkHeaders.push({ index: rawLines.length, content: block.header });
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

    const hunkHeaderMap = new Map<number, string>();
    for (const h of hunkHeaders) hunkHeaderMap.set(h.index, h.content);
    return { rawLines, hunkHeaders, hunkHeaderMap, lang };
  });

  // Highlighted lines — starts as plain, updated asynchronously by $effect
  let lines = $state<HighlightedLine[]>([]);

  $effect(() => {
    const { rawLines, lang } = parsed;

    // Immediately render without syntax highlighting
    lines = rawLines.map(l => ({ ...l, tokens: null }));

    if (rawLines.length === 0) return;

    // Asynchronously apply Shiki tokens
    const codeStr = rawLines.map(l => l.content).join('\n');
    tokenizeCode(codeStr, lang).then((tokenLines) => {
      lines = rawLines.map((line, i) => ({
        ...line,
        tokens: tokenLines[i] ?? null,
      }));
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
  {:else}
    <div class="diff-content">
      {#each lines as line, i (i)}
        {#if parsed.hunkHeaderMap.has(i)}
          <div class="hunk-header">{parsed.hunkHeaderMap.get(i) ?? ''}</div>
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
</style>
