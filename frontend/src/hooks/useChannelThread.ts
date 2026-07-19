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
  /** Advances whenever a REST page supplies the authoritative root row. */
  rootFloorRevision: number;
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

function mergeThreadPage(
  current: Map<ChannelMessageId, ChannelMessage>,
  pageMessages: ChannelMessage[],
  rootId: ChannelMessageId
): Map<ChannelMessageId, ChannelMessage> {
  const next = new Map(current);
  for (const message of pageMessages) {
    const retained = next.get(message.id);
    if (retained === undefined) {
      next.set(message.id, message);
      continue;
    }
    if (message.id === rootId) {
      next.set(rootId, {
        ...message,
        ...retained,
        // REST carries the refreshed authoritative floor; the retained row may
        // carry newer live presentation fields.
        replyCount: Math.max(message.replyCount ?? 0, retained.replyCount ?? 0),
      });
    }
    // Reply collisions retain the live row (it may still be streaming).
  }
  return next;
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
  const [rootFloorRevision, setRootFloorRevision] = useState(0);

  const requestKeyRef = useRef('');
  const backfillRef = useRef(backfill);
  const cursorRef = useRef<number | null>(null);
  const hasMoreOlderRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const lastFoldedLiveRowsRef = useRef<Map<ChannelMessageId, ChannelMessage>>(
    new Map()
  );

  backfillRef.current = backfill;
  hasMoreOlderRef.current = hasMoreOlder;

  useEffect(() => {
    const requestKey = rootId === null ? '' : `${channelId}\u0000${rootId}`;
    requestKeyRef.current = requestKey;
    cursorRef.current = null;
    hasMoreOlderRef.current = false;
    loadingOlderRef.current = false;
    lastFoldedLiveRowsRef.current.clear();
    setBackfill(new Map());
    setHasMoreOlder(false);
    setLoadingOlder(false);
    setError(null);
    setRootFloorRevision(0);

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
        const next = mergeThreadPage(
          backfillRef.current,
          page.messages,
          rootId
        );
        backfillRef.current = next;
        setBackfill(next);
        if (page.messages.some((message) => message.id === rootId)) {
          setRootFloorRevision((revision) => revision + 1);
        }
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

  // Fold every live thread row into hook-owned state. A later authoritative
  // reducer replacement must not erase rows already observed by an open panel.
  useEffect(() => {
    if (rootId === null) return;
    let next: Map<ChannelMessageId, ChannelMessage> | null = null;
    for (const message of liveMessages) {
      if (message.id !== rootId && message.threadId !== rootId) continue;
      if (lastFoldedLiveRowsRef.current.get(message.id) === message) continue;
      lastFoldedLiveRowsRef.current.set(message.id, message);
      next ??= new Map(backfillRef.current);
      const retained = next.get(message.id);
      next.set(
        message.id,
        message.id === rootId && retained
          ? {
              ...retained,
              ...message,
              replyCount: Math.max(
                retained.replyCount ?? 0,
                message.replyCount ?? 0
              ),
            }
          : message
      );
    }
    if (next === null) return;
    backfillRef.current = next;
    setBackfill(next);
  }, [liveMessages, rootId]);

  const merged = useMemo(() => {
    const rows = new Map(backfill);
    if (rootId !== null) {
      for (const message of liveMessages) {
        if (message.id !== rootId && message.threadId !== rootId) continue;
        const retained = rows.get(message.id);
        rows.set(
          message.id,
          message.id === rootId && retained
            ? {
                ...retained,
                ...message,
                replyCount: Math.max(
                  retained.replyCount ?? 0,
                  message.replyCount ?? 0
                ),
              }
            : message
        );
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
      const next = mergeThreadPage(backfillRef.current, page.messages, rootId);
      backfillRef.current = next;
      setBackfill(next);
      if (page.messages.some((message) => message.id === rootId)) {
        setRootFloorRevision((revision) => revision + 1);
      }
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
    rootFloorRevision,
  };
}
