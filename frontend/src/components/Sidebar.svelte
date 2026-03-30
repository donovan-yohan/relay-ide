<script lang="ts">
  import {
    getUi,
    closeSidebar,
    saveSidebarWidth,
    toggleSidebarCollapsed,
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    DEFAULT_SIDEBAR_WIDTH,
    COLLAPSED_SIDEBAR_WIDTH,
  } from '../lib/state/ui.svelte.js';
  import { getSessionState, getSessionsForRepo, getSessionsForWorkspaceGroup, reorderWorkspaces } from '../lib/state/sessions.svelte.js';
  import { workspaceAttentionScore } from '../lib/state/attention.js';
  import type { Repo, WorktreeInfo, OrgPrsResponse, Workspace } from '../lib/types.js';
  import WorkspaceGroup from './WorkspaceGroup.svelte';
  import { fetchOrgPrs } from '../lib/api.js';
  import { createQuery } from '@tanstack/svelte-query';
  import { dndzone } from 'svelte-dnd-action';
  import TuiButton from './TuiButton.svelte';
  import WorkspaceItem from './WorkspaceItem.svelte';

  const ui = getUi();
  const sessionState = getSessionState();

  let {
    onSelectSession,
    onOpenSettings,
    onNewWorktree,
    onAddWorkspace,
    onDeleteSession,
    onDeleteWorktree,
    onLaunchWorkspaceSession,
  }: {
    onSelectSession: (id: string) => void;
    onOpenSettings: (workspace?: Repo) => void;
    onNewWorktree: (workspace: Repo) => void;
    onAddWorkspace: () => void;
    onDeleteSession?: (id: string) => void;
    onDeleteWorktree?: (wt: WorktreeInfo) => void;
    onLaunchWorkspaceSession?: (workspaceId: string) => void;
  } = $props();

  let effectiveWidth = $derived(
    ui.sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : ui.sidebarWidth,
  );

  function handleSelectWorkspace(path: string) {
    ui.activeRepoPath = path;
    // Clear active session so the main area shows the dashboard
    sessionState.activeSessionId = null;
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = ui.sidebarWidth;

    const onMouseMove = (e: MouseEvent) => {
      const newWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + (e.clientX - startX)),
      );
      ui.sidebarWidth = newWidth;
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveSidebarWidth();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function resetWidth(e: MouseEvent) {
    e.preventDefault();
    ui.sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
    saveSidebarWidth();
  }

  // Workspace groups + ungrouped repos
  let workspaceGroups = $derived(sessionState.workspaceGroups);
  let groupedRepoPaths = $derived(new Set(workspaceGroups.flatMap((ws: Workspace) => ws.repos)));
  let ungroupedRepos = $derived(sessionState.repos.filter(r => !groupedRepoPaths.has(r.path)));
  let reposByPath = $derived(new Map(sessionState.repos.map(r => [r.path, r])));

  // ── Drag-and-drop reorder ──
  const flipDurationMs = 200;

  // Coarse-pointer devices (phones, tablets) need drag gating to preserve scroll
  const isTouchDevice = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  let mobileDragEnabled = $state(false);
  let dragDisabled = $derived(isTouchDevice && !mobileDragEnabled);

  // Track whether user has manually reordered in this session
  let userHasDragged = $state(false);

  // Pre-compute sidebar items grouped by repo for O(1) lookup in sort
  let itemsByRepo = $derived(new Map(
    sessionState.repos.map(r => [
      r.path,
      sessionState.sidebarItems.filter(i => i.repoPath === r.path),
    ])
  ));

  // Attention-sorted ungrouped workspace list
  let attentionSortedUngrouped = $derived(
    [...ungroupedRepos].sort((a, b) => {
      return workspaceAttentionScore(itemsByRepo.get(b.path) ?? [])
        - workspaceAttentionScore(itemsByRepo.get(a.path) ?? []);
    })
  );

  // svelte-dnd-action requires items with `id` property
  let dndItems = $derived(
    (userHasDragged ? ungroupedRepos : attentionSortedUngrouped)
      .map(w => ({ id: w.path, workspace: w }))
  );

  // Local mutable copy for DnD updates
  let localDndItems = $state<Array<{ id: string; workspace: Repo }>>([]);
  $effect(() => { localDndItems = dndItems; });

  function handleDndConsider(e: CustomEvent<{ items: typeof localDndItems }>) {
    localDndItems = e.detail.items;
  }

  function handleDndFinalize(e: CustomEvent<{ items: typeof localDndItems }>) {
    localDndItems = e.detail.items;
    userHasDragged = true;
    // Server requires the full set of repo paths (grouped + ungrouped).
    // Keep grouped repos in their current order, then append the new ungrouped order.
    const groupedPaths = sessionState.repos.filter(r => groupedRepoPaths.has(r.path)).map(r => r.path);
    const newUngroupedOrder = localDndItems.map(item => item.id);
    reorderWorkspaces([...groupedPaths, ...newUngroupedOrder]);
    mobileDragEnabled = false;
  }

  // ── Org PRs for sidebar enrichment ──
  const orgQuery = createQuery<OrgPrsResponse>(() => ({
    queryKey: ['org-prs'],
    queryFn: fetchOrgPrs,
    staleTime: 60_000,
  }));

  let orgPrs = $derived(orgQuery.data?.prs ?? []);

  // ── Mobile long-press to enable drag ──
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  function handleTouchStart() {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      mobileDragEnabled = true;
      longPressTimer = null;
    }, 500);
  }

  function cancelTouch() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    mobileDragEnabled = false;
  }
</script>

<aside
  class="sidebar"
  class:open={ui.sidebarOpen}
  class:collapsed={ui.sidebarCollapsed}
  style:width="{effectiveWidth}px"
  style:min-width="{effectiveWidth}px"
>
  <div class="sidebar-header">
    <button
      class="collapse-btn"
      aria-label={ui.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      onclick={toggleSidebarCollapsed}
    >
      {ui.sidebarCollapsed ? '»' : '«'}
    </button>
    {#if !ui.sidebarCollapsed}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="sidebar-brand"
        data-track="sidebar.home"
        onclick={() => {
          ui.activeRepoPath = null;
          sessionState.activeSessionId = null;
          closeSidebar();
        }}
      >Relay</span>
    {/if}
    <button class="icon-btn" aria-label="Close sidebar" onclick={closeSidebar}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  </div>

  {#if !ui.sidebarCollapsed}

    <div class="workspace-list">
      <!-- Workspace groups -->
      {#each workspaceGroups.toSorted((a, b) => a.order - b.order) as ws (ws.id)}
        {@const wsRepos = ws.repos.map((p: string) => reposByPath.get(p)).filter((r): r is import('../lib/types.js').Repo => r !== undefined)}
        {@const wsSessions = getSessionsForWorkspaceGroup(ws.id)}
        {@const wsWorktrees = sessionState.worktrees.filter(wt =>
          ws.repos.includes(wt.repoPath)
        )}
        <WorkspaceGroup
          workspace={ws}
          repos={wsRepos}
          sessions={wsSessions}
          worktrees={wsWorktrees}
          activeRepoPath={ui.activeRepoPath}
          activeSessionId={sessionState.activeSessionId}
          onLaunchSession={(id) => onLaunchWorkspaceSession?.(id)}
          {onSelectSession}
          onSelectWorkspace={handleSelectWorkspace}
          {onNewWorktree}
          {onOpenSettings}
          onDeleteSession={(id) => onDeleteSession?.(id)}
          onDeleteWorktree={(wt) => onDeleteWorktree?.(wt)}
          {orgPrs}
        />
      {/each}

      <!-- Ungrouped section -->
      {#if ungroupedRepos.length > 0}
        {#if workspaceGroups.length > 0}
          <div class="ungrouped-label">ungrouped</div>
        {/if}

        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="ungrouped-list"
          use:dndzone={{ items: localDndItems, flipDurationMs, type: 'workspaces', dropTargetStyle: {}, dragDisabled }}
          onconsider={handleDndConsider}
          onfinalize={handleDndFinalize}
          ontouchstart={handleTouchStart}
          ontouchend={cancelTouch}
          ontouchmove={cancelTouch}
          ontouchcancel={cancelTouch}
        >
          {#each localDndItems as item (item.id)}
            {@const workspace = item.workspace}
            {@const activeSessions = getSessionsForRepo(workspace.path)}
            {@const activeWorktreePaths = new Set(activeSessions.map(s => s.worktreePath).filter(Boolean) as string[])}
            {@const inactiveWorktrees = sessionState.worktrees.filter(wt =>
              wt.repoPath === workspace.path &&
              wt.path.startsWith(workspace.path + '/') &&
              !activeWorktreePaths.has(wt.path)
            )}
            {@const groupedByPath = (() => {
              const groups = new Map<string, typeof activeSessions>();
              groups.set(workspace.path, []);
              for (const s of activeSessions) {
                const groupKey = s.worktreePath ?? s.repoPath;
                const existing = groups.get(groupKey);
                if (existing) existing.push(s);
                else groups.set(groupKey, [s]);
              }
              return groups;
            })()}
            <div>
              <WorkspaceItem
                {workspace}
                sessionGroups={groupedByPath}
                {inactiveWorktrees}
                isActive={ui.activeRepoPath === workspace.path && !sessionState.activeSessionId}
                onSelectWorkspace={handleSelectWorkspace}
                {onSelectSession}
                onNewWorktree={onNewWorktree}
                {onOpenSettings}
                onDeleteSession={(id) => onDeleteSession?.(id)}
                onDeleteWorktree={(wt) => onDeleteWorktree?.(wt)}
                {orgPrs}
              />
            </div>
          {/each}
        </div>
      {/if}

      <!-- Empty states -->
      {#if sessionState.repos.length === 0}
        <div class="empty-state">
          <span>no workspaces</span>
        </div>
      {:else if workspaceGroups.length === 0 && ungroupedRepos.length > 0}
        <div class="empty-workspace-hint">
          <span>no workspaces yet</span>
        </div>
      {/if}
    </div>

    <div class="sidebar-footer-row">
      <TuiButton variant="primary" data-track="sidebar.add-workspace" onclick={onAddWorkspace} style="flex: 1;">
        + Add Workspace
      </TuiButton>
      <button class="settings-icon-btn" data-track="sidebar.settings" onclick={() => onOpenSettings()} aria-label="Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" width="14" height="14"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1-1.51V15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="resize-handle" onmousedown={startResize} ondblclick={resetWidth}></div>
  {/if}

  <div class="scanline-overlay" aria-hidden="true"></div>
</aside>

<style>
  .sidebar {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border-right: 1px solid var(--border);
    overflow: hidden;
    transition: transform 0.25s ease, width 0.2s ease, min-width 0.2s ease;
    z-index: 100;
  }

  /* Resize handle */
  .resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    width: 4px;
    height: 100%;
    cursor: col-resize;
    z-index: 10;
    transition: background 0.15s;
  }

  .resize-handle:hover {
    background: var(--accent);
  }

  /* Header */
  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    /* Match PrTopBar (36px + 1px border) + SessionTabBar (32px + 1px border) = 70px total */
    height: 69px; /* 70px minus own 1px border-bottom */
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .sidebar-brand {
    flex: 1;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text);
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: color 0.12s;
  }

  .sidebar-brand:hover {
    color: var(--accent);
  }

  .collapse-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: var(--font-size-lg);
    cursor: pointer;
    padding: 8px 12px;
    border-radius: 0;
    flex-shrink: 0;
    line-height: 1;
    font-family: var(--font-mono);
    min-width: 36px;
    min-height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .collapse-btn:hover {
    color: var(--text);
    background: var(--border);
  }

  .sidebar.collapsed .sidebar-header {
    justify-content: center;
    padding: 12px 4px;
  }

  .icon-btn {
    background: none;
    border: none;
    color: var(--text);
    font-size: var(--font-size-lg);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 0;
    touch-action: manipulation;
    display: none; /* shown on mobile only */
  }

  .icon-btn:active {
    background: var(--border);
  }

  /* Workspace list */
  .workspace-list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .empty-state {
    padding: 16px 12px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    opacity: 0.5;
    text-align: center;
  }

  .ungrouped-label {
    padding: 8px 12px 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-transform: lowercase;
  }

  .ungrouped-list {
    overflow-y: auto;
    overflow-x: hidden;
  }

  .empty-workspace-hint {
    padding: 12px 12px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    opacity: 0.5;
    text-align: center;
  }

  /* Bottom footer row */
  .sidebar-footer-row {
    display: flex;
    gap: 8px;
    margin: 8px;
    align-items: stretch;
    flex-shrink: 0;
  }


  .settings-icon-btn {
    width: 40px;
    min-height: 40px;
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.1s, color 0.1s;
  }

  .settings-icon-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  /* CRT scanline overlay */
  .scanline-overlay {
    pointer-events: none;
    position: absolute;
    inset: 0;
    z-index: 1;
    height: 200%;
    background: repeating-linear-gradient(
      to bottom,
      transparent 0px,
      transparent 3px,
      rgba(255, 255, 255, 0.02) 3px,
      rgba(255, 255, 255, 0.02) 4px
    );
    animation: scanline-drift 30s linear infinite;
  }

  @keyframes scanline-drift {
    from { transform: translateY(0); }
    to { transform: translateY(-50%); }
  }

  @media (prefers-reduced-motion: reduce) {
    .scanline-overlay { animation: none; }
  }

  /* Mobile — full-screen overlay */
  @media (max-width: 600px) {
    .sidebar {
      position: fixed;
      inset: 0;
      width: 100vw !important;
      min-width: 100vw !important;
      height: 100vh;
      height: 100dvh;
      transform: translateX(-100%);
      transition: transform 0.25s ease;
      box-shadow: none;
    }

    .sidebar.open {
      transform: translateX(0);
    }

    .collapse-btn {
      display: none;
    }

    .icon-btn {
      display: block;
      font-size: var(--font-size-lg);
      padding: 4px 8px;
    }

    .resize-handle {
      display: none;
    }
  }
</style>
