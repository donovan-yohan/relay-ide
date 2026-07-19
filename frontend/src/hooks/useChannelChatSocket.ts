import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  applyChannelEventV1,
  initialChannelReducerState,
  isChannelEventV1,
  mergeHistoryPage,
  type ChannelMessage,
  type ChannelMessagePart,
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
import { useChannelActivityStore } from '../lib/stores/channel-activity.js';

// app close codes emitted by the channel WS hub (server/channel-hub.ts).
const CHANNEL_WS_NOT_FOUND_CLOSE_CODE = 4404;
const CHANNEL_WS_BACKPRESSURE_CLOSE_CODE = 4409;

const BACKOFF_STEPS = [1_000, 2_000, 4_000, 8_000];
const BACKOFF_CAP = 10_000;
const MAX_RECONNECT_ATTEMPTS = 30;
const HISTORY_PAGE_LIMIT = 50;
// Liveness (#1178): the channel socket is push-only with no app ping/pong, so a
// half-open socket (NAT/proxy idle drop, tab sleep/wake, wifi→cellular) reports
// OPEN forever while silently missing messages. Detect it without a server
// change: a background probe runs every INTERVAL while the tab is visible and,
// once the socket has been silent for THRESHOLD, does a cheap REST head-check
// (`fetchChannel().latestSeq`) — a divergence forces a fresh reconnect. Tab
// wake / network-online events probe immediately regardless of the threshold.
const LIVENESS_PROBE_INTERVAL_MS = 30_000;
const LIVENESS_IDLE_THRESHOLD_MS = 120_000;

/**
 * Read-only WebSocket + REST hook for a single channel (#1166). Mirrors
 * `useAgentChatSocket`'s reconnect/unmountedRef/wsRef structure but is
 * server→client-only over the socket — posting is REST (`post()`), and the
 * channel WS hub carries no application ping/pong (it never registers an inbound
 * `message` handler), so no pong-timeout health check is used. Recovery leans on
 * the reducer's own `needsCatchup` self-diagnosis (reconnect with
 * `sinceSeq=lastSeq`), native close detection with exponential backoff, and a
 * visibility/online + idle REST head-check liveness probe (#1178) that catches
 * half-dead sockets the socket layer never reports as closed.
 */
export interface UseChannelChatSocketState {
  channel: ChannelSummaryView | null;
  reducer: ChannelReducerState;
  connected: boolean;
  /**
   * True once reconnect backoff has exhausted its attempt budget (server outage
   * longer than the backoff window). The UI surfaces a manual reconnect
   * affordance in this state — it is NOT the same as "reconnecting" (#1178).
   */
  disconnected: boolean;
  /** True after a WS `4404` close or a `fetchChannel` 404 — channel is gone. */
  notFound: boolean;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  /** Increments whenever an authoritative full snapshot replaces the window. */
  fullSnapshotRevision: number;
  post: (
    text: string,
    opts?: {
      clientMessageId?: string;
      threadId?: string;
      parts?: ChannelMessagePart[];
    }
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
  const [disconnected, setDisconnected] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [fullSnapshotRevision, setFullSnapshotRevision] = useState(0);
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
  // Timestamp of the last inbound socket activity (open or message). The
  // liveness probe treats a socket silent past LIVENESS_IDLE_THRESHOLD_MS as
  // suspect and REST-verifies it (#1178).
  const lastActivityRef = useRef(0);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

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

  const connect = useCallback(
    (cid: string) => {
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
        lastActivityRef.current = Date.now();
        setConnected(true);
        setDisconnected(false);
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        lastActivityRef.current = Date.now();
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
          setFullSnapshotRevision((revision) => revision + 1);
          // full-snapshot `truncated` === "older history exists before seq 1's
          // reach"; a catchup's `truncated` is byte-budget only, so never touch
          // older-history availability on catchup.
          hasMoreOlderRef.current = channelEvent.truncated;
          setHasMoreOlder(channelEvent.truncated);
          // Stale-ahead reset (#1178): a full snapshot is authoritative for the
          // head. If the channel was recreated under the same deterministic DM id
          // and its seq restarted low, clamp the client seq stores DOWN so the
          // sidebar's activity guard and last-read marker don't suppress the
          // unread dot for the new channel's whole first lifetime.
          useChannelActivityStore
            .getState()
            .clampChannelStores(cid, channelEvent.latestSeq);
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
        if (!channelIdRef.current) return;
        if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
          // Give-up state (#1178): stop the backoff and surface a manual reconnect
          // affordance. `connected` is already false; `disconnected` distinguishes
          // "gave up" from "still retrying" so the UI stops claiming reconnecting.
          setDisconnected(true);
          return;
        }
        const attempt = reconnectAttemptRef.current;
        reconnectAttemptRef.current += 1;
        const delay = Math.min(
          BACKOFF_STEPS[attempt] ?? BACKOFF_CAP,
          BACKOFF_CAP
        );
        // Clear any prior pending timer before overwriting the ref so a stale
        // timer can never fire against a newer socket (#1178).
        clearReconnectTimer();
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (channelIdRef.current) connect(channelIdRef.current);
        }, delay);
      }
    },
    [clearReconnectTimer]
  );

  const forceReconnect = useCallback(() => {
    // Cancel any pending backoff timer first — otherwise it fires later and
    // tears down the socket we are about to (re)open (#1178).
    clearReconnectTimer();
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
    setDisconnected(false);
    reconnectAttemptRef.current = 0;
    if (channelIdRef.current) connect(channelIdRef.current);
  }, [clearReconnectTimer, connect]);

  // Reducer self-diagnosis: on a detected gap it sets needsCatchup; recover by
  // reconnecting with sinceSeq=lastSeq (the reducer's documented recovery path).
  useEffect(() => {
    if (reducer.needsCatchup) forceReconnect();
  }, [reducer.needsCatchup, forceReconnect]);

  // Liveness probe (#1178): detect half-dead sockets the socket layer never
  // reports as closed. `force` (tab wake / network online) probes immediately;
  // the background interval only probes an OPEN socket that has gone quiet past
  // the idle threshold. A REST head-check whose `latestSeq` outruns what we hold
  // proves the socket silently dropped messages → force a fresh reconnect.
  useEffect(() => {
    if (!channelId) return;

    const probe = async (force: boolean): Promise<void> => {
      const cid = channelIdRef.current;
      if (!cid || unmountedRef.current) return;
      const ws = wsRef.current;
      const open = ws?.readyState === WebSocket.OPEN;
      if (!open) {
        // Socket not established. A forced signal (user returned / network back)
        // short-circuits any pending backoff and reconnects now; the background
        // interval leaves an in-progress backoff (or given-up state) alone.
        if (force) forceReconnect();
        return;
      }
      if (
        !force &&
        Date.now() - lastActivityRef.current < LIVENESS_IDLE_THRESHOLD_MS
      ) {
        return;
      }
      try {
        const summary = await fetchChannel(cid);
        if (channelIdRef.current !== cid || unmountedRef.current) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        const known = cursorRef.current ?? reducerRef.current.lastSeq;
        if (summary.latestSeq > known) {
          forceReconnect();
        } else {
          // Confirmed healthy — reset the idle clock so we don't re-probe on
          // every interval tick while the channel is simply quiet.
          lastActivityRef.current = Date.now();
        }
      } catch {
        // head-check failed (offline/transient); the next tick retries.
      }
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void probe(true);
    };
    const onOnline = (): void => void probe(true);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void probe(false);
    }, LIVENESS_PROBE_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      clearInterval(interval);
    };
  }, [channelId, forceReconnect]);

  useEffect(() => {
    unmountedRef.current = false;
    cursorRef.current = null;
    hasMoreOlderRef.current = false;
    loadingOlderRef.current = false;
    reconnectAttemptRef.current = 0;
    lastActivityRef.current = 0;
    setReducer(initialChannelReducerState(channelId ?? ''));
    setConnected(false);
    setDisconnected(false);
    setNotFound(false);
    setHasMoreOlder(false);
    setLoadingOlder(false);
    setFullSnapshotRevision(0);
    setPostError(null);

    clearReconnectTimer();

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
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [channelId, connect, clearReconnectTimer]);

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
      opts?: {
        clientMessageId?: string;
        threadId?: string;
        parts?: ChannelMessagePart[];
      }
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
        return await postChannelMessage(cid, {
          text,
          clientMessageId,
          ...(opts?.parts !== undefined ? { parts: opts.parts } : {}),
          ...(opts?.threadId !== undefined ? { threadId: opts.threadId } : {}),
        });
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
    disconnected,
    notFound,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    fullSnapshotRevision,
    post,
    postPending,
    postError,
    clearPostError,
    resync: forceReconnect,
  };
}
