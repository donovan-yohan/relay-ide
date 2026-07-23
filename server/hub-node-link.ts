import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type {
  CredentialAuthContext,
  HubNodeRegistry,
} from './hub-node-registry.js';
import { isNodeManifest, type NodeManifest } from '../shared/node-manifest.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type HubNodeSummary,
  type RelayNodeEnvelope,
  type RelayNodeError,
} from '../shared/relay-node-protocol.js';
import { sendWithBackpressure } from './ws-backpressure.js';

interface AuthenticatedNodeLink {
  node: HubNodeSummary;
  token: string;
  credentialId: string;
}

export type HubNodeLinkAuthenticationResult =
  | { ok: true; authenticated: AuthenticatedNodeLink }
  | { ok: false; status: number; error?: RelayNodeError };

interface PendingRpc {
  nodeId: string;
  nodeWs: WebSocket;
  resolve: (payload: unknown) => void;
  reject: (error: HubNodeLinkError) => void;
  timer: NodeJS.Timeout;
}

interface PendingStream {
  nodeId: string;
  nodeWs: WebSocket;
  requestId: string;
  streamId: string;
  cancelType: string;
  opened: boolean;
  resolve: (stream: HubNodeLinkStream) => void;
  reject: (error: HubNodeLinkError) => void;
  onChunk: (payload: unknown) => void;
  onError?: (error: RelayNodeError) => void;
  onEnd?: () => void;
  timer: NodeJS.Timeout;
}

export interface HubNodeLinkStream {
  requestId: string;
  streamId: string;
  payload: unknown;
  close(): void;
}

interface BrowserPtyStream {
  nodeId: string;
  nodeWs: WebSocket;
  sessionId: string;
  browserWs: WebSocket;
}

interface NodeEventPayload {
  type?: unknown;
  [key: string]: unknown;
}

type NodeEventHandler = (type: string, data: Record<string, unknown>) => void;

const DEFAULT_RPC_TIMEOUT_MS = 10_000;

function bearerToken(request: http.IncomingMessage): string | null {
  const header = request.headers.authorization ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/**
 * #981: header carrying the node's proof of private-key possession. Read at the
 * WebSocket upgrade alongside the bearer token. A single string header value is
 * required; arrays (duplicate headers) are rejected as malformed by the
 * registry's proof verification rather than concatenated.
 */
export const NODE_LINK_PROOF_HEADER = 'x-relay-node-proof';

function nodeProofHeader(request: http.IncomingMessage): string | undefined {
  const value = request.headers[NODE_LINK_PROOF_HEADER];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hubNodeLinkAuthStatus(error: RelayNodeError): number {
  switch (error.code) {
    case 'FORBIDDEN':
    case 'NODE_REVOKED':
    case 'NODE_CREDENTIAL_EXPIRED':
    case 'NODE_PROOF_INVALID':
    case 'REPAIR_REQUIRED':
      return 403;
    default:
      // NODE_PROOF_REQUIRED + other credential failures present as 401: the
      // bearer located a credential but possession was not (yet) proven.
      return 401;
  }
}

export function authenticateHubNodeLink(
  request: http.IncomingMessage,
  registry: HubNodeRegistry | undefined,
  context: CredentialAuthContext = {}
): HubNodeLinkAuthenticationResult {
  if (!registry) return { ok: false, status: 401 };
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401 };
  const proof = nodeProofHeader(request);
  // The bearer locates the credential; key-bound credentials must additionally
  // prove private-key possession bound to the node-link audience.
  const auth = registry.authenticateNodeLinkWithProof(token, {
    ...context,
    audience: 'relay:node-link:v1',
    ...(proof ? { proof } : {}),
  });
  if (auth.ok) {
    return {
      ok: true,
      authenticated: {
        node: auth.node,
        token,
        credentialId: auth.credentialId,
      },
    };
  }
  const error = auth.ok === false ? auth.error : undefined;
  return error
    ? { ok: false, status: hubNodeLinkAuthStatus(error), error }
    : { ok: false, status: 401 };
}

function envelope(
  nodeId: string,
  channel: RelayNodeEnvelope['channel'],
  type: string,
  extras: Partial<RelayNodeEnvelope> = {}
): RelayNodeEnvelope {
  return {
    protocol: RELAY_NODE_LINK_PROTOCOL,
    protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    nodeId,
    channel,
    type,
    timestamp: new Date().toISOString(),
    ...extras,
  };
}

function errorEnvelope(
  nodeId: string,
  request: Partial<RelayNodeEnvelope>,
  error: RelayNodeError
): RelayNodeEnvelope {
  return envelope(nodeId, 'control', 'control.error', {
    ...(typeof request.requestId === 'string'
      ? { requestId: request.requestId }
      : {}),
    error,
  });
}

function invalidRequest(message: string): RelayNodeError {
  return { code: 'INVALID_REQUEST', message, retryable: false };
}

function nodeOffline(message: string): RelayNodeError {
  return { code: 'NODE_OFFLINE', message, retryable: true };
}

function parseEnvelope(data: RawData): RelayNodeEnvelope | RelayNodeError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return invalidRequest('node-link messages must be JSON envelopes');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return invalidRequest('node-link message must be an object');
  }
  const candidate = parsed as Partial<RelayNodeEnvelope>;
  if (
    candidate.protocol !== RELAY_NODE_LINK_PROTOCOL ||
    typeof candidate.protocolVersion !== 'string' ||
    typeof candidate.nodeId !== 'string' ||
    typeof candidate.channel !== 'string' ||
    typeof candidate.type !== 'string'
  ) {
    return invalidRequest('invalid relay-node-link envelope');
  }
  const validChannels: RelayNodeEnvelope['channel'][] = [
    'control',
    'rpc',
    'events',
    'pty',
    'preview',
  ];
  if (
    !validChannels.includes(candidate.channel as RelayNodeEnvelope['channel'])
  ) {
    return invalidRequest(
      `unsupported relay-node-link channel: ${candidate.channel}`
    );
  }
  return candidate as RelayNodeEnvelope;
}

function manifestFromPayload(
  payload: unknown
): NodeManifest | RelayNodeError | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const manifest = (payload as Record<string, unknown>)['manifest'];
  if (manifest === undefined || manifest === null) return undefined;
  if (!isNodeManifest(manifest)) return invalidRequest('manifest is malformed');
  return manifest;
}

function extractInventoryPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)['repoInventory'];
}

function sendJson(ws: WebSocket, payload: RelayNodeEnvelope): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

export class HubNodeLinkError extends Error {
  readonly relayNodeError: RelayNodeError;

  constructor(error: RelayNodeError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'HubNodeLinkError';
    this.relayNodeError = error;
  }
}

export type HubNodeLinkInventoryValidator = (
  payload: unknown,
  ctx: { nodeId: string }
) => { ok: true; payload: unknown } | { ok: false; error: RelayNodeError };

export type HubNodePtyInputRecorder = (input: {
  nodeId: string;
  sessionId: string;
  data: string;
}) => void;

export interface HubNodeLinkManagerOptions {
  inventoryValidator?: HubNodeLinkInventoryValidator;
  ptyInputRecorder?: HubNodePtyInputRecorder;
}

export class HubNodeLinkManager {
  private readonly links = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingRpc>();
  private readonly streams = new Map<string, PendingStream>();
  private readonly ptyStreams = new Map<string, BrowserPtyStream>();
  private readonly eventHandlers = new Set<NodeEventHandler>();
  private readonly inventoryValidator?: HubNodeLinkInventoryValidator;
  private readonly ptyInputRecorder?: HubNodePtyInputRecorder;

  constructor(options: HubNodeLinkManagerOptions = {}) {
    if (options.inventoryValidator) {
      this.inventoryValidator = options.inventoryValidator;
    }
    if (options.ptyInputRecorder) {
      this.ptyInputRecorder = options.ptyInputRecorder;
    }
  }

  validateInventoryPayload(
    payload: unknown,
    ctx: { nodeId: string }
  ): { ok: true; payload: unknown } | { ok: false; error: RelayNodeError } {
    // Safe-by-default: when no validator is wired, drop the payload
    // rather than passing it through. Composition root wires the
    // feature-layer validator in production; tests or misconfigured
    // deployments get safe-empty.
    if (!this.inventoryValidator) return { ok: true, payload: undefined };
    return this.inventoryValidator(payload, ctx);
  }

  registerNodeLink(nodeId: string, ws: WebSocket): void {
    const existing = this.links.get(nodeId);
    if (existing && existing !== ws) {
      this.cleanupNodeLinkResources(nodeId, existing);
    }
    this.links.set(nodeId, ws);
    if (existing && existing !== ws && existing.readyState === existing.OPEN) {
      existing.close(1012, 'replaced by newer relay-node link');
    }
    const cleanup = () => this.unregisterNodeLink(nodeId, ws);
    ws.once('close', cleanup);
    ws.once('error', cleanup);
  }

  hasActiveNode(nodeId: string): boolean {
    const ws = this.links.get(nodeId);
    return !!ws && ws.readyState === ws.OPEN;
  }

  request(nodeId: string, type: string, payload: unknown): Promise<unknown> {
    const ws = this.links.get(nodeId);
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new HubNodeLinkError(
        nodeOffline(`node ${nodeId} has no live reverse link`)
      );
    }
    const requestId = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new HubNodeLinkError({
            code: 'NODE_OFFLINE',
            message: `node ${nodeId} did not answer ${type}`,
            retryable: true,
          })
        );
      }, DEFAULT_RPC_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, {
        nodeId,
        nodeWs: ws,
        resolve,
        reject,
        timer,
      });
      sendJson(
        ws,
        envelope(nodeId, 'rpc', type, {
          requestId,
          payload,
        })
      );
    });
  }

  streamRequest(
    nodeId: string,
    type: string,
    payload: unknown,
    handlers: {
      onChunk: (payload: unknown) => void;
      onError?: (error: RelayNodeError) => void;
      onEnd?: () => void;
    }
  ): Promise<HubNodeLinkStream> {
    const ws = this.links.get(nodeId);
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new HubNodeLinkError(
        nodeOffline(`node ${nodeId} has no live reverse link`)
      );
    }
    const requestId = crypto.randomUUID();
    const streamId = crypto.randomUUID();
    return new Promise<HubNodeLinkStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.streams.delete(streamId);
        reject(
          new HubNodeLinkError({
            code: 'NODE_OFFLINE',
            message: `node ${nodeId} did not start ${type}`,
            retryable: true,
          })
        );
      }, DEFAULT_RPC_TIMEOUT_MS);
      timer.unref?.();
      const pendingStream: PendingStream = {
        nodeId,
        nodeWs: ws,
        requestId,
        streamId,
        cancelType: `${type}.cancel`,
        opened: false,
        resolve,
        reject,
        onChunk: handlers.onChunk,
        timer,
      };
      if (handlers.onError !== undefined) {
        pendingStream.onError = handlers.onError;
      }
      if (handlers.onEnd !== undefined) {
        pendingStream.onEnd = handlers.onEnd;
      }
      this.streams.set(streamId, pendingStream);
      sendJson(
        ws,
        envelope(nodeId, 'rpc', type, {
          requestId,
          streamId,
          payload,
        })
      );
    });
  }

  private closeStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    clearTimeout(stream.timer);
    if (stream.nodeWs.readyState === stream.nodeWs.OPEN) {
      sendJson(
        stream.nodeWs,
        envelope(stream.nodeId, 'rpc', stream.cancelType, {
          requestId: stream.requestId,
          streamId,
        })
      );
    }
    stream.onEnd?.();
  }

  attachPty(nodeId: string, sessionId: string, browserWs: WebSocket): void {
    const nodeWs = this.links.get(nodeId);
    if (!nodeWs || nodeWs.readyState !== nodeWs.OPEN) {
      throw new HubNodeLinkError(
        nodeOffline(`node ${nodeId} has no live reverse link`)
      );
    }
    const streamId = crypto.randomUUID();
    this.ptyStreams.set(streamId, { nodeId, nodeWs, sessionId, browserWs });
    sendJson(
      nodeWs,
      envelope(nodeId, 'pty', 'pty.attach', {
        streamId,
        payload: { sessionId },
      })
    );

    browserWs.on('message', (data) => {
      if (nodeWs.readyState !== nodeWs.OPEN) {
        browserWs.close(1011, 'node link closed');
        return;
      }
      const text = data.toString();
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed['type'] === 'ping') {
          if (browserWs.readyState === browserWs.OPEN)
            browserWs.send('{"type":"pong"}');
          return;
        }
        if (
          parsed['type'] === 'resize' &&
          typeof parsed['cols'] === 'number' &&
          typeof parsed['rows'] === 'number'
        ) {
          sendJson(
            nodeWs,
            envelope(nodeId, 'pty', 'pty.resize', {
              streamId,
              payload: { cols: parsed['cols'], rows: parsed['rows'] },
            })
          );
          return;
        }
      } catch {
        /* raw PTY input */
      }
      this.ptyInputRecorder?.({ nodeId, sessionId, data: text });
      sendJson(
        nodeWs,
        envelope(nodeId, 'pty', 'pty.input', {
          streamId,
          payload: { data: text },
        })
      );
    });

    const cleanup = () => {
      const stream = this.ptyStreams.get(streamId);
      if (!stream) return;
      this.ptyStreams.delete(streamId);
      if (stream.nodeWs.readyState === stream.nodeWs.OPEN) {
        sendJson(
          stream.nodeWs,
          envelope(nodeId, 'pty', 'pty.detach', { streamId })
        );
      }
    };
    browserWs.once('close', cleanup);
    browserWs.once('error', cleanup);
  }

  handleEnvelope(message: RelayNodeEnvelope): boolean {
    if (message.channel === 'rpc' && message.streamId) {
      return this.handleStreamEnvelope(message);
    }

    if (message.channel === 'rpc' && message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (pending && pending.nodeId === message.nodeId) {
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        if (message.error) pending.reject(new HubNodeLinkError(message.error));
        else pending.resolve(message.payload);
        return true;
      }
    }

    if (message.channel === 'pty' && message.streamId) {
      return this.handlePtyEnvelope(message);
    }

    if (message.channel === 'events') {
      this.handleNodeEvent(message);
      return true;
    }

    return false;
  }

  onNodeEvent(handler: NodeEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private handleStreamEnvelope(message: RelayNodeEnvelope): boolean {
    const stream = this.streams.get(message.streamId!);
    if (!stream || stream.nodeId !== message.nodeId) return false;
    if (message.error) {
      this.handleStreamError(message.streamId!, stream, message.error);
      return true;
    }
    if (message.type.endsWith('.result')) {
      this.openStream(stream, message.payload);
      return true;
    }
    if (
      message.type === 'logs.tail.chunk' ||
      message.type === 'fs.tail.chunk'
    ) {
      stream.onChunk(message.payload);
      return true;
    }
    if (
      message.type === 'logs.tail.error' ||
      message.type === 'fs.tail.error'
    ) {
      const error = payloadRecord(message.payload)['error'];
      if (typeof error === 'object' && error !== null) {
        stream.onError?.(error as RelayNodeError);
      }
      return true;
    }
    if (message.type === 'logs.tail.end' || message.type === 'fs.tail.end') {
      this.closeStream(message.streamId!);
      return true;
    }
    return false;
  }

  private handleStreamError(
    streamId: string,
    stream: PendingStream,
    error: RelayNodeError
  ): void {
    clearTimeout(stream.timer);
    if (!stream.opened) {
      this.streams.delete(streamId);
      stream.reject(new HubNodeLinkError(error));
      return;
    }
    stream.onError?.(error);
  }

  private openStream(stream: PendingStream, payload: unknown): void {
    clearTimeout(stream.timer);
    stream.opened = true;
    stream.resolve({
      requestId: stream.requestId,
      streamId: stream.streamId,
      payload,
      close: () => this.closeStream(stream.streamId),
    });
  }

  private handlePtyEnvelope(message: RelayNodeEnvelope): boolean {
    const stream = this.ptyStreams.get(message.streamId!);
    if (!stream || stream.nodeId !== message.nodeId) return false;
    const browserWs = stream.browserWs;
    if (message.type === 'pty.data') {
      const data = payloadRecord(message.payload)['data'];
      if (typeof data === 'string') {
        // #1249: routed PTY stdout is a replayable delta (browser reconnect
        // re-attaches and the node re-streams), so shed it to a lagging browser
        // socket above the soft watermark rather than queuing frames off-heap;
        // above the hard watermark close 4409 (cleanup sends pty.detach).
        sendWithBackpressure(browserWs, () => data, { droppable: true });
      }
      return true;
    }
    if (message.type === 'pty.exit') {
      this.ptyStreams.delete(message.streamId!);
      if (browserWs.readyState === browserWs.OPEN) browserWs.close(1000);
      return true;
    }
    if (message.type === 'pty.error') {
      this.ptyStreams.delete(message.streamId!);
      if (browserWs.readyState === browserWs.OPEN) browserWs.close(1011);
      return true;
    }
    return false;
  }

  private handleNodeEvent(message: RelayNodeEnvelope): void {
    const payload = payloadRecord(message.payload) as NodeEventPayload;
    if (typeof payload.type !== 'string') return;
    const data = { ...payload, nodeId: message.nodeId };
    delete data.type;
    for (const handler of Array.from(this.eventHandlers))
      handler(payload.type, data);
  }

  private unregisterNodeLink(nodeId: string, ws: WebSocket): void {
    if (this.links.get(nodeId) === ws) this.links.delete(nodeId);
    this.cleanupNodeLinkResources(nodeId, ws);
  }

  private cleanupNodeLinkResources(nodeId: string, ws: WebSocket): void {
    for (const [requestId, pending] of Array.from(this.pending)) {
      if (pending.nodeId !== nodeId || pending.nodeWs !== ws) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(
        new HubNodeLinkError(nodeOffline(`node ${nodeId} link closed`))
      );
    }
    for (const [streamId, stream] of Array.from(this.streams)) {
      if (stream.nodeId !== nodeId || stream.nodeWs !== ws) continue;
      clearTimeout(stream.timer);
      this.streams.delete(streamId);
      const error = nodeOffline(`node ${nodeId} link closed`);
      if (stream.opened) stream.onError?.(error);
      else stream.reject(new HubNodeLinkError(error));
      stream.onEnd?.();
    }
    for (const [streamId, stream] of Array.from(this.ptyStreams)) {
      if (stream.nodeId !== nodeId || stream.nodeWs !== ws) continue;
      this.ptyStreams.delete(streamId);
      if (stream.browserWs.readyState === stream.browserWs.OPEN) {
        stream.browserWs.close(1011, 'node link closed');
      }
    }
  }
}

export function createHubNodeLinkManager(
  options: HubNodeLinkManagerOptions = {}
): HubNodeLinkManager {
  return new HubNodeLinkManager(options);
}

export function handleHubNodeLink(
  ws: WebSocket,
  registry: HubNodeRegistry,
  authenticated: AuthenticatedNodeLink,
  nodeLinks?: HubNodeLinkManager
): void {
  const authenticatedNodeId = authenticated.node.nodeId;
  nodeLinks?.registerNodeLink(authenticatedNodeId, ws);
  const unsubscribeStatus = registry.onNodeStatus((event) => {
    if (event.nodeId !== authenticatedNodeId || event.status !== 'revoked')
      return;
    sendJson(
      ws,
      errorEnvelope(
        authenticatedNodeId,
        {},
        {
          code: 'NODE_REVOKED',
          message: 'node credential was revoked',
          retryable: false,
        }
      )
    );
    ws.close(4003, 'node revoked');
  });
  const cleanup = () => unsubscribeStatus();
  let disconnected = false;
  const markDisconnected = () => {
    if (disconnected) return;
    disconnected = true;
    if (nodeLinks?.hasActiveNode(authenticatedNodeId)) return;
    try {
      registry.markNodeLinkDisconnected(authenticatedNodeId);
    } catch {
      // Authenticated links can race with revoke/unpair lifecycle; close/error
      // cleanup must never crash the WebSocket upgrade handler.
    }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
  ws.on('close', markDisconnected);
  ws.on('error', markDisconnected);

  ws.on('message', (data) => {
    const parsed = parseEnvelope(data);
    if ('code' in parsed) {
      sendJson(ws, errorEnvelope(authenticatedNodeId, {}, parsed));
      return;
    }

    if (parsed.nodeId !== authenticatedNodeId) {
      sendJson(
        ws,
        errorEnvelope(
          authenticatedNodeId,
          parsed,
          invalidRequest('nodeId does not match authenticated credential')
        )
      );
      return;
    }

    if (nodeLinks?.handleEnvelope(parsed)) return;

    if (parsed.channel !== 'control') {
      sendJson(
        ws,
        errorEnvelope(
          authenticatedNodeId,
          parsed,
          invalidRequest(
            `unsupported ${parsed.channel} message: ${parsed.type}`
          )
        )
      );
      return;
    }

    if (
      parsed.type !== 'control.heartbeat' &&
      parsed.type !== 'control.hello'
    ) {
      sendJson(
        ws,
        errorEnvelope(
          authenticatedNodeId,
          parsed,
          invalidRequest(`unsupported control message: ${parsed.type}`)
        )
      );
      return;
    }

    try {
      const manifestResult = manifestFromPayload(parsed.payload);
      if (manifestResult && 'code' in manifestResult) {
        sendJson(
          ws,
          errorEnvelope(authenticatedNodeId, parsed, manifestResult)
        );
        return;
      }
      const manifest = manifestResult as NodeManifest | undefined;
      const rawInventory = extractInventoryPayload(parsed.payload);
      // Safe-by-default: when no validator is wired, drop any
      // repoInventory payload rather than storing it unvalidated. This
      // prevents nodeId spoofing or malformed payloads from reaching
      // the registry on misconfigured deployments.
      const inventoryValidation = nodeLinks
        ? nodeLinks.validateInventoryPayload(rawInventory, {
            nodeId: authenticatedNodeId,
          })
        : { ok: true as const, payload: undefined };
      if (!inventoryValidation.ok) {
        sendJson(
          ws,
          errorEnvelope(authenticatedNodeId, parsed, inventoryValidation.error)
        );
        return;
      }
      const repoInventory = inventoryValidation.payload;
      const node = registry.recordHeartbeat({
        nodeId: authenticatedNodeId,
        protocolVersion: parsed.protocolVersion,
        credentialId: authenticated.credentialId,
        ...(manifest ? { manifest } : {}),
        ...(repoInventory !== undefined && repoInventory !== null
          ? { repoInventory }
          : {}),
      });
      sendJson(ws, {
        protocol: RELAY_NODE_LINK_PROTOCOL,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        nodeId: authenticatedNodeId,
        channel: 'control',
        type:
          parsed.type === 'control.hello'
            ? 'control.hello.result'
            : 'control.heartbeat.ack',
        ...(typeof parsed.requestId === 'string'
          ? { requestId: parsed.requestId }
          : {}),
        timestamp: new Date().toISOString(),
        payload: { node },
      });
    } catch (error) {
      sendJson(
        ws,
        errorEnvelope(
          authenticatedNodeId,
          parsed,
          registry.errorBody(error).error
        )
      );
    }
  });
}
