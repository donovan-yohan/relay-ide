import { useState, useEffect, useRef, useCallback } from 'react';
import {
  applyAgentPatchV2,
  type AgentApprovalDecisionV2,
  type AgentPatchV2,
  type AgentSessionV2,
} from '../../../shared/agent-chat-protocol-v2.js';

const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 5_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3_000;
const PING_MSG = '{"type":"ping"}';
const PONG_MSG = '{"type":"pong"}';

export interface AgentChatSocketState {
  session: AgentSessionV2 | null;
  connected: boolean;
  send: (msg: Record<string, unknown>) => boolean;
  sendMessage: (turnId: string, content: string) => void;
  interrupt: (turnId?: string) => void;
  approve: (requestId: string, decision: AgentApprovalDecisionV2) => void;
  answer: (requestId: string, answers: Record<string, string[]>) => void;
  /**
   * Request the server to resume a prior provider session.
   * Only valid when `session.capabilities.resume === true` and a
   * `providerSession` id is available. Optionally pass an explicit
   * `providerSessionId`; if omitted the server uses its stored value.
   */
  resume: (providerSessionId?: string) => void;
  /**
   * Append a synthetic client-source error to the timeline. Used by the
   * composer for leading-trigger validation and client-dispatch failures
   * — keeps all error UX inside the chat window, never as toast/banner.
   */
  pushClientError: (message: string, context?: string) => void;
}

export function useAgentChatSocket(
  sessionId: string | null
): AgentChatSocketState {
  const [session, setSession] = useState<AgentSessionV2 | null>(null);
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

  const send = useCallback((msg: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // eslint-disable-next-line no-console -- intentional: surface silent send failures in devtools
      console.warn('[useAgentChatSocket] send dropped', msg.type);
      return false;
    }
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  const sendMessage = useCallback(
    (turnId: string, content: string) => {
      send({ type: 'agent-send-message-v2', turnId, content });
    },
    [send]
  );

  const interrupt = useCallback(
    (turnId?: string) => {
      send({ type: 'agent-interrupt-v2', ...(turnId ? { turnId } : {}) });
    },
    [send]
  );

  const approve = useCallback(
    (requestId: string, decision: AgentApprovalDecisionV2) => {
      send({ type: 'agent-approve-v2', requestId, decision });
    },
    [send]
  );

  const answer = useCallback(
    (requestId: string, answers: Record<string, string[]>) => {
      send({ type: 'agent-answer-v2', requestId, answers });
    },
    [send]
  );

  const resume = useCallback(
    (providerSessionId?: string) => {
      send({
        type: 'agent-resume-v2',
        ...(providerSessionId !== undefined ? { providerSessionId } : {}),
      });
    },
    [send]
  );

  const connect = useCallback(
    (sid: string) => {
      if (unmountedRef.current) return;

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
      const ws = new WebSocket(`${wsProtocol}//${location.host}/ws/${sid}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmountedRef.current || wsRef.current !== ws) return;
        reconnectAttemptRef.current = 0;
        setConnected(true);

        pingTimerRef.current = setInterval(() => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            return;
          }
          pongPendingRef.current = true;
          try {
            wsRef.current.send(PING_MSG);
          } catch (err) {
            // eslint-disable-next-line no-console -- intentional: surface socket health failures in devtools
            console.error('[useAgentChatSocket] ping failed', err);
            forceReconnect();
            return;
          }
          pongTimeoutRef.current = setTimeout(() => {
            pongPendingRef.current = false;
            forceReconnect();
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
          if (isAgentPatchMessage(parsed)) {
            setSession((current) => {
              if (parsed.type === 'agent-session-snapshot-v2') {
                return parsed.session;
              }
              return current ? applyAgentPatchV2(current, parsed) : current;
            });
          }
        } catch (err) {
          // eslint-disable-next-line no-console -- intentional: malformed WS frames should be visible while debugging
          console.warn(
            '[useAgentChatSocket] failed to parse WebSocket message',
            str.slice(0, 200),
            err
          );
        }
      };

      ws.onclose = () => {
        if (unmountedRef.current || wsRef.current !== ws) return;
        clearPing();
        wsRef.current = null;
        setConnected(false);
        scheduleReconnect();
      };

      ws.onerror = (event) => {
        // eslint-disable-next-line no-console -- intentional: browser WebSocket errors are otherwise opaque
        console.error('[useAgentChatSocket] WebSocket error', sid, event);
      };

      function forceReconnect(): void {
        clearPing();
        if (wsRef.current) {
          wsRef.current.onclose = null;
          wsRef.current.close();
          wsRef.current = null;
        }
        setConnected(false);
        scheduleReconnect();
      }

      function scheduleReconnect(): void {
        if (
          sessionIdRef.current &&
          reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS
        ) {
          reconnectAttemptRef.current++;
          reconnectTimerRef.current = setTimeout(() => {
            if (sessionIdRef.current) connect(sessionIdRef.current);
          }, RECONNECT_DELAY);
        }
      }
    },
    [clearPing]
  );

  useEffect(() => {
    unmountedRef.current = false;
    setSession(null);
    setConnected(false);

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;

    if (sessionId) {
      connect(sessionId);
    } else if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
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
  }, [clearPing, connect, sessionId]);

  const pushClientError = useCallback(
    (message: string, context?: string) => {
      setSession((current) => {
        if (!current) return current;
        const timestamp = new Date().toISOString();
        const errorItem = {
          type: 'errorMessage' as const,
          id: `error-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
          message,
          source: 'client' as const,
          status: 'completed' as const,
          startedAt: timestamp,
          completedAt: timestamp,
          ...(context !== undefined ? { context } : {}),
        };
        const lastTurn = current.turns[current.turns.length - 1];
        if (!lastTurn) {
          return {
            ...current,
            turns: [
              {
                id: `synthetic-${timestamp}`,
                status: 'failed' as const,
                startedAt: timestamp,
                completedAt: timestamp,
                items: [errorItem],
                inputMessageId: '',
              },
            ],
          };
        }
        return {
          ...current,
          turns: current.turns.map((turn, idx) =>
            idx === current.turns.length - 1
              ? { ...turn, items: [...turn.items, errorItem] }
              : turn
          ),
        };
      });
    },
    []
  );

  return {
    session,
    connected,
    send,
    sendMessage,
    interrupt,
    approve,
    answer,
    resume,
    pushClientError,
  };
}

function isAgentPatchMessage(value: unknown): value is AgentPatchV2 {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('agent-') &&
    (value as { type: string }).type.endsWith('-v2')
  );
}
