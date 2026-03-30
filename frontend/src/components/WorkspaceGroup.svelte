<script lang="ts">
  import type { Workspace, Repo, SessionSummary, WorktreeInfo, PullRequest } from '../lib/types.js';
  import { toggleWorkspaceCollapse, isWorkspaceCollapsed } from '../lib/state/ui.svelte.js';
  import { isItemLoading } from '../lib/state/sessions.svelte.js';
  import { deriveColor } from '../lib/colors.js';
  import { SvelteMap } from 'svelte/reactivity';
  import CipherText from './CipherText.svelte';
  import TuiButton from './TuiButton.svelte';
  import TuiProgress from './TuiProgress.svelte';
  import WorkspaceItem from './WorkspaceItem.svelte';

  let {
    workspace,
    repos,
    sessions = [],
    worktrees = [],
    loading = false,
    onLaunchSession,
    onSelectSession,
    onSelectWorkspace,
    onNewWorktree,
    onOpenSettings,
    onDeleteSession,
    onDeleteWorktree,
    orgPrs,
  }: {
    workspace: Workspace;
    repos: Repo[];
    sessions?: SessionSummary[];
    worktrees?: WorktreeInfo[];
    loading?: boolean;
    onLaunchSession: (workspaceId: string) => void;
    onSelectSession: (id: string) => void;
    onSelectWorkspace: (path: string) => void;
    onNewWorktree: (workspace: Repo) => void;
    onOpenSettings: (workspace?: Repo) => void;
    onDeleteSession?: (id: string) => void;
    onDeleteWorktree?: (wt: WorktreeInfo) => void;
    orgPrs?: PullRequest[];
  } = $props();

  let collapsed = $derived(isWorkspaceCollapsed(workspace.id));
  let themeColor = $derived(workspace.themeColor ?? deriveColor(workspace.name));
  let accentBorder = $derived(`color-mix(in srgb, ${themeColor} 30%, transparent)`);
  let launching = $derived(isItemLoading(`ws-launch:${workspace.id}`));

  // Sessions at workspace level (workspaceId matches, worktreePath is null-ish or no specific repo)
  let workspaceSessions = $derived(
    sessions.filter(s => s.workspaceId === workspace.id)
  );

  // Total session count for the collapsed badge
  let sessionCount = $derived(sessions.length);

  // Build sessionGroups map and inactiveWorktrees per repo for WorkspaceItem
  function getSessionGroupsForRepo(repo: Repo): SvelteMap<string, SessionSummary[]> {
    const map = new SvelteMap<string, SessionSummary[]>();
    // Seed root entry so it's always present
    map.set(repo.path, []);
    for (const s of sessions) {
      if (s.repoPath !== repo.path) continue;
      const key = s.worktreePath ?? repo.path;
      const existing = map.get(key) ?? [];
      existing.push(s);
      map.set(key, existing);
    }
    return map;
  }

  function getInactiveWorktreesForRepo(repo: Repo): WorktreeInfo[] {
    const activeWorktreePaths = new Set(
      sessions
        .filter(s => s.repoPath === repo.path && s.worktreePath !== null)
        .map(s => s.worktreePath as string)
    );
    return worktrees.filter(
      wt => wt.repoPath === repo.path && !activeWorktreePaths.has(wt.path)
    );
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="workspace-group"
  class:collapsed
  style:--theme-color={themeColor}
  style:--accent-border={accentBorder}
>
  <!-- Header row -->
  <div
    class="group-header"
    onclick={() => toggleWorkspaceCollapse(workspace.id)}
  >
    <div class="header-left">
      <span class="chevron">{collapsed ? '›' : '⌄'}</span>
      <span class="group-name">
        <CipherText text={workspace.name} {loading} />
      </span>
      {#if collapsed && sessionCount > 0}
        <span class="session-count">{sessionCount}</span>
      {/if}
    </div>
  </div>

  {#if !collapsed}
    <div class="group-body">
      <!-- Workspace-level sessions (badge: workspace) -->
      {#if workspaceSessions.length > 0}
        <ul class="workspace-sessions">
          {#each workspaceSessions as session (session.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li
              class="ws-session-row"
              onclick={() => onSelectSession(session.id)}
            >
              <span class="ws-badge">workspace</span>
              <span class="ws-session-name">{session.displayName}</span>
            </li>
          {/each}
        </ul>
      {/if}

      <!-- Launch button -->
      <div class="launch-row">
        <TuiButton
          variant="primary"
          disabled={launching}
          onclick={(e) => { e.stopPropagation(); onLaunchSession(workspace.id); }}
        >
          {#if launching}
            <TuiProgress variant="braille" />&nbsp;launching...
          {:else}
            &gt; launch workspace session
          {/if}
        </TuiButton>
      </div>

      <!-- Nested repo items -->
      {#if repos.length === 0}
        <div class="empty-repos">no repos</div>
      {:else}
        {#each repos as repo (repo.path)}
          <WorkspaceItem
            workspace={repo}
            sessionGroups={getSessionGroupsForRepo(repo)}
            inactiveWorktrees={getInactiveWorktreesForRepo(repo)}
            isActive={false}
            {onSelectWorkspace}
            {onSelectSession}
            {onNewWorktree}
            onOpenSettings={(r) => onOpenSettings(r)}
            onDeleteSession={(id) => onDeleteSession?.(id)}
            onDeleteWorktree={(wt) => onDeleteWorktree?.(wt)}
            orgPrs={orgPrs ?? []}
          />
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .workspace-group {
    display: flex;
    flex-direction: column;
    font-family: var(--font-mono);
    border-radius: 0;
  }

  /* Collapsed: 2px left accent only */
  .workspace-group.collapsed {
    border-left: 2px solid var(--accent-border);
    border-top: none;
    border-right: none;
    border-bottom: none;
  }

  /* Expanded: full 1px rectangular outline */
  .workspace-group:not(.collapsed) {
    border: 1px solid var(--accent-border);
  }

  /* Header */
  .group-header {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    cursor: pointer;
    min-height: 44px;
    transition: background 0.12s;
  }

  .group-header:hover {
    background: var(--surface-hover);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .group-name {
    font-size: var(--font-size-sm);
    font-weight: 700;
    color: var(--text);
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    text-transform: lowercase;
  }

  .session-count {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    background: var(--border);
    padding: 2px 8px;
    flex-shrink: 0;
  }

  /* Group body — pure black interior */
  .group-body {
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }

  /* Workspace-level sessions */
  .workspace-sessions {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .ws-session-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 6px 28px;
    cursor: pointer;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    min-height: 36px;
    transition: background 0.1s;
  }

  .ws-session-row:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  /* Orange outline workspace badge — zero border-radius, outline-only */
  .ws-badge {
    display: inline-flex;
    align-items: center;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: #fb923c;
    border: 1px solid #fb923c;
    border-radius: 0;
    padding: 1px 5px;
    flex-shrink: 0;
    text-transform: lowercase;
  }

  .ws-session-name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    min-width: 0;
  }

  /* Launch row */
  .launch-row {
    padding: 8px 12px;
    display: flex;
  }

  .launch-row :global(.tui-btn) {
    width: 100%;
    justify-content: center;
    text-transform: lowercase;
  }

  /* Empty repos */
  .empty-repos {
    padding: 8px 12px 8px 28px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
  }
</style>
