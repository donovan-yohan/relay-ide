<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { fetchDashboard } from '../lib/api.js';
  import { derivePrAction, buildPrStateInput } from '../lib/pr-state.js';
  import { formatRelativeTime } from '../lib/utils.js';
  import type { PullRequest, ActivityEntry, DashboardData } from '../lib/types.js';
  import DataTable from './DataTable.svelte';
  import type { Column } from './DataTable.svelte';
  import StatusDot from './StatusDot.svelte';
  import TuiButton from './TuiButton.svelte';
  import { derivePrDotStatus } from '../lib/pr-status.js';

  let {
    repoPath,
    workspaceName,
    creatingWorktree = false,
    onNewSession,
    onNewWorktree,
    onFixConflicts,
    onPrAction,
    onOpenPrSession,
  }: {
    repoPath: string;
    workspaceName: string;
    creatingWorktree?: boolean;
    onNewSession: () => void;
    onNewWorktree: () => void;
    onFixConflicts: (pr: PullRequest) => void;
    onPrAction: (pr: PullRequest) => void;
    onOpenPrSession: (pr: PullRequest) => void;
  } = $props();

  const dashQuery = createQuery<DashboardData>(() => ({
    queryKey: ['dashboard', repoPath],
    queryFn: () => fetchDashboard(repoPath),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  }));

  let data = $derived(dashQuery.data);
  let isLoading = $derived(dashQuery.isLoading);
  let isError = $derived(dashQuery.isError);

  const prColumns: Column[] = [
    { key: 'status', label: 'St', sortable: false, width: '36px' },
    { key: 'title', label: 'Title', sortable: true },
    { key: 'role', label: 'Role', sortable: true, width: '60px' },
    { key: 'age', label: 'Age', sortable: true, width: '50px' },
    { key: 'action', label: '', sortable: false, width: '160px' },
  ];

  function prActionForRow(pr: PullRequest) {
    return derivePrAction(buildPrStateInput(pr));
  }

  function prRoleLabel(pr: PullRequest): string {
    return pr.role === 'author' ? 'by you' : 'review requested';
  }

  function activityBranches(entry: ActivityEntry): string {
    if (!entry.branches || entry.branches.length === 0) return '';
    return '(' + entry.branches.join(', ') + ')';
  }

  let searchQuery = $state('');
  let sortBy = $state('age');
  let sortDir = $state<'asc' | 'desc'>('desc');

  let processedPrs = $derived.by((): PullRequest[] => {
    if (!data) return [];
    let prs = data.prs;
    const q = searchQuery.toLowerCase().trim();
    if (q) {
      prs = prs.filter(pr =>
        pr.title.toLowerCase().includes(q) ||
        String(pr.number).includes(q) ||
        pr.headRefName.toLowerCase().includes(q)
      );
    }
    prs = [...prs].sort((a, b) => {
      if (sortBy === 'title') return sortDir === 'asc' ? a.title.localeCompare(b.title) : b.title.localeCompare(a.title);
      if (sortBy === 'role') {
        const roleOrder: Record<string, number> = { reviewer: 0, author: 1 };
        return sortDir === 'asc' ? (roleOrder[a.role] ?? 1) - (roleOrder[b.role] ?? 1) : (roleOrder[b.role] ?? 1) - (roleOrder[a.role] ?? 1);
      }
      // age = updatedAt
      return sortDir === 'asc' ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt);
    });
    return prs;
  });
</script>

<div class="repo-dashboard">
  {#if data && !data.isGitRepo}
    <!-- Non-git repo: simplified view, just CTA buttons -->
    <div class="non-git-notice">
      <span class="non-git-msg">Not a git repository</span>
    </div>
  {:else}
    <!-- OPEN PULL REQUESTS section -->
    <section class="dashboard-section dashboard-section--scroll">
      <div class="section-heading">open pull requests</div>

      {#if data && !data.hasGhCli}
        <div class="section-message info">
          Install GitHub CLI for PR tracking —
          <a href="https://cli.github.com" target="_blank" rel="noopener noreferrer">cli.github.com</a>
        </div>
      {:else}
        {#snippet prActionPills(pr: PullRequest, action: ReturnType<typeof prActionForRow>)}
          <button
            class="pr-session-btn"
            title="Open session on this branch"
            onclick={() => onOpenPrSession(pr)}
          >+</button>
          {#if action.type === 'merge-pr'}
            <TuiButton
              variant="success"
              size="sm"
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Ready to merge on GitHub"
            >
              {action.label}
            </TuiButton>
          {:else if action.type !== 'none' && action.label}
            <TuiButton
              variant={action.color === 'success' ? 'success' : action.color === 'error' ? 'danger' : action.color === 'info' ? 'info' : action.color === 'accent' ? 'primary' : 'ghost'}
              size="sm"
              title={action.label}
              disabled={action.type === 'checks-running'}
              onclick={() => onPrAction(pr)}
            >
              {action.label}
            </TuiButton>
          {/if}
        {/snippet}
        <DataTable
          columns={prColumns}
          rows={processedPrs}
          {sortBy}
          {sortDir}
          onSort={(col) => {
            if (col === sortBy) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            else { sortBy = col; sortDir = 'asc'; }
          }}
          loading={isLoading}
          error={isError ? 'Could not load pull requests.' : undefined}
          emptyMessage={`No open PRs for ${workspaceName}.`}
          filteredEmptyMessage={`No results for '${searchQuery}'.`}
          hasActiveFilters={searchQuery.length > 0}
          onClearFilters={() => searchQuery = ''}
          onRowAction={(pr) => onOpenPrSession?.(pr)}
        >
          {#snippet row(pr, _index)}
            {@const action = prActionForRow(pr)}
            <div class="pr-cell pr-cell--status" style:width="36px" style:flex="none">
              <StatusDot status={derivePrDotStatus(pr)} />
            </div>
            <div class="pr-cell pr-cell--title" style:flex="1">
              <a class="pr-title-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                {pr.title}
              </a>
              <div class="pr-row-meta">
                <span class="pr-num">#{pr.number}</span>
                <span class="pr-sep">&middot;</span>
                <span class="pr-role">{prRoleLabel(pr)}</span>
                <span class="pr-sep">&middot;</span>
                <span class="pr-time">{formatRelativeTime(pr.updatedAt)}</span>
              </div>
            </div>
            <div class="pr-cell pr-cell--role" style:width="60px" style:flex="none">
              <span class="pr-role-text">{pr.role === 'author' ? 'Author' : 'Review'}</span>
            </div>
            <div class="pr-cell pr-cell--age" style:width="50px" style:flex="none">
              <span class="pr-age-text">{formatRelativeTime(pr.updatedAt)}</span>
            </div>
            <div class="pr-cell pr-cell--action" style:width="160px" style:flex="none">
              <div class="pr-row-actions">
                {@render prActionPills(pr, action)}
              </div>
            </div>
          {/snippet}

          {#snippet mobileCard(pr, _index)}
            {@const action = prActionForRow(pr)}
            <div class="mobile-pr-card">
              <div class="mobile-pr-top">
                <StatusDot status={derivePrDotStatus(pr)} />
                <a class="pr-title-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                  {pr.title}
                </a>
              </div>
              <div class="pr-row-meta">
                <span class="pr-num">#{pr.number}</span>
                <span class="pr-sep">&middot;</span>
                <span class="pr-role">{prRoleLabel(pr)}</span>
                <span class="pr-sep">&middot;</span>
                <span class="pr-time">{formatRelativeTime(pr.updatedAt)}</span>
              </div>
              <div class="pr-row-actions mobile-pr-actions">
                {@render prActionPills(pr, action)}
              </div>
            </div>
          {/snippet}
        </DataTable>
      {/if}
    </section>

    <!-- RECENT ACTIVITY section -->
    <section class="dashboard-section dashboard-section--scroll">
      <div class="section-heading">recent activity</div>

      {#if isLoading}
        <div class="scroll-container">
          <div class="activity-list">
            {#each [1, 2, 3] as _ (_)}
              <div class="activity-row skeleton">
                <div class="skeleton-line skeleton-activity"></div>
              </div>
            {/each}
          </div>
        </div>
      {:else if data && data.activity.length === 0}
        <div class="section-message">No recent commits (24h)</div>
      {:else if data}
        <div class="scroll-container">
          <div class="activity-list">
            {#each data.activity as entry (entry.hash)}
              <div class="activity-row">
                <span class="commit-hash">{entry.shortHash}</span>
                <span class="commit-msg">{entry.message}</span>
                {#if entry.branches.length > 0}
                  <span class="commit-branch">{activityBranches(entry)}</span>
                {/if}
                <span class="commit-time">{entry.timeAgo}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </section>
  {/if}

  <!-- CTA buttons — always shown -->
  <div class="cta-row">
    <TuiButton variant="primary" onclick={onNewSession}>+ Start Session</TuiButton>
    {#if !data || data.isGitRepo}
      <TuiButton variant="primary" onclick={onNewWorktree} disabled={creatingWorktree}>
        {creatingWorktree ? 'Creating...' : '+ New Worktree'}
      </TuiButton>
    {/if}
  </div>
</div>

<style>
  .repo-dashboard {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 20px;
    background: var(--bg);
    min-height: 0;
    max-width: none;
    overflow: hidden;
    flex: 1;
  }

  /* -- Section -- */
  .dashboard-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
  }

  .dashboard-section--scroll {
    flex: 1;
    min-height: 120px;
    overflow: hidden;
  }

  /* -- Scroll container with gradient fades (activity section) -- */
  .scroll-container {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .dashboard-section--scroll {
    position: relative;
  }

  .dashboard-section--scroll::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 32px;
    background: linear-gradient(to bottom, transparent, var(--bg));
    pointer-events: none;
    z-index: 1;
  }

  .section-heading {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }

  .section-message {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    color: var(--text-muted);
    padding: 8px 0;
  }

  .section-message.info a {
    color: var(--accent);
    text-decoration: none;
  }

  .section-message.info a:hover {
    text-decoration: underline;
  }

  /* -- PR cell layout (DataTable row) -- */
  .pr-cell {
    display: flex;
    align-items: center;
    padding: 8px 8px;
    min-width: 0;
  }

  .pr-cell--status {
    justify-content: center;
  }

  .pr-cell--title {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .pr-cell--role,
  .pr-cell--age {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
  }

  .pr-cell--action {
    justify-content: flex-end;
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
    max-width: 100%;
  }

  .pr-title-link:hover {
    color: var(--accent);
    text-decoration: underline;
  }

  .pr-row-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .pr-session-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 0;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
    flex-shrink: 0;
  }

  .pr-session-btn:hover {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-color: var(--accent);
    color: var(--accent);
  }

  .pr-row-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
  }

  .pr-sep {
    opacity: 0.4;
  }

  .pr-role-text,
  .pr-age-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* -- Mobile PR card -- */
  .mobile-pr-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 12px;
    width: 100%;
  }

  .mobile-pr-top {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .mobile-pr-actions {
    align-self: flex-end;
    margin-top: 4px;
  }

  /* -- Activity list -- */
  .activity-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .activity-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    min-width: 0;
  }

  .commit-hash {
    color: var(--text-muted);
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }

  .commit-msg {
    color: var(--text);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .commit-branch {
    color: var(--text-muted);
    flex-shrink: 0;
    white-space: nowrap;
  }

  .commit-time {
    color: var(--text-muted);
    flex-shrink: 0;
    white-space: nowrap;
    opacity: 0.6;
  }

  /* -- Non-git notice -- */
  .non-git-notice {
    padding: 8px 0;
  }

  .non-git-msg {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    color: var(--text-muted);
  }

  /* -- CTA buttons -- */
  .cta-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 4px;
    flex-shrink: 0;
  }

  /* -- Skeletons (activity section only) -- */
  .skeleton {
    pointer-events: none;
  }

  .skeleton-line {
    background: var(--border);
    animation: skeleton-pulse 1.4s ease-in-out infinite;
  }

  @keyframes skeleton-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0.7; }
  }

  .skeleton-activity {
    height: 12px;
    width: 75%;
  }

  /* -- Mobile -- */
  @media (max-width: 600px) {
    .repo-dashboard {
      padding: 16px;
    }
  }
</style>
