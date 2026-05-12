import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { HubNodeRegistry } from './hub-node-registry.js';
import { isNodeManifest, type NodeManifest } from '../shared/node-manifest.js';
import { isRepoInventoryReport, type RepoInventoryReport } from '../shared/repo-inventory.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type HubNodeSummary,
  type RelayNodeEnvelope,
  type RelayNodeError,
} from '../shared/relay-node-protocol.js';

interface AuthenticatedNodeLink {
  node: HubNodeSummary;
  token: string;
}

interface PendingRpc {
  nodeId: string;
  nodeWs: WebSocket;
  resolve: (payload: unknown) => void;
  reject: (error: HubNodeLinkError) => void;
  timer: NodeJS.Timeout;
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

export function authenticateHubNodeLink(
  request: http.IncomingMessage,
  registry: HubNodeRegistry | undefined
): AuthenticatedNodeLink | null {
  if (!registry) return null;
  const token = bearerToken(request);
  if (!token) return null;
  const node = registry.authenticateCredential(token);
  return node ? { node, token } : null;
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
    ...(typeof request.requestId === 'string' ? { requestId: request.requestId } : {}),
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
  if (!validChannels.includes(candidate.channel as RelayNodeEnvelope['channel'])) {
    return invalidRequest(`unsupported relay-node-link channel: ${candidate.channel}`);
  }
  return candidate as RelayNodeEnvelope;
}

function manifestFromPayload(payload: unknown): NodeManifest | RelayNodeError | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const manifest = (payload as Record<string, unknown>)['manifest'];
  if (manifest === undefined || manifest === null) return undefined;
  if (!isNodeManifest(manifest)) return invalidRequest('manifest is malformed');
  return manifest;
}

function repoInventoryFromPayload(payload: unknown): RepoInventoryReport | RelayNodeError | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const repoInventory = (payload as Record<string, unknown>)['repoInventory'];
  if (repoInventory === undefined || repoInventory === null) return undefined;
  if (!isRepoInventoryReport(repoInventory)) return invalidRequest('repoInventory is malformed');
  return repoInventory;
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

export class HubNodeLinkManager {
  private readonly links = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingRpc>();
  private readonly ptyStreams = new Map<string, BrowserPtyStream>();
  private readonly eventHandlers = new Set<NodeEventHandler>();

  registerNodeLink(nodeId: string, ws: WebSocket): void {
    const existing = this.links.get(nodeId);
    if (existing && existing !== ws) {
      this.cleanupNodeLinkResources(nodeId, existing);
      if (existing.readyState === existing.OPEN) {
        existing.close(1012, 'replaced by newer relay-node link');
      }
    }
    this.links.set(nodeId, ws);
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
      throw new HubNodeLinkError(nodeOffline(`node ${nodeId} has no live reverse link`));
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
      this.pending.set(requestId, { nodeId, nodeWs: ws, resolve, reject, timer });
      sendJson(
        ws,
        envelope(nodeId, 'rpc', type, {
          requestId,
          payload,
        })
      );
    });
  }

  attachPty(nodeId: string, sessionId: string, browserWs: WebSocket): void {
    const nodeWs = this.links.get(nodeId);
    if (!nodeWs || nodeWs.readyState !== nodeWs.OPEN) {
      throw new HubNodeLinkError(nodeOffline(`node ${nodeId} has no live reverse link`));
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
          if (browserWs.readyState === browserWs.OPEN) browserWs.send('{"type":"pong"}');
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
        sendJson(stream.nodeWs, envelope(nodeId, 'pty', 'pty.detach', { streamId }));
      }
    };
    browserWs.once('close', cleanup);
    browserWs.once('error', cleanup);
  }

  handleEnvelope(message: RelayNodeEnvelope): boolean {
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

  private handlePtyEnvelope(message: RelayNodeEnvelope): boolean {
    const stream = this.ptyStreams.get(message.streamId!);
    if (!stream || stream.nodeId !== message.nodeId) return false;
    const browserWs = stream.browserWs;
    if (message.type === 'pty.data') {
      const data = payloadRecord(message.payload)['data'];
      if (typeof data === 'string' && browserWs.readyState === browserWs.OPEN) {
        browserWs.send(data);
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
    for (const handler of Array.from(this.eventHandlers)) handler(payload.type, data);
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
      pending.reject(new HubNodeLinkError(nodeOffline(`node ${nodeId} link closed`)));
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

export function createHubNodeLinkManager(): HubNodeLinkManager {
  return new HubNodeLinkManager();
}

export function handleHubNodeLink(
  ws: WebSocket,
  registry: HubNodeRegistry,
  authenticatedNode: HubNodeSummary,
  nodeLinks?: HubNodeLinkManager
): void {
  const authenticatedNodeId = authenticatedNode.nodeId;
  nodeLinks?.registerNodeLink(authenticatedNodeId, ws);

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
          invalidRequest(`unsupported ${parsed.channel} message: ${parsed.type}`)
        )
      );
      return;
    }

    if (parsed.type !== 'control.heartbeat' && parsed.type !== 'control.hello') {
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
        sendJson(ws, errorEnvelope(authenticatedNodeId, parsed, manifestResult));
        return;
      }
      const manifest = manifestResult as NodeManifest | undefined;
      const repoInventoryResult = repoInventoryFromPayload(parsed.payload);
      if (repoInventoryResult && 'code' in repoInventoryResult) {
        sendJson(ws, errorEnvelope(authenticatedNodeId, parsed, repoInventoryResult));
        return;
      }
      const repoInventory = repoInventoryResult as RepoInventoryReport | undefined;
      const node = registry.recordHeartbeat({
        nodeId: authenticatedNodeId,
        protocolVersion: parsed.protocolVersion,
        ...(manifest ? { manifest } : {}),
        ...(repoInventory ? { repoInventory } : {}),
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
        ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}),
        timestamp: new Date().toISOString(),
        payload: { node },
      });
    } catch (error) {
      sendJson(ws, errorEnvelope(authenticatedNodeId, parsed, registry.errorBody(error).error));
    }
  });
}
