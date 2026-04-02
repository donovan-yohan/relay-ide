<script lang="ts">
  import type { SessionSummary, WorktreeInfo, RepoInfo, GitStatus } from '../lib/types.js';
  import type { MenuItem } from './ContextMenu.svelte';
  import { formatRelativeTime } from '../lib/utils.js';
  import ContextMenu from './ContextMenu.svelte';
  import CipherText from './CipherText.svelte';
  import MarqueeText from './MarqueeText.svelte';
  import StatusDot from './StatusDot.svelte';

  type ActiveVariant = {
    kind: 'active';
    session: SessionSummary;
    status: 'running' | 'idle' | 'attention';
    isSelected: boolean;
  };
  type InactiveWorktreeVariant = { kind: 'inactive-worktree'; worktree: WorktreeInfo };
  type IdleRepoVariant = { kind: 'idle-repo'; repo: RepoInfo };
  type ItemVariant = ActiveVariant | InactiveWorktreeVariant | IdleRepoVariant;

  let {
    variant,
    gitStatus,
    isLoading = false,
    onclick,
    menuItems = [],
  }: {
    variant: ItemVariant;
    gitStatus?: GitStatus | undefined;
    isLoading?: boolean;
    onclick: () => void;
    menuItems?: MenuItem[];
  } = $props();

  let displayName = $derived.by(() => {
    switch (variant.kind) {
      case 'active': {
        if (variant.session.worktreePath === null) return 'default';
        return variant.session.displayName || variant.session.repoName || variant.session.id;
      }
      case 'inactive-worktree': return variant.worktree.displayName || variant.worktree.name;
      case 'idle-repo': return 'default';
    }
  });


  let branchName = $derived.by(() => {
    switch (variant.kind) {
      case 'active': return variant.session.branchName || '';
      case 'inactive-worktree': return variant.worktree.branchName || '';
      case 'idle-repo': return variant.repo.defaultBranch || '';
    }
  });

  let lastActivity = $derived.by(() => {
    switch (variant.kind) {
      case 'active': return formatRelativeTime(variant.session.lastActivity);
      case 'inactive-worktree': return formatRelativeTime(variant.worktree.lastActivity);
      case 'idle-repo': return '';
    }
  });

  let displayState = $derived<'running' | 'idle' | 'attention' | 'disconnected'>(
    variant.kind === 'active'
      ? variant.status
      : 'disconnected',
  );

  let isSelected = $derived(variant.kind === 'active' && variant.isSelected);
  let isActive = $derived(variant.kind === 'active');

  let prIcon = $derived.by(() => {
    if (!gitStatus) return '';
    switch (gitStatus.prState) {
      case 'open': return '○';
      case 'merged': return '⬤';
      case 'closed': return '⊗';
      default: return '';
    }
  });

  let prIconClass = $derived.by(() => {
    if (!gitStatus) return '';
    switch (gitStatus.prState) {
      case 'open': return 'pr-icon pr-open';
      case 'merged': return 'pr-icon pr-merged';
      case 'closed': return 'pr-icon pr-closed';
      default: return '';
    }
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<li
  class:active-session={isActive}
  class:inactive-worktree={!isActive}
  class:selected={isSelected}
  class:loading={isLoading}
  onclick={onclick}
>
  <div class="session-info">
    <div class="session-row-1">
      <span class="status-dot-wrap"><StatusDot status={displayState} size={8} /></span>
      <span class="session-name">
        <MarqueeText>
          <span class="session-name-text"><CipherText text={displayName} loading={isLoading} /></span>
        </MarqueeText>
      </span>
    </div>
    <div class="session-row-2">
      {#if lastActivity}
        <span class="session-time">{lastActivity}</span>
      {/if}
      {#if branchName}
        <span class="session-branch">{branchName}</span>
      {/if}
      {#if prIcon}
        <span class={prIconClass}>{prIcon}</span>
      {/if}
      {#if gitStatus && (gitStatus.additions || gitStatus.deletions)}
        <span class="git-diff">
          {#if gitStatus.additions}<span class="diff-add">+{gitStatus.additions}</span>{/if}
          {#if gitStatus.deletions}<span class="diff-del">-{gitStatus.deletions}</span>{/if}
        </span>
      {/if}
      {#if variant.kind === 'active' && variant.session.dataQuality}
        <span class="data-quality-badge data-quality-badge--{variant.session.dataQuality}">[{variant.session.dataQuality}]</span>
      {/if}
    </div>
  </div>
  {#if menuItems.length > 0}
    <ContextMenu items={menuItems} />
  {/if}
</li>

<style>
  li {
    position: relative;
    display: flex;
    align-items: flex-start;
    padding: 8px 12px;
    cursor: pointer;
    border-radius: 0;
    margin: 2px 6px;
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    touch-action: manipulation;
    transition: background 0.15s, border-color 0.15s;
  }

  li.active-session {
    background: var(--bg);
    border-left: 3px solid transparent;
  }

  li.active-session:hover {
    background: var(--border);
  }

  li.active-session.selected {
    background: var(--accent);
    color: #fff;
    border-left-color: #fff;
  }

  li.active-session.selected .session-time,
  li.active-session.selected .session-branch {
    color: rgba(255, 255, 255, 0.7);
  }

  li.active-session.selected .session-name {
    color: #fff;
  }

  li.inactive-worktree {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    opacity: 0.7;
  }

  li.inactive-worktree:hover {
    opacity: 1;
    border-color: var(--accent);
  }

  li.loading {
    pointer-events: none;
    opacity: 0.5;
  }

  .session-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }

  /* Row 1: dot + name */
  .session-row-1 {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .status-dot-wrap {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    margin-right: 8px;
  }

  .session-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    font-weight: 500;
    color: var(--text);
  }

  .session-name-text {
    display: inline-block;
    white-space: nowrap;
  }

  /* Selected state */
  li.active-session.selected .session-name {
    color: #fff;
  }

  /* Row 2: time + branch + PR + diff */
  .session-row-2 {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding-left: 16px;
  }

  .session-time {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.6;
    flex-shrink: 0;
  }

  .session-branch {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .pr-icon {
    font-size: var(--font-size-xs);
    flex-shrink: 0;
  }

  .pr-open { color: #4ade80; }
  .pr-merged { color: #a78bfa; }
  .pr-closed { color: #f87171; }

  .git-diff {
    display: flex;
    gap: 4px;
    font-size: var(--font-size-xs);
    font-family: monospace;
    flex-shrink: 0;
    margin-left: auto;
  }

  .diff-add { color: #4ade80; }
  .diff-del { color: #f87171; }

  .data-quality-badge {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .data-quality-badge--hooks,
  .data-quality-badge--plugin {
    color: #4ade80;
  }

  .data-quality-badge--parser {
    color: #fbbf24;
  }

  .data-quality-badge--timer {
    color: #888888;
  }

  /* Context menu trigger styling when selected */
  li.active-session.selected :global(.context-menu-trigger) {
    color: rgba(255, 255, 255, 0.7);
  }

  li.active-session.selected :global(.context-menu-trigger:hover) {
    color: #fff;
    background: rgba(255, 255, 255, 0.15);
  }
</style>
