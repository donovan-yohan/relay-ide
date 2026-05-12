import * as express from 'express';
import type { Request, Response } from 'express';
import { isNodeManifest, type NodeManifest } from '../shared/node-manifest.js';
import {
  aggregateRepoInventoryReports,
  isRepoInventoryReport,
  type RepoInventoryReport,
} from '../shared/repo-inventory.js';
import { HubNodeRegistryError, type HubNodeRegistry } from './hub-node-registry.js';
import type { RelayNodeError } from '../shared/relay-node-protocol.js';

interface HubNodeRouterOptions {
  registry: HubNodeRegistry;
  requireAuth: express.RequestHandler;
  collectLocalRepoInventory?: () => Promise<RepoInventoryReport>;
}

function bearerToken(req: Request): string | null {
  const header = req.header('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function errorStatus(error: RelayNodeError): number {
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'TOKEN_EXPIRED':
    case 'TOKEN_ALREADY_USED':
    case 'PROTOCOL_INCOMPATIBLE':
    case 'VERSION_SKEW':
    case 'INVALID_REQUEST':
      return 400;
    case 'NODE_REVOKED':
      return 403;
    case 'NOT_FOUND':
    case 'NODE_OFFLINE':
      return 404;
    default:
      return 500;
  }
}

function sendRegistryError(
  registry: HubNodeRegistry,
  res: Response,
  error: unknown
): void {
  const body = registry.errorBody(error);
  res.status(errorStatus(body.error)).json(body);
}

function bodyRecord(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function manifestFromBody(body: Record<string, unknown>, required = false): NodeManifest | null {
  const manifest = body['manifest'];
  if (manifest === undefined || manifest === null) {
    if (required) {
      throw new HubNodeRegistryError('INVALID_REQUEST', 'manifest is required');
    }
    return null;
  }
  if (!isNodeManifest(manifest)) {
    throw new HubNodeRegistryError('INVALID_REQUEST', 'manifest is malformed');
  }
  return manifest;
}

function repoInventoryFromBody(body: Record<string, unknown>): RepoInventoryReport | null {
  const repoInventory = body['repoInventory'];
  if (repoInventory === undefined || repoInventory === null) return null;
  if (!isRepoInventoryReport(repoInventory)) {
    throw new HubNodeRegistryError('INVALID_REQUEST', 'repoInventory is malformed');
  }
  return repoInventory;
}

function pairTtlMs(body: Record<string, unknown>): number | undefined {
  const ttlMs = body['ttlMs'];
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) return ttlMs;
  const ttlSeconds = body['ttlSeconds'];
  if (typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    return Math.round(ttlSeconds * 1000);
  }
  return undefined;
}

export function createHubNodeRouter(options: HubNodeRouterOptions): express.Router {
  const router = express.Router();
  const { registry, requireAuth } = options;

  router.post('/hub/pair-tokens', requireAuth, (req, res) => {
    const body = bodyRecord(req);
    const displayName =
      typeof body['displayName'] === 'string' ? body['displayName'] : undefined;
    const ttlMs = pairTtlMs(body);
    const pairToken = registry.createPairToken({
      ...(displayName ? { displayName } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });
    res.status(201).json(pairToken);
  });

  router.post('/hub/pairing/exchange', (req, res) => {
    const body = bodyRecord(req);
    const pairToken = body['pairToken'];
    if (typeof pairToken !== 'string') {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'pairToken is required',
          retryable: false,
        },
      });
      return;
    }
    try {
      const manifest = manifestFromBody(body, true)!;
      const protocolVersion =
        typeof body['protocolVersion'] === 'string' ? body['protocolVersion'] : undefined;
      const displayName =
        typeof body['displayName'] === 'string' ? body['displayName'] : undefined;
      res.status(201).json(
        registry.exchangePairToken({
          pairToken,
          manifest,
          ...(displayName ? { displayName } : {}),
          ...(protocolVersion ? { protocolVersion } : {}),
        })
      );
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  router.post('/hub/node-heartbeat', (req, res) => {
    const token = bearerToken(req);
    const authenticated = token ? registry.authenticateCredential(token) : null;
    if (!authenticated) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'invalid node credential', retryable: false },
      });
      return;
    }
    const body = bodyRecord(req);
    const protocolVersion = body['protocolVersion'];
    if (
      body['nodeId'] !== authenticated.nodeId ||
      typeof protocolVersion !== 'string'
    ) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'nodeId and protocolVersion are required',
          retryable: false,
        },
      });
      return;
    }
    try {
      const manifest = manifestFromBody(body);
      const repoInventory = repoInventoryFromBody(body);
      res.json({
        node: registry.recordHeartbeat({
          nodeId: authenticated.nodeId,
          protocolVersion,
          ...(manifest ? { manifest } : {}),
          ...(repoInventory ? { repoInventory } : {}),
        }),
      });
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  router.get('/nodes', requireAuth, (_req, res) => {
    res.json({ nodes: registry.listNodes() });
  });

  router.get('/hub/repo-inventory', requireAuth, async (_req, res) => {
    try {
      const reports = [...registry.listRepoInventoryReports()];
      if (options.collectLocalRepoInventory) {
        reports.push(await options.collectLocalRepoInventory());
      }
      res.json(aggregateRepoInventoryReports(reports));
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  router.delete('/nodes/:nodeId', requireAuth, (req, res) => {
    const { nodeId } = req.params;
    if (!nodeId) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'nodeId is required', retryable: false },
      });
      return;
    }
    try {
      res.json({ node: registry.revokeNode(nodeId) });
    } catch (error) {
      sendRegistryError(registry, res, error);
    }
  });

  return router;
}
