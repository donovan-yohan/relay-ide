<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import type { OpenFileTab } from '../lib/state/ui.svelte.js';
  import { scorePath, type ScoredResult } from '../lib/fuzzy-scorer.js';
  import { statusToBadge, statusToBadgeColor } from '../lib/file-tree-utils.js';
  import type { FileChangeStatus } from '../lib/types.js';
  import TuiInput from './TuiInput.svelte';
  import { isMobileDevice } from '../lib/utils.js';

  let {
    open = false,
    workspacePath = '',
    changedFiles = [] as string[],
    recentFiles = [] as OpenFileTab[],
    onClose,
    onSelect,
  }: {
    open: boolean;
    workspacePath: string;
    changedFiles: string[];
    recentFiles: OpenFileTab[];
    onClose: () => void;
    onSelect: (filePath: string, isChanged: boolean) => void;
  } = $props();

  let query = $state('');
  let debouncedQuery = $state('');
  let focusedIndex = $state(0);
  let resultsEl = $state<HTMLDivElement | undefined>(undefined);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Drag-dismiss state (mobile)
  let dragStartY = 0;
  let dragOffset = $state(0);
  let dragging = false;

  // ── Data fetching ──

  async function fetchFilesList(): Promise<{ files: string[]; truncated: boolean; total: number; error?: string }> {
    const params = new URLSearchParams({ path: workspacePath });
    const res = await fetch('/workspaces/files-list?' + params.toString());
    if (!res.ok) throw new Error(`files-list failed: ${res.status}`);
    return res.json();
  }

  const filesQuery = createQuery<{ files: string[]; truncated: boolean; total: number; error?: string }>(() => ({
    queryKey: ['files-list', workspacePath],
    queryFn: fetchFilesList,
    staleTime: 30_000,
    enabled: open && !!workspacePath,
  }));

  // ── Scoring + sections ──

  interface ScoredFile {
    path: string;
    filename: string;
    directory: string;
    result: ScoredResult;
    status?: FileChangeStatus | undefined;
  }

  const allFiles = $derived(filesQuery.data?.files ?? []);
  const truncated = $derived(filesQuery.data?.truncated ?? false);
  const total = $derived(filesQuery.data?.total ?? 0);
  const error = $derived(filesQuery.data?.error);

  const recentSet = $derived(new Set(recentFiles.map(t => t.filePath)));
  const changedSet = $derived(new Set(changedFiles));

  // Build a set of files that exist in this repo (for cross-repo filtering)
  const fileSet = $derived(new Set(allFiles));

  const scoredResults = $derived.by((): ScoredFile[] => {
    const q = debouncedQuery.trim();
    let candidates: { path: string; result: ScoredResult }[];

    if (!q) {
      // No query: build a small subset for sections (avoids mapping all 50K files)
      const MAX_NEUTRAL = 64; // above 5 + 10 + 20 visible items
      const seen = new Set<string>();
      const orderedPaths: string[] = [];
      for (const tab of recentFiles) {
        if (fileSet.has(tab.filePath) && !seen.has(tab.filePath)) { seen.add(tab.filePath); orderedPaths.push(tab.filePath); }
        if (orderedPaths.length >= MAX_NEUTRAL) break;
      }
      for (const p of changedFiles) {
        if (fileSet.has(p) && !seen.has(p)) { seen.add(p); orderedPaths.push(p); }
        if (orderedPaths.length >= MAX_NEUTRAL) break;
      }
      for (const p of allFiles) {
        if (!seen.has(p)) { seen.add(p); orderedPaths.push(p); }
        if (orderedPaths.length >= MAX_NEUTRAL) break;
      }
      candidates = orderedPaths.map(p => ({ path: p, result: { score: 0, matches: [] } }));
    } else {
      // Score and filter
      candidates = [];
      for (const p of allFiles) {
        const r = scorePath(q, p);
        if (r) candidates.push({ path: p, result: r });
      }
      candidates.sort((a, b) => b.result.score - a.result.score);
    }

    return candidates.map(c => {
      const lastSep = c.path.lastIndexOf('/');
      return {
        path: c.path,
        filename: lastSep >= 0 ? c.path.slice(lastSep + 1) : c.path,
        directory: lastSep >= 0 ? c.path.slice(0, lastSep + 1) : '',
        result: c.result,
        status: undefined, // per-file status not available from lastChangedFiles (path-only)
      };
    });
  });

  // Section splitting with dedup (recent > changed > all)
  const recentSection = $derived(
    scoredResults
      .filter(f => recentSet.has(f.path) && fileSet.has(f.path))
      .slice(0, 5)
  );

  const recentPaths = $derived(new Set(recentSection.map(f => f.path)));

  const changedSection = $derived(
    scoredResults
      .filter(f => changedSet.has(f.path) && !recentPaths.has(f.path))
      .slice(0, 10)
  );

  const changedPaths = $derived(new Set(changedSection.map(f => f.path)));

  const allSection = $derived(
    scoredResults
      .filter(f => !recentPaths.has(f.path) && !changedPaths.has(f.path))
      .slice(0, 20)
  );

  interface Section { label: string; items: ScoredFile[] }

  const sections = $derived.by((): Section[] => {
    const result: Section[] = [];
    if (recentSection.length > 0) result.push({ label: 'recent', items: recentSection });
    if (changedSection.length > 0) result.push({ label: 'changed', items: changedSection });
    if (allSection.length > 0) result.push({ label: 'files', items: allSection });
    return result;
  });

  // Flat list for keyboard nav
  const flatItems = $derived(sections.flatMap(s => s.items));

  // Section start indices for Tab navigation
  const sectionStarts = $derived.by((): number[] => {
    const starts: number[] = [];
    let offset = 0;
    for (const s of sections) {
      starts.push(offset);
      offset += s.items.length;
    }
    return starts;
  });

  // ── Input handling ──

  function handleInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery = query;
      focusedIndex = 0;
    }, 100);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }

    const hasItems = flatItems.length > 0;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!hasItems) return;
      focusedIndex = Math.min(focusedIndex + 1, flatItems.length - 1);
      scrollFocusedIntoView();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hasItems) return;
      focusedIndex = Math.max(focusedIndex - 1, 0);
      scrollFocusedIntoView();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!hasItems) return;
      const item = flatItems[focusedIndex];
      if (item) onSelect(item.path, changedSet.has(item.path));
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!hasItems || sectionStarts.length === 0) return;
      // Find which section we're currently in
      let currentSection = 0;
      for (let i = sectionStarts.length - 1; i >= 0; i--) {
        if (focusedIndex >= (sectionStarts[i] ?? 0)) { currentSection = i; break; }
      }
      const nextSection = e.shiftKey
        ? (currentSection - 1 + sectionStarts.length) % sectionStarts.length
        : (currentSection + 1) % sectionStarts.length;
      focusedIndex = sectionStarts[nextSection] ?? 0;
      scrollFocusedIntoView();
      return;
    }
  }

  function scrollFocusedIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.file-picker-item.focused');
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('file-picker-overlay')) onClose();
  }

  // Mobile swipe-down dismiss
  function handleDragStart(e: TouchEvent) {
    if (!isMobileDevice) return;
    const target = e.target as HTMLElement;
    const isHandle = target.classList.contains('drag-handle') || target.classList.contains('drag-bar');
    if (!isHandle && resultsEl && resultsEl.scrollTop > 0) return;
    dragStartY = e.touches[0]!.clientY;
    dragging = true;
  }

  function handleDragMove(e: TouchEvent) {
    if (!dragging) return;
    const delta = e.touches[0]!.clientY - dragStartY;
    if (delta > 0) dragOffset = delta;
  }

  function handleDragEnd() {
    if (!dragging) return;
    dragging = false;
    if (dragOffset > 100) onClose();
    dragOffset = 0;
  }

  // Reset state when picker opens/closes + cleanup debounce timer
  $effect(() => {
    if (open) {
      query = '';
      debouncedQuery = '';
      focusedIndex = 0;
    }
    return () => { if (debounceTimer) clearTimeout(debounceTimer); };
  });

  // ── Highlight rendering ──

  function highlightMatches(text: string, matches: [number, number][], offset: number): Array<{ text: string; highlight: boolean }> {
    if (matches.length === 0) return [{ text, highlight: false }];

    const segments: Array<{ text: string; highlight: boolean }> = [];
    let pos = 0;

    for (const [start, end] of matches) {
      const localStart = start - offset;
      const localEnd = end - offset;
      if (localEnd <= 0 || localStart >= text.length) continue;

      const clampedStart = Math.max(0, localStart);
      const clampedEnd = Math.min(text.length, localEnd);

      if (clampedStart > pos) {
        segments.push({ text: text.slice(pos, clampedStart), highlight: false });
      }
      segments.push({ text: text.slice(clampedStart, clampedEnd), highlight: true });
      pos = clampedEnd;
    }

    if (pos < text.length) {
      segments.push({ text: text.slice(pos), highlight: false });
    }

    return segments.length > 0 ? segments : [{ text, highlight: false }];
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="file-picker-overlay" class:mobile={isMobileDevice} onclick={handleBackdropClick}>
    <div
      class="file-picker"
      class:mobile={isMobileDevice}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="open file"
      style={isMobileDevice && dragOffset > 0 ? `transform: translateY(${dragOffset}px)` : ''}
      ontouchstart={handleDragStart}
      ontouchmove={handleDragMove}
      ontouchend={handleDragEnd}
      ontouchcancel={handleDragEnd}
    >
      {#if isMobileDevice}
        <div class="drag-handle"><span class="drag-bar"></span></div>
      {/if}

      <div class="file-picker-input-row">
        <span class="file-picker-prompt">&gt;</span>
        <TuiInput
          bind:value={query}
          placeholder="search files..."
          oninput={handleInput}
          onkeydown={handleKeydown}
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-expanded={flatItems.length > 0}
          aria-controls="file-picker-results"
        />
      </div>

      <div class="file-picker-results" id="file-picker-results" role="listbox" bind:this={resultsEl}>
        {#if filesQuery.isError}
          <div class="file-picker-empty">failed to load files</div>
        {:else if error}
          <div class="file-picker-empty">no files found — {error}</div>
        {:else if filesQuery.isLoading}
          <div class="file-picker-empty">loading...</div>
        {:else if flatItems.length === 0 && debouncedQuery.trim()}
          <div class="file-picker-empty">no results for "{debouncedQuery}"</div>
        {:else if flatItems.length === 0}
          <div class="file-picker-empty">no files</div>
        {:else}
          {#each sections as section (section.label)}
            <div class="file-picker-section" role="presentation">
              {section.label}
            </div>
            {#each section.items as item, i (item.path)}
              {@const globalIndex = flatItems.indexOf(item)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="file-picker-item"
                class:focused={globalIndex === focusedIndex}
                role="option"
                tabindex="-1"
                aria-selected={globalIndex === focusedIndex}
                onclick={() => onSelect(item.path, changedSet.has(item.path))}
                onmouseenter={() => { focusedIndex = globalIndex; }}
              >
                <span class="item-cursor" class:visible={globalIndex === focusedIndex}>&gt;</span>
                <span class="item-filename">
                  {#each highlightMatches(item.filename, item.result.matches, item.path.length - item.filename.length) as seg}
                    {#if seg.highlight}
                      <span class="match">{seg.text}</span>
                    {:else}
                      {seg.text}
                    {/if}
                  {/each}
                </span>
                <span class="item-directory">
                  {#each highlightMatches(item.directory, item.result.matches, 0) as seg}
                    {#if seg.highlight}
                      <span class="match">{seg.text}</span>
                    {:else}
                      {seg.text}
                    {/if}
                  {/each}
                </span>
                {#if item.status}
                  <span class="item-badge" style="color: {statusToBadgeColor(item.status)}">{statusToBadge(item.status)}</span>
                {/if}
              </div>
            {/each}
          {/each}
        {/if}
      </div>

      <div class="file-picker-footer">
        {#if truncated}
          <span class="hint truncated">showing {allFiles.length} of {total} files — type to filter</span>
        {:else if !isMobileDevice}
          <span class="hint">↑↓ navigate</span>
          <span class="hint">tab section</span>
          <span class="hint">↵ open</span>
          <span class="hint">esc close</span>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .file-picker-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 20vh;
  }

  .file-picker {
    width: 100%;
    max-width: 580px;
    background: var(--surface);
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    max-height: 480px;
  }

  .file-picker-input-row {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    height: 44px;
  }

  .file-picker-prompt {
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--accent);
    font-weight: bold;
    flex-shrink: 0;
    line-height: 1;
    user-select: none;
  }

  .file-picker-input-row :global(.tui-input-wrapper) { flex: 1; }
  .file-picker-input-row :global(.tui-input) { background: transparent; border: none; padding: 0; }
  .file-picker-input-row :global(.tui-input:focus) { border: none; }
  .file-picker-input-row :global(.tui-input::placeholder) { color: var(--text-muted); opacity: 0.6; }

  .file-picker-results { overflow-y: auto; flex: 1; min-height: 0; }

  .file-picker-section {
    padding: 8px 16px 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.08em;
    user-select: none;
    text-transform: lowercase;
  }

  .file-picker-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    transition: background 0.08s;
    min-height: 32px;
  }

  .file-picker-item:hover, .file-picker-item.focused { background: var(--surface-hover); color: var(--text); }

  .item-cursor {
    flex-shrink: 0;
    width: 12px;
    font-size: var(--font-size-xs);
    color: var(--accent);
    opacity: 0;
    transition: opacity 0.12s ease-out;
  }

  .item-cursor.visible { opacity: 1; }

  .item-filename {
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }

  .item-directory {
    flex: 1;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    opacity: 0.6;
  }

  .item-badge {
    flex-shrink: 0;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    width: 16px;
    text-align: center;
  }

  .match {
    color: var(--accent);
    font-weight: 600;
  }

  .file-picker-empty {
    padding: 20px 16px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    opacity: 0.6;
    text-align: center;
  }

  .file-picker-footer {
    display: flex;
    gap: 16px;
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    min-height: 32px;
  }

  .hint {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.5;
  }

  .hint.truncated { opacity: 0.7; }

  /* Mobile bottom sheet */
  .file-picker-overlay.mobile { padding-top: 0; align-items: flex-end; background: rgba(0, 0, 0, 0.6); }

  .file-picker.mobile {
    max-width: 100%;
    max-height: 70vh;
    border: none;
    border-top: 1px solid var(--border);
    padding-bottom: env(safe-area-inset-bottom);
    border-radius: 0;
  }

  .drag-handle {
    display: flex;
    justify-content: center;
    padding: 8px 0 4px;
    cursor: grab;
    touch-action: none;
  }

  .drag-bar { width: 24px; height: 3px; background: var(--text-muted); border-radius: 0; }

  .file-picker.mobile .file-picker-item {
    min-height: 48px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--surface-hover);
  }

  .file-picker.mobile .item-cursor { display: none; }
  .file-picker.mobile .file-picker-footer { display: none; }
</style>
