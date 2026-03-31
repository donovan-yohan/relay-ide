import type { Terminal } from '@xterm/xterm';
import type { BackendDisplayState } from './state/display-state.js';
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

interface EventMessage {
  type: string;
  sessionId?: string;
  idle?: boolean;
  state?: BackendDisplayState;
  permissionType?: 'approval' | 'question';
  branchName?: string;
  displayName?: string;
  cwd?: string;
  cwdPath?: string;
  branch?: string;
  repo?: string;
  workspacePath?: string;
  changedFiles?: string[];
  timestamp?: string;
}

type EventCallback = (msg: EventMessage) => void;

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

const PING_INTERVAL = 30_000;   // 30s heartbeat
const PONG_TIMEOUT = 5_000;     // 5s to respond
const PING_MSG = '{"type":"ping"}';
const PONG_MSG = '{"type":"pong"}';

export function connectEventSocket(onMessage: EventCallback): void {
  // Null onclose before close to prevent old socket from scheduling a reconnect
  if (eventWs) { eventWs.onclose = null; eventWs.close(); eventWs = null; }
  lastEventOnMessage = onMessage;
  clearEventPing();

  const url = wsProtocol + '//' + location.host + '/ws/events';
  eventWs = new WebSocket(url);

  eventWs.onopen = () => {
    startEventPing();
  };

  eventWs.onmessage = (event) => {
    const str = event.data as string;
    // Any message clears pong pending state
    if (eventPongPending) clearEventPongTimeout();
    // Handle pong responses silently
    if (str === PONG_MSG) return;
    try { onMessage(JSON.parse(str)); } catch { /* ignore parse errors */ }
  };

  eventWs.onclose = () => {
    clearEventPing();
    setTimeout(() => connectEventSocket(onMessage), 3000);
  };

  eventWs.onerror = () => {};
}

export function connectPtySocket(
  sessionId: string,
  term: Terminal,
  onResize: () => void,
  onSessionEnd: () => void,
): void {
  if (ptyReconnectTimer) { clearTimeout(ptyReconnectTimer); ptyReconnectTimer = null; }
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

  if (ptyWs) { ptyWs.onclose = null; ptyWs.close(); ptyWs = null; }

  const url = wsProtocol + '//' + location.host + '/ws/' + sessionId;
  const socket = new WebSocket(url);
  pendingPtySocket = socket;

  socket.onopen = () => {
    pendingPtySocket = null;
    ptyWs = socket;
    ptyReconnectAttempt = 0;
    onResize();
    startPtyPing();
  };

  socket.onmessage = (event) => {
    const str = event.data as string;
    // Any message from server clears pong pending state
    if (ptyPongPending) clearPtyPongTimeout();
    // Handle pong responses silently
    if (str === PONG_MSG) return;
    term.write(str);
  };

  socket.onclose = (event) => {
    clearPtyPing();
    // Clear pending ref if this socket closed before onopen
    if (pendingPtySocket === socket) pendingPtySocket = null;
    // If this socket was superseded, ignore its close event
    if (pendingPtySocket !== socket && ptyWs !== socket) return;
    if (event.code === 1000) {
      term.write('\r\n[Session ended]\r\n');
      ptyWs = null;
      onSessionEnd();
      return;
    }
    ptyWs = null;
    if (ptyReconnectAttempt === 0) term.write('\r\n[Reconnecting...]\r\n');
    scheduleReconnect(sessionId, term, onResize, onSessionEnd);
  };

  socket.onerror = () => {};
}

function scheduleReconnect(
  sessionId: string,
  term: Terminal,
  onResize: () => void,
  onSessionEnd: () => void,
): void {
  if (ptyReconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    term.write('\r\n[Gave up reconnecting after ' + MAX_RECONNECT_ATTEMPTS + ' attempts]\r\n');
    return;
  }
  const delay = Math.min(1000 * 2 ** ptyReconnectAttempt, 10000);
  ptyReconnectAttempt++;

  ptyReconnectTimer = setTimeout(async () => {
    ptyReconnectTimer = null;
    try {
      const res = await fetch('/sessions');
      const sessionList = await res.json() as Array<{ id: string }>;
      if (!sessionList.some(s => s.id === sessionId)) {
        term.write('\r\n[Session ended]\r\n');
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
  if (ptyPongTimeout) { clearTimeout(ptyPongTimeout); ptyPongTimeout = null; }
  ptyPongTimeout = setTimeout(() => {
    ptyPongPending = false;
    forceReconnectPty();
  }, PONG_TIMEOUT);
}

function startPtyPing(): void {
  ptyPingTimer = setInterval(sendPtyPing, PING_INTERVAL);
}

function clearPtyPing(): void {
  if (ptyPingTimer) { clearInterval(ptyPingTimer); ptyPingTimer = null; }
  clearPtyPongTimeout();
}

function clearPtyPongTimeout(): void {
  ptyPongPending = false;
  if (ptyPongTimeout) { clearTimeout(ptyPongTimeout); ptyPongTimeout = null; }
}

function forceReconnectPty(): void {
  clearPtyPing();
  if (ptyWs) { ptyWs.onclose = null; ptyWs.close(); ptyWs = null; }
  if (lastPtySessionId && lastPtyTerm && lastPtyOnResize && lastPtyOnSessionEnd) {
    if (ptyReconnectAttempt === 0) lastPtyTerm.write('\r\n[Reconnecting...]\r\n');
    scheduleReconnect(lastPtySessionId, lastPtyTerm, lastPtyOnResize, lastPtyOnSessionEnd);
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
  if (eventPongTimeout) { clearTimeout(eventPongTimeout); eventPongTimeout = null; }
  eventPongTimeout = setTimeout(() => {
    eventPongPending = false;
    forceReconnectEvent();
  }, PONG_TIMEOUT);
}

function forceReconnectEvent(): void {
  clearEventPing();
  if (eventWs) { eventWs.onclose = null; eventWs.close(); eventWs = null; }
  if (lastEventOnMessage) connectEventSocket(lastEventOnMessage);
}

function startEventPing(): void {
  eventPingTimer = setInterval(sendEventPing, PING_INTERVAL);
}

function clearEventPing(): void {
  if (eventPingTimer) { clearInterval(eventPingTimer); eventPingTimer = null; }
  clearEventPongTimeout();
}

function clearEventPongTimeout(): void {
  eventPongPending = false;
  if (eventPongTimeout) { clearTimeout(eventPongTimeout); eventPongTimeout = null; }
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
