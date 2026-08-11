// #1287: ONE restore path for an archived channel/topic. Two surfaces used to
// restore with disjoint cache invalidations — the in-channel composer bar
// refreshed `['channel', id]` + `['workspace-topic', id]` while the sidebar
// refreshed `['workspace-topics']` — so whichever surface ran the restore left
// the other rendering stale archived state, and the composer swallowed the
// failure while the sidebar toasted it. This hook owns the whole contract:
// every reader key, plus the toast, for every caller.
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { restoreWorkspaceTopic } from '../api.js';
import { useToastStore } from '../stores/toasts.js';
import { topicLifecycleQueryKeys } from './topic-lifecycle-query-keys.js';

/**
 * Every query key that renders a topic's archived state.
 *
 * `['workspace-topics']`, `['channels']`, and `['channel-message-search']` are
 * prefixes, so active/archived list and search variants reconcile together.
 */
export const restoreTopicQueryKeys = topicLifecycleQueryKeys;

/**
 * Shared restore mutation. `mutate(topicId)` is a stable reference, so callers
 * can hand it straight to a `useCallback` dependency list.
 *
 * Stays pending until the invalidated reads settle — the restore affordance
 * must not flip back to "restore" while its own channel row is still archived.
 */
export function useRestoreTopicMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (topicId: string) => restoreWorkspaceTopic(topicId),
    onSuccess: async (_topic, topicId) => {
      await Promise.all(
        restoreTopicQueryKeys(topicId).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey })
        )
      );
    },
    onError: (err: unknown) => {
      // Never silent: an archived channel that refuses to reopen is exactly the
      // case an operator needs told about.
      useToastStore
        .getState()
        .showToast(
          err instanceof Error ? err.message : 'failed to restore topic'
        );
    },
  });
}
