import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatEvent } from '../../../server/chat-events.js';

const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 5_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3_000;
const PING_MSG = '{"type":"ping"}';
const PONG_MSG = '{"type":"pong"}';

export interface ChatSocketState {
  events: ChatEvent[];
  connected: boolean;
  send: (msg: Record<string, unknown>) => void;
  sendMessage: (turnId: string, content: string) => void;
  interrupt: (turnId: string) => void;
  approve: (
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ) => void;
}

export function useChatSocket(sessionId: string | null): ChatSocketState {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pongPendingRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  const unmountedRef = useRef(false);

  sessionIdRef.current = sessionId;

  const clearPing = useCallback(() => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    if (pongTimeoutRef.current) {
      clearTimeout(pongTimeoutRef.current);
      pongTimeoutRef.current = null;
    }
    pongPendingRef.current = false;
  }, []);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const sendMessage = useCallback(
    (turnId: string, content: string) => {
      send({ type: 'message', turnId, content });
    },
    [send]
  );

  const interrupt = useCallback(
    (turnId: string) => {
      send({ type: 'interrupt', turnId });
    },
    [send]
  );

  const approve = useCallback(
    (requestId: string, decision: 'allow' | 'allow-always' | 'deny') => {
      send({ type: 'approve', requestId, decision });
    },
    [send]
  );

  const connect = useCallback(
    (sid: string) => {
      if (unmountedRef.current) return;

      // Close existing socket
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      clearPing();

      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = wsProtocol + '//' + location.host + '/ws/' + sid;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmountedRef.current || wsRef.current !== ws) return;
        reconnectAttemptRef.current = 0;
        setConnected(true);

        // Start ping heartbeat
        pingTimerRef.current = setInterval(() => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
            return;
          pongPendingRef.current = true;
          try {
            wsRef.current.send(PING_MSG);
          } catch {
            return;
          }
          pongTimeoutRef.current = setTimeout(() => {
            pongPendingRef.current = false;
            // Force reconnect on pong timeout
            if (wsRef.current) {
              wsRef.current.onclose = null;
              wsRef.current.close();
              wsRef.current = null;
            }
            setConnected(false);
            if (
              sessionIdRef.current &&
              reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS
            ) {
              reconnectAttemptRef.current++;
              reconnectTimerRef.current = setTimeout(() => {
                if (sessionIdRef.current) connect(sessionIdRef.current);
              }, RECONNECT_DELAY);
            }
          }, PONG_TIMEOUT);
        }, PING_INTERVAL);
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        const str = event.data as string;
        if (pongPendingRef.current) {
          if (pongTimeoutRef.current) {
            clearTimeout(pongTimeoutRef.current);
            pongTimeoutRef.current = null;
          }
          pongPendingRef.current = false;
        }
        if (str === PONG_MSG) return;
        try {
          const parsed: unknown = JSON.parse(str);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            'type' in parsed &&
            typeof (parsed as { type: unknown }).type === 'string' &&
            (parsed as { type: string }).type.startsWith('chat:')
          ) {
            setEvents((prev) => [...prev, parsed as ChatEvent]);
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        if (unmountedRef.current) return;
        if (wsRef.current !== ws) return;
        clearPing();
        wsRef.current = null;
        setConnected(false);

        if (
          sessionIdRef.current &&
          reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS
        ) {
          reconnectAttemptRef.current++;
          reconnectTimerRef.current = setTimeout(() => {
            if (sessionIdRef.current) connect(sessionIdRef.current);
          }, RECONNECT_DELAY);
        }
      };

      ws.onerror = () => {};
    },
    [clearPing]
  );

  useEffect(() => {
    unmountedRef.current = false;
    setEvents([]);
    setConnected(false);

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;

    if (sessionId) {
      connect(sessionId);
    } else {
      // Close existing socket when sessionId is null
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      clearPing();
    }

    return () => {
      unmountedRef.current = true;
      clearPing();
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
  }, [sessionId, connect, clearPing]);

  return { events, connected, send, sendMessage, interrupt, approve };
}
