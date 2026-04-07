import { useMemo } from 'react';
import type { SidebarItem } from '../lib/types.js';
import type { DisplayState } from '../lib/state/display-state.js';
import { isAttentionState } from '../lib/state/display-state.js';
import { highestPriorityState } from '../lib/state/attention.js';

export interface RepoAggregation {
  highestState: DisplayState | null;
  attentionCount: number;
  isLoading: boolean;
}

/** Pure function — testable without React. */
export function aggregateRepo(
  repoPath: string,
  sidebarItems: SidebarItem[],
  loadingItems?: Set<string>
): RepoAggregation {
  const repoItems = sidebarItems.filter((item) => item.repoPath === repoPath);

  const hasRepoItemLoading = repoItems.some((item) =>
    loadingItems?.has(item.path)
  );
  const hasRepoScopedLoading =
    loadingItems?.has(`repo-session:${repoPath}`) ||
    loadingItems?.has(`new-worktree:${repoPath}`);
  const isLoading = hasRepoItemLoading || !!hasRepoScopedLoading;

  if (isLoading) {
    return {
      highestState: 'initializing',
      attentionCount: 0,
      isLoading: true,
    };
  }

  const states = repoItems.map((item) => item.displayState);
  const highestState = highestPriorityState(states);
  const attentionCount = repoItems.filter((item) =>
    isAttentionState(item.displayState)
  ).length;

  return {
    highestState,
    attentionCount,
    isLoading: false,
  };
}

export function useRepoAggregation(
  repoPath: string,
  sidebarItems: SidebarItem[],
  loadingItems?: Set<string>
): RepoAggregation {
  return useMemo(
    () => aggregateRepo(repoPath, sidebarItems, loadingItems),
    [repoPath, sidebarItems, loadingItems]
  );
}
