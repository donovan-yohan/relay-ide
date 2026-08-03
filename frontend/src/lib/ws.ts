import type { Terminal } from '@xterm/xterm';
import type { BackendDisplayState } from './state/display-state.js';
import type {
  AccountTelemetry,
  CurrentActivity,
  SessionTelemetry,
} from './types.js';
import type {
  EnvironmentAuthority,
  EnvironmentId,
  NodeScopedFileEvent,
  NodeScopedSessionEvent,
} from '../../../shared/node-boundary.js';
import type { NodeId } from '../../../shared/identity.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
  parseGlobalSessionId,
} from '../../../shared/identity.js';
import { createLogger } from './logger.js';
import { resolveSessionByKey, resolveSessionKey } from './session-keys.js';
import { useSessionsStore } from './stores/sessions.js';
import { useUiStore } from './stores/ui.js';
import type { TabControlEvent } from '../../../shared/control-state.js';
import type { HubNodeStatus } from '../../../shared/relay-node-protocol.js';
import type { SessionDurabilityState } from '../../../shared/session-durability.js';
import type { NodeManifest } from '../../../shared/node-manifest.js';
import {
  isTerminalStreamEnvelope,
  type TerminalStreamEnvelope,
  type TerminalStreamResizeOwner,
} from '../../../shared/session-replay.js';

const logger = createLogger('pty-ws');
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

// Discriminated union for WebSocket event messages.
// Each event type declares only its required fields.
type NodeScopedEvent = Partial<{
  nodeId: NodeId;
  environmentId: EnvironmentId;
  authority: EnvironmentAuthority;
}>;
type SessionScopedEvent = NodeScopedEvent & Partial<NodeScopedSessionEvent>;
type FileScopedEvent = NodeScopedEvent & Partial<NodeScopedFileEvent>;

export type EventMessage =
  | ({ type: 'worktrees-changed' } & NodeScopedEvent)
  | ({
      type: 'session-backend-state-changed';
      sessionId: string;
      state: BackendDisplayState;
      permissionType?: 'approval' | 'question';
    } & SessionScopedEvent)
  | ({
      type: 'session-renamed';
      sessionId: string;
      branchName: string;
      displayName: string;
    } & SessionScopedEvent)
  | ({
      type: 'session-branch-changed';
      sessionId: string;
      branch: string;
      cwdPath?: string;
    } & SessionScopedEvent)
  | ({
      type: 'session-created';
      sessionId: string;
      cwd?: string;
      branchName?: string;
    } & SessionScopedEvent)
  | ({
      type: 'session-ended';
      sessionId?: string;
      cwd?: string;
      branchName?: string;
    } & SessionScopedEvent)
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
  | ({
      type: 'files-changed';
      workspacePath: string;
      changedFiles?: string[];
    } & FileScopedEvent)
  | ({
      type: 'session-activity-changed';
      sessionId: string;
      timestamp?: string;
      currentActivity?: CurrentActivity | null;
    } & SessionScopedEvent)
  | ({
      type: 'session-telemetry';
      sessionId: string;
      data: SessionTelemetry | Record<string, unknown>;
    } & SessionScopedEvent)
  | { type: 'tab-control-event'; event: TabControlEvent }
  | {
      type: 'account-telemetry';
      data: AccountTelemetry | Record<string, unknown> | null;
    }
  | { type: 'browser-tab-opened'; filePath: string; token: string }
  | { type: 'browser-tab-refreshed'; filePath: string }
  | {
      type: 'node.status';
      nodeId: string;
      status: HubNodeStatus;
      lastSeenAt: string;
      manifest?: NodeManifest;
    }
  | { type: 'server-restarting'; reason?: string }
  | { type: 'channel-activity'; channelId: string; latestSeq: number }
  /**
   * The operator moved their last-read mark on ANOTHER device (#1308 slice 3).
   * Single-operator device sync, never a read receipt: there is no reader
   * identity because there is only one reader. The lane is unfiltered, so the
   * writing device also receives its own echo — applying it is monotonic and
   * idempotent, so that costs nothing.
   */
  | { type: 'channel-read-state'; channelId: string; lastReadSeq: number }
  | {
      type: 'channel-agent-status';
      channelId: string;
      agentId: string;
      status: 'spawning' | 'thinking' | 'streaming' | 'waiting' | 'idle';
      runtimeId: string | null;
      /**
       * Posts waiting to trigger this agent's NEXT turn (#1308 slice 4).
       * Optional so a hub that predates the field is still readable; treat an
       * absent value as zero.
       */
      queuedCount?: number;
    }
  | ({
      type: 'session-durability-changed';
      sessionId: string;
      from: SessionDurabilityState | undefined;
      to: SessionDurabilityState;
      at: string;
    } & SessionScopedEvent);

type EventCallback = (msg: EventMessage) => void;
type EventOpenCallback = () => void;
export type EventConnectionStatus = 'connected' | 'reconnecting';
type EventConnectionStatusCallback = (status: EventConnectionStatus) => void;

const MAX_RECONNECT_ATTEMPTS = 30;
const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 5_000;
const PING_MSG = '{"type":"ping"}';
const PONG_MSG = '{"type":"pong"}';

// Flow control constants (string length / UTF-16 code units, ≈ bytes for mostly-ASCII)
const HIGH_WATER_MARK = 512 * 1024;
const LOW_WATER_MARK = 128 * 1024;
const MAX_QUEUE_SIZE = 2 * 1024 * 1024;
const BG_FLUSH_INTERVAL = 250;
const SERVER_RESTART_CLEAN_CLOSE_RECONNECT_WINDOW_MS = 30_000;

// ── Event socket (singleton; not per-session) ────────────────────────────────

let eventWs: WebSocket | null = null;
let eventPingTimer: ReturnType<typeof setInterval> | null = null;
let eventPongPending = false;
let eventPongTimeout: ReturnType<typeof setTimeout> | null = null;

let lastEventOnMessage: EventCallback | null = null;
let lastEventOnOpen: EventOpenCallback | null = null;
let lastOnAuthRequired: (() => void) | null = null;
let lastEventOnStatus: EventConnectionStatusCallback | null = null;
let serverRestartAuthGraceUntil = 0;

export function connectEventSocket(
  onMessage: EventCallback,
  onOpen?: EventOpenCallback,
  onAuthRequired?: () => void,
  onStatus?: EventConnectionStatusCallback
): void {
  if (eventWs) {
    eventWs.onclose = null;
    eventWs.close();
    eventWs = null;
  }
  lastEventOnMessage = onMessage;
  lastEventOnOpen = onOpen ?? null;
  lastOnAuthRequired = onAuthRequired ?? lastOnAuthRequired;
  lastEventOnStatus = onStatus ?? lastEventOnStatus;
  clearEventPing();

  const url = wsProtocol + '//' + location.host + '/ws/events';
  eventWs = new WebSocket(url);

  eventWs.onopen = () => {
    startEventPing();
    lastEventOnStatus?.('connected');
    onOpen?.();
  };

  eventWs.onmessage = (event) => {
    const str = event.data as string;
    if (eventPongPending) clearEventPongTimeout();
    if (str === PONG_MSG) return;
    try {
      const msg = JSON.parse(str) as EventMessage;
      if (msg.type === 'server-restarting') {
        markServerRestarting();
      }
      onMessage(msg);
    } catch {
      /* ignore parse errors */
    }
  };

  eventWs.onclose = () => {
    clearEventPing();
    lastEventOnStatus?.('reconnecting');
    setTimeout(() => void reconnectWithAuthCheck(), 3000);
  };

  eventWs.onerror = () => {};
}

async function reconnectWithAuthCheck(): Promise<void> {
  try {
    const res = await fetch('/auth/check');
    if (res.status === 401) {
      if (isWithinServerRestartGrace()) {
        setTimeout(() => void reconnectWithAuthCheck(), 1000);
        return;
      }
      lastOnAuthRequired?.();
      return;
    }
  } catch {
    /* keep trying */
  }
  if (lastEventOnMessage) {
    connectEventSocket(
      lastEventOnMessage,
      lastEventOnOpen ?? undefined,
      lastOnAuthRequired ?? undefined,
      lastEventOnStatus ?? undefined
    );
  }
}

function sendEventPing(): void {
  if (!eventWs || eventWs.readyState !== WebSocket.OPEN) return;
  eventPongPending = true;
  try {
    eventWs.send(PING_MSG);
  } catch {
    forceReconnectEvent();
    return;
  }
  if (eventPongTimeout) clearTimeout(eventPongTimeout);
  eventPongTimeout = setTimeout(() => {
    eventPongPending = false;
    forceReconnectEvent();
  }, PONG_TIMEOUT);
}

function forceReconnectEvent(): void {
  clearEventPing();
  lastEventOnStatus?.('reconnecting');
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

// ── Per-session PTY connection registry ──────────────────────────────────────

// 256 KiB UTF-16 code units cap for inactive terminal tabs (rough parity with
// the largest scrollback we keep in xterm, which is measured in lines not bytes).
const INACTIVE_BUFFER_CAP = 256 * 1024;

interface PtyConnection {
  /** Scoped registry key for the mounted frontend terminal. */
  sessionId: string;
  /** Node-local id used by local and remote PTY endpoints. */
  localSessionId: string;
  nodeId?: NodeId;
  ws: WebSocket | null;
  pendingWs: WebSocket | null;
  term: Terminal;
  onResize: () => void;
  onSessionEnd: () => void;

  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  reconnectOnCleanCloseUntil: number;

  pingTimer: ReturnType<typeof setInterval> | null;
  pongPending: boolean;
  pongTimeout: ReturnType<typeof setTimeout> | null;

  writeQueue: string[];
  queueSize: number;
  pendingSize: number;
  paused: boolean;
  rafHandle: number | null;
  bgTimer: ReturnType<typeof setTimeout> | null;

  /** True while the terminal tab is inactive — incoming data is buffered instead of painted. */
  renderPaused: boolean;
  /** Ring buffer for bytes received while renderPaused is true. */
  pauseBuffer: string[];
  /**
   * Logical head of the ring buffer. Eviction advances this index rather than
   * shifting the array (O(1) vs O(N)); the array is compacted when head
   * exceeds half its length.
   */
  pauseBufferHead: number;
  /** Total UTF-16 code unit count of live pauseBuffer content. */
  pauseBufferSize: number;

  terminalStreamCursor: number;
  terminalStreamClientId: string;
  resizeOwner: TerminalStreamResizeOwner;
}

const ptyConnections = new Map<string, PtyConnection>();

function createTerminalStreamClientId(): string {
  return `browser-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function appendTerminalStreamParams(path: string, conn: PtyConnection): string {
  const params = new URLSearchParams({
    clientId: conn.terminalStreamClientId,
    resizeOwner: conn.resizeOwner,
  });
  if (conn.terminalStreamCursor > 0) {
    params.set('cursor', String(conn.terminalStreamCursor));
  }
  return `${path}?${params.toString()}`;
}

function enqueuePtyOutput(conn: PtyConnection, data: string): void {
  // While the terminal tab is inactive, route data to the pause ring buffer
  // instead of the xterm write queue so we don't paint invisible frames.
  if (conn.renderPaused) {
    appendToPauseBuffer(conn, data);
    return;
  }

  if (conn.queueSize + data.length > MAX_QUEUE_SIZE) {
    if (!conn.paused) {
      logger.warn(
        'flow-control: queue cap reached (session=%s, queue=%d), dropping data',
        conn.sessionId,
        conn.queueSize
      );
    }
    return;
  }

  conn.writeQueue.push(data);
  conn.queueSize += data.length;
  if (conn.paused) {
    logger.debug(
      'flow-control: queued %d chars while paused (session=%s, pending=%d, queue=%d)',
      data.length,
      conn.sessionId,
      conn.pendingSize,
      conn.writeQueue.length
    );
  }
  if (!conn.paused) scheduleFlush(conn);
}

function handleTerminalStreamEnvelope(
  conn: PtyConnection,
  envelope: TerminalStreamEnvelope
): void {
  conn.terminalStreamCursor = Math.max(
    conn.terminalStreamCursor,
    envelope.cursor
  );
  if (envelope.kind === 'data') {
    enqueuePtyOutput(conn, envelope.payload.data);
    return;
  }
  if (envelope.kind === 'lag') {
    logger.warn(
      'terminal-stream lag notice (session=%s, reason=%s, requested=%s, oldest=%d, latest=%d)',
      conn.sessionId,
      envelope.payload.reason,
      String(envelope.payload.requestedCursor),
      envelope.payload.oldestCursor,
      envelope.payload.latestCursor
    );
  }
}

function parseTerminalStreamMessage(
  data: string
): TerminalStreamEnvelope | null {
  if (!data.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return isTerminalStreamEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isWithinServerRestartGrace(): boolean {
  return serverRestartAuthGraceUntil > Date.now();
}

function markServerRestarting(): void {
  markPtyConnectionsForServerRestart();
  serverRestartAuthGraceUntil = Math.max(
    serverRestartAuthGraceUntil,
    Date.now() + SERVER_RESTART_CLEAN_CLOSE_RECONNECT_WINDOW_MS
  );
}

function markPtyConnectionsForServerRestart(): void {
  const reconnectUntil =
    Date.now() + SERVER_RESTART_CLEAN_CLOSE_RECONNECT_WINDOW_MS;
  const sessions = useSessionsStore.getState();
  ptyConnections.forEach((conn) => {
    if (!conn.ws && !conn.pendingWs) return;
    conn.reconnectOnCleanCloseUntil = Math.max(
      conn.reconnectOnCleanCloseUntil,
      reconnectUntil
    );
    sessions.beginPtyReconnect(conn.sessionId);
  });
}

function shouldReconnectCleanPtyClose(conn: PtyConnection): boolean {
  return conn.reconnectOnCleanCloseUntil > Date.now();
}

function beginPtyReconnect(conn: PtyConnection): void {
  useSessionsStore.getState().beginPtyReconnect(conn.sessionId);
  if (conn.reconnectAttempt === 0) {
    conn.term.write('\r\n[reconnecting...]\r\n');
  }
  scheduleReconnect(conn);
}

function resolvePtyTarget(sessionKey: string): {
  registryKey: string;
  localSessionId: string;
  nodeId?: NodeId;
} {
  const sessions = useSessionsStore.getState().sessions;
  const session = resolveSessionByKey(sessions, sessionKey);
  if (session) {
    return {
      registryKey: resolveSessionKey(sessions, sessionKey),
      localSessionId: session.id,
      ...(session.nodeId ? { nodeId: session.nodeId } : {}),
    };
  }

  const parsedGlobalSessionId = parseGlobalSessionId(sessionKey);
  return {
    registryKey: sessionKey,
    localSessionId: parsedGlobalSessionId?.localSessionId ?? sessionKey,
    ...(parsedGlobalSessionId ? { nodeId: parsedGlobalSessionId.nodeId } : {}),
  };
}

function getActiveSessionId(): string | null {
  const sessionKey =
    useUiStore.getState().sendToTargetSessionId ??
    useSessionsStore.getState().activeSessionId;
  if (!sessionKey) return null;
  return resolvePtyTarget(sessionKey).registryKey;
}

function getActiveConnection(): PtyConnection | null {
  const id = getActiveSessionId();
  if (!id) return null;
  return ptyConnections.get(id) ?? null;
}

function disposePtyConnectionResources(conn: PtyConnection): void {
  clearPtyPing(conn);
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }
  if (conn.rafHandle !== null) {
    cancelAnimationFrame(conn.rafHandle);
    conn.rafHandle = null;
  }
  if (conn.bgTimer !== null) {
    clearTimeout(conn.bgTimer);
    conn.bgTimer = null;
  }
}

function flushWriteQueue(conn: PtyConnection): void {
  conn.rafHandle = null;
  conn.bgTimer = null;
  if (conn.writeQueue.length === 0) return;

  const combined = conn.writeQueue.join('');
  const combinedLen = combined.length;
  conn.writeQueue = [];
  conn.queueSize = 0;

  conn.pendingSize += combinedLen;
  conn.term.write(combined, () => {
    conn.pendingSize -= combinedLen;
    if (conn.paused && conn.pendingSize < LOW_WATER_MARK) {
      conn.paused = false;
      logger.info(
        'flow-control: LOW water mark reached, resuming (session=%s, pending=%d, queued=%d)',
        conn.sessionId,
        conn.pendingSize,
        conn.writeQueue.length
      );
      scheduleFlush(conn);
    }
  });

  if (conn.pendingSize >= HIGH_WATER_MARK) {
    conn.paused = true;
    logger.warn(
      'flow-control: HIGH water mark hit, pausing (session=%s, pending=%d)',
      conn.sessionId,
      conn.pendingSize
    );
  }
}

function scheduleFlush(conn: PtyConnection): void {
  if (conn.renderPaused) return;
  if (conn.rafHandle !== null || conn.bgTimer !== null) return;
  if (document.hidden) {
    conn.bgTimer = setTimeout(() => flushWriteQueue(conn), BG_FLUSH_INTERVAL);
  } else {
    conn.rafHandle = requestAnimationFrame(() => flushWriteQueue(conn));
  }
}

/**
 * Append data to the ring buffer for an inactive terminal, trimming oldest
 * bytes from the front when the cap is exceeded (FIFO eviction).
 */
function appendToPauseBuffer(conn: PtyConnection, data: string): void {
  conn.pauseBuffer.push(data);
  conn.pauseBufferSize += data.length;

  // Evict oldest chunks using a head-index to avoid O(N) Array.shift() calls.
  // Incrementing pauseBufferHead is O(1); the array is compacted once head
  // exceeds half the array length to prevent unbounded memory growth.
  while (conn.pauseBufferSize > INACTIVE_BUFFER_CAP) {
    const oldest = conn.pauseBuffer[conn.pauseBufferHead];
    if (oldest === undefined) break;

    if (conn.pauseBufferSize - oldest.length >= INACTIVE_BUFFER_CAP) {
      // Drop entire chunk — advance head.
      conn.pauseBufferHead++;
      conn.pauseBufferSize -= oldest.length;
    } else {
      // Partially trim the oldest chunk in-place.
      const excess = conn.pauseBufferSize - INACTIVE_BUFFER_CAP;
      conn.pauseBuffer[conn.pauseBufferHead] = oldest.slice(excess);
      conn.pauseBufferSize -= excess;
      break;
    }
  }

  // Compact: once the dead prefix is more than half the array, splice it away.
  if (conn.pauseBufferHead > conn.pauseBuffer.length >> 1) {
    conn.pauseBuffer = conn.pauseBuffer.slice(conn.pauseBufferHead);
    conn.pauseBufferHead = 0;
  }
}

export function connectPtySocket(
  sessionId: string,
  term: Terminal,
  onResize: () => void,
  onSessionEnd: () => void,
  resizeOwner: TerminalStreamResizeOwner = 'active'
): void {
  const { registryKey, localSessionId, nodeId } = resolvePtyTarget(sessionId);
  // Tear down any existing connection for this scoped terminal target.
  const existing = ptyConnections.get(registryKey);
  if (existing) {
    disposePtyConnectionResources(existing);
    if (existing.pendingWs) {
      existing.pendingWs.onopen = null;
      existing.pendingWs.onmessage = null;
      existing.pendingWs.onclose = null;
      existing.pendingWs.onerror = null;
      existing.pendingWs.close();
      existing.pendingWs = null;
    }
    if (existing.ws) {
      existing.ws.onclose = null;
      existing.ws.close();
      existing.ws = null;
    }
  }

  const conn: PtyConnection = {
    sessionId: registryKey,
    localSessionId,
    ...(nodeId ? { nodeId } : {}),
    ws: null,
    pendingWs: null,
    term,
    onResize,
    onSessionEnd,
    reconnectTimer: null,
    reconnectAttempt: 0,
    reconnectOnCleanCloseUntil: 0,
    pingTimer: null,
    pongPending: false,
    pongTimeout: null,
    writeQueue: [],
    queueSize: 0,
    pendingSize: 0,
    paused: false,
    rafHandle: null,
    bgTimer: null,
    renderPaused: false,
    pauseBuffer: [],
    pauseBufferHead: 0,
    pauseBufferSize: 0,
    terminalStreamCursor: 0,
    terminalStreamClientId: createTerminalStreamClientId(),
    resizeOwner,
  };
  ptyConnections.set(registryKey, conn);

  openPtySocket(conn);
}

function openPtySocket(conn: PtyConnection): void {
  const path =
    conn.nodeId && conn.nodeId !== DEFAULT_LOCAL_NODE_ID
      ? '/nodes/' +
        encodeURIComponent(conn.nodeId) +
        '/ws/sessions/' +
        encodeURIComponent(conn.localSessionId)
      : '/ws/' + encodeURIComponent(conn.localSessionId);
  const url =
    wsProtocol + '//' + location.host + appendTerminalStreamParams(path, conn);
  const socket = new WebSocket(url);
  conn.pendingWs = socket;

  socket.onopen = () => {
    conn.pendingWs = null;
    conn.ws = socket;
    conn.reconnectAttempt = 0;
    conn.reconnectOnCleanCloseUntil = 0;
    conn.onResize();
    startPtyPing(conn);
    useSessionsStore.getState().clearPtyReconnect(conn.sessionId);
  };

  socket.onmessage = (event) => {
    const str = event.data as string;
    if (conn.pongPending) clearPtyPongTimeout(conn);
    if (str === PONG_MSG) return;

    const envelope = parseTerminalStreamMessage(str);
    if (envelope) {
      handleTerminalStreamEnvelope(conn, envelope);
      return;
    }

    enqueuePtyOutput(conn, str);
  };

  socket.onclose = (event) => {
    const wasPending = conn.pendingWs === socket;
    const wasActive = conn.ws === socket;

    clearPtyPing(conn);
    if (conn.rafHandle !== null) {
      cancelAnimationFrame(conn.rafHandle);
      conn.rafHandle = null;
    }
    if (conn.bgTimer !== null) {
      clearTimeout(conn.bgTimer);
      conn.bgTimer = null;
    }
    if (wasPending) conn.pendingWs = null;
    if (wasActive) conn.ws = null;
    if (!wasPending && !wasActive) return;

    if (event.code === 1000 && shouldReconnectCleanPtyClose(conn)) {
      beginPtyReconnect(conn);
      return;
    }

    if (event.code === 1000) {
      conn.term.write('\r\n[session ended]\r\n');
      useSessionsStore.getState().clearPtyReconnect(conn.sessionId);
      ptyConnections.delete(conn.sessionId);
      conn.onSessionEnd();
      return;
    }
    beginPtyReconnect(conn);
  };

  socket.onerror = () => {};
}

function scheduleReconnect(conn: PtyConnection): void {
  if (conn.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    conn.term.write(
      '\r\n[gave up reconnecting after ' +
        MAX_RECONNECT_ATTEMPTS +
        ' attempts]\r\n'
    );
    useSessionsStore.getState().clearPtyReconnect(conn.sessionId);
    return;
  }
  const delay = Math.min(1000 * 2 ** conn.reconnectAttempt, 10000);
  conn.reconnectAttempt++;

  conn.reconnectTimer = setTimeout(async () => {
    conn.reconnectTimer = null;
    try {
      const authRes = await fetch('/auth/check');
      if (authRes.status === 401) {
        if (isWithinServerRestartGrace()) {
          scheduleReconnect(conn);
          return;
        }
        useSessionsStore.getState().clearPtyReconnect(conn.sessionId);
        lastOnAuthRequired?.();
        return;
      }
      const res = await fetch('/sessions');
      const sessionList = (await res.json()) as Array<{
        id: string;
        nodeId?: string;
        globalSessionId?: string;
      }>;
      if (
        !sessionList.some(
          (s) =>
            s.globalSessionId === conn.sessionId ||
            (s.nodeId
              ? (s.globalSessionId ?? createGlobalSessionId(s.nodeId, s.id)) ===
                conn.sessionId
              : s.id === conn.localSessionId)
        )
      ) {
        conn.term.write('\r\n[session ended]\r\n');
        useSessionsStore.getState().clearPtyReconnect(conn.sessionId);
        ptyConnections.delete(conn.sessionId);
        conn.onSessionEnd();
        return;
      }
      openPtySocket(conn);
    } catch {
      scheduleReconnect(conn);
    }
  }, delay);
}

function sendPtyPing(conn: PtyConnection): void {
  if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
  conn.pongPending = true;
  try {
    conn.ws.send(PING_MSG);
  } catch {
    forceReconnectPty(conn);
    return;
  }
  if (conn.pongTimeout) {
    clearTimeout(conn.pongTimeout);
    conn.pongTimeout = null;
  }
  conn.pongTimeout = setTimeout(() => {
    conn.pongPending = false;
    forceReconnectPty(conn);
  }, PONG_TIMEOUT);
}

function startPtyPing(conn: PtyConnection): void {
  conn.pingTimer = setInterval(() => sendPtyPing(conn), PING_INTERVAL);
}

function clearPtyPing(conn: PtyConnection): void {
  if (conn.pingTimer) {
    clearInterval(conn.pingTimer);
    conn.pingTimer = null;
  }
  clearPtyPongTimeout(conn);
}

function clearPtyPongTimeout(conn: PtyConnection): void {
  conn.pongPending = false;
  if (conn.pongTimeout) {
    clearTimeout(conn.pongTimeout);
    conn.pongTimeout = null;
  }
}

function forceReconnectPty(conn: PtyConnection): void {
  clearPtyPing(conn);
  if (conn.ws) {
    conn.ws.onclose = null;
    conn.ws.close();
    conn.ws = null;
  }
  beginPtyReconnect(conn);
}

export function disconnectPtySocket(sessionId: string): void {
  const registryKey = resolvePtyTarget(sessionId).registryKey;
  const conn = ptyConnections.get(registryKey);
  if (!conn) return;
  disposePtyConnectionResources(conn);
  if (conn.pendingWs) {
    conn.pendingWs.onclose = null;
    conn.pendingWs.close();
    conn.pendingWs = null;
  }
  if (conn.ws) {
    conn.ws.onclose = null;
    conn.ws.close();
    conn.ws = null;
  }
  ptyConnections.delete(conn.sessionId);
  useSessionsStore.getState().clearPtyReconnect(conn.sessionId);
}

// ── Visibility change — proactive reconnection on mobile wake ────────────────

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;

  for (const conn of ptyConnections.values()) {
    if (conn.ws && conn.ws.readyState !== WebSocket.OPEN) {
      forceReconnectPty(conn);
    } else if (conn.ws) {
      sendPtyPing(conn);
    }
  }

  if (eventWs && eventWs.readyState !== WebSocket.OPEN) {
    forceReconnectEvent();
  } else if (eventWs) {
    sendEventPing();
  }
});

// ── Public API ───────────────────────────────────────────────────────────────

export function sendPtyData(sessionId: string, data: string): void;
export function sendPtyData(data: string): void;
export function sendPtyData(arg1: string, arg2?: string): void {
  let conn: PtyConnection | null;
  let data: string;
  if (arg2 !== undefined) {
    conn = ptyConnections.get(resolvePtyTarget(arg1).registryKey) ?? null;
    data = arg2;
  } else {
    conn = getActiveConnection();
    data = arg1;
  }
  if (conn?.ws && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(data);
  }
}

export function sendPtyResize(
  sessionId: string,
  cols: number,
  rows: number
): void;
export function sendPtyResize(cols: number, rows: number): void;
export function sendPtyResize(
  arg1: string | number,
  arg2: number,
  arg3?: number
): void {
  let conn: PtyConnection | null;
  let cols: number;
  let rows: number;
  if (typeof arg1 === 'string' && arg3 !== undefined) {
    conn = ptyConnections.get(resolvePtyTarget(arg1).registryKey) ?? null;
    cols = arg2;
    rows = arg3;
  } else if (typeof arg1 === 'number') {
    conn = getActiveConnection();
    cols = arg1;
    rows = arg2;
  } else {
    return;
  }
  if (conn?.ws && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(
      JSON.stringify({
        type: 'resize',
        cols,
        rows,
        owner: conn.resizeOwner,
        clientId: conn.terminalStreamClientId,
      })
    );
  }
}

export function isPtyConnected(sessionId?: string): boolean {
  const conn = sessionId
    ? (ptyConnections.get(resolvePtyTarget(sessionId).registryKey) ?? null)
    : getActiveConnection();
  return !!conn?.ws && conn.ws.readyState === WebSocket.OPEN;
}

/**
 * Pause xterm rendering for a terminal tab that is now inactive.
 * Incoming PTY bytes are buffered in a 256 KB ring buffer instead of painted.
 * The WebSocket connection stays open.
 */
export function pausePtyFeed(sessionId: string): void {
  const conn = ptyConnections.get(resolvePtyTarget(sessionId).registryKey);
  if (!conn || conn.renderPaused) return;
  conn.resizeOwner = 'passive';
  conn.renderPaused = true;
  // Cancel any pending flush so we don't paint after pausing.
  if (conn.rafHandle !== null) {
    cancelAnimationFrame(conn.rafHandle);
    conn.rafHandle = null;
  }
  if (conn.bgTimer !== null) {
    clearTimeout(conn.bgTimer);
    conn.bgTimer = null;
  }
}

/**
 * Resume xterm rendering for a terminal tab that has become active.
 * Flushes all buffered bytes to xterm in the next animation frame, then
 * the caller should invoke fit() once the frame has painted.
 */
export function resumePtyFeed(sessionId: string): void {
  const conn = ptyConnections.get(resolvePtyTarget(sessionId).registryKey);
  if (!conn || !conn.renderPaused) return;
  conn.renderPaused = false;
  conn.resizeOwner = 'active';

  // Move all live pauseBuffer chunks into the write queue individually —
  // no join() allocation since flushWriteQueue will join them anyway.
  // Use concat() rather than push(...spread) to stay stack-safe with many chunks.
  if (conn.pauseBufferSize > 0) {
    conn.writeQueue = conn.writeQueue.concat(
      conn.pauseBuffer.slice(conn.pauseBufferHead)
    );
    conn.queueSize += conn.pauseBufferSize;
  }
  conn.pauseBuffer = [];
  conn.pauseBufferHead = 0;
  conn.pauseBufferSize = 0;

  // Always schedule a flush if writeQueue has data and we are not
  // flow-control paused — even when pauseBuffer was empty (fixes the case
  // where data was already in writeQueue before the pause started).
  if (!conn.paused && conn.writeQueue.length > 0) scheduleFlush(conn);
}

// ── Test-only helpers ────────────────────────────────────────────────────────

/** @internal — exposed for tests to inspect/reset the connection registry. */
export function _ptyConnectionsForTesting(): Map<string, PtyConnection> {
  return ptyConnections;
}

/** @internal — exposed for tests to clear all connections without socket teardown. */
export function _clearPtyConnectionsForTesting(): void {
  for (const conn of ptyConnections.values()) {
    disposePtyConnectionResources(conn);
  }
  ptyConnections.clear();
}
