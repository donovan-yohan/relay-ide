<script lang="ts">
  import { useQueryClient, createQuery } from '@tanstack/svelte-query';
  import type {
    PullRequest, OrgPrsResponse, GitHubIssue, GitHubIssuesResponse,
    SessionSummary, WorktreeInfo, BranchInfo,
  } from '../lib/types.js';
  import { fetchBranches } from '../lib/api.js';
  import { resolveIntent } from '../lib/session-intent.js';
  import type { SessionIntent, PickerItem } from '../lib/session-intent.js';
  import { derivePrDotStatus } from '../lib/pr-status.js';
  import type { PrDotStatus } from '../lib/pr-status.js';
  import PickerResultRow from './PickerResultRow.svelte';
  import TuiInput from './TuiInput.svelte';

  let {
    open = false,
    repoPath,
    sessions,
    worktrees,
    onClose,
    onSelectIntent,
  }: {
    open: boolean;
    repoPath: string;
    sessions: SessionSummary[];
    worktrees: WorktreeInfo[];
    onClose: () => void;
    onSelectIntent: (intent: SessionIntent, item: PickerItem) => void;
  } = $props();

  type TabId = 'all' | 'prs' | 'branches' | 'issues';

  let activeTab = $state<TabId>('all');
  let query = $state('');
  let focusedIndex = $state(0);
  let inputWrapperEl = $state<HTMLDivElement | undefined>(undefined);

  const queryClient = useQueryClient();

  // Data sources — read from TanStack Query cache + fetch branches on demand
  let cachedPrs = $derived<PullRequest[]>(
    queryClient.getQueryData<OrgPrsResponse>(['org-prs'])?.prs ?? []
  );

  let cachedIssues = $derived<GitHubIssue[]>(
    queryClient.getQueryData<GitHubIssuesResponse>(['github-issues'])?.issues ?? []
  );

  const branchQuery = createQuery<BranchInfo[]>(() => ({
    queryKey: ['branches', repoPath],
    queryFn: () => fetchBranches(repoPath),
    staleTime: 30_000,
    enabled: open && !!repoPath,
  }));

  let branches = $derived(branchQuery.data ?? []);

  // Filter
  let q = $derived(query.toLowerCase().trim());

  let filteredPrs = $derived(
    q ? cachedPrs.filter(pr =>
      pr.title.toLowerCase().includes(q) ||
      String(pr.number).includes(q) ||
      pr.headRefName.toLowerCase().includes(q)
    ) : cachedPrs
  );

  let filteredBranches = $derived(
    q ? branches.filter(b => b.name.toLowerCase().includes(q)) : branches
  );

  let filteredIssues = $derived(
    q ? cachedIssues.filter(i =>
      i.title.toLowerCase().includes(q) ||
      String(i.number).includes(q)
    ) : cachedIssues
  );

  // Split PRs: open review requests vs everything else (authored + closed/merged)
  let reviewPrs = $derived(filteredPrs.filter(pr => pr.role === 'reviewer' && pr.state === 'OPEN'));
  let authorPrs = $derived(filteredPrs.filter(pr => pr.role === 'author' || pr.state !== 'OPEN'));

  // Build picker items with intents
  interface PickerRow {
    item: PickerItem;
    intents: SessionIntent[];
    label: string;
    sublabel: string;
    dotStatus?: PrDotStatus;
  }

  function prToRow(pr: PullRequest): PickerRow {
    const item: PickerItem = { kind: 'pr', pr };
    return {
      item,
      intents: resolveIntent(item, pr.role, sessions, worktrees),
      label: `#${pr.number} ${pr.title}`,
      sublabel: pr.repoName ?? pr.headRefName,
      dotStatus: derivePrDotStatus(pr),
    };
  }

  function branchToRow(branch: BranchInfo): PickerRow {
    const prForBranch = cachedPrs.find(pr => pr.headRefName === branch.name);
    const item: PickerItem = {
      kind: 'branch',
      name: branch.name,
      ahead: 0,
      behind: 0,
      prNumber: prForBranch?.number ?? null,
      repoPath,
    };
    return {
      item,
      intents: resolveIntent(item, 'author', sessions, worktrees),
      label: branch.name,
      sublabel: prForBranch ? `PR #${prForBranch.number}` : '',
    };
  }

  function issueToRow(issue: GitHubIssue): PickerRow {
    const item: PickerItem = { kind: 'issue', issue };
    return {
      item,
      intents: resolveIntent(item, 'author', sessions, []),
      label: `#${issue.number} ${issue.title}`,
      sublabel: issue.labels.map(l => l.name).join(', '),
    };
  }

  // Tab content
  interface ResultGroup {
    label: string;
    rows: PickerRow[];
  }

  let groups = $derived.by((): ResultGroup[] => {
    switch (activeTab) {
      case 'prs': {
        const g: ResultGroup[] = [];
        if (reviewPrs.length > 0) g.push({ label: 'needs your review', rows: reviewPrs.map(prToRow) });
        if (authorPrs.length > 0) g.push({ label: 'your pull requests', rows: authorPrs.map(prToRow) });
        return g;
      }
      case 'branches':
        return filteredBranches.length > 0
          ? [{ label: 'branches', rows: filteredBranches.map(branchToRow) }]
          : [];
      case 'issues': {
        const assigned = filteredIssues.filter(i => i.assignees.length > 0);
        const unassigned = filteredIssues.filter(i => i.assignees.length === 0);
        const g: ResultGroup[] = [];
        if (assigned.length > 0) g.push({ label: 'assigned to you', rows: assigned.map(issueToRow) });
        if (unassigned.length > 0) g.push({ label: 'recent issues', rows: unassigned.map(issueToRow) });
        return g;
      }
      case 'all': {
        const g: ResultGroup[] = [];
        if (reviewPrs.length > 0) g.push({ label: 'needs your review', rows: reviewPrs.slice(0, 3).map(prToRow) });
        if (authorPrs.length > 0) g.push({ label: 'pull requests', rows: authorPrs.slice(0, 3).map(prToRow) });
        if (filteredBranches.length > 0) g.push({ label: 'branches', rows: filteredBranches.slice(0, 5).map(branchToRow) });
        if (filteredIssues.length > 0) g.push({ label: 'issues', rows: filteredIssues.slice(0, 3).map(issueToRow) });
        return g;
      }
    }
  });

  let flatRows = $derived(groups.flatMap(g => g.rows));
  let rowIndexMap = $derived(new Map(flatRows.map((row, i) => [row, i])));

  $effect(() => {
    if (focusedIndex >= flatRows.length) {
      focusedIndex = Math.max(0, flatRows.length - 1);
    }
  });

  $effect(() => {
    if (open) {
      query = '';
      activeTab = 'all';
      focusedIndex = 0;
      requestAnimationFrame(() => inputWrapperEl?.querySelector('input')?.focus());
    }
  });

  const tabs: { id: TabId; label: string }[] = [
    { id: 'all', label: 'all' },
    { id: 'prs', label: 'prs' },
    { id: 'branches', label: 'branches' },
    { id: 'issues', label: 'issues' },
  ];

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIndex = Math.min(focusedIndex + 1, flatRows.length - 1);
      scrollFocusedIntoView();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIndex = Math.max(focusedIndex - 1, 0);
      scrollFocusedIntoView();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const currentIdx = tabs.findIndex(t => t.id === activeTab);
      const nextIdx = e.shiftKey
        ? (currentIdx - 1 + tabs.length) % tabs.length
        : (currentIdx + 1) % tabs.length;
      activeTab = tabs[nextIdx]!.id;
      focusedIndex = 0;
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = flatRows[focusedIndex];
      if (row && row.intents[0]) {
        onSelectIntent(row.intents[0], row.item);
        onClose();
      }
      return;
    }
  }

  function scrollFocusedIntoView() {
    requestAnimationFrame(() => {
      document.querySelector('.picker-row.focused')?.scrollIntoView({ block: 'nearest' });
    });
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('picker-overlay')) {
      onClose();
    }
  }

  function handleIntentSelect(intent: SessionIntent, item: PickerItem) {
    onSelectIntent(intent, item);
    onClose();
  }

  let emptyMessage = $derived.by((): string => {
    if (q) return `no results for '${q}'`;
    switch (activeTab) {
      case 'prs': return 'no open pull requests';
      case 'branches': return 'no branches found';
      case 'issues': return 'no open issues';
      case 'all': return 'no items found';
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="picker-overlay" onclick={handleBackdropClick}>
    <div class="picker" role="dialog" aria-modal="true" aria-label="Open picker">
      <!-- Search -->
      <div class="picker-search" bind:this={inputWrapperEl}>
        <span class="picker-prompt">/</span>
        <TuiInput
          bind:value={query}
          placeholder="search..."
          onkeydown={handleKeydown}
          autocomplete="off"
          spellcheck={false}
        />
        <button class="picker-close-btn" onclick={onClose} aria-label="Close">
          <span class="close-desktop">esc</span>
          <span class="close-mobile">close</span>
        </button>
      </div>

      <!-- Tabs -->
      <div class="picker-tabs" role="tablist">
        {#each tabs as tab}
          <button
            class="picker-tab"
            class:active={activeTab === tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onclick={() => { activeTab = tab.id; focusedIndex = 0; }}
          >
            {tab.label}
          </button>
        {/each}
      </div>

      <!-- Results -->
      <div class="picker-results" role="listbox">
        {#if flatRows.length === 0}
          <div class="picker-empty">{emptyMessage}</div>
        {:else}
          {#each groups as group}
            <div class="picker-category">{group.label}</div>
            {#each group.rows as row}
              {@const globalIndex = rowIndexMap.get(row) ?? -1}
              <PickerResultRow
                label={row.label}
                sublabel={row.sublabel}
                {...(row.dotStatus ? { dotStatus: row.dotStatus } : {})}
                intents={row.intents}
                focused={globalIndex === focusedIndex}
                onSelectIntent={(intent) => handleIntentSelect(intent, row.item)}
                onRowClick={() => {
                  if (row.intents[0]) handleIntentSelect(row.intents[0], row.item);
                }}
              />
            {/each}
          {/each}
        {/if}
      </div>

      <!-- Footer -->
      <div class="picker-footer">
        <span class="hint">&#x2191;&#x2193; navigate</span>
        <span class="hint">tab switch tabs</span>
        <span class="hint">&#x21B5; select</span>
        <span class="hint">esc close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .picker-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 1000;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 15vh;
  }

  .picker {
    width: 100%;
    max-width: 600px;
    background: var(--surface);
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    max-height: 60vh;
  }

  .picker-search {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .picker-prompt {
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--accent);
    flex-shrink: 0;
    user-select: none;
  }

  .picker-search :global(.tui-input-wrapper) {
    flex: 1;
  }

  .picker-search :global(.tui-input) {
    background: transparent;
    border: none;
    padding: 0;
  }

  .picker-search :global(.tui-input:focus) {
    border: none;
  }

  .picker-close-btn {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    background: none;
    border: 1px solid var(--border);
    padding: 2px 6px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .picker-close-btn:hover {
    border-color: var(--text-muted);
  }

  .close-mobile { display: none; }

  /* Tabs */
  .picker-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .picker-tab {
    padding: 8px 16px;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
  }

  .picker-tab:hover {
    color: var(--text);
  }

  .picker-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  /* Results */
  .picker-results {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .picker-category {
    padding: 8px 16px 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.08em;
    user-select: none;
  }

  .picker-empty {
    padding: 24px 16px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    opacity: 0.6;
    text-align: center;
  }

  /* Footer */
  .picker-footer {
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

  /* Mobile — full-screen picker */
  @media (max-width: 600px) {
    .picker-overlay {
      padding-top: 0;
    }

    .picker {
      max-width: 100%;
      max-height: 100vh;
      height: 100vh;
      border: none;
    }

    .close-desktop { display: none; }
    .close-mobile { display: inline; }
  }
</style>
