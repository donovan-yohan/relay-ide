<script lang="ts">
  import type { Repo, SessionSummary, WorktreeInfo, PullRequest } from '../lib/types.js';
  import { deriveColor } from '../lib/colors.js';
  import { derivePrDotStatus } from '../lib/pr-status.js';
  import StatusDot from './StatusDot.svelte';
  import { getSessionState, refreshAll, setLoading, clearLoading, isItemLoading } from '../lib/state/sessions.svelte.js';
  import { isAttentionState } from '../lib/state/display-state.js';
  import { toggleWorkspaceCollapse, isWorkspaceCollapsed, getTimeTick } from '../lib/state/ui.svelte.js';
  import { formatRelativeTimeCompact } from '../lib/utils.js';
  import { createSession, renameSession } from '../lib/api.js';
  import ContextMenu from './ContextMenu.svelte';
  import type { MenuItem } from './ContextMenu.svelte';
  import CipherText from './CipherText.svelte';
  const sessionState = getSessionState();

  let {
    workspace,
    sessionGroups,
    inactiveWorktrees = [],
    isActive,
    onSelectWorkspace,
    onSelectSession,
    onNewWorktree,
    onOpenSettings,
    onDeleteSession,
    onDeleteWorktree,
    orgPrs,
  }: {
    workspace: Repo;
    sessionGroups: Map<string, SessionSummary[]>;
    inactiveWorktrees?: WorktreeInfo[];
    isActive: boolean;
    onSelectWorkspace: (path: string) => void;
    onSelectSession: (id: string) => void;
    onNewWorktree: (workspace: Repo) => void;
    onOpenSettings: (workspace: Repo) => void;
    onDeleteSession?: (id: string) => void;
    onDeleteWorktree?: (wt: WorktreeInfo) => void;
    orgPrs?: PullRequest[];
  } = $props();

  // Flatten all sessions for attention detection
  let allSessions = $derived([...sessionGroups.values()].flat());

  let initialColor = $derived(deriveColor(workspace.name));
  let initial = $derived(workspace.name.charAt(0).toUpperCase());
  let collapsed = $derived(isWorkspaceCollapsed(workspace.path));
  let totalItems = $derived(allSessions.length + inactiveWorktrees.length);

  // Precompute O(1) lookup map to avoid O(n²) linear finds in the render path
  let sidebarItemById = $derived(
    new Map(sessionState.sidebarItems.map(i => [i.id, i]))
  );

  function statusDotClass(groupPath: string): string {
    const state = sidebarItemById.get(groupPath)?.displayState ?? 'inactive';
    return 'status-dot status-dot--' + state;
  }

  function itemHasAttention(groupPath: string): boolean {
    const item = sidebarItemById.get(groupPath);
    return item !== undefined && isAttentionState(item.displayState);
  }

  function sessionDisplayName(session: SessionSummary): string {
    if (session.worktreePath === null) {
      // Show "default" unless the user explicitly renamed the session
      const wasRenamed = session.displayName && session.displayName !== session.repoName;
      return wasRenamed ? session.displayName : 'default';
    }
    return session.displayName || session.branchName || session.repoName || session.id;
  }

  // Group identity: name derived from worktree/branch, not individual tab
  function groupDisplayName(groupPath: string, sessions: SessionSummary[]): string {
    const isRepoRoot = groupPath === workspace.path;
    if (isRepoRoot) {
      const repoSession = sessions.find(s => s.worktreePath === null);
      if (repoSession) {
        const wasRenamed = repoSession.displayName && repoSession.displayName !== repoSession.repoName;
        return wasRenamed ? repoSession.displayName : 'default';
      }
      return 'default';
    }
    // All sessions in a worktree group share the same branch — use any
    const branch = sessions.find(s => s.branchName)?.branchName;
    const cwdName = sessions[0]?.cwd.split('/').pop();
    return branch || cwdName || sessions[0]?.repoName || 'unknown';
  }

  let hasAttention = $derived(
    sessionState.sidebarItems
      .filter(i => i.repoPath === workspace.path)
      .some(i => isAttentionState(i.displayState))
  );
  let creatingWorktree = $derived(isItemLoading(`new-worktree:${workspace.path}`));

  // Detect mobile for context menu behavior
  let isMobile = $state(typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches);

  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  function handleHeaderClick(e: MouseEvent) {
    void e;
    if (isMobile) {
      onSelectWorkspace(workspace.path);
      return;
    }
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      toggleWorkspaceCollapse(workspace.path);
    } else {
      clickTimer = setTimeout(() => {
        clickTimer = null;
        onSelectWorkspace(workspace.path);
      }, 200);
    }
  }

  // Context menu refs (keyed by row identifier)
  let menuRefs: Record<string, ContextMenu> = {};

  // Long-press handling for mobile context menus
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  function handleRowTouchStart(key: string, el: HTMLElement) {
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      const menu = menuRefs[key];
      if (menu) menu.openAt(el);
    }, 500);
  }

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  // Force re-derive on time tick
  let _tick = $derived(getTimeTick());

  function sessionTime(session: SessionSummary): string {
    void _tick;
    return formatRelativeTimeCompact(session.lastActivity);
  }

  function worktreeTime(wt: WorktreeInfo): string {
    void _tick;
    return formatRelativeTimeCompact(wt.lastActivity);
  }

  function findPrForBranch(branchName: string): PullRequest | undefined {
    return orgPrs?.find(pr => pr.headRefName === branchName && pr.state === 'OPEN' && pr.repoPath === workspace.path);
  }

  async function handleRename(session: SessionSummary) {
    const newName = prompt('Rename session:', sessionDisplayName(session));
    if (newName && newName.trim()) {
      await renameSession(session.id, newName.trim());
      await refreshAll();
    }
  }

  function sessionMenuItems(session: SessionSummary): MenuItem[] {
    return [
      { label: 'Rename', action: () => handleRename(session) },
      { label: 'Kill', action: () => onDeleteSession?.(session.id), danger: true },
    ];
  }

  function worktreeMenuItems(wt: WorktreeInfo): MenuItem[] {
    return [
      {
        label: 'Resume',
        action: async () => {
          if (isItemLoading(wt.path)) return;
          setLoading(wt.path);
          try {
            const session = await createSession({
              repoPath: workspace.path,
              worktreePath: wt.path,
              type: 'agent',
              branchName: wt.branchName || wt.name,
            });
            await refreshAll();
            onSelectSession(session.id);
          } catch { /* silent */ } finally {
            clearLoading(wt.path);
          }
        },
      },
      {
        label: 'Resume (YOLO)',
        action: async () => {
          if (isItemLoading(wt.path)) return;
          setLoading(wt.path);
          try {
            const session = await createSession({
              repoPath: workspace.path,
              worktreePath: wt.path,
              type: 'agent',
              branchName: wt.branchName || wt.name,
              yolo: true,
            });
            await refreshAll();
            onSelectSession(session.id);
          } catch { /* silent */ } finally {
            clearLoading(wt.path);
          }
        },
      },
      {
        label: 'Delete Worktree',
        action: () => onDeleteWorktree?.(wt),
        danger: true,
      },
    ];
  }
</script>

<div class="workspace-item" class:active={isActive}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="workspace-header"
    class:attention={hasAttention}
    data-track="sidebar.workspace.click"
    onclick={handleHeaderClick}
  >
    <div class="workspace-left">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="collapse-chevron"
        class:collapsed
        onclick={(e) => { e.stopPropagation(); toggleWorkspaceCollapse(workspace.path); }}
      >{collapsed ? '›' : '⌄'}</span>
      <span class="initial-block" style:background={initialColor}>{initial}</span>
      <span class="workspace-name">{workspace.name}</span>
      {#if collapsed && totalItems > 0}
        <span class="collapse-count">{totalItems}</span>
      {/if}
    </div>
    <div class="workspace-actions">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="action-btn"
        title="Settings"
        onclick={(e) => { e.stopPropagation(); onOpenSettings(workspace); }}
      ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" width="14" height="14"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1-1.51V15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
    </div>
  </div>

  {#if !collapsed}
    <ul class="session-list">
      {#each [...sessionGroups.entries()] as [groupPath, groupSessions] (groupPath)}
        {@const representative = groupSessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))[0]}
        {@const sessionCount = groupSessions.length}
        {@const isRepoRoot = groupPath === workspace.path}
        {@const hasActiveSessions = sessionCount > 0}
        {#if hasActiveSessions && representative}
          {@const matchedPr = findPrForBranch(groupSessions[0]?.branchName ?? '')}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li
            class="session-row"
            class:selected={groupSessions.some(s => sessionState.activeSessionId === s.id)}
            class:attention={itemHasAttention(groupPath)}
            data-track="sidebar.session.click"
            onclick={() => onSelectSession(representative.id)}
            ontouchstart={(e) => handleRowTouchStart(representative.id, e.currentTarget as HTMLElement)}
            ontouchend={cancelLongPress}
            ontouchmove={cancelLongPress}
          >
            <div class="session-row-primary">
              <span class={statusDotClass(groupPath)}></span>
              <span class="session-name" class:bold={itemHasAttention(groupPath)}>{groupDisplayName(groupPath, groupSessions)}</span>
              {#if sessionCount > 1}
                <span class="session-count-badge">{sessionCount}</span>
              {/if}
              {#if matchedPr}
                <span class="sidebar-pr-status">
                  <StatusDot status={derivePrDotStatus(matchedPr)} size={5} />
                  {#if matchedPr.ciStatus === 'SUCCESS'}<span class="ci-pass"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" width="9" height="9"><polyline points="20 6 9 17 4 12"/></svg></span>
                  {:else if matchedPr.ciStatus === 'FAILURE' || matchedPr.ciStatus === 'ERROR'}<span class="ci-fail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" width="9" height="9"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
                  {:else if matchedPr.ciStatus === 'PENDING'}<span class="ci-pending" style="font-size:9px">●</span>
                  {/if}
                </span>
              {/if}
            </div>
            <div class="session-row-secondary">
              <span class="secondary-time">{sessionTime(representative)}</span>
              {#if representative.branchName}
                <span class="secondary-branch"><CipherText text={representative.branchName} /></span>
              {/if}
            </div>
            <div class="row-menu-overlay">
              <ContextMenu items={sessionMenuItems(representative)} bind:this={menuRefs[representative.id]} />
            </div>
          </li>
        {:else if isRepoRoot}
          <!-- Persistent repo root entry — always shown even with no active sessions -->
          {@const repoLoadingKey = `repo-session:${workspace.path}`}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li
            class="session-row inactive"
            class:loading={isItemLoading(repoLoadingKey)}
            data-track="sidebar.repo.click"
            onclick={async () => {
              if (isItemLoading(repoLoadingKey)) return;
              setLoading(repoLoadingKey);
              try {
                const session = await createSession({
                  repoPath: workspace.path,
                  worktreePath: null,
                  type: 'agent',
                });
                await refreshAll();
                onSelectSession(session.id);
              } catch { /* silent */ } finally {
                clearLoading(repoLoadingKey);
              }
            }}
          >
            <div class="session-row-primary">
              <span class="dot dot-inactive"></span>
              <span class="session-name">{isItemLoading(repoLoadingKey) ? 'starting...' : 'default'}</span>
            </div>
            {#if workspace.defaultBranch}
              <div class="session-row-secondary">
                <span class="secondary-branch">{workspace.defaultBranch}</span>
              </div>
            {/if}
          </li>
        {/if}
      {/each}
      {#each inactiveWorktrees as wt (wt.path)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <li
          class="session-row inactive"
          class:loading={isItemLoading(wt.path)}
          data-track="sidebar.worktree.click"
          onclick={async () => {
            if (isItemLoading(wt.path)) return;
            setLoading(wt.path);
            try {
              const session = await createSession({
                repoPath: workspace.path,
                worktreePath: wt.path,
                type: 'agent',
                branchName: wt.branchName || wt.name,
              });
              await refreshAll();
              onSelectSession(session.id);
            } catch { /* silent */ } finally {
              clearLoading(wt.path);
            }
          }}
          ontouchstart={(e) => handleRowTouchStart(wt.path, e.currentTarget as HTMLElement)}
          ontouchend={cancelLongPress}
          ontouchmove={cancelLongPress}
        >
          <div class="session-row-primary">
            <span class="dot dot-inactive"></span>
            <span class="session-name">{isItemLoading(wt.path) ? 'resuming...' : wt.branchName || wt.displayName || wt.name}</span>
          </div>
          <div class="session-row-secondary">
            <span class="secondary-time">{worktreeTime(wt)}</span>
            {#if wt.branchName}
              <span class="secondary-branch"><CipherText text={wt.branchName} /></span>
            {/if}
          </div>
          <div class="row-menu-overlay">
            <ContextMenu items={worktreeMenuItems(wt)} bind:this={menuRefs[wt.path]} />
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if !collapsed}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="add-worktree-row" class:disabled={creatingWorktree} data-track="sidebar.new-worktree" onclick={() => { if (!creatingWorktree) onNewWorktree(workspace); }}>
      <span class="add-worktree-btn">{creatingWorktree ? 'creating...' : '+ new worktree'}</span>
    </div>
  {/if}

  <div class="workspace-divider"></div>
</div>

<style>
  .workspace-item {
    display: flex;
    flex-direction: column;
  }

  /* Header row */
  .workspace-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    cursor: pointer;
    min-height: 44px;
    transition: background 0.12s;
  }

  .workspace-header:hover {
    background: var(--surface-hover);
  }

  .workspace-item.active .workspace-header {
    background: var(--surface-hover);
  }

  .workspace-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .collapse-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    transition: color 0.12s;
  }

  .collapse-chevron:hover {
    color: var(--text);
  }

  .collapse-count {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    background: var(--border);
    border-radius: 0;
    padding: 2px 8px;
    flex-shrink: 0;
  }

  .initial-block {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 0;
    font-size: var(--font-size-xs);
    font-weight: 700;
    color: #000;
    font-family: var(--font-mono);
    flex-shrink: 0;
    line-height: 1;
  }

  .workspace-name {
    font-size: var(--font-size-sm);
    font-weight: 700;
    color: var(--text);
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  /* Quick-action buttons — only visible on hover */
  .workspace-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.12s;
    flex-shrink: 0;
  }

  .workspace-header:hover .workspace-actions {
    opacity: 1;
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 0;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    cursor: pointer;
    font-family: var(--font-mono);
    transition: background 0.1s, color 0.1s;
  }

  .action-btn:hover {
    background: var(--border);
    color: var(--text);
  }

  /* Session list */
  .session-list {
    list-style: none;
  }

  .session-row {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 8px 8px 36px;
    cursor: pointer;
    min-height: 44px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    transition: background 0.1s;
    border-left: 3px solid transparent;
    justify-content: center;
  }

  .session-row:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .session-row.selected {
    border-left-color: var(--accent);
    background: var(--surface-hover);
    color: var(--text);
  }

  .session-row.attention .session-name {
    font-weight: 700;
    color: var(--text);
  }

  /* Two-line row layout */
  .session-row-primary {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .session-row-secondary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 16px;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    min-width: 0;
  }

  .secondary-branch {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  /* Context menu overlay — positioned over the row, visible on hover (desktop) */
  .row-menu-overlay {
    position: absolute;
    right: 8px;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    opacity: 0;
    transition: opacity 0.12s;
  }

  .session-row:hover .row-menu-overlay {
    opacity: 1;
  }

  .secondary-pr {
    white-space: nowrap;
    flex-shrink: 0;
    color: var(--accent);
  }

  .sidebar-pr-status { display: inline-flex; align-items: center; gap: 2px; margin-left: 4px; }
  .ci-pass { color: var(--status-success); }
  .ci-fail { color: var(--status-error); }
  .ci-pending { color: var(--status-warning); }

  .secondary-time {
    white-space: nowrap;
    flex-shrink: 0;
    opacity: 0.7;
  }

  /* Session count badge */
  .session-count-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    border-radius: 0;
    background: var(--border);
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    padding: 0 4px;
    flex-shrink: 0;
  }

  /* Diff badge */
  .diff-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--font-size-xs);
    flex-shrink: 0;
    margin-left: auto;
  }

  .diff-add { color: var(--status-success); }
  .diff-del { color: var(--status-error); }

  /* Status dot */
  .status-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* Display-state dot classes */
  .status-dot--running      { background: var(--status-success); }
  .status-dot--initializing { background: #6b7280; }
  .status-dot--unseen-idle  {
    background: var(--status-warning);
    box-shadow: 0 0 5px 1px rgba(251, 191, 36, 0.45);
    animation: attention-glow 2s ease-in-out infinite;
  }
  .status-dot--seen-idle    { background: var(--status-info); }
  .status-dot--permission   {
    background: #eab308;
    box-shadow: 0 0 5px 1px rgba(234, 179, 8, 0.45);
    animation: attention-glow 1.5s ease-in-out infinite;
  }
  .status-dot--inactive     { background: transparent; border: 1.5px solid var(--border); }

  .dot-inactive        { width: 7px; height: 7px; border-radius: 50%; background: transparent; border: 1.5px solid var(--border); flex-shrink: 0; }
  .session-row.inactive .session-name { color: var(--text-muted); }
  .session-row.inactive:hover .session-name { color: var(--text); }
  .session-row.loading { pointer-events: none; opacity: 0.7; }
  .session-row.loading .session-name { color: var(--accent); }

  @keyframes attention-glow {
    0%, 100% { box-shadow: 0 0 3px 1px rgba(251, 191, 36, 0.3); }
    50%       { box-shadow: 0 0 7px 2px rgba(251, 191, 36, 0.6); }
  }

  .session-name {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .session-name.bold {
    font-weight: 700;
  }

  /* Add worktree row */
  .add-worktree-row {
    padding: 4px 8px 8px 36px;
  }

  .add-worktree-btn {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    opacity: 0.5;
    cursor: pointer;
    transition: opacity 0.1s, color 0.1s;
  }

  .add-worktree-btn:hover {
    opacity: 1;
    color: var(--text);
  }

  .add-worktree-row.disabled {
    pointer-events: none;
  }

  .add-worktree-row.disabled .add-worktree-btn {
    opacity: 0.7;
    color: var(--accent);
  }

  /* Solid divider */
  .workspace-divider {
    height: 1px;
    background: var(--border);
    margin: 0;
  }

  /* Mobile: ensure 44px touch targets */
  @media (max-width: 600px) {
    .workspace-header {
      min-height: 48px;
    }

    .session-row {
      min-height: 48px;
    }

    /* Always show actions on mobile (no hover) */
    .workspace-actions {
      opacity: 1;
    }

    /* On mobile, always show dots (no hover) */
    .row-menu-overlay {
      opacity: 1;
    }
  }
</style>
