import type * as http from 'node:http';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { HubNodeRegistry } from './hub-node-registry.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  type HubNodeSummary,
  type RelayNodeEnvelope,
  type RelayNodeError,
} from '../shared/relay-node-protocol.js';

interface AuthenticatedNodeLink {
  node: HubNodeSummary;
  token: string;
}

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

function errorEnvelope(
  nodeId: string,
  request: Partial<RelayNodeEnvelope>,
  error: RelayNodeError
): RelayNodeEnvelope {
  return {
    protocol: RELAY_NODE_LINK_PROTOCOL,
    protocolVersion: '1.0',
    nodeId,
    channel: 'control',
    type: 'control.error',
    timestamp: new Date().toISOString(),
    ...(typeof request.requestId === 'string' ? { requestId: request.requestId } : {}),
    error,
  };
}

function invalidRequest(message: string): RelayNodeError {
  return { code: 'INVALID_REQUEST', message, retryable: false };
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
  const envelope = parsed as Partial<RelayNodeEnvelope>;
  if (
    envelope.protocol !== RELAY_NODE_LINK_PROTOCOL ||
    typeof envelope.protocolVersion !== 'string' ||
    typeof envelope.nodeId !== 'string' ||
    envelope.channel !== 'control' ||
    typeof envelope.type !== 'string'
  ) {
    return invalidRequest('invalid relay-node-link control envelope');
  }
  return envelope as RelayNodeEnvelope;
}

function manifestFromPayload(payload: unknown): NodeManifest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const manifest = (payload as Record<string, unknown>)['manifest'];
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const candidate = manifest as Partial<NodeManifest>;
  if (candidate.schemaVersion !== 1 || typeof candidate.hostname !== 'string') return undefined;
  return manifest as NodeManifest;
}

function sendJson(ws: WebSocket, payload: RelayNodeEnvelope): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

export function handleHubNodeLink(
  ws: WebSocket,
  registry: HubNodeRegistry,
  authenticatedNode: HubNodeSummary
): void {
  const authenticatedNodeId = authenticatedNode.nodeId;

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
      const node = registry.recordHeartbeat({
        nodeId: authenticatedNodeId,
        protocolVersion: parsed.protocolVersion,
        ...(manifestFromPayload(parsed.payload) ? { manifest: manifestFromPayload(parsed.payload)! } : {}),
      });
      sendJson(ws, {
        protocol: RELAY_NODE_LINK_PROTOCOL,
        protocolVersion: '1.0',
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
