<script lang="ts">
  import { getUi, openFileTab, type RightSidebarTab, toggleRightSidebarCollapsed } from '../lib/state/ui.svelte.js';
  import { fetchChangedFiles, fetchDefaultBranch, browseFsDirectory, type BrowseEntry } from '../lib/api.js';
  import type { ChangedFile, DiffSource } from '../lib/types.js';
  import { buildChangedFilesTree, flattenVisibleNodes, statusToBadge, statusToBadgeColor, type FileTreeNode, type FlatNode } from '../lib/file-tree-utils.js';
  import { diffSourceToBase } from '../lib/diff-utils.js';
  import DiffSourceToggle from './DiffSourceToggle.svelte';

  let {
    workspacePath,
    changedFilesData = [],
    onFileSelect,
  }: {
    workspacePath: string;
    changedFilesData?: string[];
    onFileSelect?: (filePath: string, isChanged: boolean) => void;
  } = $props();

  const ui = getUi();

  // ── Changes tab state ──
  let changedFiles = $state<ChangedFile[]>([]);
  let aggregate = $state({ additions: 0, deletions: 0, fileCount: 0 });
  let changesLoading = $state(false);
  let changesError = $state<string | null>(null);
  let treeNodes = $state<FileTreeNode[]>([]);

  // diffSource and defaultBranch are shared via ui state so FileViewerPane stays in sync
  let diffSource = $derived(ui.fileDiffSource);
  let defaultBranch = $derived(ui.fileDiffDefaultBranch);

  // ── All files tab state ──
  let allFilesTree = $state<BrowseEntry[]>([]);
  let allFilesExpanded = $state<Set<string>>(new Set());
  let allFilesChildren = $state<Map<string, BrowseEntry[]>>(new Map());
  let allFilesLoading = $state(false);
  let allFilesError = $state<string | null>(null);

  // ── Cipher-decode animation state ──
  let animatingPaths = $state<Set<string>>(new Set());

  // ── Keyboard nav ──
  let focusedIndex = $state(-1);

  let base = $derived(diffSourceToBase(diffSource, defaultBranch));
  let visibleNodes = $derived(flattenVisibleNodes(treeNodes));

  // ── Fetch changed files ──
  export async function refresh(): Promise<void> {
    if (!workspacePath) return;
    changesLoading = true;
    changesError = null;
    try {
      const data = await fetchChangedFiles(workspacePath, base);
      if (data.error) {
        changesError = data.error;
      } else {
        changedFiles = data.files;
        aggregate = data.aggregate;
        treeNodes = buildChangedFilesTree(data.files);
      }
    } catch (err) {
      changesError = err instanceof Error ? err.message : 'failed to load';
    } finally {
      changesLoading = false;
    }
  }

  // Fetch default branch then refresh — single effect avoids double-fetch on mount
  let lastWorkspacePath = '';
  $effect(() => {
    if (!workspacePath) return;
    // Track base to re-fetch when diff source changes
    void base;
    const wp = workspacePath;
    const needsBranchFetch = wp !== lastWorkspacePath;
    lastWorkspacePath = wp;

    if (needsBranchFetch) {
      fetchDefaultBranch(wp).then(b => {
        ui.fileDiffDefaultBranch = b;
        refresh();
      });
    } else {
      refresh();
    }
  });

  // Handle real-time file change events — mark new files for animation
  $effect(() => {
    const newFiles = changedFilesData;
    if (newFiles.length > 0) {
      const prevSet = new Set(ui.lastChangedFiles);
      const justChanged = newFiles.filter(f => !prevSet.has(f));
      if (justChanged.length > 0) {
        animatingPaths = new Set([...animatingPaths, ...justChanged]);
        setTimeout(() => {
          animatingPaths = new Set([...animatingPaths].filter(p => !justChanged.includes(p)));
        }, 500);
      }
      ui.lastChangedFiles = [...newFiles];
    }
  });

  // ── All files tab ──
  async function loadAllFiles(): Promise<void> {
    if (!workspacePath) return;
    allFilesLoading = true;
    allFilesError = null;
    try {
      const data = await browseFsDirectory(workspacePath, { includeFiles: true, showHidden: false });
      allFilesTree = data.entries;
    } catch (err) {
      allFilesError = err instanceof Error ? err.message : 'failed to load';
    } finally {
      allFilesLoading = false;
    }
  }

  async function toggleAllFilesDir(entryPath: string): Promise<void> {
    if (allFilesExpanded.has(entryPath)) {
      allFilesExpanded.delete(entryPath);
      allFilesExpanded = new Set(allFilesExpanded);
    } else {
      allFilesExpanded.add(entryPath);
      allFilesExpanded = new Set(allFilesExpanded);
      if (!allFilesChildren.has(entryPath)) {
        try {
          const data = await browseFsDirectory(entryPath, { includeFiles: true, showHidden: false });
          allFilesChildren.set(entryPath, data.entries);
          allFilesChildren = new Map(allFilesChildren);
        } catch {
          // best effort
        }
      }
    }
  }

  $effect(() => {
    if (ui.rightSidebarTab === 'all-files' && allFilesTree.length === 0 && !allFilesLoading) {
      loadAllFiles();
    }
  });

  // ── Tree interactions ──
  function handleFileClick(node: FileTreeNode): void {
    if (node.isDirectory) {
      node.expanded = !node.expanded;
      treeNodes = [...treeNodes]; // trigger reactivity
    } else {
      const isChanged = changedFiles.some(f => f.path === node.path);
      openFileTab(node.path, isChanged);
      onFileSelect?.(node.path, isChanged);
    }
  }

  function handleAllFilesClick(entry: BrowseEntry): void {
    if (entry.isDirectory !== false) {
      toggleAllFilesDir(entry.path);
    } else {
      // Derive relative path safely via prefix check + slice
      const prefix = workspacePath + '/';
      const relativePath = entry.path.startsWith(prefix)
        ? entry.path.slice(prefix.length)
        : entry.path;
      const isChanged = changedFiles.some(f => f.path === relativePath);
      openFileTab(relativePath, isChanged);
      onFileSelect?.(relativePath, isChanged);
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    const nodes = visibleNodes;
    if (nodes.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIndex = Math.min(focusedIndex + 1, nodes.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIndex = Math.max(focusedIndex - 1, 0);
    } else if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < nodes.length) {
      e.preventDefault();
      handleFileClick(nodes[focusedIndex]!.node);
    }
  }

  function setTab(tab: RightSidebarTab): void {
    ui.rightSidebarTab = tab;
  }

  // Check if a file path has the "recently changed" blue dot
  function isRecentlyChanged(filePath: string): boolean {
    return changedFilesData.length > 0 && changedFilesData.includes(filePath);
  }
</script>

{#if ui.rightSidebarCollapsed}
  <!-- Collapsed rail -->
  <div class="sidebar-collapsed" role="complementary" aria-label="file tree">
    <button class="expand-btn" onclick={toggleRightSidebarCollapsed} aria-label="expand file tree">&gt;</button>
  </div>
{:else}
  <div
    class="sidebar"
    role="complementary"
    aria-label="file tree"
    style="width: {ui.rightSidebarWidth}px"
  >
    <!-- Tab bar -->
    <div class="tab-bar" role="tablist">
      {#each [
        { id: 'changes' as RightSidebarTab, label: 'changes' },
        { id: 'all-files' as RightSidebarTab, label: 'all files' },
        { id: 'checks' as RightSidebarTab, label: 'checks' },
      ] as tab (tab.id)}
        <button
          class="tab"
          class:active={ui.rightSidebarTab === tab.id}
          role="tab"
          aria-selected={ui.rightSidebarTab === tab.id}
          onclick={() => setTab(tab.id)}
        >
          {tab.label}
          {#if tab.id === 'changes' && aggregate.fileCount > 0}
            <span class="tab-count">{aggregate.fileCount}</span>
          {/if}
        </button>
      {/each}
      <button class="collapse-btn" onclick={toggleRightSidebarCollapsed} aria-label="collapse file tree">&lt;</button>
    </div>

    <!-- Tab content -->
    <div class="tab-content">
      {#if ui.rightSidebarTab === 'changes'}
        <!-- Diff source toggle -->
        <div class="controls-row">
          <DiffSourceToggle value={diffSource} onchange={(s) => { ui.fileDiffSource = s; }} {defaultBranch} />
        </div>

        {#if changesLoading && changedFiles.length === 0}
          <div class="loading-state">
            <span class="spinner">&#x280B;</span> loading changes...
          </div>
        {:else if changesError}
          <div class="error-state">
            <span class="error-text">{changesError}</span>
            <button class="retry-btn" onclick={() => refresh()}>retry</button>
          </div>
        {:else if visibleNodes.length === 0}
          <div class="empty-state">
            no changes yet — when an agent writes code, changed files appear here. click any line to send it as context.
          </div>
        {:else}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="tree" role="tree" tabindex="0" onkeydown={handleKeydown}>
            {#each visibleNodes as { node, depth }, i (node.path)}
              {@const isFocused = focusedIndex === i}
              {@const isAnimating = animatingPaths.has(node.path)}
              <button
                class="tree-item"
                class:focused={isFocused}
                class:animating={isAnimating}
                class:directory={node.isDirectory}
                role="treeitem"
                aria-selected={isFocused}
                aria-expanded={node.isDirectory ? node.expanded : undefined}
                aria-label="{node.name}{node.status ? `, ${node.status}` : ''}{node.additions ? `, ${node.additions} additions` : ''}{node.deletions ? `, ${node.deletions} deletions` : ''}{isRecentlyChanged(node.path) ? ', recently changed' : ''}"
                style="padding-left: {16 + depth * 20}px"
                onclick={() => handleFileClick(node)}
              >
                <span class="icon-slot">
                  {#if isRecentlyChanged(node.path) && !node.isDirectory}
                    <span class="blue-dot" aria-label="recently changed"></span>
                  {:else if node.isDirectory}
                    <span class="expand-arrow">{node.expanded ? 'v' : '>'}</span>
                  {/if}
                </span>
                <span class="node-name">{node.name}</span>
                <span class="action-slot">
                  {#if node.isDirectory}
                    <span class="file-count">{node.fileCount}</span>
                  {:else if node.status}
                    <span class="badge" style="color: {statusToBadgeColor(node.status)}">{statusToBadge(node.status)}</span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}

        <!-- Aggregate stats -->
        {#if aggregate.fileCount > 0}
          <div class="stats-bar">
            {aggregate.fileCount} changed
            <span class="stat-add">+{aggregate.additions}</span>
            <span class="stat-del">-{aggregate.deletions}</span>
          </div>
        {/if}

      {:else if ui.rightSidebarTab === 'all-files'}
        {#if allFilesLoading && allFilesTree.length === 0}
          <div class="loading-state">
            <span class="spinner">&#x280B;</span> loading files...
          </div>
        {:else if allFilesError}
          <div class="error-state">
            <span class="error-text">{allFilesError}</span>
            <button class="retry-btn" onclick={() => loadAllFiles()}>retry</button>
          </div>
        {:else if allFilesTree.length === 0}
          <div class="empty-state">empty repository</div>
        {:else}
          {#snippet allFilesNode(entries: BrowseEntry[], depth: number)}
            {#each entries as entry (entry.path)}
              <button
                class="tree-item"
                class:directory={entry.isDirectory !== false}
                role="treeitem"
                aria-expanded={entry.isDirectory !== false ? allFilesExpanded.has(entry.path) : undefined}
                aria-selected={false}
                style="padding-left: {16 + depth * 20}px"
                onclick={() => handleAllFilesClick(entry)}
              >
                <span class="icon-slot">
                  {#if entry.isDirectory !== false}
                    <span class="expand-arrow">{allFilesExpanded.has(entry.path) ? 'v' : '>'}</span>
                  {/if}
                </span>
                <span class="node-name">{entry.name}</span>
                {#if entry.isDirectory !== false && entry.hasChildren}
                  <span class="action-slot">
                    <span class="has-children-dot"></span>
                  </span>
                {/if}
              </button>
              {#if allFilesExpanded.has(entry.path) && allFilesChildren.has(entry.path)}
                {@render allFilesNode(allFilesChildren.get(entry.path) ?? [], depth + 1)}
              {/if}
            {/each}
          {/snippet}

          <div class="tree" role="tree">
            {@render allFilesNode(allFilesTree, 0)}
          </div>
        {/if}

      {:else if ui.rightSidebarTab === 'checks'}
        <div class="empty-state">checks — coming soon</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg, #000);
    border-left: 1px solid var(--border, #333);
    overflow: hidden;
    min-width: 160px;
  }

  .sidebar-collapsed {
    width: 16px;
    height: 100%;
    background: var(--bg, #000);
    border-left: 1px solid var(--border, #333);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 8px;
  }

  .expand-btn {
    background: none;
    border: none;
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-sm, 0.8125rem);
    cursor: pointer;
    padding: 0;
  }

  .expand-btn:hover {
    color: var(--text, #e0e0e0);
  }

  /* Tab bar */
  .tab-bar {
    display: flex;
    border-bottom: 1px solid var(--border, #333);
    padding: 0;
    flex-shrink: 0;
  }

  .tab {
    flex: 1;
    padding: 6px 8px;
    background: none;
    border: none;
    border-bottom: 1px solid transparent;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text-muted, #888);
    cursor: pointer;
    white-space: nowrap;
  }

  .tab:hover {
    color: var(--text, #e0e0e0);
  }

  .tab.active {
    color: var(--text, #e0e0e0);
    border-bottom-color: var(--accent, #d97757);
  }

  .tab-count {
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text-muted, #888);
    margin-left: 4px;
  }

  .collapse-btn {
    background: none;
    border: none;
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
    padding: 6px 8px;
    flex-shrink: 0;
  }

  .collapse-btn:hover {
    color: var(--text, #e0e0e0);
  }

  /* Tab content */
  .tab-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .controls-row {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border, #333);
  }

  /* Tree */
  .tree {
    outline: none;
  }

  .tree-item {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 44px;
    padding: 10px 16px;
    background: none;
    border: none;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text, #e0e0e0);
    cursor: pointer;
    text-align: left;
    gap: 4px;
  }

  .tree-item:hover {
    background: var(--surface-hover, #141414);
  }

  .tree-item.focused {
    background: var(--surface-hover, #141414);
    outline: 1px solid var(--accent, #d97757);
    outline-offset: -1px;
  }

  .tree-item.animating {
    animation: flash-accent 300ms ease-out;
  }

  @keyframes flash-accent {
    0% { background: color-mix(in srgb, var(--accent) 10%, transparent); }
    100% { background: transparent; }
  }

  .icon-slot {
    width: 24px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .expand-arrow {
    color: var(--text-muted, #888);
    font-size: var(--font-size-xs, 0.75rem);
  }

  .blue-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-info, #60a5fa);
  }

  .node-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .action-slot {
    flex-shrink: 0;
    min-width: 36px;
    text-align: right;
  }

  .badge {
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    font-weight: 600;
  }

  .file-count {
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text-muted, #888);
  }

  .has-children-dot {
    display: inline-block;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--text-muted, #888);
  }

  /* States */
  .loading-state, .error-state, .empty-state {
    padding: 16px;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-sm, 0.8125rem);
    color: var(--text-muted, #888);
  }

  .error-state {
    color: var(--status-error, #f87171);
  }

  .error-text {
    font-size: var(--font-size-xs, 0.75rem);
  }

  .retry-btn {
    display: inline-block;
    margin-top: 8px;
    padding: 2px 8px;
    background: none;
    border: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
  }

  .retry-btn:hover {
    color: var(--text, #e0e0e0);
    border-color: var(--text-muted, #888);
  }

  .spinner {
    display: inline-block;
    animation: spin 0.8s steps(8) infinite;
  }

  @keyframes spin {
    to { content: '⠏'; }
  }

  /* Stats bar */
  .stats-bar {
    padding: 6px 16px;
    border-top: 1px solid var(--border, #333);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text-muted, #888);
    flex-shrink: 0;
  }

  .stat-add {
    color: var(--status-success, #4ade80);
  }

  .stat-del {
    color: var(--status-error, #f87171);
  }
</style>
