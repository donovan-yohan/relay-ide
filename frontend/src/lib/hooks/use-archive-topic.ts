import { useMutation, useQueryClient } from '@tanstack/react-query';

import { archiveWorkspaceTopic } from '../api.js';
import { useToastStore } from '../stores/toasts.js';

/** Every cached projection whose membership or archived state changes. */
export function archiveTopicQueryKeys(topicId: string): string[][] {
  return [
    ['channel', topicId],
    ['workspace-topic', topicId],
    ['workspace-topics'],
    ['channels'],
    ['channel-message-search'],
  ];
}

/**
 * Shared reversible archive mutation.
 *
 * The mutation remains pending until every mounted reader has reconciled, so a
 * caller can safely leave the archived channel only after the active rail and
 * search projections can no longer select it again.
 */
export function useArchiveTopicMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (topicId: string) => archiveWorkspaceTopic(topicId),
    onSuccess: async (_topic, topicId) => {
      await Promise.all(
        archiveTopicQueryKeys(topicId).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey })
        )
      );
    },
    onError: (err: unknown) => {
      useToastStore
        .getState()
        .showToast(
          err instanceof Error ? err.message : 'failed to archive channel'
        );
    },
  });
}
