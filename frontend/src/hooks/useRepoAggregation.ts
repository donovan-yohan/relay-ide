import { useMemo } from 'react';
import type { SidebarItem } from '../lib/types.js';
import type { DisplayState } from '../lib/state/display-state.js';
import { isAttentionState } from '../lib/state/display-state.js';
import { highestPriorityState } from '../lib/state/attention.js';

interface RepoAggregation {
  highestState: DisplayState | null;
  attentionCount: number;
  isLoading: boolean;
}

export function useRepoAggregation(
  repoPath: string,
  sidebarItems: SidebarItem[],
  loadingItems?: Set<string>
): RepoAggregation {
  return useMemo(() => {
    const repoItems = sidebarItems.filter((item) => item.repoPath === repoPath);

    const isLoading = repoItems.some((item) => loadingItems?.has(item.path));

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
  }, [repoPath, sidebarItems, loadingItems]);
}
