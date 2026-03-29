<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { Repo, SessionSummary, PullRequest, OrgPrsResponse, GitHubIssue, GitHubIssuesResponse, JiraIssue, JiraIssuesResponse } from '../lib/types.js';
  import { derivePrDotStatus } from '../lib/pr-status.js';
  import StatusDot from './StatusDot.svelte';
  import TuiInput from './TuiInput.svelte';
  import { getAllActions } from '../lib/actions/registry.svelte.js';
  import type { ActionContext, Action } from '../lib/actions/types.js';

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
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debouncedQuery = $state('');

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

  // Settings entries
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

  // Commands from the action registry, filtered by current context
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
  type SpotlightResult =
    | { type: 'workspace'; id: string; label: string; sublabel?: string; data: Repo }
    | { type: 'session'; id: string; label: string; sublabel?: string; data: SessionSummary }
    | { type: 'pr' | 'attention'; id: string; label: string; sublabel?: string; data: PullRequest }
    | { type: 'ticket'; id: string; label: string; sublabel?: string; data: GitHubIssue | JiraIssue }
    | { type: 'command'; id: string; label: string; sublabel?: string; data: Action }
    | { type: 'setting'; id: string; label: string; sublabel?: string; data: { id: string; label: string; description: string; section: string } };

  let results = $derived.by((): SpotlightResult[] => {
    const q = debouncedQuery.toLowerCase().trim();
    const items: SpotlightResult[] = [];

    if (!q) {
      // Default: needs attention + recent workspaces
      for (const pr of needsAttention) {
        items.push({
          type: 'attention',
          id: `attn-${pr.number}`,
          label: `#${pr.number} ${pr.title}`,
          sublabel: pr.repoName ?? '',
          data: pr,
        });
      }
      for (const ws of workspaces.slice(0, 5)) {
        items.push({
          type: 'workspace',
          id: `ws-${ws.path}`,
          label: ws.name,
          sublabel: ws.path,
          data: ws,
        });
      }
      for (const action of registryCommands) {
        items.push({
          type: 'command',
          id: `cmd-${action.id}`,
          label: action.label,
          sublabel: action.description ?? '',
          data: action,
        });
      }
      return items;
    }

    // Workspaces
    const wsMatches = workspaces
      .filter(w => w.name.toLowerCase().includes(q))
      .slice(0, 5);
    for (const ws of wsMatches) {
      items.push({
        type: 'workspace',
        id: `ws-${ws.path}`,
        label: ws.name,
        sublabel: ws.path,
        data: ws,
      });
    }

    // Sessions
    const sessMatches = sessions
      .filter(s =>
        s.displayName.toLowerCase().includes(q) ||
        s.branchName.toLowerCase().includes(q) ||
        s.repoName.toLowerCase().includes(q)
      )
      .slice(0, 5);
    for (const s of sessMatches) {
      items.push({
        type: 'session',
        id: `sess-${s.id}`,
        label: s.displayName || s.branchName || s.repoName,
        sublabel: s.repoName,
        data: s,
      });
    }

    // PRs
    const prMatches = cachedPrs
      .filter(pr =>
        pr.title.toLowerCase().includes(q) ||
        String(pr.number).includes(q) ||
        pr.headRefName.toLowerCase().includes(q)
      )
      .slice(0, 5);
    for (const pr of prMatches) {
      items.push({
        type: 'pr',
        id: `pr-${pr.number}`,
        label: `#${pr.number} ${pr.title}`,
        sublabel: pr.repoName ?? pr.headRefName,
        data: pr,
      });
    }

    // GitHub Issues
    const ghMatches = cachedGithubIssues
      .filter(i =>
        i.title.toLowerCase().includes(q) ||
        String(i.number).includes(q)
      )
      .slice(0, 3);
    for (const issue of ghMatches) {
      items.push({
        type: 'ticket',
        id: `gh-${issue.number}`,
        label: `#${issue.number} ${issue.title}`,
        sublabel: issue.repoName,
        data: issue,
      });
    }

    // Jira Issues
    const jiraMatches = cachedJiraIssues
      .filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.key.toLowerCase().includes(q)
      )
      .slice(0, 3);
    for (const issue of jiraMatches) {
      items.push({
        type: 'ticket',
        id: `jira-${issue.key}`,
        label: `${issue.key} ${issue.title}`,
        sublabel: issue.status,
        data: issue,
      });
    }

    // Commands from registry
    const cmdMatches = registryCommands
      .filter(a =>
        a.label.toLowerCase().includes(q) ||
        (a.description?.toLowerCase().includes(q)) ||
        (a.aliases?.some(alias => alias.toLowerCase().includes(q)))
      );
    for (const action of cmdMatches) {
      items.push({
        type: 'command',
        id: `cmd-${action.id}`,
        label: action.label,
        sublabel: action.description ?? '',
        data: action,
      });
    }

    // Settings
    const settingMatches = SETTINGS_ENTRIES
      .filter(s =>
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    for (const s of settingMatches) {
      items.push({
        type: 'setting',
        id: s.id,
        label: s.label,
        sublabel: s.description,
        data: s,
      });
    }

    return items;
  });

  // Group results by type for category headers
  interface ResultGroup {
    label: string;
    items: SpotlightResult[];
  }

  let groupedResults = $derived.by((): ResultGroup[] => {
    const q = debouncedQuery.toLowerCase().trim();
    const groups: ResultGroup[] = [];
    const typeOrder: Array<{ type: SpotlightResult['type']; label: string }> = q
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
      if (items.length > 0) {
        groups.push({ label, items });
      }
    }
    return groups;
  });

  // Flat list for keyboard navigation
  let flatItems = $derived(groupedResults.flatMap(g => g.items));

  // Clamp focused index when results change
  $effect(() => {
    if (focusedIndex >= flatItems.length) {
      focusedIndex = Math.max(0, flatItems.length - 1);
    }
  });

  // Focus input when opened
  $effect(() => {
    if (open) {
      query = '';
      debouncedQuery = '';
      focusedIndex = 0;
      requestAnimationFrame(() => inputWrapperEl?.querySelector('input')?.focus());
    }
  });

  function handleInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery = query;
    }, 150);
  }

  async function selectItem(item: SpotlightResult) {
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
      case 'workspace':
        onSelectWorkspace(item.data.path);
        break;
      case 'session':
        onSelectSession(item.data.id);
        break;
      case 'attention':
      case 'pr':
        onSelectPr(item.data);
        break;
      case 'ticket':
        break;
      case 'setting':
        onOpenSettings?.(item.data.section);
        break;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIndex = Math.min(focusedIndex + 1, flatItems.length - 1);
      scrollFocusedIntoView();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIndex = Math.max(focusedIndex - 1, 0);
      scrollFocusedIntoView();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = flatItems[focusedIndex];
      if (item) selectItem(item);
      return;
    }
  }

  function scrollFocusedIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector('.spotlight-item.focused');
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('spotlight-overlay')) {
      onClose();
    }
  }

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

  function formatShortcut(key: string): string {
    const parts = key
      .replace('mod', isMac ? '⌘' : 'ctrl')
      .replace('shift', '⇧')
      .split('+')
      .map(k => k.length === 1 ? k.toUpperCase() : k);
    return isMac ? parts.join('') : parts.join('+');
  }

  function categoryIcon(type: SpotlightResult['type']): string {
    switch (type) {
      case 'workspace': return '■';
      case 'session': return '▸';
      case 'pr': case 'attention': return '●';
      case 'ticket': return '◆';
      case 'command': return '>';
      case 'setting': return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" width="14" height="14"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1-1.51V15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
      default: return '';
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="spotlight-overlay" onclick={handleBackdropClick}>
    <div
      class="spotlight"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div class="spotlight-input-row" bind:this={inputWrapperEl}>
        <span class="spotlight-prompt">&gt;</span>
        <TuiInput
          bind:value={query}
          placeholder="search workspaces, PRs, commands..."
          oninput={handleInput}
          onkeydown={handleKeydown}
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-expanded={flatItems.length > 0}
          aria-controls="spotlight-results"
          aria-activedescendant={flatItems[focusedIndex] ? `spotlight-item-${flatItems[focusedIndex]!.id}` : undefined}
        />
      </div>

      <div class="spotlight-results" id="spotlight-results" role="listbox">
        {#if flatItems.length === 0 && debouncedQuery.trim()}
          <div class="spotlight-empty">No results for '{debouncedQuery}'</div>
        {:else}
          {#each groupedResults as group}
            <div class="spotlight-category" role="presentation">
              {group.label}
              {#if group.label === 'needs attention'}
                <span class="category-count">({group.items.length})</span>
              {/if}
            </div>
            {#each group.items as item, i}
              {@const globalIndex = flatItems.indexOf(item)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                id="spotlight-item-{item.id}"
                class="spotlight-item"
                class:focused={globalIndex === focusedIndex}
                role="option"
                aria-selected={globalIndex === focusedIndex}
                onclick={() => selectItem(item)}
                onmouseenter={() => { focusedIndex = globalIndex; }}
              >
                {#if item.type === 'attention' || item.type === 'pr'}
                  <StatusDot status={derivePrDotStatus(item.data)} size={7} />
                {:else if item.type === 'command' && item.data.icon}
                  <span class="item-icon">{item.data.icon}</span>
                {:else}
                  <span class="item-icon">{@html categoryIcon(item.type)}</span>
                {/if}
                <span class="item-label">{item.label}</span>
                {#if item.sublabel}
                  <span class="item-sublabel">{item.sublabel}</span>
                {/if}
                {#if item.type === 'command' && item.data.shortcut}
                  <kbd class="item-shortcut">{formatShortcut(item.data.shortcut.key)}</kbd>
                {/if}
              </div>
            {/each}
          {/each}
        {/if}
      </div>

      <div class="spotlight-footer">
        <span class="shortcut-hint">↑↓ navigate</span>
        <span class="shortcut-hint">↵ select</span>
        <span class="shortcut-hint">esc close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .spotlight-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 1000;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 15vh;
  }

  .spotlight {
    width: 100%;
    max-width: 560px;
    background: var(--surface);
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    max-height: 60vh;
  }

  .spotlight-input-row {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .spotlight-prompt {
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--accent);
    flex-shrink: 0;
    line-height: 1;
    user-select: none;
  }

  .spotlight-input-row :global(.tui-input-wrapper) {
    flex: 1;
  }

  .spotlight-input-row :global(.tui-input) {
    background: transparent;
    border: none;
    padding: 0;
  }

  .spotlight-input-row :global(.tui-input:focus) {
    border: none;
  }

  .spotlight-input-row :global(.tui-input::placeholder) {
    color: var(--text-muted);
    opacity: 0.5;
  }

  .spotlight-results {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .spotlight-category {
    padding: 8px 16px 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.08em;
    user-select: none;
  }

  .category-count {
    font-weight: 400;
    opacity: 0.7;
  }

  .spotlight-item {
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

  .spotlight-item:hover,
  .spotlight-item.focused {
    background: var(--surface-hover);
    color: var(--text);
  }

  .item-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.6;
  }

  .item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .item-sublabel {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.5;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
    min-width: 0;
    max-width: 120px;
  }

  .item-shortcut {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    border: 1px solid var(--border);
    padding: 1px 4px;
    flex-shrink: 0;
    opacity: 0.6;
  }

  .spotlight-empty {
    padding: 20px 16px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    opacity: 0.6;
    text-align: center;
  }

  .spotlight-footer {
    display: flex;
    gap: 16px;
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .shortcut-hint {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.5;
  }

  /* Mobile */
  @media (max-width: 600px) {
    .spotlight-overlay {
      padding-top: 5vh;
      padding-left: 12px;
      padding-right: 12px;
    }

    .spotlight {
      max-height: 70vh;
    }
  }
</style>
