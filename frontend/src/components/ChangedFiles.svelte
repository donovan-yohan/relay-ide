<script lang="ts">
  import type { Column } from './DataTable.svelte';
  import DataTable from './DataTable.svelte';
  import DiffViewer from './DiffViewer.svelte';
  import DiffSourceToggle from './DiffSourceToggle.svelte';
  import { fetchChangedFiles, fetchFileDiff, fetchDefaultBranch } from '../lib/api.js';
  import { generateFileSummary } from '../lib/diff-summary.js';
  import { statusIcon, statusColor, diffSourceToBase } from '../lib/diff-utils.js';
  import { rootShortName } from '../lib/utils.js';
  import type { ChangedFile, DiffSource } from '../lib/types.js';

  let {
    workspacePath,
    onExpandFile,
  }: {
    workspacePath: string;
    onExpandFile?: (file: ChangedFile, base: string | undefined) => void;
  } = $props();

  let files = $state<ChangedFile[]>([]);
  let aggregate = $state({ additions: 0, deletions: 0, fileCount: 0 });
  let loading = $state(false);
  let error = $state<string | undefined>(undefined);
  let expanded = $state(false);
  let expandedFile = $state<string | null>(null);
  let fileDiff = $state<string>('');
  let diffLoading = $state(false);
  let diffError = $state<string | undefined>(undefined);
  let sortBy = $state('path');
  let sortDir = $state<'asc' | 'desc'>('asc');
  let summaries = $state(new Map<string, string>());

  let diffSource = $state<DiffSource>('working');
  let defaultBranch = $state('main');

  let base = $derived(diffSourceToBase(diffSource, defaultBranch));

  const columns: Column[] = [
    { key: 'status', label: '', width: '24px' },
    { key: 'path', label: 'file', sortable: true },
    { key: 'additions', label: '+', sortable: true, width: '50px' },
    { key: 'deletions', label: '-', sortable: true, width: '50px' },
  ];

  let sortedFiles = $derived.by(() => {
    const sorted = [...files];
    sorted.sort((a, b) => {
      const aVal = (a as unknown as Record<string, unknown>)[sortBy];
      const bVal = (b as unknown as Record<string, unknown>)[sortBy];
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      const aStr = String(aVal ?? '');
      const bStr = String(bVal ?? '');
      return sortDir === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
    });
    return sorted;
  });

  export async function refresh() {
    if (!workspacePath) return;
    loading = true;
    error = undefined;
    try {
      const data = await fetchChangedFiles(workspacePath, base);
      files = data.files;
      aggregate = data.aggregate;
      error = data.error;
      summaries = new Map();
      expandedFile = null;
      fileDiff = '';
    } catch (err: unknown) {
      console.error('[ChangedFiles] refresh failed:', err instanceof Error ? err.message : String(err));
      error = 'Failed to fetch changed files';
      files = [];
    } finally {
      loading = false;
    }
  }

  // $effect is intentional here: refresh() is async and writes to $state — cannot be $derived.
  $effect(() => {
    void workspacePath;
    void base;
    if (workspacePath) void refresh();
  });

  $effect(() => {
    if (workspacePath) {
      fetchDefaultBranch(workspacePath).then(b => { defaultBranch = b; });
    }
  });

  function handleSort(col: string) {
    if (sortBy === col) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortBy = col;
      sortDir = 'asc';
    }
  }

  async function handleRowAction(file: ChangedFile) {
    if (expandedFile === file.path) {
      expandedFile = null;
      fileDiff = '';
      return;
    }
    const targetPath = file.path;
    expandedFile = targetPath;
    diffLoading = true;
    diffError = undefined;
    try {
      const data = await fetchFileDiff(workspacePath, file.path, base);
      if (expandedFile !== targetPath) return; // stale — user clicked a different file
      if (data.error) {
        diffError = data.error;
        fileDiff = '';
      } else {
        fileDiff = data.diff;
        if (!summaries.get(file.path) && fileDiff) {
          summaries.set(file.path, generateFileSummary(fileDiff, file.path, file.status));
          summaries = new Map(summaries); // trigger reactivity
        }
      }
    } catch (err: unknown) {
      if (expandedFile !== targetPath) return; // stale
      const message = err instanceof Error ? err.message : 'unknown error';
      diffError = `failed to load diff: ${message}`;
      fileDiff = '';
    } finally {
      if (expandedFile === targetPath) diffLoading = false;
    }
  }

</script>

<div class="changed-files-panel">
  <button
    class="summary-bar"
    onclick={() => { expanded = !expanded; if (expanded && files.length === 0) refresh(); }}
    aria-expanded={expanded}
  >
    <span class="summary-label">changed files</span>
    {#if aggregate.fileCount > 0}
      <span class="summary-stats">
        {aggregate.fileCount} file{aggregate.fileCount !== 1 ? 's' : ''}
        <span class="stat-add">+{aggregate.additions}</span>
        <span class="stat-del">-{aggregate.deletions}</span>
      </span>
    {:else if loading}
      <span class="summary-stats loading-text">scanning...</span>
    {:else}
      <span class="summary-stats muted">no changes</span>
    {/if}
    <span class="expand-indicator">{expanded ? '▾' : '▸'}</span>
  </button>

  {#if expanded}
    <div class="files-content">
      <div class="files-toolbar">
        <DiffSourceToggle
          value={diffSource}
          onchange={(s) => { diffSource = s; }}
          {defaultBranch}
        />
      </div>
      <DataTable
        {columns}
        rows={sortedFiles}
        groupBy="directory"
        {sortBy}
        {sortDir}
        onSort={handleSort}
        {loading}
        {error}
        emptyMessage="no changes detected"
        onRowAction={handleRowAction}
        maxHeight="300px"
      >
        {#snippet row(file: ChangedFile, _index: number)}
          <div class="file-row" class:expanded-row={expandedFile === file.path}>
            <span class="status-icon" style="color: {statusColor[file.status] ?? 'var(--text-muted)'}">{statusIcon[file.status] ?? '?'}</span>
            <span class="file-name" title={file.path}>
              {rootShortName(file.path)}
              {#if summaries.get(file.path)}
                <span class="file-summary">{summaries.get(file.path)}</span>
              {/if}
            </span>
            <span class="stat stat-add">+{file.additions}</span>
            <span class="stat stat-del">-{file.deletions}</span>
            {#if onExpandFile}
              <button
                class="expand-btn"
                title="open full diff"
                onclick={(e) => { e.stopPropagation(); onExpandFile(file, base); }}
                aria-label="expand diff for {file.path}"
              >[↗]</button>
            {/if}
          </div>
          {#if expandedFile === file.path}
            <div class="inline-diff">
              {#if diffError}
                <div class="diff-error">{diffError}</div>
              {:else}
                <DiffViewer diff={fileDiff} filePath={file.path} loading={diffLoading} />
              {/if}
            </div>
          {/if}
        {/snippet}

        {#snippet mobileCard(file: ChangedFile, _index: number)}
          <button class="mobile-file-card" onclick={() => handleRowAction(file)}>
            <div class="card-header">
              <span class="status-icon" style="color: {statusColor[file.status] ?? 'var(--text-muted)'}">{statusIcon[file.status] ?? '?'}</span>
              <span class="file-name">{rootShortName(file.path)}</span>
              <span class="card-stats">
                <span class="stat-add">+{file.additions}</span>
                <span class="stat-del">-{file.deletions}</span>
              </span>
            </div>
            {#if summaries.get(file.path)}
              <div class="card-summary">{summaries.get(file.path)}</div>
            {/if}
            {#if expandedFile === file.path}
              <div class="inline-diff">
                {#if diffError}
                  <div class="diff-error">{diffError}</div>
                {:else}
                  <DiffViewer diff={fileDiff} filePath={file.path} loading={diffLoading} />
                {/if}
              </div>
            {/if}
          </button>
        {/snippet}
      </DataTable>
    </div>
  {/if}
</div>

<style>
  .changed-files-panel {
    border-top: 1px solid var(--border, #333);
  }

  .summary-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text-muted, #888);
    text-align: left;
  }

  .summary-bar:hover {
    background: var(--surface-hover, #141414);
  }

  .summary-label {
    color: var(--text, #e0e0e0);
  }

  .summary-stats {
    flex: 1;
  }

  .loading-text {
    opacity: 0.6;
  }

  .muted {
    opacity: 0.5;
  }

  .stat-add { color: var(--status-success, #4ade80); }
  .stat-del { color: var(--status-error, #f87171); }

  .diff-error {
    padding: 8px 12px;
    color: var(--status-error, #f87171);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .expand-indicator {
    flex-shrink: 0;
    opacity: 0.5;
  }

  .files-content {
    border-top: 1px solid var(--border, #333);
  }

  .files-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border, #333);
  }

  .expand-btn {
    flex-shrink: 0;
    padding: 0 4px;
    background: transparent;
    border: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
  }

  .expand-btn:hover {
    color: var(--accent, #d97757);
    border-color: var(--accent, #d97757);
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    cursor: pointer;
  }

  .file-row:hover {
    background: var(--surface-hover, #141414);
  }

  .expanded-row {
    background: var(--surface-hover, #141414);
  }

  .status-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-weight: bold;
  }

  .file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text, #e0e0e0);
  }

  .file-summary {
    margin-left: 8px;
    color: var(--text-muted, #888);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .stat {
    flex-shrink: 0;
    width: 40px;
    text-align: right;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .inline-diff {
    margin: 4px 0 4px 24px;
  }

  .mobile-file-card {
    display: block;
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-bottom: 1px solid var(--border, #333);
    background: transparent;
    cursor: pointer;
    text-align: left;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text, #e0e0e0);
  }

  .mobile-file-card:active {
    background: var(--surface-hover, #141414);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .card-stats {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }

  .card-summary {
    margin-top: 4px;
    padding-left: 24px;
    color: var(--text-muted, #888);
  }
</style>
