<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { fetchBranches, switchBranch } from '../lib/api.js';
  import type { BranchInfo } from '../lib/types.js';
  import CipherText from './CipherText.svelte';
  import TuiMenuItem from './TuiMenuItem.svelte';
  import TuiMenuPanel from './TuiMenuPanel.svelte';

  let {
    repoPath,
    currentBranch,
    onSwitch,
    disabled = false,
    currentWorktreePath,
    onJumpToSession,
    onStartSession,
    onCreateBranch,
  }: {
    repoPath: string;
    currentBranch: string;
    onSwitch: (branch: string) => void;
    disabled?: boolean;
    currentWorktreePath?: string;
    onJumpToSession?: (sessionId: string) => void;
    onStartSession?: (worktreePath: string) => void;
    onCreateBranch?: (branchName: string) => void;
  } = $props();

  let open = $state(false);
  let filterText = $state('');
  let wrapperEl = $state<HTMLDivElement | null>(null);
  let filterInputEl = $state<HTMLInputElement | null>(null);
  let switching = $state<string | null>(null);
  let switchError = $state<string | null>(null);

  const branchQuery = createQuery<BranchInfo[]>(() => ({
    queryKey: ['branches', repoPath],
    queryFn: () => fetchBranches(repoPath),
    staleTime: 30_000,
    enabled: open,
  }));

  let filteredBranches = $derived.by(() => {
    const branches = branchQuery.data ?? [];
    if (!filterText.trim()) return branches;
    const lower = filterText.toLowerCase();
    return branches.filter(b => b.name.toLowerCase().includes(lower));
  });

  let showCreateOption = $derived.by(() => {
    if (!filterText.trim()) return false;
    const branches = branchQuery.data ?? [];
    return !branches.some(b => b.name === filterText.trim());
  });

  function openDropdown() {
    if (disabled) return;
    open = true;
    filterText = '';
    switchError = null;
    requestAnimationFrame(() => filterInputEl?.focus());
  }

  function closeDropdown() {
    open = false;
    filterText = '';
  }

  async function handleSelect(branchName: string) {
    if (branchName === currentBranch) {
      closeDropdown();
      return;
    }
    switching = branchName;
    switchError = null;
    try {
      const result = await switchBranch(repoPath, branchName);
      if (result.success) {
        closeDropdown();
        onSwitch(branchName);
      } else {
        switchError = result.error ?? 'Failed to switch branch';
      }
    } catch {
      switchError = 'Failed to switch branch';
    } finally {
      switching = null;
    }
  }

  function isCheckedOutElsewhere(branch: BranchInfo): boolean {
    if (!currentWorktreePath || !branch.checkedOutIn) return false;
    return branch.checkedOutIn.worktreePath !== currentWorktreePath;
  }

  function handleJump(branch: BranchInfo, e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!branch.checkedOutIn) return;
    if (branch.checkedOutIn.sessionId && onJumpToSession) {
      onJumpToSession(branch.checkedOutIn.sessionId);
    } else if (onStartSession) {
      onStartSession(branch.checkedOutIn.worktreePath);
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (open && wrapperEl && document.contains(e.target as Node) && !wrapperEl.contains(e.target as Node)) {
      closeDropdown();
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      closeDropdown();
      e.stopPropagation();
    }
  }
</script>

<svelte:window onclick={onWindowClick} />

<div class="branch-switcher" bind:this={wrapperEl}>
  <button
    class="branch-trigger"
    class:branch-disabled={disabled}
    onclick={openDropdown}
    title={disabled ? 'Unavailable while agent is running' : undefined}
    aria-label="Switch branch"
    aria-expanded={open}
    aria-haspopup="listbox"
  >
    <span class="branch-icon">⑂</span>
    <span class="branch-name">{currentBranch}</span>
    <svg class="branch-caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
      <path d="M1 1l4 4 4-4" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>

  {#if open}
    <div class="branch-dropdown" role="listbox" tabindex="-1" aria-label="Branches" onkeydown={onKeydown}>
      <TuiMenuPanel>
        <div class="branch-filter-wrap">
          <input
            bind:this={filterInputEl}
            type="text"
            class="branch-filter"
            placeholder="Filter branches..."
            bind:value={filterText}
            onkeydown={onKeydown}
            aria-label="Filter branches"
          />
        </div>

        {#if switchError}
          <div class="branch-error">{switchError}</div>
        {/if}

        {#if showCreateOption && onCreateBranch}
          <div class="branch-create" role="option" aria-selected={false} tabindex="-1" onmousedown={() => onCreateBranch?.(filterText.trim())}>
            <span class="branch-create-icon">+</span>
            <span>Create "<strong>{filterText.trim()}</strong>"</span>
          </div>
        {/if}

        {#if branchQuery.isLoading}
          <div class="branch-loading"><CipherText loading={true} text="Fetching branches..." /></div>
        {:else if filteredBranches.length === 0 && !showCreateOption}
          <div class="branch-empty">No branches match</div>
        {:else}
          <div class="branch-list">
            {#each filteredBranches as branch (branch.name)}
              {@const checkedOutElsewhere = isCheckedOutElsewhere(branch)}
              <TuiMenuItem
                role="option"
                ariaSelected={branch.name === currentBranch}
                disabled={checkedOutElsewhere || switching === branch.name}
                onmousedown={() => handleSelect(branch.name)}
              >
                {#snippet icon()}
                  {#if branch.name === currentBranch}
                    <span class="branch-check">&#10003;</span>
                  {:else}
                    <span class="branch-check branch-check--empty"></span>
                  {/if}
                {/snippet}
                <span class="branch-option-name" class:branch-current={branch.name === currentBranch} class:branch-checked-out={checkedOutElsewhere}>{branch.name}</span>
                {#if checkedOutElsewhere && branch.checkedOutIn && (onJumpToSession || onStartSession)}
                  <span class="branch-worktree-name">({branch.checkedOutIn.worktreeName})</span>
                  <button
                    class="branch-jump-btn"
                    title="Jump to worktree"
                    onmousedown={(e) => handleJump(branch, e)}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M4.5 2H2.5C2.22 2 2 2.22 2 2.5V9.5C2 9.78 2.22 10 2.5 10H9.5C9.78 10 10 9.78 10 9.5V7.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                      <path d="M7 2H10V5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                      <path d="M10 2L5.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                    </svg>
                  </button>
                {/if}
                {#if switching === branch.name}
                  <span class="branch-spinner">&hellip;</span>
                {/if}
              </TuiMenuItem>
            {/each}
          </div>
        {/if}
      </TuiMenuPanel>
    </div>
  {/if}
</div>

<style>
  .branch-switcher {
    position: relative;
  }

  .branch-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 0;
    transition: background 0.12s;
    white-space: nowrap;
    min-width: 0;
  }

  .branch-trigger:hover {
    background: var(--surface-hover);
  }

  .branch-trigger.branch-disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .branch-trigger.branch-disabled:hover {
    background: none;
  }

  .branch-icon {
    color: var(--text-muted);
    font-size: var(--font-size-base);
    flex-shrink: 0;
  }

  .branch-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }

  .branch-caret {
    flex-shrink: 0;
    color: var(--text-muted);
    margin-left: 1px;
  }

  .branch-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 220px;
    max-width: 340px;
    z-index: 200;
  }

  .branch-filter-wrap {
    padding: 8px 8px 4px;
    border-bottom: 1px solid var(--border);
  }

  .branch-filter {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    padding: 4px 8px;
    outline: none;
    box-sizing: border-box;
  }

  .branch-filter:focus {
    border-color: var(--accent);
  }

  .branch-error {
    font-size: var(--font-size-xs);
    color: var(--status-error);
    padding: 4px 8px;
  }

  .branch-loading,
  .branch-empty {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    padding: 8px 12px;
    font-style: italic;
  }

  .branch-create {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    font-size: var(--font-size-xs);
    cursor: pointer;
    color: var(--accent);
    border-bottom: 1px solid var(--border);
    transition: background 0.1s;
  }

  .branch-create:hover {
    background: var(--surface-hover);
  }

  .branch-create-icon {
    font-weight: bold;
    flex-shrink: 0;
  }

  .branch-list {
    max-height: 240px;
    overflow-y: auto;
  }

  .branch-current {
    color: var(--accent);
  }

  .branch-checked-out {
    text-decoration: line-through;
    opacity: 0.5;
  }

  .branch-worktree-name {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.7;
    flex-shrink: 0;
  }

  .branch-jump-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    border-radius: 0;
    transition: color 0.12s, background 0.12s;
  }

  .branch-jump-btn:hover {
    color: var(--accent);
    background: var(--surface-hover);
  }

  .branch-check {
    font-size: var(--font-size-xs);
    width: 10px;
    flex-shrink: 0;
    color: var(--accent);
  }

  .branch-check--empty {
    display: inline-block;
  }

  .branch-option-name {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .branch-spinner {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    flex-shrink: 0;
  }
</style>
