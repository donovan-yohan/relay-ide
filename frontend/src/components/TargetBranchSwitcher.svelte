<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { fetchBranches } from '../lib/api.js';
  import type { BranchInfo } from '../lib/types.js';
  import TuiMenuItem from './TuiMenuItem.svelte';
  import TuiMenuPanel from './TuiMenuPanel.svelte';

  let {
    repoPath,
    currentBase,
    prNumber,
    disabled = false,
    onBaseChanged,
  }: {
    repoPath: string;
    currentBase: string;
    prNumber: number;
    disabled?: boolean;
    onBaseChanged?: (newBase: string) => void;
  } = $props();

  let open = $state(false);
  let filterText = $state('');
  let wrapperEl = $state<HTMLDivElement | null>(null);
  let filterInputEl = $state<HTMLInputElement | null>(null);
  let switching = $state<string | null>(null);
  let switchError = $state<string | null>(null);

  // Fetch branches (remote only) -- lazy, only when dropdown opens
  const branchQuery = createQuery<BranchInfo[]>(() => ({
    queryKey: ['branches', repoPath],
    queryFn: () => fetchBranches(repoPath),
    staleTime: 30_000,
    enabled: open,
  }));

  // Filter to remote-only branches (origin/ prefix already stripped by backend, defensive strip here)
  let filteredBranches = $derived.by(() => {
    const branches = (branchQuery.data ?? [])
      .filter(b => b.isRemote)
      .map(b => ({ ...b, name: b.name.replace(/^origin\//, '') }));

    // Deduplicate by name
    const seen = new Set<string>();
    const deduped = branches.filter(b => {
      if (seen.has(b.name)) return false;
      seen.add(b.name);
      return true;
    });

    if (!filterText.trim()) return deduped;
    const lower = filterText.toLowerCase();
    return deduped.filter(b => b.name.toLowerCase().includes(lower));
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
    if (branchName === currentBase) {
      closeDropdown();
      return;
    }
    switching = branchName;
    switchError = null;
    try {
      const res = await fetch('/workspaces/pr-base?path=' + encodeURIComponent(repoPath), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prNumber, baseBranch: branchName }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (data.success) {
        closeDropdown();
        onBaseChanged?.(branchName);
      } else {
        switchError = data.error ?? 'Failed to change base branch';
      }
    } catch {
      switchError = 'Failed to change base branch';
    } finally {
      switching = null;
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

<div class="target-switcher" bind:this={wrapperEl}>
  <button
    class="target-trigger"
    class:target-disabled={disabled}
    onclick={openDropdown}
    aria-label="Change target branch"
    aria-expanded={open}
    aria-haspopup="listbox"
    title={disabled ? 'Unavailable while agent is running' : 'Change target branch'}
  >
    <span class="target-name">{currentBase}</span>
    <svg class="target-caret" width="8" height="5" viewBox="0 0 8 5" aria-hidden="true">
      <path d="M1 1l3 3 3-3" stroke="currentColor" fill="none" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
  </button>

  {#if open}
    <div class="target-dropdown" role="listbox" tabindex="-1" aria-label="Target branches" onkeydown={onKeydown}>
      <TuiMenuPanel>
        <div class="target-filter-wrap">
          <input
            bind:this={filterInputEl}
            type="text"
            class="target-filter"
            placeholder="Filter branches..."
            bind:value={filterText}
            onkeydown={onKeydown}
            aria-label="Filter target branches"
          />
        </div>

        {#if switchError}
          <div class="target-error">{switchError}</div>
        {/if}

        {#if branchQuery.isLoading}
          <div class="target-loading">Loading...</div>
        {:else if filteredBranches.length === 0}
          <div class="target-empty">No branches match</div>
        {:else}
          <div class="target-list">
            {#each filteredBranches as branch (branch.name)}
              <TuiMenuItem
                role="option"
                ariaSelected={branch.name === currentBase}
                disabled={switching === branch.name}
                onmousedown={() => handleSelect(branch.name)}
              >
                {#snippet icon()}
                  {#if branch.name === currentBase}
                    <span class="target-check">&#10003;</span>
                  {:else}
                    <span class="target-check target-check--empty"></span>
                  {/if}
                {/snippet}
                <span class="target-option-name" class:target-current={branch.name === currentBase}>{branch.name}</span>
                {#if switching === branch.name}
                  <span class="target-spinner">&hellip;</span>
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
  .target-switcher {
    position: relative;
  }

  .target-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 0;
    transition: background 0.12s;
    white-space: nowrap;
    min-width: 0;
  }

  .target-trigger:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .target-disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .target-disabled:hover {
    background: none;
    color: var(--text-muted);
  }

  .target-name {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 120px;
  }

  .target-caret {
    flex-shrink: 0;
    color: var(--text-muted);
    margin-left: 1px;
  }

  .target-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 220px;
    max-width: 340px;
    z-index: 200;
  }

  .target-filter-wrap {
    padding: 8px 8px 4px;
    border-bottom: 1px solid var(--border);
  }

  .target-filter {
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

  .target-filter:focus {
    border-color: var(--accent);
  }

  .target-error {
    font-size: var(--font-size-xs);
    color: var(--status-error);
    padding: 4px 8px;
  }

  .target-loading,
  .target-empty {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    padding: 8px 12px;
    font-style: italic;
  }

  .target-list {
    max-height: 240px;
    overflow-y: auto;
  }

  .target-current {
    color: var(--accent);
  }

  .target-check {
    font-size: var(--font-size-xs);
    width: 10px;
    flex-shrink: 0;
    color: var(--accent);
  }

  .target-check--empty {
    display: inline-block;
  }

  .target-option-name {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .target-spinner {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    flex-shrink: 0;
  }
</style>
