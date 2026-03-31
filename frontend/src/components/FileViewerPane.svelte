<script lang="ts">
  import { getUi, closeFileTab, closeAllFileTabs, type OpenFileTab } from '../lib/state/ui.svelte.js';
  import { getSessionState } from '../lib/state/sessions.svelte.js';
  import { fetchFileDiff } from '../lib/api.js';
  import { diffSourceToBase } from '../lib/diff-utils.js';
  import { parseLineReference } from '../lib/file-tree-utils.js';
  // DiffSource is now read from shared UI state, not props
  import DiffViewer from './DiffViewer.svelte';
  import CodeBlock from './CodeBlock.svelte';

  let {
    workspacePath,
    onInjectReference,
  }: {
    workspacePath: string;
    onInjectReference?: (reference: string) => void;
  } = $props();

  const ui = getUi();
  const sessionState = getSessionState();

  // Read diffSource and view mode from shared UI state
  let diffSource = $derived(ui.fileDiffSource);
  let defaultBranch = $derived(ui.fileDiffDefaultBranch);
  let diffViewMode = $derived(ui.fileDiffViewMode);
  let wordWrap = $derived(ui.fileWordWrap);

  function toggleDiffViewMode(): void {
    ui.fileDiffViewMode = diffViewMode === 'unified' ? 'side-by-side' : 'unified';
  }

  function toggleWordWrap(): void {
    ui.fileWordWrap = !wordWrap;
  }

  // ── Diff/content cache ──
  let diffCache = $state<Map<string, string>>(new Map());
  let loadingPaths = $state<Set<string>>(new Set());
  let errorPaths = $state<Map<string, string>>(new Map());

  let base = $derived(diffSourceToBase(diffSource, defaultBranch));
  let activeTab = $derived<OpenFileTab | undefined>(
    ui.openFileTabs.find(t => t.filePath === ui.activeFileTabPath)
  );
  let activeDiff = $derived(activeTab ? diffCache.get(cacheKey(activeTab.filePath)) ?? '' : '');
  let activeLoading = $derived(activeTab ? loadingPaths.has(cacheKey(activeTab.filePath)) : false);
  let activeError = $derived(activeTab ? errorPaths.get(cacheKey(activeTab.filePath)) ?? null : null);

  // Active session info for send-to pill
  let activeSessionName = $derived.by(() => {
    const targetId = ui.sendToTargetSessionId ?? sessionState.activeSessionId;
    if (!targetId) return 'no sessions';
    const session = sessionState.sessions.find(s => s.id === targetId);
    return session?.displayName ?? session?.branchName ?? 'session';
  });

  let hasActiveSession = $derived(
    (ui.sendToTargetSessionId ?? sessionState.activeSessionId) !== null
  );

  // Cache key includes base to avoid stale diffs across diff source changes
  function cacheKey(filePath: string): string {
    return `${filePath}::${base ?? 'working'}`;
  }

  // Fetch diff when active tab or base changes
  $effect(() => {
    const tab = activeTab;
    if (!tab || !workspacePath) return;
    const key = cacheKey(tab.filePath);
    if (diffCache.has(key)) return;
    if (loadingPaths.has(key)) return;

    const capturedBase = base;
    loadingPaths.add(key);
    loadingPaths = new Set(loadingPaths);

    fetchFileDiff(workspacePath, tab.filePath, capturedBase).then(
      (result) => {
        // Discard if base changed during fetch
        if (base !== capturedBase) return;
        if (result.error) {
          errorPaths.set(key, result.error);
          errorPaths = new Map(errorPaths);
        } else {
          diffCache.set(key, result.diff);
          diffCache = new Map(diffCache);
        }
      },
      (err) => {
        if (base !== capturedBase) return;
        errorPaths.set(key, err instanceof Error ? err.message : 'failed to load diff');
        errorPaths = new Map(errorPaths);
      },
    ).finally(() => {
      loadingPaths.delete(key);
      loadingPaths = new Set(loadingPaths);
    });
  });

  function handleCloseTab(filePath: string, e: MouseEvent): void {
    e.stopPropagation();
    closeFileTab(filePath);
    const key = cacheKey(filePath);
    diffCache.delete(key);
    errorPaths.delete(key);
    diffCache = new Map(diffCache);
    errorPaths = new Map(errorPaths);
  }

  function handleTabClick(tab: OpenFileTab): void {
    ui.activeFileTabPath = tab.filePath;
  }

  function handleDiffLineClick(filePath: string, lineNumber: number): void {
    if (!hasActiveSession) return;
    const reference = parseLineReference(filePath, lineNumber);
    onInjectReference?.(reference);
  }

  function handleRetry(): void {
    if (!activeTab) return;
    const key = cacheKey(activeTab.filePath);
    errorPaths.delete(key);
    diffCache.delete(key);
    errorPaths = new Map(errorPaths);
    diffCache = new Map(diffCache);
  }

  function languageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
      py: 'python', rs: 'rust', go: 'go', rb: 'ruby',
      java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
      css: 'css', scss: 'scss', html: 'html', svelte: 'svelte',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
      md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
      sql: 'sql', graphql: 'graphql',
    };
    return map[ext] ?? 'text';
  }
</script>

<div class="file-viewer">
  <!-- File tab bar -->
  <div class="file-tab-bar">
    <div class="tabs-scroll">
      {#each ui.openFileTabs as tab (tab.filePath)}
        <div
          class="file-tab"
          class:active={ui.activeFileTabPath === tab.filePath}
          role="tab"
          tabindex="0"
          aria-selected={ui.activeFileTabPath === tab.filePath}
          onclick={() => handleTabClick(tab)}
          onkeydown={(e) => { if (e.key === 'Enter') handleTabClick(tab); }}
          title={tab.filePath}
        >
          <span class="tab-name">{tab.fileName}</span>
          {#if tab.isChanged}
            <span class="tab-badge">M</span>
          {/if}
          <button
            class="tab-close"
            onclick={(e) => handleCloseTab(tab.filePath, e)}
            aria-label="close {tab.fileName}"
          >×</button>
        </div>
      {/each}
    </div>
    <div class="tab-bar-actions">
      <button class="diff-mode-btn" onclick={toggleWordWrap} title="Toggle word wrap">
        {wordWrap ? '[nowrap]' : '[wrap]'}
      </button>
      {#if activeTab?.isChanged}
        <button class="diff-mode-btn" onclick={toggleDiffViewMode} title="Toggle split/unified diff">
          {diffViewMode === 'unified' ? '[split]' : '[unified]'}
        </button>
      {/if}
      {#if ui.openFileTabs.length > 1}
        <button class="close-all-btn" onclick={closeAllFileTabs}>close all</button>
      {/if}
      <!-- Send-to pill -->
      <div class="send-to-pill" class:disabled={!hasActiveSession}>
        <span class="send-to-label">send to:</span>
        <span class="send-to-target">{activeSessionName}</span>
      </div>
    </div>
  </div>

  <!-- Content area -->
  <div class="file-content" role="tabpanel">
    {#if !activeTab}
      <div class="empty-viewer">select a file from the sidebar</div>
    {:else if activeLoading}
      <div class="loading-viewer">
        <span class="spinner">&#x280B;</span> loading {activeTab.fileName}...
      </div>
    {:else if activeError}
      <div class="error-viewer">
        <div class="error-text">failed to load diff: {activeError}</div>
        <div class="error-actions">
          <button class="retry-btn" onclick={handleRetry}>retry</button>
          <button class="close-btn" onclick={() => closeFileTab(activeTab!.filePath)}>close tab</button>
        </div>
      </div>
    {:else if activeTab.isChanged && activeDiff}
      <!-- Diff view with line-click handler -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="diff-wrapper" onclick={(e) => {
        // Diff-to-agent bridge: detect clicks on line numbers in the gutter
        const target = e.target as HTMLElement;
        const lineEl = target.closest('.line-number, .d2h-code-linenumber');
        if (!lineEl || !activeTab) return;
        const lineText = lineEl.textContent?.trim();
        const lineNum = lineText ? parseInt(lineText, 10) : NaN;
        if (!Number.isNaN(lineNum) && lineNum > 0) {
          handleDiffLineClick(activeTab.filePath, lineNum);
        }
      }}>
        <DiffViewer
          diff={activeDiff}
          filePath={activeTab.filePath}
          mode={diffViewMode}
          {wordWrap}
        />
      </div>
    {:else if !activeTab.isChanged}
      <!-- Raw file view -->
      <div class="raw-file" class:word-wrap={wordWrap}>
        <CodeBlock code={activeDiff || '(empty file)'} language={languageFromPath(activeTab.filePath)} />
      </div>
    {:else}
      <div class="empty-viewer">no diff available</div>
    {/if}
  </div>
</div>

<style>
  .file-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg, #000);
    overflow: hidden;
  }

  /* File tab bar */
  .file-tab-bar {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border, #333);
    min-height: 32px;
    flex-shrink: 0;
  }

  .tabs-scroll {
    display: flex;
    overflow-x: auto;
    flex: 1;
    min-width: 0;
  }

  .tabs-scroll::-webkit-scrollbar {
    height: 2px;
  }

  .tabs-scroll::-webkit-scrollbar-thumb {
    background: var(--border, #333);
  }

  .file-tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    background: none;
    border: none;
    border-bottom: 1px solid transparent;
    border-right: 1px solid var(--border, #333);
    margin-bottom: -1px;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--text-muted, #888);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .file-tab:hover {
    color: var(--text, #e0e0e0);
    background: var(--surface-hover, #141414);
  }

  .file-tab.active {
    color: var(--text, #e0e0e0);
    border-bottom-color: var(--accent, #d97757);
  }

  .tab-name {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tab-badge {
    font-size: 0.625rem;
    color: var(--status-warning, #fbbf24);
  }

  .tab-close {
    background: none;
    border: none;
    color: var(--text-muted, #888);
    font-size: var(--font-size-sm, 0.8125rem);
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
  }

  .tab-close:hover {
    color: var(--text, #e0e0e0);
  }

  .tab-bar-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    flex-shrink: 0;
  }

  .diff-mode-btn {
    background: none;
    border: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
    white-space: nowrap;
    padding: 1px 6px;
  }

  .diff-mode-btn:hover {
    color: var(--text, #e0e0e0);
    border-color: var(--text-muted, #888);
  }

  .close-all-btn {
    background: none;
    border: none;
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
    white-space: nowrap;
  }

  .close-all-btn:hover {
    color: var(--text, #e0e0e0);
  }

  /* Send-to pill */
  .send-to-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--border, #333);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    white-space: nowrap;
  }

  .send-to-pill.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .send-to-label {
    color: var(--text-muted, #888);
  }

  .send-to-target {
    color: var(--text, #e0e0e0);
  }

  /* Content */
  .file-content {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }

  .diff-wrapper {
    position: relative;
    height: 100%;
    overflow: auto;
  }

  /* Override DiffViewer standalone styles when embedded in file viewer */
  .diff-wrapper :global(.diff-viewer) {
    max-height: none;
    border: none;
  }

  /* Diff-to-agent bridge: make line numbers clickable with + indicator */
  .diff-wrapper :global(.line-number),
  .diff-wrapper :global(.d2h-code-linenumber) {
    position: relative;
    cursor: pointer;
  }

  .diff-wrapper :global(.line-number)::before,
  .diff-wrapper :global(.d2h-code-linenumber)::before {
    content: '+';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted, #888);
    font-size: 10px;
    opacity: 0;
    transition: opacity 100ms;
    pointer-events: none;
  }

  .diff-wrapper :global(.line-number):hover::before,
  .diff-wrapper :global(.d2h-code-linenumber):hover::before {
    opacity: 1;
    color: var(--accent, #d97757);
  }

  .diff-wrapper :global(.line-number):hover,
  .diff-wrapper :global(.d2h-code-linenumber):hover {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .raw-file {
    padding: 8px;
  }

  .raw-file.word-wrap :global(pre) {
    white-space: pre-wrap;
    word-break: break-all;
  }

  .empty-viewer, .loading-viewer, .error-viewer {
    padding: 24px 16px;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-sm, 0.8125rem);
    color: var(--text-muted, #888);
  }

  .error-viewer {
    color: var(--status-error, #f87171);
  }

  .error-text {
    font-size: var(--font-size-xs, 0.75rem);
    margin-bottom: 8px;
  }

  .error-actions {
    display: flex;
    gap: 8px;
  }

  .retry-btn, .close-btn {
    padding: 2px 8px;
    background: none;
    border: 1px solid var(--border, #333);
    color: var(--text-muted, #888);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
  }

  .retry-btn:hover, .close-btn:hover {
    color: var(--text, #e0e0e0);
    border-color: var(--text-muted, #888);
  }

  .spinner {
    display: inline-block;
    animation: braille-spin 0.8s steps(8) infinite;
  }

  @keyframes braille-spin {
    to { content: '⠏'; }
  }
</style>
