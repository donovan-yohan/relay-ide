<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { fetchOrgPrs, fetchBranchLinks, fetchPresets, savePreset, deletePreset } from '../lib/api.js';
  import { derivePrAction } from '../lib/pr-state.js';
  import { formatRelativeTime } from '../lib/utils.js';
  import type { AnyIssue, PullRequest, OrgPrsResponse, BranchLinksResponse, FilterPreset } from '../lib/types.js';
  import { deriveColor } from '../lib/colors.js';
  import { derivePrDotStatus } from '../lib/pr-status.js';
  import DataTable from './DataTable.svelte';
  import type { Column } from './DataTable.svelte';
  import FilterChipBar from './FilterChipBar.svelte';
  import type { FilterChip } from './FilterChipBar.svelte';
  import StatusDot from './StatusDot.svelte';
  import TuiButton from './TuiButton.svelte';
  import TicketsPanel from './TicketsPanel.svelte';
  import StartWorkModal from './StartWorkModal.svelte';
  import AutomationPanel from './AutomationPanel.svelte';

  let { onOpenWorkspace, onOpenSession }: {
    onOpenWorkspace: (path: string) => void;
    onOpenSession?: (sessionId: string) => void;
  } = $props();

  const queryClient = useQueryClient();

  let activeTab = $state<'prs' | 'tickets'>('prs');
  let startWorkIssue = $state<AnyIssue | null>(null);

  const orgQuery = createQuery<OrgPrsResponse>(() => ({
    queryKey: ['org-prs'],
    queryFn: fetchOrgPrs,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  }));

  const branchLinksQuery = createQuery<BranchLinksResponse>(() => ({
    queryKey: ['branch-links'],
    queryFn: fetchBranchLinks,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  }));

  const presetsQuery = createQuery<FilterPreset[]>(() => ({
    queryKey: ['presets'],
    queryFn: fetchPresets,
    staleTime: 30_000,
  }));

  let data = $derived(orgQuery.data);
  let isLoading = $derived(orgQuery.isLoading);
  let isError = $derived(orgQuery.isError);

  // --- Column definitions ---
  const prColumns: Column[] = [
    { key: 'status', label: 'St', sortable: false, width: '36px' },
    { key: 'title', label: 'Title', sortable: true },
    { key: 'repo', label: 'Repo', sortable: true, width: '100px' },
    { key: 'role', label: 'Role', sortable: true, width: '60px' },
    { key: 'ci', label: 'CI', sortable: false, width: '32px' },
    { key: 'age', label: 'Age', sortable: true, width: '50px' },
    { key: 'action', label: '', sortable: false, width: '140px' },
  ];

  // --- Filter / sort state ---
  let activeStatusChips = $state<string[]>([]);
  let searchQuery = $state('');
  let sortBy = $state('role');
  let sortDir = $state<'asc' | 'desc'>('asc');

  // --- Status filter chips ---
  const statusChips: FilterChip[] = [
    { id: 'open', label: 'Open' },
    { id: 'draft', label: 'Draft' },
    { id: 'changes-requested', label: 'Changes Req' },
    { id: 'approved', label: 'Approved' },
  ];

  // --- Helpers ---
  function prActionForRow(pr: PullRequest) {
    const prState = pr.state === 'OPEN' ? 'OPEN' : pr.state === 'MERGED' ? 'MERGED' : 'CLOSED';
    return derivePrAction({
      commitsAhead: 1,
      prState,
      ciPassing: 0,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 0,
      mergeable: (pr.mergeable as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null) ?? null,
      unresolvedCommentCount: 0,
    });
  }

  function prRoleLabel(pr: PullRequest): string {
    return pr.role === 'author' ? 'by you' : 'review requested';
  }

  function ciIcon(pr: PullRequest): { icon: string; cls: string } | null {
    if (!pr.ciStatus) return null;
    if (pr.ciStatus === 'SUCCESS') return {
      icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6l2.5 2.5L10 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      cls: 'ci-pass',
    };
    if (pr.ciStatus === 'FAILURE' || pr.ciStatus === 'ERROR') return {
      icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      cls: 'ci-fail',
    };
    if (pr.ciStatus === 'PENDING') return {
      icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.6"/></svg>',
      cls: 'ci-pending',
    };
    return null;
  }

  let allPrs = $derived(data?.prs ?? []);

  // --- Filter + sort pipeline ---
  let processedPrs = $derived.by((): PullRequest[] => {
    let prs = allPrs;
    // Status filter
    if (activeStatusChips.length > 0) {
      prs = prs.filter(pr => activeStatusChips.includes(derivePrDotStatus(pr)));
    }
    // Search
    const q = searchQuery.toLowerCase().trim();
    if (q) {
      prs = prs.filter(pr =>
        pr.title.toLowerCase().includes(q) ||
        String(pr.number).includes(q) ||
        (pr.headRefName ?? '').toLowerCase().includes(q)
      );
    }
    // Sort: default is role (priority tier) then updated
    if (sortBy === 'role') {
      const priorityTier = (pr: PullRequest): number => {
        if (pr.reviewDecision === 'CHANGES_REQUESTED' && pr.role === 'author') return 0;
        if (pr.role === 'reviewer') return 1;
        if (pr.role === 'author' && !pr.reviewDecision) return 2;
        if (pr.reviewDecision === 'APPROVED' && pr.ciStatus === 'SUCCESS') return 3;
        return 4;
      };
      prs = [...prs].sort((a, b) => {
        const tierDiff = priorityTier(a) - priorityTier(b);
        if (tierDiff !== 0) return sortDir === 'asc' ? tierDiff : -tierDiff;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
    } else if (sortBy === 'title') {
      prs = [...prs].sort((a, b) => sortDir === 'asc' ? a.title.localeCompare(b.title) : b.title.localeCompare(a.title));
    } else if (sortBy === 'repo') {
      prs = [...prs].sort((a, b) => sortDir === 'asc' ? (a.repoName ?? '').localeCompare(b.repoName ?? '') : (b.repoName ?? '').localeCompare(a.repoName ?? ''));
    } else {
      // age = updatedAt
      prs = [...prs].sort((a, b) => sortDir === 'asc' ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt));
    }
    return prs;
  });

  let openCount = $derived(allPrs.filter(pr => pr.state === 'OPEN').length);

  // Attention count: PRs where you need to act (changes requested on yours, or awaiting your review).
  // Returns 0 when data is loading/errored since allPrs will be empty.
  let prAttentionCount = $derived(
    allPrs.filter(pr =>
      pr.state === 'OPEN' && (
        pr.reviewDecision === 'CHANGES_REQUESTED' ||
        pr.role === 'reviewer'
      )
    ).length
  );

  let branchLinksData = $derived(branchLinksQuery.data ?? {});

  // Extract ticket ID from a branch name by looking up branch-links data.
  // Returns the issue number string (e.g. "123") if a match is found.
  function getTicketIdForPr(headRefName: string): string | null {
    for (const [issueNumber, links] of Object.entries(branchLinksData)) {
      for (const link of links) {
        if (link.branchName === headRefName) {
          return issueNumber;
        }
      }
    }
    return null;
  }

  let hasActiveFilters = $derived(activeStatusChips.length > 0 || searchQuery.length > 0);

  function clearFilters() {
    activeStatusChips = [];
    searchQuery = '';
  }

  function handleSort(col: string) {
    if (col === sortBy) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortBy = col;
      sortDir = 'asc';
    }
  }

  function handleChipToggle(id: string) {
    activeStatusChips = activeStatusChips.includes(id)
      ? activeStatusChips.filter(c => c !== id)
      : [...activeStatusChips, id];
  }

  function applyPreset(preset: FilterPreset) {
    activeStatusChips = preset.filters.status ?? [];
    sortBy = preset.sort.column;
    sortDir = preset.sort.direction;
  }

  async function handleSaveCurrentView() {
    const name = window.prompt('Save current view as:');
    if (!name || !name.trim()) return;
    const filters: FilterPreset['filters'] = {};
    if (activeStatusChips.length > 0) filters.status = [...activeStatusChips];
    try {
      await savePreset({
        name: name.trim(),
        filters,
        sort: { column: sortBy, direction: sortDir },
      });
      await queryClient.invalidateQueries({ queryKey: ['presets'] });
    } catch (e) {
      console.error('Failed to save preset:', e);
    }
  }

  async function handleDeletePreset(preset: FilterPreset) {
    try {
      await deletePreset(preset.name);
      await queryClient.invalidateQueries({ queryKey: ['presets'] });
    } catch (e) {
      console.error('Failed to delete preset:', e);
    }
  }
</script>

<div class="org-dashboard">
  <div class="org-header">
    <span class="org-title">All Workspaces</span>
    {#if activeTab === 'prs' && !isLoading && !isError && !data?.error}
      <span class="org-subtitle">
        {#if openCount === 1}1 open PR{:else}{openCount} open PRs{/if}
      </span>
    {/if}
  </div>

  <!-- Tab strip -->
  <div class="tab-strip">
    <button
      class="tab-btn"
      class:tab-btn--active={activeTab === 'prs'}
      onclick={() => { activeTab = 'prs'; }}
    >
      PRs {#if prAttentionCount > 0}<span class="tab-badge">{prAttentionCount}</span>{/if}
    </button>
    <button
      class="tab-btn"
      class:tab-btn--active={activeTab === 'tickets'}
      onclick={() => { activeTab = 'tickets'; }}
    >
      Tickets
    </button>
  </div>

  {#if activeTab === 'prs'}
    {#if data?.error === 'gh_not_in_path'}
      <div class="state-message state-message--info">
        Install GitHub CLI for PR tracking —
        <a href="https://cli.github.com" target="_blank" rel="noopener noreferrer">cli.github.com</a>
      </div>
    {:else if data?.error === 'gh_not_authenticated'}
      <div class="state-message state-message--info">
        Run <code>gh auth login</code> to connect GitHub.
      </div>
    {:else if data?.error === 'gh_timeout'}
      <div class="state-message state-message--error">
        <span>GitHub is taking too long. Try again.</span>
        <button class="retry-btn" onclick={() => orgQuery.refetch()}>Retry</button>
      </div>
    {:else if data?.error === 'no_workspaces'}
      <!-- App.svelte handles the no_workspaces case -->
    {:else}
      {#if !isLoading && !isError && allPrs.length > 0}
        <div class="presets-row">
          <select
            class="preset-select"
            value=""
            onchange={(e) => {
              const val = (e.currentTarget as HTMLSelectElement).value;
              if (val === '__save__') {
                (e.currentTarget as HTMLSelectElement).value = '';
                void handleSaveCurrentView();
              } else if (val) {
                const preset = (presetsQuery.data ?? []).find(p => p.name === val);
                if (preset) applyPreset(preset);
                (e.currentTarget as HTMLSelectElement).value = '';
              }
            }}
          >
            <option value="" disabled>Presets...</option>
            {#each (presetsQuery.data ?? []) as preset}
              <option value={preset.name}>{preset.name}</option>
            {/each}
            <option value="__save__">Save current view...</option>
          </select>
          {#each (presetsQuery.data ?? []).filter(p => !p.builtIn) as preset}
            <button
              class="preset-delete-btn"
              title="Delete preset: {preset.name}"
              onclick={() => void handleDeletePreset(preset)}
            >× {preset.name}</button>
          {/each}
        </div>
        <FilterChipBar
          chips={statusChips}
          activeChips={activeStatusChips}
          onToggle={handleChipToggle}
          onClearAll={clearFilters}
          searchQuery={searchQuery}
          onSearch={(q) => searchQuery = q}
        />
      {/if}

      <DataTable
        columns={prColumns}
        rows={processedPrs}
        groupBy="repoName"
        {sortBy}
        {sortDir}
        onSort={handleSort}
        loading={isLoading}
        error={isError ? 'Could not load pull requests.' : undefined}
        emptyMessage="No open PRs across workspaces."
        filteredEmptyMessage="No PRs match filters."
        {hasActiveFilters}
        onClearFilters={clearFilters}
        maxHeight="100%"
        onRowAction={(pr) => onOpenWorkspace(pr.repoPath ?? '')}
      >
        {#snippet row(pr, _index)}
          {@const action = prActionForRow(pr)}
          {@const repoName = pr.repoName ?? ''}
          {@const chipColor = deriveColor(repoName)}
          {@const ticketId = getTicketIdForPr(pr.headRefName)}
          <!-- St column -->
          <div class="cell cell--status" style:width="36px" style:flex="none">
            <StatusDot status={derivePrDotStatus(pr)} />
          </div>
          <!-- Title column -->
          <div class="cell cell--title" style:flex="1">
            <div class="pr-row-title-line">
              <a class="pr-title-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                {pr.title}
              </a>
            </div>
            <div class="pr-row-meta">
              <span class="pr-meta-text">#{pr.number}</span>
              {#if ticketId}
                <span class="pr-sep">·</span>
                <span class="ticket-chip">{ticketId}</span>
              {/if}
              <span class="pr-sep">·</span>
              <span class="pr-meta-text">{prRoleLabel(pr)}</span>
              <span class="pr-sep">·</span>
              <span class="pr-meta-text">{formatRelativeTime(pr.updatedAt)}</span>
            </div>
          </div>
          <!-- Repo column -->
          <div class="cell cell--repo" style:width="100px" style:flex="none">
            {#if repoName}
              <span
                class="repo-chip"
                style:background={chipColor}
                title={pr.repoPath ?? repoName}
              >{repoName}</span>
            {/if}
          </div>
          <!-- Role column -->
          <div class="cell cell--role" style:width="60px" style:flex="none">
            <span class="pr-meta-text">{pr.role}</span>
          </div>
          <!-- CI column -->
          {@const ci = ciIcon(pr)}
          <div class="cell cell--ci" style:width="32px" style:flex="none">
            {#if ci}
              <span class="ci-icon {ci.cls}">{@html ci.icon}</span>
            {/if}
          </div>
          <!-- Age column -->
          <div class="cell cell--age" style:width="50px" style:flex="none">
            <span class="pr-meta-text">{formatRelativeTime(pr.updatedAt)}</span>
          </div>
          <!-- Action column -->
          <div class="cell cell--action" style:width="140px" style:flex="none">
            {#if action.type !== 'none' && action.label}
              <TuiButton
                variant={action.color === 'success' ? 'success' : action.color === 'error' ? 'danger' : action.color === 'accent' ? 'primary' : 'ghost'}
                size="sm"
                title={action.label}
                onclick={() => onOpenWorkspace(pr.repoPath ?? '')}
              >
                {action.label}
              </TuiButton>
            {/if}
          </div>
        {/snippet}

        {#snippet mobileCard(pr, _index)}
          {@const action = prActionForRow(pr)}
          {@const repoName = pr.repoName ?? ''}
          {@const chipColor = deriveColor(repoName)}
          {@const ticketId = getTicketIdForPr(pr.headRefName)}
          <div class="mobile-card">
            <div class="mobile-card-line1">
              <StatusDot status={derivePrDotStatus(pr)} />
              <a class="pr-title-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                {pr.title}
              </a>
            </div>
            <div class="mobile-card-line2">
              {#if repoName}
                <span
                  class="repo-chip"
                  style:background={chipColor}
                  title={pr.repoPath ?? repoName}
                >{repoName}</span>
              {/if}
              {#if ticketId}
                <span class="ticket-chip">{ticketId}</span>
              {/if}
              <span class="pr-meta-text">{prRoleLabel(pr)}</span>
              <span class="pr-sep">·</span>
              <span class="pr-meta-text">{formatRelativeTime(pr.updatedAt)}</span>
            </div>
            {#if action.type !== 'none' && action.label}
              <TuiButton
                variant={action.color === 'success' ? 'success' : action.color === 'error' ? 'danger' : action.color === 'accent' ? 'primary' : 'ghost'}
                size="sm"
                onclick={() => onOpenWorkspace(pr.repoPath ?? '')}
              >
                {action.label}
              </TuiButton>
            {/if}
          </div>
        {/snippet}
      </DataTable>
    {/if}
  {:else if activeTab === 'tickets'}
    <TicketsPanel onStartWork={(issue) => { startWorkIssue = issue; }} />
  {:else}
    <!-- future tabs -->
  {/if}

  <AutomationPanel />

  {#if startWorkIssue}
    <StartWorkModal
      issue={startWorkIssue}
      open={true}
      onClose={() => { startWorkIssue = null; }}
      onSessionCreated={(id) => { startWorkIssue = null; onOpenSession?.(id); }}
    />
  {/if}
</div>

<style>
  .org-dashboard {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
    background: var(--bg);
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  /* -- Header -- */
  .org-header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .org-title {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .org-subtitle {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    opacity: 0.7;
  }

  /* -- Tab strip -- */
  .tab-strip {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    margin-top: -4px;
  }

  .tab-btn {
    padding: 8px 12px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    margin-bottom: -1px;
    transition: color 0.12s, border-color 0.12s;
    white-space: nowrap;
    letter-spacing: 0.06em;
  }

  .tab-btn:hover {
    color: var(--text);
  }

  .tab-btn--active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .tab-badge {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--accent);
    margin-left: 4px;
    opacity: 0.8;
  }

  /* -- State messages (gh errors) -- */
  .state-message {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    color: var(--text-muted);
    padding: 8px 0;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .state-message--info a {
    color: var(--accent);
    text-decoration: none;
  }

  .state-message--info a:hover {
    text-decoration: underline;
  }

  .state-message--error {
    color: var(--status-error);
  }

  .retry-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    cursor: pointer;
    padding: 4px 8px;
    transition: border-color 0.12s, color 0.12s;
  }

  .retry-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* -- Table cell layout -- */
  .cell {
    display: flex;
    align-items: center;
    padding: 8px;
    min-width: 0;
  }

  .cell--status {
    justify-content: center;
  }

  .cell--title {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .cell--repo,
  .cell--role,
  .cell--age {
    justify-content: flex-start;
    overflow: hidden;
  }

  .cell--action {
    justify-content: flex-end;
  }

  .cell--ci {
    justify-content: center;
  }

  .ci-icon { font-size: 12px; font-weight: bold; }
  .ci-pass { color: var(--status-success); }
  .ci-fail { color: var(--status-error); }
  .ci-pending { color: var(--status-warning); animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* -- PR row content -- */
  .pr-row-title-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    width: 100%;
  }

  .pr-title-link {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    color: var(--text);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1;
  }

  .pr-title-link:hover {
    color: var(--accent);
    text-decoration: underline;
  }

  .pr-row-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    flex-wrap: wrap;
  }

  .pr-meta-text {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .pr-sep {
    opacity: 0.4;
  }

  /* Repo chip */
  .repo-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 0;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 700;
    color: #000;
    white-space: nowrap;
    transition: opacity 0.12s;
    line-height: 1.4;
  }

  .repo-chip:hover {
    opacity: 0.8;
  }

  /* Ticket chip */
  .ticket-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 0;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-muted);
    background: var(--surface);
    border: 1px solid var(--border);
    white-space: nowrap;
    line-height: 1.4;
  }

  /* -- Mobile card layout -- */
  .mobile-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 8px;
    width: 100%;
  }

  .mobile-card-line1 {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .mobile-card-line2 {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    flex-wrap: wrap;
  }

  /* -- Presets row -- */
  .presets-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  .preset-select {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text-muted);
    padding: 4px 8px;
    cursor: pointer;
    outline: none;
    transition: border-color 0.12s;
  }

  .preset-select:focus,
  .preset-select:hover {
    border-color: var(--accent);
    color: var(--text);
  }

  .preset-delete-btn {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text-muted);
    padding: 4px 8px;
    cursor: pointer;
    transition: border-color 0.12s, color 0.12s;
    white-space: nowrap;
  }

  .preset-delete-btn:hover {
    border-color: var(--status-error, #e05555);
    color: var(--status-error, #e05555);
  }

  @media (max-width: 600px) {
    .org-dashboard {
      padding: 16px;
    }
  }
</style>
