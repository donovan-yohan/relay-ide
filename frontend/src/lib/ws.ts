import type { Terminal } from '@xterm/xterm';
import type { BackendDisplayState } from './state/display-state.js';
import type {
  AccountTelemetry,
  CurrentActivity,
  SessionTelemetry,
} from './types.js';
import { createLogger } from './logger.js';
import { useSessionsStore } from './stores/sessions.js';

const logger = createLogger('pty-ws');
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

// Discriminated union for WebSocket event messages.
// Each event type declares only its required fields.
export type EventMessage =
  | { type: 'worktrees-changed' }
  | {
      type: 'session-backend-state-changed';
      sessionId: string;
      state: BackendDisplayState;
      permissionType?: 'approval' | 'question';
    }
  | {
      type: 'session-renamed';
      sessionId: string;
      branchName: string;
      displayName: string;
    }
  | {
      type: 'session-branch-changed';
      sessionId: string;
      branch: string;
      cwdPath?: string;
    }
  | {
      type: 'session-ended';
      sessionId?: string;
      cwd?: string;
      branchName?: string;
    }
  | { type: 'ref-changed'; cwdPath: string; branch?: string; repo?: string }
  | {
      type: 'pr-updated';
      repo?: string;
      number?: number;
      action?: string;
      state?: string;
      merged?: boolean;
      repos?: string[];
      workspacePaths?: string[];
    }
  | {
      type: 'ci-updated';
      repo?: string;
      repos?: string[];
      workspacePaths?: string[];
    }
  | { type: 'files-changed'; workspacePath: string; changedFiles?: string[] }
  | {
      type: 'session-activity-changed';
      sessionId: string;
      timestamp?: string;
      currentActivity?: CurrentActivity | null;
    }
  | {
      type: 'session-telemetry';
      sessionId: string;
      data: SessionTelemetry | Record<string, unknown>;
    }
  | {
      type: 'account-telemetry';
      data: AccountTelemetry | Record<string, unknown> | null;
    }
  | { type: 'browser-tab-opened'; filePath: string; token: string }
  | { type: 'browser-tab-refreshed'; filePath: string }
  | { type: 'server-restarting' };

type EventCallback = (msg: EventMessage) => void;
type EventOpenCallback = () => void;

let eventWs: WebSocket | null = null;
let ptyWs: WebSocket | null = null;
let pendingPtySocket: WebSocket | null = null;
const MAX_RECONNECT_ATTEMPTS = 30;

let ptyReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let ptyReconnectAttempt = 0;

// Ping/pong state for zombie WebSocket detection
let ptyPingTimer: ReturnType<typeof setInterval> | null = null;
let ptyPongPending = false;
let ptyPongTimeout: ReturnType<typeof setTimeout> | null = null;
let eventPingTimer: ReturnType<typeof setInterval> | null = null;
let eventPongPending = false;
let eventPongTimeout: ReturnType<typeof setTimeout> | null = null;

// Track last-known connection params for visibilitychange reconnection
let lastPtySessionId: string | null = null;
let lastPtyTerm: Terminal | null = null;
let lastPtyOnResize: (() => void) | null = null;
let lastPtyOnSessionEnd: (() => void) | null = null;
let lastEventOnMessage: EventCallback | null = null;
let lastEventOnOpen: EventOpenCallback | null = null;
let lastOnAuthRequired: (() => void) | null = null;

const PING_INTERVAL = 30_000; // 30s heartbeat
const PONG_TIMEOUT = 5_000; // 5s to respond
const PING_MSG = '{"type":"ping"}';
const PONG_MSG = '{"type":"pong"}';

export function connectEventSocket(
  onMessage: EventCallback,
  onOpen?: EventOpenCallback,
  onAuthRequired?: () => void
): void {
  // Null onclose before close to prevent old socket from scheduling a reconnect
  if (eventWs) {
    eventWs.onclose = null;
    eventWs.close();
    eventWs = null;
  }
  lastEventOnMessage = onMessage;
  lastEventOnOpen = onOpen ?? null;
  lastOnAuthRequired = onAuthRequired ?? lastOnAuthRequired;
  clearEventPing();

  const url = wsProtocol + '//' + location.host + '/ws/events';
  eventWs = new WebSocket(url);

  eventWs.onopen = () => {
    startEventPing();
    onOpen?.();
  };

  eventWs.onmessage = (event) => {
    const str = event.data as string;
    // Any message clears pong pending state
    if (eventPongPending) clearEventPongTimeout();
    // Handle pong responses silently
    if (str === PONG_MSG) return;
    try {
      onMessage(JSON.parse(str));
    } catch {
      /* ignore parse errors */
    }
  };

  eventWs.onclose = () => {
    clearEventPing();
    setTimeout(() => void reconnectWithAuthCheck(), 3000);
  };

  eventWs.onerror = () => {};
}

async function reconnectWithAuthCheck(): Promise<void> {
  try {
    const res = await fetch('/auth/check');
    if (res.status === 401) {
      lastOnAuthRequired?.();
      return;
    }
  } catch {
    // Server unreachable — keep trying to reconnect
  }
  if (lastEventOnMessage) {
    connectEventSocket(lastEventOnMessage, lastEventOnOpen ?? undefined);
  }
}

export function connectPtySocket(
  sessionId: string,
  term: Terminal,
  onResize: () => void,
  onSessionEnd: () => void
): void {
  if (ptyReconnectTimer) {
    clearTimeout(ptyReconnectTimer);
    ptyReconnectTimer = null;
  }
  ptyReconnectAttempt = 0;
  clearPtyPing();

  // Store connection params for visibilitychange reconnection
  lastPtySessionId = sessionId;
  lastPtyTerm = term;
  lastPtyOnResize = onResize;
  lastPtyOnSessionEnd = onSessionEnd;

  // Close any socket still in CONNECTING state from a previous call
  if (pendingPtySocket) {
    pendingPtySocket.onopen = null;
    pendingPtySocket.onmessage = null;
    pendingPtySocket.onclose = null;
    pendingPtySocket.onerror = null;
    pendingPtySocket.close();
    pendingPtySocket = null;
  }

  if (ptyWs) {
    ptyWs.onclose = null;
    ptyWs.close();
    ptyWs = null;
  }

  const url = wsProtocol + '//' + location.host + '/ws/' + sessionId;
  const socket = new WebSocket(url);
  pendingPtySocket = socket;

  socket.onopen = () => {
    pendingPtySocket = null;
    ptyWs = socket;
    ptyReconnectAttempt = 0;
    onResize();
    startPtyPing();
    useSessionsStore.getState().clearPtyReconnect(sessionId);
  };

  // Flow control constants (thresholds measured in string length / UTF-16 code units,
  // which is close enough to bytes for mostly-ASCII terminal output)
  const HIGH_WATER_MARK = 512 * 1024; // ~500KB — pause feeding xterm
  const LOW_WATER_MARK = 128 * 1024; //  ~128KB — resume feeding xterm
  const MAX_QUEUE_SIZE = 2 * 1024 * 1024; // ~2MB — cap queued data to prevent OOM
  const BG_FLUSH_INTERVAL = 250; // ms — fallback flush interval when tab is hidden

  // Per-connection write buffer state (scoped here; abandoned on next connectPtySocket call)
  let writeQueue: string[] = [];
  let queueSize = 0; // total string length queued but not yet handed to term.write
  let pendingSize = 0; // string length handed to term.write but not yet processed
  let paused = false;
  let rafHandle: number | null = null;
  let bgTimer: ReturnType<typeof setTimeout> | null = null;

  function flushWriteQueue(): void {
    rafHandle = null;
    bgTimer = null;
    if (writeQueue.length === 0) return;

    // Coalesce all queued chunks into a single term.write call per frame
    const combined = writeQueue.join('');
    const combinedLen = combined.length;
    writeQueue = [];
    queueSize = 0;

    pendingSize += combinedLen;
    term.write(combined, () => {
      pendingSize -= combinedLen;
      // Resume if we were paused and the buffer has drained below the low-water mark
      if (paused && pendingSize < LOW_WATER_MARK) {
        paused = false;
        logger.info(
          'flow-control: LOW water mark reached, resuming (pending=%d, queued=%d)',
          pendingSize,
          writeQueue.length
        );
        scheduleFlush();
      }
    });

    // Check pressure after handing off the coalesced write
    if (pendingSize >= HIGH_WATER_MARK) {
      paused = true;
      logger.warn(
        'flow-control: HIGH water mark hit, pausing (pending=%d)',
        pendingSize
      );
    }
  }

  function scheduleFlush(): void {
    if (rafHandle !== null || bgTimer !== null) return;
    // RAF is throttled/paused in background tabs — use setTimeout fallback
    if (document.hidden) {
      bgTimer = setTimeout(flushWriteQueue, BG_FLUSH_INTERVAL);
    } else {
      rafHandle = requestAnimationFrame(flushWriteQueue);
    }
  }

  socket.onmessage = (event) => {
    const str = event.data as string;
    // Any message from server clears pong pending state
    if (ptyPongPending) clearPtyPongTimeout();
    // Handle pong responses silently
    if (str === PONG_MSG) return;

    // Cap queue size to prevent unbounded memory growth
    if (queueSize + str.length > MAX_QUEUE_SIZE) {
      if (!paused) {
        logger.warn(
          'flow-control: queue cap reached (%d), dropping data',
          queueSize
        );
      }
      return;
    }

    writeQueue.push(str);
    queueSize += str.length;
    if (paused) {
      logger.debug(
        'flow-control: queued %d chars while paused (pending=%d, queue=%d)',
        str.length,
        pendingSize,
        writeQueue.length
      );
    }
    if (!paused) scheduleFlush();
  };

  socket.onclose = (event) => {
    clearPtyPing();
    // Cancel any pending flush for this socket
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (bgTimer !== null) {
      clearTimeout(bgTimer);
      bgTimer = null;
    }
    // Clear pending ref if this socket closed before onopen
    if (pendingPtySocket === socket) pendingPtySocket = null;
    // If this socket was superseded, ignore its close event
    if (pendingPtySocket !== socket && ptyWs !== socket) return;
    if (event.code === 1000) {
      term.write('\r\n[Session ended]\r\n');
      ptyWs = null;
      useSessionsStore.getState().clearPtyReconnect(sessionId);
      onSessionEnd();
      return;
    }
    ptyWs = null;
    useSessionsStore.getState().beginPtyReconnect(sessionId);
    if (ptyReconnectAttempt === 0) term.write('\r\n[Reconnecting...]\r\n');
    scheduleReconnect(sessionId, term, onResize, onSessionEnd);
  };

  socket.onerror = () => {};
}

function scheduleReconnect(
  sessionId: string,
  term: Terminal,
  onResize: () => void,
  onSessionEnd: () => void
): void {
  if (ptyReconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    term.write(
      '\r\n[Gave up reconnecting after ' +
        MAX_RECONNECT_ATTEMPTS +
        ' attempts]\r\n'
    );
    useSessionsStore.getState().clearPtyReconnect(sessionId);
    return;
  }
  const delay = Math.min(1000 * 2 ** ptyReconnectAttempt, 10000);
  ptyReconnectAttempt++;

  ptyReconnectTimer = setTimeout(async () => {
    ptyReconnectTimer = null;
    try {
      const authRes = await fetch('/auth/check');
      if (authRes.status === 401) {
        useSessionsStore.getState().clearPtyReconnect(sessionId);
        lastOnAuthRequired?.();
        return;
      }
      const res = await fetch('/sessions');
      const sessionList = (await res.json()) as Array<{ id: string }>;
      if (!sessionList.some((s) => s.id === sessionId)) {
        term.write('\r\n[Session ended]\r\n');
        useSessionsStore.getState().clearPtyReconnect(sessionId);
        onSessionEnd();
        return;
      }
      term.clear();
      connectPtySocket(sessionId, term, onResize, onSessionEnd);
    } catch {
      scheduleReconnect(sessionId, term, onResize, onSessionEnd);
    }
  }, delay);
}

// ── Ping/pong heartbeat ──────────────────────────────────────────────────────

// Send a ping to the PTY socket and schedule a reconnect if no pong arrives.
function sendPtyPing(): void {
  if (!ptyWs || ptyWs.readyState !== WebSocket.OPEN) return;
  ptyPongPending = true;
  try {
    ptyWs.send(PING_MSG);
  } catch {
    forceReconnectPty();
    return;
  }
  if (ptyPongTimeout) {
    clearTimeout(ptyPongTimeout);
    ptyPongTimeout = null;
  }
  ptyPongTimeout = setTimeout(() => {
    ptyPongPending = false;
    forceReconnectPty();
  }, PONG_TIMEOUT);
}

function startPtyPing(): void {
  ptyPingTimer = setInterval(sendPtyPing, PING_INTERVAL);
}

function clearPtyPing(): void {
  if (ptyPingTimer) {
    clearInterval(ptyPingTimer);
    ptyPingTimer = null;
  }
  clearPtyPongTimeout();
}

function clearPtyPongTimeout(): void {
  ptyPongPending = false;
  if (ptyPongTimeout) {
    clearTimeout(ptyPongTimeout);
    ptyPongTimeout = null;
  }
}

function forceReconnectPty(): void {
  clearPtyPing();
  if (ptyWs) {
    ptyWs.onclose = null;
    ptyWs.close();
    ptyWs = null;
  }
  if (
    lastPtySessionId &&
    lastPtyTerm &&
    lastPtyOnResize &&
    lastPtyOnSessionEnd
  ) {
    useSessionsStore.getState().beginPtyReconnect(lastPtySessionId);
    if (ptyReconnectAttempt === 0)
      lastPtyTerm.write('\r\n[Reconnecting...]\r\n');
    scheduleReconnect(
      lastPtySessionId,
      lastPtyTerm,
      lastPtyOnResize,
      lastPtyOnSessionEnd
    );
  }
}

// Send a ping to the event socket and schedule a reconnect if no pong arrives.
function sendEventPing(): void {
  if (!eventWs || eventWs.readyState !== WebSocket.OPEN) return;
  eventPongPending = true;
  try {
    eventWs.send(PING_MSG);
  } catch {
    forceReconnectEvent();
    return;
  }
  if (eventPongTimeout) {
    clearTimeout(eventPongTimeout);
    eventPongTimeout = null;
  }
  eventPongTimeout = setTimeout(() => {
    eventPongPending = false;
    forceReconnectEvent();
  }, PONG_TIMEOUT);
}

function forceReconnectEvent(): void {
  clearEventPing();
  if (eventWs) {
    eventWs.onclose = null;
    eventWs.close();
    eventWs = null;
  }
  setTimeout(() => void reconnectWithAuthCheck(), 1000);
}

function startEventPing(): void {
  eventPingTimer = setInterval(sendEventPing, PING_INTERVAL);
}

function clearEventPing(): void {
  if (eventPingTimer) {
    clearInterval(eventPingTimer);
    eventPingTimer = null;
  }
  clearEventPongTimeout();
}

function clearEventPongTimeout(): void {
  eventPongPending = false;
  if (eventPongTimeout) {
    clearTimeout(eventPongTimeout);
    eventPongTimeout = null;
  }
}

// ── Visibility change — proactive reconnection on mobile wake ────────────────

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;

  // PTY socket: if dead, force reconnect; if alive, probe with a ping
  if (ptyWs && ptyWs.readyState !== WebSocket.OPEN) {
    forceReconnectPty();
  } else if (ptyWs) {
    sendPtyPing();
  }

  // Event socket: if dead, force reconnect; if alive, probe with a ping
  if (eventWs && eventWs.readyState !== WebSocket.OPEN) {
    forceReconnectEvent();
  } else if (eventWs) {
    sendEventPing();
  }
});

// ── Public API ───────────────────────────────────────────────────────────────

export function sendPtyData(data: string): void {
  if (ptyWs && ptyWs.readyState === WebSocket.OPEN) ptyWs.send(data);
}

export function sendPtyResize(cols: number, rows: number): void {
  if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
    ptyWs.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
}

export function isPtyConnected(): boolean {
  return ptyWs !== null && ptyWs.readyState === WebSocket.OPEN;
}
