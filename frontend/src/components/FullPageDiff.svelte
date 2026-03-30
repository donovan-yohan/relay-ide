<script lang="ts">
  import DiffViewer from './DiffViewer.svelte';
  import DiffFileSidebar from './DiffFileSidebar.svelte';
  import DiffSourceToggle from './DiffSourceToggle.svelte';
  import { fetchChangedFiles, fetchFileDiff, fetchDefaultBranch } from '../lib/api.js';
  import { generateFileSummary } from '../lib/diff-summary.js';
  import { diffSourceToBase } from '../lib/diff-utils.js';
  import type { ChangedFile, DiffSource } from '../lib/types.js';

  let {
    workspacePath,
    initialFile,
    initialBase,
    onClose,
  }: {
    workspacePath: string;
    initialFile?: string;
    initialBase?: string;
    onClose: () => void;
  } = $props();

  let files = $state<ChangedFile[]>([]);
  let loading = $state(true);
  let activeFilePath = $state<string | null>(initialFile ?? null);
  let fileDiff = $state('');
  let diffLoading = $state(false);
  let diffSource = $state<DiffSource>(
    initialBase === 'cached' ? 'staged'
    : initialBase ? 'branch'
    : 'working'
  );
  let defaultBranch = $state(initialBase && initialBase !== 'cached' ? initialBase : 'main');
  let diffMode = $state<'unified' | 'side-by-side'>('unified');
  let sidebarRef = $state<DiffFileSidebar | undefined>(undefined);
  let hunkCount = $state(0);
  let summary = $state('');

  let base = $derived(diffSourceToBase(diffSource, defaultBranch));

  async function loadFiles() {
    loading = true;
    try {
      const data = await fetchChangedFiles(workspacePath, base);
      files = data.files;
      if (!activeFilePath || !files.some(f => f.path === activeFilePath)) {
        activeFilePath = files.length > 0 ? files[0]!.path : null;
      }
    } catch {
      files = [];
    } finally {
      loading = false;
    }
  }

  async function loadDiff(filePath: string) {
    diffLoading = true;
    summary = '';
    try {
      const data = await fetchFileDiff(workspacePath, filePath, base);
      fileDiff = data.diff;
      const file = files.find(f => f.path === filePath);
      if (file && fileDiff) {
        summary = generateFileSummary(fileDiff, filePath, file.status);
      }
    } catch {
      fileDiff = '';
    } finally {
      diffLoading = false;
    }
  }

  function handleSelectFile(file: ChangedFile) {
    activeFilePath = file.path;
  }

  $effect(() => {
    void base;
    loadFiles();
  });

  $effect(() => {
    void base;
    if (activeFilePath) {
      loadDiff(activeFilePath);
    }
  });

  $effect(() => {
    if (workspacePath && defaultBranch === 'main') {
      fetchDefaultBranch(workspacePath).then(b => { defaultBranch = b; });
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'j') {
      e.preventDefault();
      sidebarRef?.moveFocus(1);
    } else if (e.key === 'k') {
      e.preventDefault();
      sidebarRef?.moveFocus(-1);
    } else if (e.key === 'n') {
      e.preventDefault();
      scrollToHunk(1);
    } else if (e.key === 'p') {
      e.preventDefault();
      scrollToHunk(-1);
    }
  }

  let currentHunkIndex = $state(-1);

  function scrollToHunk(delta: number) {
    const hunks = document.querySelectorAll('.fpd-main .hunk-header');
    const visibleCount = hunks.length;
    if (visibleCount === 0) return;
    const target = currentHunkIndex + delta;
    if (target < 0 || target >= visibleCount) return;
    currentHunkIndex = target;
    hunks[target]!.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="full-page-diff">
  <div class="fpd-header">
    <button class="close-btn" onclick={onClose} aria-label="close diff view">[x] close</button>
    <span class="fpd-title">
      {#if activeFilePath}
        {activeFilePath}
        {#if summary}
          <span class="fpd-summary">— {summary}</span>
        {/if}
      {:else}
        diff view
      {/if}
    </span>
    <div class="fpd-controls">
      <DiffSourceToggle value={diffSource} onchange={(s) => { diffSource = s; }} {defaultBranch} />
      <button
        class="mode-toggle"
        onclick={() => { diffMode = diffMode === 'unified' ? 'side-by-side' : 'unified'; }}
        title="toggle unified/side-by-side"
      >
        {diffMode === 'unified' ? '[split]' : '[unified]'}
      </button>
    </div>
  </div>

  <div class="fpd-body">
    <DiffFileSidebar
      bind:this={sidebarRef}
      {files}
      activeFile={activeFilePath}
      onSelectFile={handleSelectFile}
    />
    <div class="fpd-main">
      {#if activeFilePath}
        <DiffViewer
          diff={fileDiff}
          filePath={activeFilePath}
          loading={diffLoading}
          mode={diffMode}
          onHunkCount={(c) => { hunkCount = c; currentHunkIndex = -1; }}
        />
      {:else if loading}
        <div class="fpd-empty">loading files...</div>
      {:else}
        <div class="fpd-empty">no files changed</div>
      {/if}
    </div>
  </div>

  <div class="fpd-footer">
    <span class="hint">j/k navigate files</span>
    <span class="hint">n/p jump hunks</span>
    <span class="hint">esc close</span>
  </div>
</div>

<style>
  .full-page-diff {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg, #000);
    color: var(--text, #e0e0e0);
    font-family: var(--font-mono, monospace);
  }

  .fpd-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border, #333);
    flex-shrink: 0;
  }

  .close-btn {
    background: transparent;
    border: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
    padding: 2px 8px;
  }

  .close-btn:hover {
    color: var(--status-error, #f87171);
    border-color: var(--status-error, #f87171);
  }

  .fpd-title {
    flex: 1;
    font-size: var(--font-size-sm, 0.85rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fpd-summary {
    color: var(--text-muted, #888);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .fpd-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .mode-toggle {
    background: transparent;
    border: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
    padding: 2px 8px;
  }

  .mode-toggle:hover {
    color: var(--accent, #d97757);
    border-color: var(--accent, #d97757);
  }

  .fpd-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .fpd-main {
    flex: 1;
    overflow: auto;
    min-width: 0;
  }

  .fpd-main :global(.diff-viewer) {
    max-height: none;
    border: none;
  }

  .fpd-empty {
    padding: 24px;
    color: var(--text-muted, #888);
    text-align: center;
  }

  .fpd-footer {
    display: flex;
    gap: 16px;
    padding: 4px 12px;
    border-top: 1px solid var(--border, #333);
    flex-shrink: 0;
  }

  .hint {
    font-size: 0.65rem;
    color: var(--text-muted, #888);
  }

  @media (max-width: 600px) {
    .fpd-body {
      flex-direction: column;
    }

    .fpd-body :global(.diff-sidebar) {
      max-width: none;
      min-width: 0;
      max-height: 120px;
      border-right: none;
      border-bottom: 1px solid var(--border, #333);
    }
  }
</style>
