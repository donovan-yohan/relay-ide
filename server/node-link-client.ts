import { WebSocket, type RawData } from 'ws';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type RelayNodeEnvelope,
  type RelayNodeError,
} from '../shared/relay-node-protocol.js';

export interface NodeLinkCredential {
  nodeId: string;
  token: string;
}

/**
 * #981: outgoing proof header name. HTTP headers are case-insensitive; the hub
 * reads the lowercased `x-relay-node-proof`.
 */
export const NODE_LINK_PROOF_HEADER_NAME = 'X-Relay-Node-Proof';

export interface NodeLinkEnvelopeHandlerContext {
  send: (envelope: RelayNodeEnvelope) => void;
  sendWithBackpressure?: (envelope: RelayNodeEnvelope) => Promise<void>;
  buildEnvelope: (
    channel: RelayNodeEnvelope['channel'],
    type: string,
    extras?: Partial<RelayNodeEnvelope>
  ) => RelayNodeEnvelope;
}

export type NodeLinkChannelHandler = (
  envelope: RelayNodeEnvelope,
  context: NodeLinkEnvelopeHandlerContext
) => void;

export interface NodeLinkClientDeps {
  hubUrl: string;
  credential: NodeLinkCredential;
  getManifest: () => Promise<NodeManifest> | NodeManifest;
  getRepoInventory?: () => Promise<unknown> | unknown;
  heartbeatIntervalMs?: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectJitterMs?: number;
  maxSendBufferedBytes?: number;
  sendBackpressureTimeoutMs?: number;
  sendBackpressurePollMs?: number;
  webSocketFactory?: NodeLinkWebSocketFactory;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  random?: () => number;
  logger?: Logger;
  onPtyEnvelope?: NodeLinkChannelHandler;
  onRpcEnvelope?: NodeLinkChannelHandler;
  /**
   * #981: produce a fresh proof of private-key possession for each (re)connect.
   * Called once per dial; a returned string is sent in the `X-Relay-Node-Proof`
   * header alongside the bearer token. Omit (or return undefined) for legacy
   * bearer-only credentials. Re-invoked on every reconnect so the proof stays
   * inside the hub's freshness window.
   */
  buildNodeLinkProof?: () => string | undefined;
}

export interface NodeLinkWebSocketLike {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: RawData) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount?: number;
}

export type NodeLinkWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> }
) => NodeLinkWebSocketLike;

export type NodeLinkState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stopped';

export interface NodeLinkClient {
  start(): void;
  stop(reason?: string): Promise<void>;
  getState(): NodeLinkState;
  onStateChange(handler: (state: NodeLinkState) => void): () => void;
}

const DEFAULTS = {
  heartbeatIntervalMs: 20_000,
  initialReconnectDelayMs: 1_000,
  maxReconnectDelayMs: 60_000,
  reconnectJitterMs: 500,
  maxSendBufferedBytes: 1_048_576,
  sendBackpressureTimeoutMs: 5_000,
  sendBackpressurePollMs: 25,
};

const TERMINAL_ERROR_CODES = new Set<RelayNodeError['code']>([
  'NODE_REVOKED',
  'PROTOCOL_INCOMPATIBLE',
  'UNAUTHORIZED',
]);

function toLinkUrl(hubUrl: string): string {
  const url = new URL('/hub/node-link', hubUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.toString();
}

function defaultWebSocketFactory(
  url: string,
  options: { headers: Record<string, string> }
): NodeLinkWebSocketLike {
  return new WebSocket(url, {
    headers: options.headers,
  }) as unknown as NodeLinkWebSocketLike;
}

export function createNodeLinkClient(deps: NodeLinkClientDeps): NodeLinkClient {
  const logger = deps.logger ?? createLogger('node-link');
  const heartbeatIntervalMs =
    deps.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
  const initialReconnectDelayMs =
    deps.initialReconnectDelayMs ?? DEFAULTS.initialReconnectDelayMs;
  const maxReconnectDelayMs =
    deps.maxReconnectDelayMs ?? DEFAULTS.maxReconnectDelayMs;
  const reconnectJitterMs =
    deps.reconnectJitterMs ?? DEFAULTS.reconnectJitterMs;
  const maxSendBufferedBytes = deps.maxSendBufferedBytes ?? DEFAULTS.maxSendBufferedBytes;
  const sendBackpressureTimeoutMs =
    deps.sendBackpressureTimeoutMs ?? DEFAULTS.sendBackpressureTimeoutMs;
  const sendBackpressurePollMs = deps.sendBackpressurePollMs ?? DEFAULTS.sendBackpressurePollMs;
  const webSocketFactory = deps.webSocketFactory ?? defaultWebSocketFactory;
  const setTimer = deps.setTimeoutFn ?? setTimeout;
  const clearTimer = deps.clearTimeoutFn ?? clearTimeout;
  const random = deps.random ?? Math.random;
  const linkUrl = toLinkUrl(deps.hubUrl);

  function connectHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${deps.credential.token}`,
    };
    // #981: re-sign per dial so the proof is fresh on every reconnect.
    const proof = deps.buildNodeLinkProof?.();
    if (proof) headers[NODE_LINK_PROOF_HEADER_NAME] = proof;
    return headers;
  }

  let state: NodeLinkState = 'idle';
  let ws: NodeLinkWebSocketLike | undefined;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stateHandlers = new Set<(state: NodeLinkState) => void>();

  function setState(next: NodeLinkState): void {
    if (state === next) return;
    state = next;
    for (const handler of Array.from(stateHandlers)) handler(next);
  }

  function envelope(
    channel: RelayNodeEnvelope['channel'],
    type: string,
    extras: Partial<RelayNodeEnvelope> = {}
  ): RelayNodeEnvelope {
    return {
      protocol: RELAY_NODE_LINK_PROTOCOL,
      protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
      nodeId: deps.credential.nodeId,
      channel,
      type,
      timestamp: new Date().toISOString(),
      ...extras,
    };
  }

  function send(payload: RelayNodeEnvelope): void {
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      logger.warn(
        `send failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function nodeLinkBackpressureError(
    message: string,
    details: Record<string, unknown> = {}
  ): RelayNodeError {
    return {
      code: 'NODE_BUSY',
      message,
      retryable: true,
      details: { reasonCode: 'FILE_RPC_FOLLOW_BACKPRESSURE', ...details },
    };
  }

  async function waitForBufferedRoom(socket: NodeLinkWebSocketLike): Promise<void> {
    const startedAt = Date.now();
    while ((socket.bufferedAmount ?? 0) > maxSendBufferedBytes) {
      if (stopped || ws !== socket || socket.readyState !== socket.OPEN) {
        throw nodeLinkBackpressureError('node link websocket closed before send drained', {
          bufferedAmount: socket.bufferedAmount ?? 0,
          maxSendBufferedBytes,
        });
      }
      if (Date.now() - startedAt >= sendBackpressureTimeoutMs) {
        throw nodeLinkBackpressureError('node link websocket send buffer stayed saturated', {
          bufferedAmount: socket.bufferedAmount ?? 0,
          maxSendBufferedBytes,
          timeoutMs: sendBackpressureTimeoutMs,
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimer(resolve, sendBackpressurePollMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      });
    }
  }

  async function sendWithBackpressure(payload: RelayNodeEnvelope): Promise<void> {
    const socket = ws;
    if (!socket || socket.readyState !== socket.OPEN) {
      throw nodeLinkBackpressureError('node link websocket is not open');
    }
    await waitForBufferedRoom(socket);
    const data = JSON.stringify(payload);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimer(() => {
        if (settled) return;
        settled = true;
        reject(
          nodeLinkBackpressureError('node link websocket send did not drain before timeout', {
            bufferedAmount: socket.bufferedAmount ?? 0,
            timeoutMs: sendBackpressureTimeoutMs,
            bytes: Buffer.byteLength(data),
          })
        );
      }, sendBackpressureTimeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      try {
        socket.send(data, (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          if (err) reject(err);
          else resolve();
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        reject(error);
      }
    });
  }

  async function buildControlPayload(): Promise<Record<string, unknown>> {
    const manifest = await deps.getManifest();
    const payload: Record<string, unknown> = { manifest };
    if (deps.getRepoInventory) {
      try {
        const repoInventory = await deps.getRepoInventory();
        if (repoInventory !== undefined && repoInventory !== null) {
          payload['repoInventory'] = repoInventory;
        }
      } catch (error) {
        logger.warn(
          `repo inventory collection failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return payload;
  }

  async function sendHello(): Promise<void> {
    const payload = await buildControlPayload();
    send(envelope('control', 'control.hello', { payload }));
  }

  function scheduleNextHeartbeat(): void {
    if (stopped) return;
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = undefined;
      runHeartbeat();
    }, heartbeatIntervalMs);
    (heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }

  function runHeartbeat(): void {
    const inflightWs = ws;
    if (stopped || !inflightWs || inflightWs.readyState !== inflightWs.OPEN) {
      return;
    }
    void buildControlPayload()
      .then((payload) => {
        if (
          stopped ||
          ws !== inflightWs ||
          inflightWs.readyState !== inflightWs.OPEN
        ) {
          return;
        }
        send(envelope('control', 'control.heartbeat', { payload }));
      })
      .catch((error) => {
        logger.warn(
          `heartbeat payload build failed: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        if (stopped || ws !== inflightWs) return;
        scheduleNextHeartbeat();
      });
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    scheduleNextHeartbeat();
  }

  function stopHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearTimer(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function nextReconnectDelay(): number {
    const exponent = Math.min(reconnectAttempt, 10);
    const base = Math.min(
      maxReconnectDelayMs,
      initialReconnectDelayMs * 2 ** exponent
    );
    const jitter = Math.floor(random() * reconnectJitterMs);
    return base + jitter;
  }

  function scheduleReconnect(reason: string): void {
    if (stopped) return;
    setState('reconnecting');
    const delay = nextReconnectDelay();
    reconnectAttempt += 1;
    logger.info(
      `reconnect in ${delay}ms (attempt ${reconnectAttempt}): ${reason}`
    );
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    (reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  function handleEnvelope(env: RelayNodeEnvelope): void {
    if (env.channel === 'control') {
      if (
        env.type === 'control.hello.result' ||
        env.type === 'control.heartbeat.ack'
      ) {
        reconnectAttempt = 0;
        return;
      }
      if (env.type === 'control.error' && env.error) {
        if (TERMINAL_ERROR_CODES.has(env.error.code)) {
          logger.error(
            `terminal error from hub (${env.error.code}): ${env.error.message}`
          );
          void stop(env.error.message);
          return;
        }
        logger.warn(
          `control.error from hub (${env.error.code}): ${env.error.message}`
        );
        return;
      }
    }
    if (env.channel === 'pty') {
      if (deps.onPtyEnvelope) {
        deps.onPtyEnvelope(env, {
          send,
          sendWithBackpressure,
          buildEnvelope: envelope,
        });
        return;
      }
      logger.debug(`received pty/${env.type} but no handler registered`);
      return;
    }
    if (env.channel === 'rpc') {
      if (deps.onRpcEnvelope) {
        deps.onRpcEnvelope(env, {
          send,
          sendWithBackpressure,
          buildEnvelope: envelope,
        });
        return;
      }
      logger.debug(`received rpc/${env.type} but no handler registered`);
      return;
    }
  }

  function connect(): void {
    if (stopped) return;
    setState('connecting');
    let socket: NodeLinkWebSocketLike;
    try {
      socket = webSocketFactory(linkUrl, { headers: connectHeaders() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      scheduleReconnect(`dial threw: ${message}`);
      return;
    }
    ws = socket;

    socket.on('open', () => {
      if (stopped || ws !== socket) return;
      setState('connected');
      logger.info(`connected to ${linkUrl}`);
      sendHello().catch((error) => {
        if (stopped || ws !== socket) return;
        logger.warn(
          `hello failed: ${error instanceof Error ? error.message : String(error)}`
        );
        try {
          socket.close(1011, 'hello failed');
        } catch {
          /* ignore */
        }
      });
      startHeartbeat();
    });

    socket.on('message', (data) => {
      if (stopped || ws !== socket) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        logger.warn('received non-JSON frame; ignoring');
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { protocol?: unknown }).protocol !== RELAY_NODE_LINK_PROTOCOL
      ) {
        logger.warn('received frame with unexpected protocol; ignoring');
        return;
      }
      handleEnvelope(parsed as RelayNodeEnvelope);
    });

    socket.on('close', (code, reason) => {
      if (ws !== socket && !stopped) return;
      const reasonText = reason?.toString?.() ?? '';
      stopHeartbeat();
      if (ws === socket) ws = undefined;
      if (stopped) {
        setState('stopped');
        return;
      }
      if (code === 4003) {
        // hub-side revoke close
        logger.error(`hub closed link with code ${code}: ${reasonText}`);
        void stop(reasonText || 'closed by hub');
        return;
      }
      scheduleReconnect(`socket closed (code=${code} reason=${reasonText})`);
    });

    socket.on('error', (err) => {
      if (stopped || ws !== socket) return;
      logger.warn(`socket error: ${err.message}`);
    });
  }

  async function stop(reason?: string): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) {
      clearTimer(reconnectTimer);
      reconnectTimer = undefined;
    }
    stopHeartbeat();
    const current = ws;
    ws = undefined;
    if (current) {
      try {
        current.close(1000, reason ?? 'node-link client stop');
      } catch {
        /* ignore */
      }
    }
    setState('stopped');
  }

  function start(): void {
    if (state !== 'idle') return;
    stopped = false;
    reconnectAttempt = 0;
    connect();
  }

  function onStateChange(handler: (state: NodeLinkState) => void): () => void {
    stateHandlers.add(handler);
    return () => stateHandlers.delete(handler);
  }

  return {
    start,
    stop,
    getState: () => state,
    onStateChange,
  };
}
