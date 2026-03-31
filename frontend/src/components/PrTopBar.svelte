<script lang="ts">
  import { untrack } from 'svelte';
  import { createQuery } from '@tanstack/svelte-query';
  import { fetchPrForBranchOrNull, fetchCiStatusOrNull, fetchCurrentBranch } from '../lib/api.js';
  import { sendPtyData } from '../lib/ws.js';
  import {
    derivePrAction,
    deriveSecondaryAction,
    getActionPrompt,
  } from '../lib/pr-state.js';
  import type { PrAction, StatusColor } from '../lib/pr-state.js';
  import type { PrInfo, CiStatus } from '../lib/types.js';
  import { getUi, toggleRightSidebarCollapsed } from '../lib/state/ui.svelte.js';
  import CipherText from './CipherText.svelte';
  import TuiButton from './TuiButton.svelte';
  import BranchSwitcher from './BranchSwitcher.svelte';
  import TargetBranchSwitcher from './TargetBranchSwitcher.svelte';
  import RenameWarningModal from './dialogs/RenameWarningModal.svelte';

  const ui = getUi();

  let {
    repoPath,
    branchName,
    sessionId,
    agentRunning = false,
    onArchive,
  }: {
    repoPath: string;
    branchName: string;
    sessionId: string | null;
    agentRunning?: boolean;
    onArchive?: () => void;
  } = $props();

  // currentBranch starts from the prop but can diverge when user switches locally.
  // Re-sync when the parent prop changes (e.g. workspace navigation).
  // svelte-ignore state_referenced_locally
  let currentBranch = $state(branchName);
  $effect(() => { currentBranch = branchName; });

  // If branchName is empty (repo sessions), detect the current branch from git
  $effect(() => {
    if (!branchName && repoPath) {
      fetchCurrentBranch(repoPath).then(branch => {
        if (branch) currentBranch = branch;
      });
    }
  });

  const prQuery = createQuery<PrInfo | null>(() => ({
    queryKey: ['pr', repoPath, currentBranch],
    queryFn: () => fetchPrForBranchOrNull(repoPath, currentBranch),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  }));

  const ciQuery = createQuery<CiStatus | null>(() => ({
    queryKey: ['ci-status', repoPath, currentBranch],
    queryFn: () => fetchCiStatusOrNull(repoPath, currentBranch),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: prQuery.data?.state === 'OPEN',
  }));

  // Refetch PR and CI data when session changes (e.g. workspace navigation).
  // untrack() prevents tracking prQuery/ciQuery stores — without it, the effect
  // re-triggers on every query state change (isFetching, data), creating an infinite loop.
  $effect(() => {
    if (sessionId) {
      untrack(() => {
        prQuery.refetch();
        ciQuery.refetch();
      });
    }
  });

  let pr = $derived(prQuery.data ?? null);
  let ci = $derived(ciQuery.data ?? null);

  let prStateInput = $derived({
    commitsAhead: pr ? 1 : 0,
    prState: pr ? (pr.isDraft ? 'DRAFT' : pr.state) : null as 'OPEN' | 'CLOSED' | 'MERGED' | 'DRAFT' | null,
    ciPassing: ci?.passing ?? 0,
    ciFailing: ci?.failing ?? 0,
    ciPending: ci?.pending ?? 0,
    ciTotal: ci?.total ?? 0,
    mergeable: pr?.mergeable ?? null,
    unresolvedCommentCount: pr?.unresolvedCommentCount ?? 0,
  });

  let prAction = $derived(derivePrAction(prStateInput));
  let secondaryAction = $derived(deriveSecondaryAction(prAction, prStateInput));

  let showAction = $derived(prAction.type !== 'none');

  function colorToVariant(color: StatusColor): 'primary' | 'ghost' | 'danger' | 'success' | 'info' {
    if (color === 'success') return 'success';
    if (color === 'error') return 'danger';
    if (color === 'accent') return 'primary';
    return 'ghost';
  }
  let isRefreshing = $derived(prQuery.isFetching || ciQuery.isFetching);

  function handleRefresh() {
    prQuery.refetch();
    ciQuery.refetch();
  }

  function handleActionClick(action: PrAction = prAction) {
    const ctx = {
      branchName: currentBranch,
      baseBranch: pr?.baseRefName ?? '',
      prNumber: pr?.number ?? 0,
      unresolvedCommentCount: pr?.unresolvedCommentCount ?? 0,
    };
    const prompt = getActionPrompt(action, ctx);
    if (prompt === null) {
      onArchive?.();
      return;
    }
    if (sessionId) {
      sendPtyData(prompt + '\r');
    }
  }

  function handleBranchSwitch(branch: string) {
    currentBranch = branch;
  }

  let copyFeedback = $state(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(currentBranch);
      copyFeedback = true;
      setTimeout(() => copyFeedback = false, 1500);
    } catch { /* clipboard may not be available */ }
  }

  // ── Inline rename ──────────────────────────────────
  let renaming = $state(false);
  let renameValue = $state('');
  let renameSubmitting = $state(false);
  let renameInputEl = $state<HTMLInputElement | null>(null);
  let renameWarning = $state<{ oldName: string; newName: string } | null>(null);

  function startRename() {
    if (agentRunning) return;
    renaming = true;
    renameValue = currentBranch;
    requestAnimationFrame(() => renameInputEl?.focus());
  }

  function cancelRename() {
    if (renameSubmitting) return;
    renaming = false;
    renameValue = '';
  }

  async function confirmRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === currentBranch) {
      cancelRename();
      return;
    }

    renameSubmitting = true;
    try {
      const res = await fetch('/workspaces/rename-branch?path=' + encodeURIComponent(repoPath), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: trimmed }),
      });
      const data = await res.json() as { success?: boolean; oldName?: string; newName?: string; error?: string };
      if (data.success && data.oldName && data.newName) {
        const oldName = data.oldName;
        currentBranch = data.newName;
        renaming = false;
        renameValue = '';

        // If PR exists, show warning modal
        if (pr) {
          renameWarning = { oldName, newName: data.newName };
        }
      } else {
        // Show error and exit rename mode
        renaming = false;
        renameValue = '';
      }
    } catch {
      // Exit rename mode on error
      renaming = false;
      renameValue = '';
    } finally {
      renameSubmitting = false;
    }
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmRename();
    } else if (e.key === 'Escape') {
      cancelRename();
    }
  }
</script>

<div class="pr-top-bar" class:bar-merged={pr?.state === 'MERGED'} class:bar-conflicts={pr?.mergeable === 'CONFLICTING'}>
  <!-- Left section: branch switcher + target branch -->
  <div class="bar-left">
    {#if renaming}
      <div class="rename-input-wrap">
        <span class="branch-icon">⑂</span>
        <input
          bind:this={renameInputEl}
          type="text"
          class="rename-input"
          bind:value={renameValue}
          onkeydown={handleRenameKeydown}
          onblur={cancelRename}
        />
      </div>
    {:else}
      <div class="branch-with-actions">
        <BranchSwitcher
          {repoPath}
          currentWorktreePath={repoPath}
          currentBranch={currentBranch}
          disabled={agentRunning}
          onSwitch={handleBranchSwitch}
        />

        <!-- Hover-reveal icons — overlaid to the right of branch name, left of chevron -->
        <div class="hover-icons">
        <button
          class="hover-icon"
          onclick={handleCopy}
          title={copyFeedback ? 'Copied!' : 'Copy branch name'}
          aria-label="Copy branch name"
        >
          {#if copyFeedback}
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8l3 3 7-7" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          {:else}
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" fill="none" stroke-width="1.5"/>
              <path d="M3 11V3a1.5 1.5 0 011.5-1.5H11" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          {/if}
        </button>
        <button
          class="hover-icon"
          onclick={startRename}
          disabled={agentRunning}
          title={agentRunning ? 'Unavailable while agent is running' : 'Rename branch'}
          aria-label="Rename branch"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      </div>
    {/if}

    {#if pr?.baseRefName}
      <span class="target-section">
        <span class="target-arrow" aria-hidden="true">
          <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
            <path d="M1 5h10M8 2l3 3-3 3" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <TargetBranchSwitcher
          {repoPath}
          currentBase={pr.baseRefName}
          prNumber={pr.number}
          disabled={agentRunning}
          onBaseChanged={() => {
            prQuery.refetch();
          }}
        />
      </span>
    {/if}
  </div>

  <!-- Middle: PR link + diff stats -->
  {#if pr}
    <div class="bar-middle" aria-label="pull request">
      <a
        class="pr-link"
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        data-track="pr-top-bar.open-pr"
        aria-label="PR #{pr.number}: {pr.title}"
      >
        PR #{pr.number}
        <svg class="pr-ext-icon" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 9L9 1M9 1H4M9 1V6" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </a>
    </div>
    <span class="diff-stats">
      <span class="diff-add">+{pr.additions}</span>
      <span class="diff-del">-{pr.deletions}</span>
    </span>
  {/if}

  <!-- Right: action buttons -->
  <div class="bar-right">
    <button
      class="refresh-btn"
      class:refreshing={isRefreshing}
      onclick={handleRefresh}
      disabled={isRefreshing}
      aria-label="Refresh PR data"
      title="Refresh PR data"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M14 8A6 6 0 1 1 8 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M8 0L14 2L12 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>
    </button>
    {#if prQuery.isLoading}
      <CipherText text="loading" loading={true} />
    {:else}
      {#if secondaryAction}
        <TuiButton
          variant="ghost"
          size="sm"
          data-track="pr-top-bar.secondary-action"
          onclick={() => handleActionClick(secondaryAction!)}
          aria-label={secondaryAction.label}
        >
          {secondaryAction.label}
        </TuiButton>
      {/if}
      {#if showAction}
        <TuiButton
          variant={colorToVariant(prAction.color)}
          size="sm"
          data-track="pr-top-bar.primary-action"
          onclick={() => handleActionClick()}
          disabled={prAction.type === 'checks-running'}
          aria-label={prAction.label}
        >
          {prAction.label}
        </TuiButton>
      {/if}
    {/if}
    <button
      class="sidebar-toggle-btn"
      onclick={toggleRightSidebarCollapsed}
      aria-label={ui.rightSidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar'}
      title={ui.rightSidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar'}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1" y="2" width="14" height="12" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="square"/>
        <line x1="10" y1="2" x2="10" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>
      </svg>
    </button>
  </div>

  {#if renameWarning}
    <RenameWarningModal
      oldName={renameWarning.oldName}
      newName={renameWarning.newName}
      {repoPath}
      onClose={() => {
        renameWarning = null;
        prQuery.refetch();
      }}
    />
  {/if}
</div>

<style>
  .pr-top-bar {
    display: flex;
    align-items: center;
    height: 36px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 0 8px;
    gap: 0;
    flex-shrink: 0;
    overflow: visible;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
  }

  /* ── Left ─────────────────────────── */
  .bar-left {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    padding-right: 8px;
    border-right: 1px solid var(--border);
    align-self: stretch;
  }

  .target-section {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .target-arrow {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    flex-shrink: 0;
    padding: 0 2px;
  }

  /* ── Middle ────────────────────────── */
  .bar-middle {
    display: flex;
    align-items: center;
    padding: 0 12px;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .pr-link {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--text-muted);
    text-decoration: none;
    font-size: var(--font-size-xs);
    transition: color 0.12s;
  }

  .pr-link:hover {
    color: var(--accent);
  }

  .pr-ext-icon {
    flex-shrink: 0;
    opacity: 0.6;
  }

  /* ── Right ─────────────────────────── */
  .bar-right {
    display: flex;
    align-items: center;
    padding-left: 8px;
    gap: 8px;
    flex-shrink: 0;
  }

  .sidebar-toggle-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    transition: color 0.12s, background 0.12s;
  }

  .sidebar-toggle-btn:hover {
    color: var(--text);
    background: var(--border);
  }

  .refresh-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    transition: color 0.12s, background 0.12s;
  }

  .refresh-btn:hover:not(:disabled) {
    color: var(--text);
    background: var(--border);
  }

  .refresh-btn:disabled {
    cursor: default;
  }

  .refresh-btn.refreshing svg {
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .bar-merged {
    background: color-mix(in srgb, var(--status-merged) 8%, var(--surface));
  }

  .bar-conflicts {
    background: color-mix(in srgb, var(--status-error) 8%, var(--surface));
  }

  .diff-stats {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    padding: 0 8px;
    flex-shrink: 0;
  }

  .diff-add { color: var(--status-success); }
  .diff-del { color: var(--status-error); }

  /* ── Rename ──────────────────────────── */
  .rename-input-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
  }

  .rename-input {
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    padding: 2px 8px;
    outline: none;
    min-width: 120px;
    max-width: 250px;
  }

  /* Hover-reveal icons */
  .branch-with-actions {
    position: relative;
    display: flex;
    align-items: center;
  }

  .hover-icons {
    position: absolute;
    right: 24px; /* left of the chevron */
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s;
    pointer-events: none;
    z-index: 1;
    background: var(--bg);
    padding-left: 4px;
  }

  .branch-with-actions:hover .hover-icons {
    opacity: 1;
    pointer-events: auto;
  }

  .hover-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    transition: color 0.12s, background 0.12s;
  }

  .hover-icon:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-hover);
  }

  .hover-icon:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .branch-icon {
    color: var(--text-muted);
    font-size: var(--font-size-base);
    flex-shrink: 0;
  }

  /* ── Mobile ─────────────────────────── */
  @media (max-width: 600px) {
    .hover-icons {
      opacity: 1;
    }

    .target-section,
    .bar-middle,
    .diff-stats {
      display: none;
    }

    .bar-left {
      border-right: none;
      padding-right: 4px;
    }
  }
</style>
