import * as express from 'express';
import type { Request, Response } from 'express';
import { isNodeManifest, type NodeManifest } from '../shared/node-manifest.js';
import {
  aggregateRepoInventoryReports,
  isRepoInventoryReport,
  type RepoInventoryReport,
} from '../shared/repo-inventory.js';
import { HubNodeRegistryError, type HubNodeRegistry } from './hub-node-registry.js';
import {
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type RelayNodeError,
} from '../shared/relay-node-protocol.js';
import {
  BOOTSTRAP_DIAGNOSTICS,
  generateBootstrapCommands,
  type BootstrapServiceMode,
} from '../shared/bootstrap-diagnostics.js';
import { HubNodeLinkError, type HubNodeLinkManager } from './hub-node-link.js';
import type { SessionSummary } from './types.js';
import {
  createGlobalSessionId,
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../shared/identity.js';

interface HubNodeRouterOptions {
  registry: HubNodeRegistry;
  requireAuth: express.RequestHandler;
  collectLocalRepoInventory?: () => Promise<RepoInventoryReport>;
  nodeLinks?: HubNodeLinkManager;
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
    case 'NODE_UNSUPPORTED':
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

function relayError(code: RelayNodeError['code'], message: string, retryable = false): RelayNodeError {
  return { code, message, retryable };
}

function sendRelayError(res: Response, error: RelayNodeError): void {
  res.status(errorStatus(error)).json({ error });
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Partial<SessionSummary>;
  return (
    typeof session.id === 'string' &&
    (session.type === 'agent' || session.type === 'terminal') &&
    (session.mode === 'pty' || session.mode === 'web') &&
    typeof session.repoPath === 'string' &&
    (typeof session.worktreePath === 'string' || session.worktreePath === null) &&
    typeof session.cwd === 'string' &&
    typeof session.repoName === 'string' &&
    typeof session.branchName === 'string' &&
    typeof session.displayName === 'string' &&
    typeof session.createdAt === 'string' &&
    typeof session.lastActivity === 'string' &&
    typeof session.idle === 'boolean' &&
    (typeof session.customCommand === 'string' || session.customCommand === null) &&
    (session.status === 'active' || session.status === 'disconnected') &&
    typeof session.needsBranchRename === 'boolean' &&
    typeof session.agentState === 'string'
  );
}

function scopedNodeSession(nodeId: string, session: SessionSummary): SessionSummary {
  const scoped: SessionSummary = { ...session };
  delete scoped.nodeId;
  delete scoped.globalSessionId;
  delete scoped.repoInstanceId;
  delete scoped.worktreeInstanceId;

  return {
    ...scoped,
    nodeId,
    globalSessionId: createGlobalSessionId(nodeId, scoped.id),
    ...(scoped.repoPath ? { repoInstanceId: createRepoInstanceId(nodeId, scoped.repoPath) } : {}),
    ...(scoped.worktreePath
      ? { worktreeInstanceId: createWorktreeInstanceId(nodeId, scoped.worktreePath) }
      : {}),
  };
}

function sessionFromPayload(payload: unknown): SessionSummary {
  if (typeof payload !== 'object' || payload === null) {
    throw new HubNodeRegistryError('INVALID_REQUEST', 'node session create response was malformed');
  }
  const session = (payload as Record<string, unknown>)['session'];
  if (!isSessionSummary(session)) {
    throw new HubNodeRegistryError('INVALID_REQUEST', 'node session create response was malformed');
  }
  return session;
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

const serviceModeValues = new Set<BootstrapServiceMode>([
  'manual',
  'launchd',
  'systemd-user',
  'systemd-system',
  'wsl-systemd',
  'wsl-manual',
]);

function serviceModesFromBody(body: Record<string, unknown>): BootstrapServiceMode[] | undefined {
  const serviceModes = body['serviceModes'];
  if (!Array.isArray(serviceModes)) return undefined;
  return serviceModes.filter(
    (mode): mode is BootstrapServiceMode =>
      typeof mode === 'string' && serviceModeValues.has(mode as BootstrapServiceMode)
  );
}

function stringFromBody(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hubUrlFromRequest(req: Request, body: Record<string, unknown>): string {
  const explicitHubUrl = stringFromBody(body, 'hubUrl');
  if (explicitHubUrl) return explicitHubUrl;
  const forwardedProto = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
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
    const hubUrl = hubUrlFromRequest(req, body);
    const sshTarget = stringFromBody(body, 'sshTarget');
    const tailscaleTarget = stringFromBody(body, 'tailscaleTarget');
    const serviceModes = serviceModesFromBody(body);
    res.status(201).json({
      ...pairToken,
      hubUrl,
      suggestedCommands: generateBootstrapCommands({
        hubUrl,
        pairToken: pairToken.pairToken,
        ...(sshTarget ? { sshTarget } : {}),
        ...(tailscaleTarget ? { tailscaleTarget } : {}),
        ...(serviceModes ? { serviceModes } : {}),
      }),
      diagnostics: BOOTSTRAP_DIAGNOSTICS,
    });
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

  router.post('/hub/nodes/:nodeId/sessions', requireAuth, async (req, res) => {
    const { nodeId } = req.params;
    if (!nodeId) {
      sendRelayError(res, relayError('INVALID_REQUEST', 'nodeId is required'));
      return;
    }
    const node = registry.listNodes().find((candidate) => candidate.nodeId === nodeId);
    if (!node || node.status === 'revoked') {
      sendRelayError(res, relayError('NOT_FOUND', 'node is not paired'));
      return;
    }
    if (node.protocolVersion !== RELAY_NODE_LINK_PROTOCOL_VERSION) {
      const [nodeMajor] = node.protocolVersion.split('.');
      const [hubMajor] = RELAY_NODE_LINK_PROTOCOL_VERSION.split('.');
      sendRelayError(
        res,
        relayError(
          nodeMajor === hubMajor ? 'VERSION_SKEW' : 'PROTOCOL_INCOMPATIBLE',
          `relay-node-link protocol ${node.protocolVersion} must exactly match hub protocol ${RELAY_NODE_LINK_PROTOCOL_VERSION}`
        )
      );
      return;
    }
    if (node.capabilities.core.tmux !== 'available') {
      sendRelayError(
        res,
        relayError(
          'NODE_UNSUPPORTED',
          `node ${nodeId} cannot host tmux-backed PTY sessions`
        )
      );
      return;
    }
    if (node.status !== 'online' || !options.nodeLinks?.hasActiveNode(nodeId)) {
      sendRelayError(
        res,
        relayError('NODE_OFFLINE', `node ${nodeId} has no live reverse link`, true)
      );
      return;
    }

    try {
      const payload = await options.nodeLinks.request(nodeId, 'sessions.create', bodyRecord(req));
      res.status(201).json(scopedNodeSession(nodeId, sessionFromPayload(payload)));
    } catch (error) {
      if (error instanceof HubNodeLinkError) {
        sendRelayError(res, error.relayNodeError);
        return;
      }
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
