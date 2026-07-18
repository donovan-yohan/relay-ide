import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  applyChannelEventV1,
  initialChannelReducerState,
  isChannelEventV1,
  mergeHistoryPage,
  type ChannelMessage,
  type ChannelReducerState,
} from '../../../shared/channel-chat-protocol.js';
import {
  fetchChannel,
  fetchChannelHistory,
  postChannelMessage,
  HttpError,
  type ChannelSummaryView,
} from '../lib/api.js';
import { createBrowserId } from '../lib/browserId.js';

// app close codes emitted by the channel WS hub (server/channel-hub.ts).
const CHANNEL_WS_NOT_FOUND_CLOSE_CODE = 4404;
const CHANNEL_WS_BACKPRESSURE_CLOSE_CODE = 4409;

const BACKOFF_STEPS = [1_000, 2_000, 4_000, 8_000];
const BACKOFF_CAP = 10_000;
const MAX_RECONNECT_ATTEMPTS = 30;
const HISTORY_PAGE_LIMIT = 50;

/**
 * Read-only WebSocket + REST hook for a single channel (#1166). Mirrors
 * `useAgentChatSocket`'s reconnect/unmountedRef/wsRef structure but is
 * server→client-only over the socket — posting is REST (`post()`), and the
 * channel WS hub carries no application ping/pong (it never registers an inbound
 * `message` handler), so no pong-timeout health check is used. Recovery leans on
 * the reducer's own `needsCatchup` self-diagnosis (reconnect with
 * `sinceSeq=lastSeq`) plus native close detection with exponential backoff.
 */
export interface UseChannelChatSocketState {
  channel: ChannelSummaryView | null;
  reducer: ChannelReducerState;
  connected: boolean;
  /** True after a WS `4404` close or a `fetchChannel` 404 — channel is gone. */
  notFound: boolean;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  post: (
    text: string,
    opts?: { clientMessageId?: string }
  ) => Promise<ChannelMessage>;
  postPending: boolean;
  postError: HttpError | null;
  clearPostError: () => void;
  /** Force a fresh reconnect with sinceSeq=lastSeq (manual "resync now"). */
  resync: () => void;
}

export function useChannelChatSocket(
  channelId: string | null
): UseChannelChatSocketState {
  const [reducer, setReducer] = useState<ChannelReducerState>(() =>
    initialChannelReducerState(channelId ?? '')
  );
  const [connected, setConnected] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [postPending, setPostPending] = useState(false);
  const [postError, setPostError] = useState<HttpError | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const unmountedRef = useRef(false);
  const channelIdRef = useRef(channelId);
  const cursorRef = useRef<number | null>(null);
  const reducerRef = useRef(reducer);
  const hasMoreOlderRef = useRef(false);
  const loadingOlderRef = useRef(false);

  channelIdRef.current = channelId;
  reducerRef.current = reducer;
  hasMoreOlderRef.current = hasMoreOlder;

  // A separate small fetch: the WS snapshot carries messages/members but not the
  // topic's archived/title/kind fields. React Query 404 → surfaced as notFound.
  const channelQuery = useQuery({
    queryKey: ['channel', channelId],
    queryFn: () => fetchChannel(channelId as string),
    enabled: channelId !== null,
    staleTime: 10_000,
    retry: false,
  });

  useEffect(() => {
    if (
      channelQuery.error instanceof HttpError &&
      channelQuery.error.status === 404
    ) {
      setNotFound(true);
    }
  }, [channelQuery.error]);

  // Advance the reconnect cursor once real data exists; an empty channel keeps
  // it null so a reconnect re-requests a full snapshot.
  useEffect(() => {
    if (reducer.lastSeq > 0) cursorRef.current = reducer.lastSeq;
  }, [reducer.lastSeq]);

  const connect = useCallback((cid: string) => {
    if (unmountedRef.current) return;

    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cursor = cursorRef.current;
    const query = cursor !== null ? `?sinceSeq=${cursor}` : '';
    const ws = new WebSocket(
      `${wsProtocol}//${location.host}/ws/channels/${encodeURIComponent(cid)}${query}`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmountedRef.current || wsRef.current !== ws) return;
      reconnectAttemptRef.current = 0;
      setConnected(true);
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (!isChannelEventV1(parsed)) return;
      const channelEvent = parsed;
      if (
        channelEvent.type === 'channel-snapshot-v1' &&
        channelEvent.mode === 'full'
      ) {
        // full-snapshot `truncated` === "older history exists before seq 1's
        // reach"; a catchup's `truncated` is byte-budget only, so never touch
        // older-history availability on catchup.
        hasMoreOlderRef.current = channelEvent.truncated;
        setHasMoreOlder(channelEvent.truncated);
      }
      setReducer((prev) => applyChannelEventV1(prev, channelEvent));
    };

    ws.onclose = (event) => {
      if (unmountedRef.current || wsRef.current !== ws) return;
      wsRef.current = null;
      setConnected(false);
      if (event.code === CHANNEL_WS_NOT_FOUND_CLOSE_CODE) {
        setNotFound(true);
        return; // channel gone — stop reconnecting
      }
      if (event.code === CHANNEL_WS_BACKPRESSURE_CLOSE_CODE) {
        // expected self-healing path: reconnect immediately with the current
        // lastSeq as sinceSeq, no backoff.
        reconnectAttemptRef.current = 0;
        if (channelIdRef.current) connect(channelIdRef.current);
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      // Browser WS errors are opaque; the following close handler drives recovery.
    };

    function scheduleReconnect(): void {
      if (
        !channelIdRef.current ||
        reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS
      ) {
        return;
      }
      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current += 1;
      const delay = Math.min(
        BACKOFF_STEPS[attempt] ?? BACKOFF_CAP,
        BACKOFF_CAP
      );
      reconnectTimerRef.current = setTimeout(() => {
        if (channelIdRef.current) connect(channelIdRef.current);
      }, delay);
    }
  }, []);

  const forceReconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
    reconnectAttemptRef.current = 0;
    if (channelIdRef.current) connect(channelIdRef.current);
  }, [connect]);

  // Reducer self-diagnosis: on a detected gap it sets needsCatchup; recover by
  // reconnecting with sinceSeq=lastSeq (the reducer's documented recovery path).
  useEffect(() => {
    if (reducer.needsCatchup) forceReconnect();
  }, [reducer.needsCatchup, forceReconnect]);

  useEffect(() => {
    unmountedRef.current = false;
    cursorRef.current = null;
    hasMoreOlderRef.current = false;
    loadingOlderRef.current = false;
    reconnectAttemptRef.current = 0;
    setReducer(initialChannelReducerState(channelId ?? ''));
    setConnected(false);
    setNotFound(false);
    setHasMoreOlder(false);
    setLoadingOlder(false);
    setPostError(null);

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (channelId) {
      connect(channelId);
    } else if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [channelId, connect]);

  const loadOlder = useCallback(async () => {
    const cid = channelIdRef.current;
    if (!cid || loadingOlderRef.current || !hasMoreOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const earliest = reducerRef.current.messages[0]?.seq;
      const page = await fetchChannelHistory(cid, {
        ...(earliest !== undefined ? { beforeSeq: earliest } : {}),
        limit: HISTORY_PAGE_LIMIT,
      });
      if (channelIdRef.current !== cid) return;
      setReducer((prev) => mergeHistoryPage(prev, page.messages));
      const more = page.hasMore || page.messages.length >= HISTORY_PAGE_LIMIT;
      hasMoreOlderRef.current = more;
      setHasMoreOlder(more);
    } catch {
      // Leave hasMoreOlder as-is; a later scroll retries.
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, []);

  const post = useCallback(
    async (
      text: string,
      opts?: { clientMessageId?: string }
    ): Promise<ChannelMessage> => {
      const cid = channelIdRef.current;
      if (!cid) throw new Error('no active channel');
      const clientMessageId = opts?.clientMessageId ?? createBrowserId('chm');
      setPostPending(true);
      setPostError(null);
      try {
        // No optimistic insert — the server's channel-message-created-v1
        // broadcast (received over this same open socket) is the sole source of
        // truth for the row appearing, matching the reducer's idempotent replay.
        return await postChannelMessage(cid, { text, clientMessageId });
      } catch (err) {
        if (err instanceof HttpError) setPostError(err);
        throw err;
      } finally {
        setPostPending(false);
      }
    },
    []
  );

  const clearPostError = useCallback(() => setPostError(null), []);

  return {
    channel: channelQuery.data ?? null,
    reducer,
    connected,
    notFound,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    post,
    postPending,
    postError,
    clearPostError,
    resync: forceReconnect,
  };
}
