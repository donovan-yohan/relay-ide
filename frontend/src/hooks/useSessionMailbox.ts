import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionInboxMessageId } from '../../../shared/context-packet.js';
import {
  fetchInboxMessages,
  previewInboxMessages,
  updateInboxMessageState,
  type DecoratedInboxMessage,
} from '../lib/api.js';
import {
  buildSessionMailboxSummary,
  type SessionMailboxSummary,
} from '../lib/session-mailbox.js';

export const SESSION_MAILBOX_REFETCH_MS = 10_000;

export type SessionMailboxMode = 'preview' | 'detail';
export type SessionMailboxAction = 'ack' | 'resolve' | 'ignore';

export interface UseSessionMailboxOptions {
  limit?: number;
  mode?: SessionMailboxMode;
  enabled?: boolean;
}

export interface UseSessionMailboxResult {
  messages: DecoratedInboxMessage[];
  summary: SessionMailboxSummary;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isUpdating: boolean;
  refetch: () => Promise<unknown>;
  updateMessage: (
    id: SessionInboxMessageId,
    action: SessionMailboxAction
  ) => Promise<void>;
}

export function sessionMailboxQueryKey(
  sessionId: string | null | undefined,
  mode: SessionMailboxMode
): readonly [string, string, SessionMailboxMode] {
  return ['session-mailbox', sessionId ?? 'none', mode] as const;
}

export function useSessionMailbox(
  sessionId: string | null | undefined,
  options: UseSessionMailboxOptions = {}
): UseSessionMailboxResult {
  const { limit = 8, mode = 'preview', enabled = true } = options;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: sessionMailboxQueryKey(sessionId, mode),
    enabled: enabled && !!sessionId,
    staleTime: 2_500,
    refetchInterval: enabled && !!sessionId ? SESSION_MAILBOX_REFETCH_MS : false,
    refetchOnWindowFocus: true,
    queryFn: () => {
      if (!sessionId) return Promise.resolve([]);
      return mode === 'detail'
        ? fetchInboxMessages(sessionId, limit)
        : previewInboxMessages(sessionId, limit);
    },
  });

  const mutation = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: SessionInboxMessageId;
      action: SessionMailboxAction;
    }) => updateInboxMessageState(id, action),
    onSuccess: () => {
      if (sessionId) {
        void queryClient.invalidateQueries({
          queryKey: ['session-mailbox', sessionId],
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['active-work'] });
    },
  });

  const messages = useMemo(() => query.data ?? [], [query.data]);
  const summary = useMemo(
    () => buildSessionMailboxSummary(messages),
    [messages]
  );
  const updateMessage = useCallback(
    async (id: SessionInboxMessageId, action: SessionMailboxAction) => {
      await mutation.mutateAsync({ id, action });
    },
    [mutation]
  );

  return {
    messages,
    summary,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error instanceof Error ? query.error : null,
    isUpdating: mutation.isPending,
    refetch: query.refetch,
    updateMessage,
  };
}
