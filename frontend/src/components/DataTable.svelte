<script module lang="ts">
  export interface Column {
    key: string;
    label: string;
    sortable?: boolean;
    width?: string;
    align?: 'left' | 'right' | 'center';
  }
</script>

<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';

  interface Props {
    columns: Column[];
    rows: T[];
    groupBy?: string;
    sortBy: string;
    sortDir: 'asc' | 'desc';
    onSort: (column: string) => void;
    loading?: boolean;
    error?: string | undefined;
    emptyMessage?: string;
    filteredEmptyMessage?: string;
    onClearFilters?: () => void;
    maxHeight?: string;
    onRowAction?: (item: T) => void;
    skeletonCount?: number;
    hasActiveFilters?: boolean;
    row: Snippet<[T, number]>;
    mobileCard: Snippet<[T, number]>;
  }

  let {
    columns,
    rows,
    groupBy,
    sortBy,
    sortDir,
    onSort,
    loading = false,
    error,
    emptyMessage = 'No data.',
    filteredEmptyMessage = 'No results match the current filters.',
    onClearFilters,
    maxHeight = '400px',
    onRowAction,
    skeletonCount = 3,
    hasActiveFilters = false,
    row,
    mobileCard,
  }: Props = $props();

  // --- Mobile detection ---
  // Using $effect is correct here: matchMedia requires addEventListener/removeEventListener
  // for change events, which is a browser side-effect that cannot be expressed as $derived.
  let isMobile = $state(false);

  $effect(() => {
    const mql = window.matchMedia('(max-width: 600px)');
    isMobile = mql.matches;
    function handler(e: MediaQueryListEvent) {
      isMobile = e.matches;
    }
    mql.addEventListener('change', handler);
    return () => {
      mql.removeEventListener('change', handler);
    };
  });

  // --- Scroll overflow detection ---
  let isScrollable = $state(false);

  // --- Keyboard nav ---
  let focusedIndex = $state(0);
  let scrollContainerEl: HTMLDivElement | undefined = $state(undefined);

  $effect(() => {
    if (!scrollContainerEl) return;
    const check = () => {
      isScrollable = scrollContainerEl!.scrollHeight > scrollContainerEl!.clientHeight;
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(scrollContainerEl);
    return () => observer.disconnect();
  });

  // Reset focusedIndex when rows change (new array reference from $derived.by).
  // Uses referential identity check — $derived.by always returns a new array.
  let prevRowsRef: T[] | undefined;
  $effect(() => {
    if (rows !== prevRowsRef) {
      prevRowsRef = rows;
      focusedIndex = 0;
    }
  });

  // --- Grouping ---
  interface Group {
    key: string;
    items: T[];
  }

  // Using a plain Map inside $derived.by is fine — it's a local variable
  // created and consumed within the callback, not reactive state.
  let groups = $derived.by((): Group[] => {
    if (!groupBy) return [];
    const map = new Map<string, T[]>();
    for (const item of rows) {
      const val = String((item as Record<string, unknown>)[groupBy] ?? 'Other');
      const arr = map.get(val);
      if (arr) {
        arr.push(item);
      } else {
        map.set(val, [item]);
      }
    }
    const keys = [...map.keys()].sort();
    return keys.map((k) => ({ key: k, items: map.get(k)! }));
  });

  let collapsed = $state<Record<string, boolean>>({});

  function toggleGroup(key: string) {
    collapsed[key] = !collapsed[key];
    focusedIndex = 0;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (rows.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIndex = Math.min(focusedIndex + 1, rows.length - 1);
      scrollFocusedIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIndex = Math.max(focusedIndex - 1, 0);
      scrollFocusedIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const focused = rows[focusedIndex];
      if (onRowAction && focused !== undefined) {
        onRowAction(focused);
      }
    }
  }

  function scrollFocusedIntoView() {
    queueMicrotask(() => {
      if (!scrollContainerEl) return;
      const el = scrollContainerEl.querySelector(`[data-row-index="${focusedIndex}"]`);
      if (el) {
        (el as HTMLElement).scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function getAriaSort(col: Column): 'ascending' | 'descending' | 'none' {
    if (sortBy !== col.key) return 'none';
    return sortDir === 'asc' ? 'ascending' : 'descending';
  }

  function getFlatIndex(groupIndex: number, itemIndex: number): number {
    let idx = 0;
    for (let g = 0; g < groupIndex; g++) {
      idx += groups[g]!.items.length;
    }
    return idx + itemIndex;
  }
</script>

<div class="data-table-wrapper" role="list">
  {#if !isMobile}
    <!-- Column headers -->
    <div class="data-table-header">
      {#each columns as col (col.key)}
        <div
          class="data-table-th"
          aria-sort={getAriaSort(col)}
          style:width={col.width}
          style:flex={col.width ? 'none' : '1'}
          style:text-align={col.align}
        >
          {#if col.sortable}
            <button
              class="sort-trigger"
              onclick={() => onSort(col.key)}
            >
              {col.label}
              {#if sortBy === col.key}
                <span class="sort-indicator">{sortDir === 'asc' ? '▲' : '▼'}</span>
              {/if}
            </button>
          {:else}
            {col.label}
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Scroll container wrapper (positioned parent for gradient) -->
  <div class="scroll-wrapper" style:max-height={maxHeight}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="scroll-container"
      bind:this={scrollContainerEl}
      tabindex="0"
      onkeydown={handleKeydown}
      aria-label="Table body"
    >
      {#if loading}
        <!-- Skeleton state -->
        {#each Array(skeletonCount) as _, i (i)}
          <div class="skeleton-row">
            {#if isMobile}
              <div class="skeleton-card">
                <div class="skeleton-line" style="width: 60%; height: 13px;"></div>
                <div class="skeleton-line" style="width: 40%; height: 10px;"></div>
              </div>
            {:else}
              {#each columns as col (col.key)}
                <div
                  class="skeleton-cell"
                  style:width={col.width}
                  style:flex={col.width ? 'none' : '1'}
                >
                  <div class="skeleton-line" style="width: 70%; height: 12px;"></div>
                </div>
              {/each}
            {/if}
          </div>
        {/each}

      {:else if error}
        <!-- Error state -->
        <div class="state-message state-message--error">
          <span>{error}</span>
        </div>

      {:else if rows.length === 0}
        <!-- Empty state -->
        <div class="state-message">
          {#if hasActiveFilters}
            <span>{filteredEmptyMessage}</span>
            {#if onClearFilters}
              <button class="clear-filters-btn" onclick={onClearFilters}>
                Clear filters
              </button>
            {/if}
          {:else}
            <span>{emptyMessage}</span>
          {/if}
        </div>

      {:else if groupBy && groups.length > 0}
        <!-- Grouped rows -->
        {#each groups as group, gi (group.key)}
          <button
            class="group-header"
            onclick={() => toggleGroup(group.key)}
            aria-expanded={!collapsed[group.key]}
          >
            <span class="group-chevron" class:collapsed={collapsed[group.key]}>&#9654;</span>
            <span class="group-label">{group.key}</span>
            <span class="group-count">{group.items.length}</span>
          </button>
          {#if !collapsed[group.key]}
            {#each group.items as item, ii (getFlatIndex(gi, ii))}
              {@const flatIdx = getFlatIndex(gi, ii)}
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div
                class="data-table-row"
                class:clickable={!!onRowAction}
                class:focused={focusedIndex === flatIdx}
                data-row-index={flatIdx}
                role="listitem"
                tabindex="-1"
                onclick={() => onRowAction?.(item)}
              >
                {#if isMobile}
                  {@render mobileCard(item, flatIdx)}
                {:else}
                  {@render row(item, flatIdx)}
                {/if}
              </div>
            {/each}
          {/if}
        {/each}

      {:else}
        <!-- Ungrouped rows -->
        {#each rows as item, i (i)}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="data-table-row"
            class:clickable={!!onRowAction}
            class:focused={focusedIndex === i}
            data-row-index={i}
            role="listitem"
            tabindex="-1"
            onclick={() => onRowAction?.(item)}
          >
            {#if isMobile}
              {@render mobileCard(item, i)}
            {:else}
              {@render row(item, i)}
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <!-- Gradient fade (only when content overflows) -->
    {#if isScrollable}
      <div class="scroll-fade"></div>
    {/if}
  </div>
</div>

<style>
  .data-table-wrapper {
    display: flex;
    flex-direction: column;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
  }

  /* --- Column headers --- */
  .data-table-header {
    display: flex;
    border-bottom: 1px solid var(--border);
    padding: 0 4px;
  }

  .data-table-th {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    padding: 8px 8px;
    transition: color 0.12s;
    user-select: none;
  }

  .data-table-th:hover {
    color: var(--text);
  }

  .sort-trigger {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: inherit;
  }

  .sort-trigger:hover {
    color: var(--text);
  }

  .sort-indicator {
    color: var(--accent);
    font-size: var(--font-size-xs);
  }

  /* --- Scroll wrapper (positioned parent for gradient) --- */
  .scroll-wrapper {
    position: relative;
    border: 1px solid var(--border);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .scroll-container {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    outline: none;
  }

  .scroll-container:focus-visible {
    outline: none;
  }

  .scroll-fade {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 32px;
    background: linear-gradient(transparent, var(--bg));
    pointer-events: none;
  }

  /* --- Rows --- */
  .data-table-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    padding: 0 4px;
    border-bottom: 1px solid var(--border);
    transition: background 0.1s;
    outline: none;
  }

  .data-table-row.clickable {
    cursor: pointer;
  }

  .data-table-row.clickable:hover {
    background: var(--surface-hover);
  }

  .data-table-row:last-child {
    border-bottom: none;
  }

  .data-table-row.focused {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    background: var(--surface-hover);
  }

  /* --- Skeleton --- */
  .skeleton-row {
    display: flex;
    padding: 8px 8px;
    border-bottom: 1px solid var(--border);
    min-height: 40px;
    align-items: center;
  }

  .skeleton-row:last-child {
    border-bottom: none;
  }

  .skeleton-cell {
    padding: 0 8px;
  }

  .skeleton-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    padding: 4px 8px;
  }

  /* --- State messages --- */
  .state-message {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px 12px;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    text-align: center;
  }

  .state-message--error {
    color: var(--status-error);
  }

  .clear-filters-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    cursor: pointer;
    padding: 4px 8px;
    transition: border-color 0.12s, color 0.12s;
  }

  .clear-filters-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* --- Group headers --- */
  .group-header {
    all: unset;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    user-select: none;
    transition: background 0.1s;
    width: 100%;
    box-sizing: border-box;
    font-family: var(--font-mono);
  }

  .group-header:hover {
    background: var(--surface-hover);
  }

  .group-header:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .group-chevron {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    transition: transform 0.15s;
    display: inline-block;
  }

  .group-chevron.collapsed {
    transform: rotate(0deg);
  }

  .group-chevron:not(.collapsed) {
    transform: rotate(90deg);
  }

  .group-label {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    letter-spacing: 0.06em;
  }

  .group-count {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    background: var(--border);
    padding: 2px 4px;
    border-radius: 0;
    opacity: 0.8;
  }

  .skeleton-line {
    background: var(--border);
    animation: skeleton-pulse 1.4s ease-in-out infinite;
  }

  @keyframes skeleton-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0.7; }
  }

  /* --- Mobile card mode --- */
  @media (max-width: 600px) {
    .data-table-row {
      display: block;
      min-height: 44px;
    }
  }
</style>
