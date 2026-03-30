<script lang="ts">
  import type { ChangedFile } from '../lib/types.js';

  let {
    files,
    activeFile,
    onSelectFile,
  }: {
    files: ChangedFile[];
    activeFile: string | null;
    onSelectFile: (file: ChangedFile) => void;
  } = $props();

  const statusIcon: Record<string, string> = {
    added: '+',
    modified: '~',
    deleted: '-',
    renamed: '→',
    untracked: '?',
  };

  const statusColor: Record<string, string> = {
    added: 'var(--status-success)',
    modified: 'var(--status-warning)',
    deleted: 'var(--status-error)',
    renamed: 'var(--status-info)',
    untracked: 'var(--text-muted)',
  };

  function fileName(filePath: string): string {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? filePath : filePath.slice(idx + 1);
  }

  function fileDir(filePath: string): string {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? '' : filePath.slice(0, idx);
  }

  let focusedIndex = $state(0);

  export function moveFocus(delta: number) {
    focusedIndex = Math.max(0, Math.min(files.length - 1, focusedIndex + delta));
    const file = files[focusedIndex];
    if (file) onSelectFile(file);
  }

  export function getFocusedIndex(): number {
    return focusedIndex;
  }

  $effect(() => {
    if (activeFile) {
      const idx = files.findIndex(f => f.path === activeFile);
      if (idx >= 0) focusedIndex = idx;
    }
  });
</script>

<div class="diff-sidebar" role="listbox" aria-label="changed files">
  {#each files as file, i (file.path)}
    <button
      class="sidebar-file"
      class:active={activeFile === file.path}
      class:focused={focusedIndex === i}
      role="option"
      aria-selected={activeFile === file.path}
      data-file-index={i}
      onclick={() => { focusedIndex = i; onSelectFile(file); }}
    >
      <span class="status" style="color: {statusColor[file.status] ?? 'var(--text-muted)'}">{statusIcon[file.status] ?? '?'}</span>
      <span class="name" title={file.path}>
        {fileName(file.path)}
        {#if fileDir(file.path)}
          <span class="dir">{fileDir(file.path)}/</span>
        {/if}
      </span>
      <span class="stats">
        <span class="stat-add">+{file.additions}</span>
        <span class="stat-del">-{file.deletions}</span>
      </span>
    </button>
  {/each}
</div>

<style>
  .diff-sidebar {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    border-right: 1px solid var(--border, #333);
    min-width: 200px;
    max-width: 280px;
  }

  .sidebar-file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-muted, #222);
    cursor: pointer;
    text-align: left;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text, #e0e0e0);
    min-height: 28px;
  }

  .sidebar-file:hover {
    background: var(--surface-hover, #141414);
  }

  .sidebar-file.active {
    background: rgba(217, 119, 87, 0.08);
    border-left: 2px solid var(--accent, #d97757);
  }

  .sidebar-file.focused {
    outline: 1px solid var(--accent, #d97757);
    outline-offset: -1px;
  }

  .status {
    flex-shrink: 0;
    width: 12px;
    text-align: center;
    font-weight: bold;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dir {
    color: var(--text-muted, #888);
    font-size: 0.7rem;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stats {
    flex-shrink: 0;
    display: flex;
    gap: 4px;
    font-size: 0.65rem;
  }

  .stat-add { color: var(--status-success, #4ade80); }
  .stat-del { color: var(--status-error, #f87171); }
</style>
