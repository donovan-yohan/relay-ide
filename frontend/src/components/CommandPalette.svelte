<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { Repo, SessionSummary, PullRequest, OrgPrsResponse, GitHubIssue, GitHubIssuesResponse, JiraIssue, JiraIssuesResponse } from '../lib/types.js';
  import { derivePrDotStatus } from '../lib/pr-status.js';
  import StatusDot from './StatusDot.svelte';
  import TuiInput from './TuiInput.svelte';
  import { getAllActions } from '../lib/actions/registry.svelte.js';
  import { formatShortcut } from '../lib/actions/shortcuts.js';
  import type { ActionContext, Action } from '../lib/actions/types.js';
  import { onDestroy } from 'svelte';
  import { isMobileDevice, isMac } from '../lib/utils.js';

  const TABS = ['all', 'sessions', 'workspaces', 'prs', 'settings'] as const;
  type Tab = typeof TABS[number];

  let {
    open = false,
    workspaces,
    sessions,
    actionContext,
    onClose,
    onSelectWorkspace,
    onSelectSession,
    onSelectPr,
    onOpenSettings,
  }: {
    open: boolean;
    workspaces: Repo[];
    sessions: SessionSummary[];
    actionContext: ActionContext;
    onClose: () => void;
    onSelectWorkspace: (path: string) => void;
    onSelectSession: (id: string) => void;
    onSelectPr: (pr: PullRequest) => void;
    onOpenSettings?: (sectionId: string) => void;
  } = $props();

  const queryClient = useQueryClient();

  let query = $state('');
  let focusedIndex = $state(0);
  let inputWrapperEl = $state<HTMLDivElement | undefined>(undefined);
  let resultsEl = $state<HTMLDivElement | undefined>(undefined);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debouncedQuery = $state('');
  let activeTab = $state<Tab>('all');

  // Drag-dismiss state (mobile)
  let dragStartY = 0;
  let dragOffset = $state(0);
  let dragging = $state(false);

  // Read cached data from svelte-query
  let cachedPrs = $derived<PullRequest[]>(
    (queryClient.getQueryData<OrgPrsResponse>(['org-prs'])?.prs ?? [])
  );
  let cachedGithubIssues = $derived<GitHubIssue[]>(
    (queryClient.getQueryData<GitHubIssuesResponse>(['github-issues'])?.issues ?? [])
  );
  let cachedJiraIssues = $derived<JiraIssue[]>(
    (queryClient.getQueryData<JiraIssuesResponse>(['jira-issues'])?.issues ?? [])
  );

  // Settings entries (searchable)
  const SETTINGS_ENTRIES = [
    { id: 'setting-agent', label: 'Default Coding Agent', description: 'Which AI agent to use', section: 'section-general' },
    { id: 'setting-continue', label: 'Continue Session', description: 'Resume last session when opening a repo', section: 'section-general' },
    { id: 'setting-yolo', label: 'YOLO Mode', description: 'Skip permission checks', section: 'section-general' },
    { id: 'setting-tmux', label: 'Launch in tmux', description: 'Wrap sessions in tmux', section: 'section-general' },
    { id: 'setting-notifications', label: 'Notifications', description: 'Push notifications for sessions', section: 'section-general' },
    { id: 'setting-github', label: 'GitHub Connection', description: 'Connect GitHub account for PRs and CI', section: 'section-integrations' },
    { id: 'setting-webhooks', label: 'Webhooks', description: 'Real-time CI and PR updates', section: 'section-integrations' },
    { id: 'setting-jira', label: 'Jira', description: 'See Jira tickets in the sidebar', section: 'section-integrations' },
    { id: 'setting-devtools', label: 'Developer Tools', description: 'Mobile debug panel', section: 'section-advanced' },
    { id: 'setting-analytics', label: 'Analytics', description: 'Local usage data', section: 'section-advanced' },
    { id: 'setting-version', label: 'Version', description: 'Check for updates', section: 'section-about' },
  ];

  // Registry commands filtered by context
  let registryCommands = $derived.by(() => {
    return getAllActions().filter(a => !a.when || a.when(actionContext));
  });

  // "Needs Attention" — PRs with changes requested or awaiting review
  let needsAttention = $derived(
    cachedPrs.filter(pr =>
      pr.state === 'OPEN' && (
        pr.reviewDecision === 'CHANGES_REQUESTED' ||
        pr.role === 'reviewer'
      )
    ).slice(0, 5)
  );

  // Search results
  type PaletteResult =
    | { type: 'workspace'; id: string; label: string; sublabel?: string; data: Repo }
    | { type: 'session'; id: string; label: string; sublabel?: string; data: SessionSummary }
    | { type: 'pr' | 'attention'; id: string; label: string; sublabel?: string; data: PullRequest }
    | { type: 'ticket'; id: string; label: string; sublabel?: string; data: GitHubIssue | JiraIssue }
    | { type: 'command'; id: string; label: string; sublabel?: string; data: Action }
    | { type: 'setting'; id: string; label: string; sublabel?: string; data: { id: string; label: string; description: string; section: string } };

  // Tab filter mapping
  function matchesTab(type: PaletteResult['type']): boolean {
    if (activeTab === 'all') return true;
    switch (activeTab) {
      case 'sessions': return type === 'session' || type === 'command';
      case 'workspaces': return type === 'workspace';
      case 'prs': return type === 'pr' || type === 'attention';
      case 'settings': return type === 'setting' || type === 'command';
      default: return true;
    }
  }

  let results = $derived.by((): PaletteResult[] => {
    const q = debouncedQuery.toLowerCase().trim();
    const items: PaletteResult[] = [];

    if (!q) {
      for (const pr of needsAttention) {
        items.push({ type: 'attention', id: `attn-${pr.number}`, label: `#${pr.number} ${pr.title}`, sublabel: pr.repoName ?? '', data: pr });
      }
      for (const ws of workspaces.slice(0, 5)) {
        items.push({ type: 'workspace', id: `ws-${ws.path}`, label: ws.name, sublabel: ws.path, data: ws });
      }
      for (const action of registryCommands) {
        items.push({ type: 'command', id: `cmd-${action.id}`, label: action.label, sublabel: action.description ?? '', data: action });
      }
      return items.filter(r => matchesTab(r.type));
    }

    // Workspaces
    for (const ws of workspaces.filter(w => w.name.toLowerCase().includes(q)).slice(0, 5)) {
      items.push({ type: 'workspace', id: `ws-${ws.path}`, label: ws.name, sublabel: ws.path, data: ws });
    }
    // Sessions
    for (const s of sessions.filter(s => s.displayName.toLowerCase().includes(q) || s.branchName.toLowerCase().includes(q) || s.repoName.toLowerCase().includes(q)).slice(0, 5)) {
      items.push({ type: 'session', id: `sess-${s.id}`, label: s.displayName || s.branchName || s.repoName, sublabel: s.repoName, data: s });
    }
    // PRs
    for (const pr of cachedPrs.filter(pr => pr.title.toLowerCase().includes(q) || String(pr.number).includes(q) || pr.headRefName.toLowerCase().includes(q)).slice(0, 5)) {
      items.push({ type: 'pr', id: `pr-${pr.number}`, label: `#${pr.number} ${pr.title}`, sublabel: pr.repoName ?? pr.headRefName, data: pr });
    }
    // GitHub Issues
    for (const issue of cachedGithubIssues.filter(i => i.title.toLowerCase().includes(q) || String(i.number).includes(q)).slice(0, 3)) {
      items.push({ type: 'ticket', id: `gh-${issue.number}`, label: `#${issue.number} ${issue.title}`, sublabel: issue.repoName, data: issue });
    }
    // Jira Issues
    for (const issue of cachedJiraIssues.filter(i => i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q)).slice(0, 3)) {
      items.push({ type: 'ticket', id: `jira-${issue.key}`, label: `${issue.key} ${issue.title}`, sublabel: issue.status, data: issue });
    }
    // Commands from registry
    for (const action of registryCommands.filter(a => a.label.toLowerCase().includes(q) || (a.description?.toLowerCase().includes(q)) || (a.aliases?.some(alias => alias.toLowerCase().includes(q))))) {
      items.push({ type: 'command', id: `cmd-${action.id}`, label: action.label, sublabel: action.description ?? '', data: action });
    }
    // Settings
    for (const s of SETTINGS_ENTRIES.filter(s => s.label.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))) {
      items.push({ type: 'setting', id: s.id, label: s.label, sublabel: s.description, data: s });
    }
    return items.filter(r => matchesTab(r.type));
  });

  // Group results by type
  interface ResultGroup { label: string; items: PaletteResult[]; }

  let groupedResults = $derived.by((): ResultGroup[] => {
    const q = debouncedQuery.toLowerCase().trim();
    const groups: ResultGroup[] = [];
    const typeOrder: Array<{ type: PaletteResult['type']; label: string }> = q
      ? [
          { type: 'workspace', label: 'workspaces' },
          { type: 'session', label: 'sessions' },
          { type: 'pr', label: 'pull requests' },
          { type: 'ticket', label: 'tickets' },
          { type: 'command', label: 'commands' },
          { type: 'setting', label: 'settings' },
        ]
      : [
          { type: 'attention', label: 'needs attention' },
          { type: 'workspace', label: 'workspaces' },
          { type: 'command', label: 'commands' },
        ];
    for (const { type, label } of typeOrder) {
      const items = results.filter(r => r.type === type);
      if (items.length > 0) groups.push({ label, items });
    }
    return groups;
  });

  let flatItems = $derived(groupedResults.flatMap(g => g.items));
  let flatIndexMap = $derived(new Map(flatItems.map((item, i) => [item.id, i])));

  $effect(() => {
    if (focusedIndex >= flatItems.length) focusedIndex = Math.max(0, flatItems.length - 1);
  });

  $effect(() => {
    if (open) {
      query = '';
      debouncedQuery = '';
      focusedIndex = 0;
      activeTab = 'all';
      dragOffset = 0;
      dragging = false;
      requestAnimationFrame(() => inputWrapperEl?.querySelector('input')?.focus());
    }
  });

  onDestroy(() => { if (debounceTimer) clearTimeout(debounceTimer); });

  function handleInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debouncedQuery = query; }, 150);
  }

  async function selectItem(item: PaletteResult) {
    if (item.type === 'command') {
      try {
        await item.data.handler(actionContext);
        onClose();
      } catch (err) {
        console.error(`Action "${item.data.id}" failed:`, err);
        onClose();
      }
      return;
    }
    onClose();
    switch (item.type) {
      case 'workspace': onSelectWorkspace(item.data.path); break;
      case 'session': onSelectSession(item.data.id); break;
      case 'attention': case 'pr': onSelectPr(item.data); break;
      case 'ticket': break;
      case 'setting': onOpenSettings?.(item.data.section); break;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); focusedIndex = Math.min(focusedIndex + 1, flatItems.length - 1); scrollFocusedIntoView(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusedIndex = Math.max(focusedIndex - 1, 0); scrollFocusedIntoView(); return; }
    if (e.key === 'Enter') { e.preventDefault(); const item = flatItems[focusedIndex]; if (item) selectItem(item); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const idx = TABS.indexOf(activeTab);
      activeTab = e.shiftKey ? TABS[(idx - 1 + TABS.length) % TABS.length]! : TABS[(idx + 1) % TABS.length]!;
      focusedIndex = 0;
      return;
    }
  }

  function scrollFocusedIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.palette-item.focused');
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('palette-overlay')) onClose();
  }

  function categoryIcon(type: PaletteResult['type']): string {
    switch (type) {
      case 'workspace': return '■';
      case 'session': return '▸';
      case 'pr': case 'attention': return '●';
      case 'ticket': return '#';
      case 'command': return '>';
      case 'setting': return '*';
      default: return '';
    }
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
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="palette-overlay" class:mobile={isMobileDevice} onclick={handleBackdropClick}>
    <div
      class="palette"
      class:mobile={isMobileDevice}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Command palette"
      style={isMobileDevice && dragOffset > 0 ? `transform: translateY(${dragOffset}px)` : ''}
      ontouchstart={handleDragStart}
      ontouchmove={handleDragMove}
      ontouchend={handleDragEnd}
      ontouchcancel={handleDragEnd}
    >
      {#if isMobileDevice}
        <div class="drag-handle"><span class="drag-bar"></span></div>
      {/if}

      <div class="palette-input-row" bind:this={inputWrapperEl}>
        <span class="palette-prompt">&gt;</span>
        <TuiInput
          bind:value={query}
          placeholder="search commands, workspaces, sessions..."
          oninput={handleInput}
          onkeydown={handleKeydown}
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-expanded={flatItems.length > 0}
          aria-controls="palette-results"
          aria-activedescendant={flatItems[focusedIndex] ? `palette-item-${flatItems[focusedIndex]!.id}` : undefined}
        />
      </div>

      <div class="palette-tabs" role="tablist">
        {#each TABS as tab (tab)}
          <button
            class="palette-tab"
            class:active={activeTab === tab}
            role="tab"
            aria-selected={activeTab === tab}
            onclick={() => { activeTab = tab as typeof activeTab; focusedIndex = 0; }}
          >{tab}</button>
        {/each}
      </div>

      <div class="palette-results" id="palette-results" role="listbox" bind:this={resultsEl}>
        {#if flatItems.length === 0 && debouncedQuery.trim()}
          <div class="palette-empty">no results for "{debouncedQuery}"</div>
        {:else}
          {#each groupedResults as group (group.label)}
            <div class="palette-category" role="presentation">
              {group.label}
              {#if group.label === 'needs attention'}
                <span class="category-count">({group.items.length})</span>
              {/if}
            </div>
            {#each group.items as item (item.id)}
              {@const globalIndex = flatIndexMap.get(item.id) ?? -1}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                id="palette-item-{item.id}"
                class="palette-item"
                class:focused={globalIndex === focusedIndex}
                role="option"
                tabindex="-1"
                aria-selected={globalIndex === focusedIndex}
                onclick={() => selectItem(item)}
                onmouseenter={() => { focusedIndex = globalIndex; }}
              >
                <span class="item-cursor" class:visible={globalIndex === focusedIndex}>&gt;</span>
                {#if item.type === 'attention' || item.type === 'pr'}
                  <StatusDot status={derivePrDotStatus(item.data)} size={7} />
                {:else if item.type === 'command' && item.data.icon}
                  <span class="item-icon">{item.data.icon}</span>
                {:else}
                  <span class="item-icon">{categoryIcon(item.type)}</span>
                {/if}
                <span class="item-label">{item.label}</span>
                {#if item.sublabel}
                  <span class="item-sublabel">{item.sublabel}</span>
                {/if}
                {#if !isMobileDevice && item.type === 'command' && item.data.shortcut}
                  <kbd class="item-shortcut">{formatShortcut(item.data.shortcut.key, isMac)}</kbd>
                {/if}
              </div>
            {/each}
          {/each}
        {/if}
      </div>

      {#if !isMobileDevice}
        <div class="palette-footer">
          <span class="hint">↑↓ navigate</span>
          <span class="hint">tab category</span>
          <span class="hint">↵ select</span>
          <span class="hint">esc close</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .palette-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 20vh;
  }

  .palette {
    width: 100%;
    max-width: 580px;
    background: var(--surface);
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    max-height: 480px;
  }

  .palette-input-row {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    height: 44px;
  }

  .palette-prompt {
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--accent);
    font-weight: bold;
    flex-shrink: 0;
    line-height: 1;
    user-select: none;
  }

  .palette-input-row :global(.tui-input-wrapper) { flex: 1; }
  .palette-input-row :global(.tui-input) { background: transparent; border: none; padding: 0; }
  .palette-input-row :global(.tui-input:focus) { border: none; }
  .palette-input-row :global(.tui-input::placeholder) { color: var(--text-muted); opacity: 0.6; }

  .palette-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    height: 32px;
  }

  .palette-tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 6px 12px;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    cursor: pointer;
    text-transform: lowercase;
  }

  .palette-tab:hover { color: var(--text); }
  .palette-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  .palette-results { overflow-y: auto; flex: 1; min-height: 0; }

  .palette-category {
    padding: 8px 16px 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.08em;
    user-select: none;
    text-transform: lowercase;
  }

  .category-count { font-weight: 400; opacity: 0.7; }

  .palette-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    transition: background 0.08s;
    min-height: 36px;
  }

  .palette-item:hover, .palette-item.focused { background: var(--surface-hover); color: var(--text); }

  .item-cursor {
    flex-shrink: 0;
    width: 12px;
    font-size: var(--font-size-xs);
    color: var(--accent);
    opacity: 0;
    transition: opacity 0.12s ease-out;
  }

  .item-cursor.visible { opacity: 1; }

  .item-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.6;
  }

  .item-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  .item-sublabel {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
    min-width: 0;
    max-width: 180px;
  }

  .item-shortcut {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    border: 1px solid var(--border);
    padding: 1px 6px;
    flex-shrink: 0;
    border-radius: 0;
  }

  .palette-empty {
    padding: 20px 16px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    opacity: 0.6;
    text-align: center;
  }

  .palette-footer {
    display: flex;
    gap: 16px;
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .hint {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.5;
  }

  /* Mobile bottom sheet */
  .palette-overlay.mobile { padding-top: 0; align-items: flex-end; background: rgba(0, 0, 0, 0.6); }

  .palette.mobile {
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

  .palette.mobile .palette-item {
    min-height: 48px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--surface-hover);
  }

  .palette.mobile .item-cursor { display: none; }
  .palette.mobile .item-shortcut { display: none; }
  .palette.mobile .palette-tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; }
</style>
