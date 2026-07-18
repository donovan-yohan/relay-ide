import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../../shared/channel-chat-protocol.js';
import { fetchChannelThreadHistory } from '../lib/api.js';

const THREAD_HISTORY_PAGE_LIMIT = 50;

export interface UseChannelThreadState {
  root: ChannelMessage | null;
  replies: ChannelMessage[];
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  loading: boolean;
  error: Error | null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function cursorFromPage(
  messages: ChannelMessage[],
  rootId: ChannelMessageId
): number | null {
  const earliestReply = messages.find((message) => message.id !== rootId);
  return earliestReply?.seq ?? null;
}

/**
 * REST backfill overlaid by the channel reducer's live rows. There is no thread
 * socket: live rows win id collisions so streaming updates remain immediate,
 * while fetched rows (especially the root) survive reducer-window replacement.
 */
export function useChannelThread(
  channelId: string,
  rootId: ChannelMessageId | null,
  liveMessages: ChannelMessage[]
): UseChannelThreadState {
  const [backfill, setBackfill] = useState<
    Map<ChannelMessageId, ChannelMessage>
  >(() => new Map());
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const requestKeyRef = useRef('');
  const backfillRef = useRef(backfill);
  const cursorRef = useRef<number | null>(null);
  const hasMoreOlderRef = useRef(false);
  const loadingOlderRef = useRef(false);

  backfillRef.current = backfill;
  hasMoreOlderRef.current = hasMoreOlder;

  useEffect(() => {
    const requestKey = rootId === null ? '' : `${channelId}\u0000${rootId}`;
    requestKeyRef.current = requestKey;
    cursorRef.current = null;
    hasMoreOlderRef.current = false;
    loadingOlderRef.current = false;
    setBackfill(new Map());
    setHasMoreOlder(false);
    setLoadingOlder(false);
    setError(null);

    if (rootId === null) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void fetchChannelThreadHistory(channelId, rootId, {
      limit: THREAD_HISTORY_PAGE_LIMIT,
    })
      .then((page) => {
        if (requestKeyRef.current !== requestKey) return;
        // Preserve a root captured from the live reducer when a newest-first
        // page does not reach it (long threads can omit the root until the
        // pagination walk reaches the oldest page).
        const retainedRoot = backfillRef.current.get(rootId);
        const next = new Map<ChannelMessageId, ChannelMessage>();
        for (const message of page.messages) next.set(message.id, message);
        if (retainedRoot !== undefined) next.set(rootId, retainedRoot);
        backfillRef.current = next;
        setBackfill(next);
        cursorRef.current =
          page.nextCursor?.beforeSeq ?? cursorFromPage(page.messages, rootId);
        const more =
          page.hasMore || page.messages.length >= THREAD_HISTORY_PAGE_LIMIT;
        hasMoreOlderRef.current = more;
        setHasMoreOlder(more);
      })
      .catch((caught: unknown) => {
        if (requestKeyRef.current !== requestKey) return;
        setError(asError(caught));
      })
      .finally(() => {
        if (requestKeyRef.current === requestKey) setLoading(false);
      });
  }, [channelId, rootId]);

  // The volatile reducer tail can later replace its whole window. Once we have
  // seen the root live, retain it in the hook-owned map so the pinned panel root
  // never disappears merely because channel history moved past it.
  useEffect(() => {
    if (rootId === null) return;
    const liveRoot = liveMessages.find((message) => message.id === rootId);
    if (
      liveRoot === undefined ||
      backfillRef.current.get(rootId) === liveRoot
    ) {
      return;
    }
    const next = new Map(backfillRef.current);
    next.set(rootId, liveRoot);
    backfillRef.current = next;
    setBackfill(next);
  }, [liveMessages, rootId]);

  const merged = useMemo(() => {
    const rows = new Map(backfill);
    if (rootId !== null) {
      for (const message of liveMessages) {
        if (message.id === rootId || message.threadId === rootId) {
          rows.set(message.id, message);
        }
      }
    }
    return rows;
  }, [backfill, liveMessages, rootId]);

  const root = rootId === null ? null : (merged.get(rootId) ?? null);
  const replies = useMemo(
    () =>
      rootId === null
        ? []
        : [...merged.values()]
            .filter((message) => message.threadId === rootId)
            .sort((a, b) => a.seq - b.seq),
    [merged, rootId]
  );

  const loadOlder = useCallback(async (): Promise<void> => {
    if (
      rootId === null ||
      loadingOlderRef.current ||
      !hasMoreOlderRef.current
    ) {
      return;
    }
    const requestKey = `${channelId}\u0000${rootId}`;
    const beforeSeq = cursorRef.current;
    if (beforeSeq === null) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setError(null);
    try {
      const page = await fetchChannelThreadHistory(channelId, rootId, {
        beforeSeq,
        limit: THREAD_HISTORY_PAGE_LIMIT,
      });
      if (requestKeyRef.current !== requestKey) return;
      const next = new Map(backfillRef.current);
      for (const message of page.messages) next.set(message.id, message);
      backfillRef.current = next;
      setBackfill(next);
      cursorRef.current =
        page.nextCursor?.beforeSeq ?? cursorFromPage(page.messages, rootId);
      const more =
        page.hasMore || page.messages.length >= THREAD_HISTORY_PAGE_LIMIT;
      hasMoreOlderRef.current = more;
      setHasMoreOlder(more);
    } catch (caught: unknown) {
      if (requestKeyRef.current === requestKey) setError(asError(caught));
    } finally {
      if (requestKeyRef.current === requestKey) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [channelId, rootId]);

  return {
    root,
    replies,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    loading,
    error,
  };
}
