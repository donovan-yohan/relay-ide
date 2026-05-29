import * as fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeRouter } from '../server/hub-node-router.js';
import { createHubNodeLinkManager } from '../server/hub-node-link.js';
import { createLocalRelayNode } from '../server/local-node.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';
import { setupWebSocket } from '../server/ws.js';
import type { SessionSummary } from '../server/types.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import {
  RELAY_NODE_LINK_PROTOCOL,
  RELAY_NODE_LINK_PROTOCOL_VERSION,
  type RelayNodeEnvelope,
} from '../shared/relay-node-protocol.js';
import {
  createLocalCompatibilitySessionEnvelope,
  createRoutedNodeSessionEnvelope,
} from '../shared/session-envelope.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';
import { mintPairTokenWithOperatorGrantForTest } from './helpers/operator-pairing.js';

function manifest(overrides: Partial<NodeManifest> = {}): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'linux',
    arch: 'x64',
    hostname: 'session-route-node',
    relayVersion: '0.1.0-test',
    generatedAt: '2026-01-02T03:04:05.000Z',
    wsl: { detected: false, version: null, systemd: false },
    serviceManager: {
      kind: 'systemd-user',
      label: 'systemd user',
      supported: true,
      installable: true,
      installHint: 'install',
      uninstallHint: 'uninstall',
      message: 'ok',
      caveats: [],
    },
    capabilities: {
      tmux: { id: 'tmux', label: 'tmux', status: 'available', message: 'ok' },
      git: { id: 'git', label: 'Git', status: 'available', message: 'ok' },
      clipboard: {
        id: 'clipboard',
        label: 'Clipboard',
        status: 'unknown',
        message: 'unknown',
      },
      browserAutomation: {
        id: 'browserAutomation',
        label: 'Browser automation',
        status: 'degraded',
        message: 'missing deps',
      },
      githubCli: {
        id: 'githubCli',
        label: 'GitHub CLI',
        status: 'available',
        message: 'ok',
      },
      tailscale: {
        id: 'tailscale',
        label: 'Tailscale CLI',
        status: 'unavailable',
        message: 'missing',
      },
      ssh: {
        id: 'ssh',
        label: 'SSH client',
        status: 'available',
        message: 'ok',
      },
      agents: {
        claude: {
          id: 'claude',
          label: 'Claude',
          status: 'available',
          message: 'ok',
        },
      },
    },
    ...overrides,
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing server address');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

async function nextJson(ws: WebSocket): Promise<RelayNodeEnvelope> {
  return await new Promise<RelayNodeEnvelope>((resolve) => {
    ws.once('message', (data) =>
      resolve(JSON.parse(data.toString()) as RelayNodeEnvelope)
    );
  });
}

async function nextEvent(ws: WebSocket): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve) => {
    ws.once('message', (data) =>
      resolve(JSON.parse(data.toString()) as Record<string, unknown>)
    );
  });
}

async function rawUpgrade(port: number, pathName: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        `GET ${pathName} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      );
    });
    let response = '';
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error('timed out waiting for raw upgrade response'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString();
      socket.destroy();
      resolve(response);
    });
    socket.on('error', reject);
  });
}

async function pairNode(
  base: string,
  nodeManifest = manifest()
): Promise<{
  token: string;
  nodeId: string;
}> {
  const pair = await mintPairTokenWithOperatorGrantForTest(base, {
    displayName: 'Remote Node',
  });

  const exchangeRes = await fetch(`${base}/hub/pairing/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairToken: pair.pairToken, manifest: nodeManifest }),
  });
  expect(exchangeRes.status).toBe(201);
  const exchange = (await exchangeRes.json()) as {
    credential: { token: string; nodeId: string };
  };
  return {
    token: exchange.credential.token,
    nodeId: exchange.credential.nodeId,
  };
}

function remoteSession(nodeId: string): SessionSummary {
  return {
    id: 'remote-session-1',
    type: 'terminal',
    agent: 'claude',
    mode: 'pty',
    repoPath: '/srv/relay-ide',
    worktreePath: null,
    cwd: '/srv/relay-ide',
    repoName: 'relay-ide',
    branchName: 'nightly',
    displayName: 'relay-ide terminal',
    createdAt: '2026-01-02T03:04:05.000Z',
    lastActivity: '2026-01-02T03:04:05.000Z',
    idle: false,
    customCommand: null,
    nodeId,
    globalSessionId: `${nodeId}:remote-session-1`,
    repoInstanceId: `${nodeId}:%2Fsrv%2Frelay-ide`,
    useTmux: true,
    tmuxSessionName: 'relay-ide-remote-session-1',
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
  };
}

function seedRemoteSessionEnvelope(
  sessionEnvelopes: ReturnType<typeof createSessionEnvelopeRegistry>,
  nodeId: string
): void {
  sessionEnvelopes.upsert(
    createRoutedNodeSessionEnvelope({
      sessionId: 'remote-session-1',
      globalSessionId: `${nodeId}:remote-session-1`,
      nodeId,
      repoPath: '/srv/relay-ide',
      cwd: '/srv/relay-ide',
      issuedAt: '2026-01-02T03:04:05.000Z',
    })
  );
}

function grantNodeCapabilitiesForTest(
  registry: ReturnType<typeof createHubNodeRegistry>,
  nodeId: string,
  capabilities: RelayCapabilityBit[]
): void {
  const state = (registry as unknown as {
    state: {
      nodes: Array<{
        nodeId: string;
        acl?: {
          grants: {
            allowed: RelayCapabilityBit[];
            requiresConfirmation: RelayCapabilityBit[];
          };
          lifecycle: { updatedAt: string };
        };
      }>;
    };
  }).state;
  const node = state.nodes.find((candidate) => candidate.nodeId === nodeId);
  expect(node?.acl).toBeDefined();
  for (const capability of capabilities) {
    if (!node!.acl!.grants.allowed.includes(capability)) {
      node!.acl!.grants.allowed.push(capability);
    }
  }
  node!.acl!.lifecycle.updatedAt = '2026-01-02T03:04:05.000Z';
}

describe('hub-routed node session create and attach', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  async function startHub(now = () => new Date('2026-01-02T03:04:05.000Z')) {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-hub-session-route-')
    );
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const registry = createHubNodeRegistry({
      storagePath: path.join(tmpDir, 'nodes.json'),
      now,
    });
    const nodeLinks = createHubNodeLinkManager();
    const sessionEnvelopes = createSessionEnvelopeRegistry();
    const auditEntries: SecurityAuditEntryInput[] = [];
    const app = express();
    app.use(express.json());
    const requireAuth: express.RequestHandler = (req, res, next) => {
      if (req.header('x-test-auth') === 'yes') next();
      else res.status(401).json({ error: 'Unauthorized' });
    };
    const cliGatewayAuth: express.RequestHandler = (req, res, next) => {
      if (req.header('x-test-auth') === 'yes') {
        next();
        return;
      }
      if (req.header('x-relay-cli-actor-token') === 'v1') {
        res.status(401).json({ error: 'actor command route binding required' });
        return;
      }
      if (
        req.header('x-relay-cli-gateway') === 'v1' &&
        req.header('authorization') === 'Bearer scoped-test-token'
      ) {
        next();
        return;
      }
      res.status(401).json({ error: 'Unauthorized' });
    };
    const cliGatewayAuthForActorCommand =
      (expectedCommand: string): express.RequestHandler =>
      (req, res, next) => {
        if (req.header('x-relay-cli-actor-token') === 'v1') {
          if (
            req.header('x-relay-cli-gateway') === 'v1' &&
            req.header('authorization') === 'Bearer scoped-test-token' &&
            req.header('x-relay-cli-command') === expectedCommand
          ) {
            next();
            return;
          }
          res.status(401).json({ error: 'actor command route binding required' });
          return;
        }
        cliGatewayAuth(req, res, next);
      };
    app.use(
      createHubNodeRouter({
        registry,
        nodeLinks,
        sessionEnvelopes,
        auditSink: { append: (entry) => auditEntries.push(entry) },
        now,
        requireAuth,
        cliGatewayAuth,
        cliGatewayAuthForActorCommand,
      })
    );
    const server = http.createServer(app);
    setupWebSocket(
      server,
      new Set(),
      null,
      undefined,
      true,
      createLocalRelayNode({ nodeId: 'hub-node' }),
      registry,
      nodeLinks,
      sessionEnvelopes
    );
    const port = await listen(server);
    cleanup.push(() => close(server));
    return {
      base: `http://127.0.0.1:${port}`,
      wsBase: `ws://127.0.0.1:${port}`,
      port,
      nodeLinks,
      sessionEnvelopes,
      auditEntries,
      registry,
    };
  }

  it('lets v1 CLI gateway scoped bearer auth read nodes and create routed sessions without cookies', async () => {
    const { base } = await startHub();
    const { nodeId } = await pairNode(base);
    const cliHeaders = {
      authorization: 'Bearer scoped-test-token',
      'x-relay-cli-gateway': 'v1',
    };

    const nodesRes = await fetch(`${base}/nodes`, { headers: cliHeaders });
    expect(nodesRes.status).toBe(200);
    expect(await nodesRes.json()).toMatchObject({ nodes: [{ nodeId }] });

    const createRes = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { ...cliHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
      }
    );
    expect(createRes.status).toBe(404);
    expect(await createRes.json()).toMatchObject({
      error: { code: 'NODE_OFFLINE', retryable: true },
    });
  });

  it('binds actor-token nodes.list auth to /nodes instead of caller-spoofed audit or log routes', async () => {
    const { base } = await startHub();
    const { nodeId } = await pairNode(base);
    const actorHeaders = {
      authorization: 'Bearer scoped-test-token',
      'x-relay-cli-gateway': 'v1',
      'x-relay-cli-actor-token': 'v1',
      'x-relay-cli-command': 'nodes.list',
    };

    const nodesRes = await fetch(`${base}/nodes`, { headers: actorHeaders });
    expect(nodesRes.status).toBe(200);
    expect(await nodesRes.json()).toMatchObject({ nodes: [{ nodeId }] });

    const auditVerifyRes = await fetch(`${base}/hub/audit/verify`, {
      headers: actorHeaders,
    });
    expect(auditVerifyRes.status).toBe(401);

    const auditEntriesRes = await fetch(`${base}/hub/audit/entries`, {
      headers: actorHeaders,
    });
    expect(auditEntriesRes.status).toBe(401);

    const logsRes = await fetch(`${base}/hub/nodes/nope/logs`, {
      headers: actorHeaders,
    });
    expect(logsRes.status).toBe(401);
  });

  it('renews routed scoped session expiry without changing authority', async () => {
    const { base, sessionEnvelopes, auditEntries } = await startHub();
    const { nodeId } = await pairNode(base);
    sessionEnvelopes.upsert(
      createRoutedNodeSessionEnvelope({
        sessionId: 'remote-session-1',
        globalSessionId: `${nodeId}:remote-session-1`,
        nodeId,
        repoPath: '/srv/relay-ide',
        cwd: '/srv/relay-ide',
        issuedAt: '2026-01-02T03:04:05.000Z',
        expiresAt: '2026-01-02T03:05:00.000Z',
        correlationId: 'corr-route-renew',
      })
    );
    const before = sessionEnvelopes.read(`${nodeId}:remote-session-1`);

    const res = await fetch(`${base}/hub/scoped-sessions/remote-session-1/renew`, {
      method: 'POST',
      headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId, ttlSeconds: 300 }),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { session: { expiresAt: string } };
    expect(payload.session.expiresAt).toBe('2026-01-02T03:09:05.000Z');
    const after = sessionEnvelopes.read(`${nodeId}:remote-session-1`);
    expect(after?.expiresAt).toBe('2026-01-02T03:09:05.000Z');
    expect({
      intent: after?.intent,
      scope: after?.scope,
      peerIdentity: after?.peerIdentity,
      nodeId: after?.nodeId,
      globalSessionId: after?.globalSessionId,
      issuedAt: after?.issuedAt,
      correlationId: after?.correlationId,
    }).toEqual({
      intent: before?.intent,
      scope: before?.scope,
      peerIdentity: before?.peerIdentity,
      nodeId: before?.nodeId,
      globalSessionId: before?.globalSessionId,
      issuedAt: before?.issuedAt,
      correlationId: before?.correlationId,
    });
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        eventType: 'grant',
        decision: 'allow',
        reasonCode: 'SESSION_RENEWED',
        sessionId: 'remote-session-1',
      })
    );
  });

  it('re-evaluates node policy before extending a routed scoped session', async () => {
    const { base, sessionEnvelopes } = await startHub();
    const nodeId = 'unpaired-renew-node';
    sessionEnvelopes.upsert(
      createRoutedNodeSessionEnvelope({
        sessionId: 'policy-renew-route',
        globalSessionId: `${nodeId}:policy-renew-route`,
        nodeId,
        repoPath: '/srv/relay-ide',
        cwd: '/srv/relay-ide',
        issuedAt: '2026-01-02T03:04:05.000Z',
        expiresAt: '2026-01-02T03:05:00.000Z',
      })
    );

    const res = await fetch(`${base}/hub/scoped-sessions/policy-renew-route/renew`, {
      method: 'POST',
      headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId, ttlSeconds: 300 }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        details: { reasonCode: 'POLICY_NODE_NOT_PAIRED', requiredBits: ['session:attach'] },
      },
    });
    expect(sessionEnvelopes.read('policy-renew-route', nodeId)?.expiresAt).toBe(
      '2026-01-02T03:05:00.000Z'
    );
  });

  it('fails closed when renew addresses duplicate local session ids without nodeId', async () => {
    const { base, sessionEnvelopes } = await startHub();
    for (const nodeId of ['node-a', 'node-b']) {
      sessionEnvelopes.upsert(
        createRoutedNodeSessionEnvelope({
          sessionId: 'duplicate-renew-route',
          globalSessionId: `${nodeId}:duplicate-renew-route`,
          nodeId,
          repoPath: `/srv/${nodeId}`,
          cwd: `/srv/${nodeId}`,
          issuedAt: '2026-01-02T03:04:05.000Z',
          expiresAt: '2026-01-02T03:05:00.000Z',
        })
      );
    }

    const res = await fetch(`${base}/hub/scoped-sessions/duplicate-renew-route/renew`, {
      method: 'POST',
      headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 300 }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'INVALID_REQUEST',
        details: { reasonCode: 'AMBIGUOUS_LOCAL_SESSION_ID', matches: 2 },
      },
    });
  });

  it('returns typed INVALID_REQUEST for overflow renewal TTL input', async () => {
    const { base, sessionEnvelopes } = await startHub();
    const { nodeId } = await pairNode(base);
    sessionEnvelopes.upsert(
      createRoutedNodeSessionEnvelope({
        sessionId: 'overflow-renew-route',
        globalSessionId: `${nodeId}:overflow-renew-route`,
        nodeId,
        repoPath: '/srv/relay-ide',
        cwd: '/srv/relay-ide',
        issuedAt: '2026-01-02T03:04:05.000Z',
        expiresAt: '2026-01-02T03:05:00.000Z',
      })
    );

    const res = await fetch(`${base}/hub/scoped-sessions/overflow-renew-route/renew`, {
      method: 'POST',
      headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId, ttlSeconds: Number.MAX_SAFE_INTEGER }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'INVALID_REQUEST',
        details: { reasonCode: 'INVALID_LIFECYCLE_INPUT', field: 'ttlSeconds' },
      },
    });
  });

  it('denies scoped session renewals for expired revoked mismatched non-renewable and authority mutation cases', async () => {
    const { base, sessionEnvelopes, auditEntries } = await startHub();
    const { nodeId } = await pairNode(base);
    for (const [sessionId, expiresAt, revocable] of [
      ['expired-renew-route', '2026-01-02T03:04:00.000Z', true],
      ['revoked-renew-route', '2026-01-02T03:10:00.000Z', true],
      ['mismatch-renew-route', '2026-01-02T03:10:00.000Z', true],
      ['nonrenew-renew-route', '2026-01-02T03:10:00.000Z', false],
      ['authority-renew-route', '2026-01-02T03:10:00.000Z', true],
    ] as const) {
      sessionEnvelopes.upsert(
        createRoutedNodeSessionEnvelope({
          sessionId,
          globalSessionId: `${nodeId}:${sessionId}`,
          nodeId,
          repoPath: '/srv/relay-ide',
          cwd: '/srv/relay-ide',
          issuedAt: '2026-01-02T03:04:05.000Z',
          expiresAt,
          revocable,
        })
      );
    }
    sessionEnvelopes.revoke('revoked-renew-route', { nodeId, reason: 'test-revoked' });

    async function renew(sessionId: string, body: Record<string, unknown>) {
      const res = await fetch(`${base}/hub/scoped-sessions/${sessionId}/renew`, {
        method: 'POST',
        headers: { 'x-test-auth': 'yes', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, payload: await res.json() };
    }

    await expect(renew('expired-renew-route', { nodeId, ttlSeconds: 300 })).resolves.toMatchObject({
      status: 403,
      payload: { error: { code: 'SESSION_EXPIRED' } },
    });
    await expect(renew('revoked-renew-route', { nodeId, ttlSeconds: 300 })).resolves.toMatchObject({
      status: 403,
      payload: { error: { code: 'SESSION_REVOKED' } },
    });
    await expect(
      renew('mismatch-renew-route', { nodeId: 'node-b', ttlSeconds: 300 })
    ).resolves.toMatchObject({
      status: 403,
      payload: { error: { code: 'SESSION_MISMATCH' } },
    });
    await expect(renew('nonrenew-renew-route', { nodeId, ttlSeconds: 300 })).resolves.toMatchObject({
      status: 403,
      payload: { error: { code: 'SESSION_NON_RENEWABLE' } },
    });
    await expect(
      renew('authority-renew-route', { nodeId, ttlSeconds: 300, scope: { kind: 'node-cwd' } })
    ).resolves.toMatchObject({
      status: 403,
      payload: { error: { code: 'SESSION_MISMATCH' } },
    });
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'expiry', reasonCode: 'SESSION_EXPIRED' }),
        expect.objectContaining({ eventType: 'revocation', reasonCode: 'SESSION_REVOKED' }),
        expect.objectContaining({ eventType: 'denial', reasonCode: 'SESSION_NODE_MISMATCH' }),
        expect.objectContaining({ eventType: 'denial', reasonCode: 'SESSION_NON_RENEWABLE' }),
        expect.objectContaining({ eventType: 'denial', reasonCode: 'SESSION_RENEW_AUTHORITY_IMMUTABLE' }),
      ])
    );
  });

  it('rejects hidden v1 create fields before node-link routing', async () => {
    const { base } = await startHub();
    const { nodeId } = await pairNode(base);

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer scoped-test-token',
          'x-relay-cli-gateway': 'v1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repoPath: '/srv/relay-ide',
          type: 'terminal',
          command: 'hidden-non-contract-field',
        }),
      }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
        details: { field: 'command' },
      },
    });
  });

  it('defaults routed v1 creates to agent and forwards only sanitized fields', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer scoped-test-token',
          'x-relay-cli-gateway': 'v1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ repoPath: '/srv/relay-ide' }),
      }
    );

    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      nodeId,
      channel: 'rpc',
      type: 'sessions.create',
      payload: { repoPath: '/srv/relay-ide', type: 'agent' },
    });
    expect(request.payload as Record<string, unknown>).not.toHaveProperty('nodeId');
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            ...remoteSession(nodeId),
            type: 'agent',
            displayName: 'relay-ide agent',
          },
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ type: 'agent', nodeId });
  });

  it('rejects routed v1 create bodies with a conflicting nodeId', async () => {
    const { base } = await startHub();
    const { nodeId } = await pairNode(base);

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer scoped-test-token',
          'x-relay-cli-gateway': 'v1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          nodeId: 'other-node',
          repoPath: '/srv/relay-ide',
          type: 'terminal',
        }),
      }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
        details: { field: 'nodeId', nodeId, bodyNodeId: 'other-node' },
      },
    });
  });

  it('returns NODE_OFFLINE when a selected node has no live reverse link', async () => {
    const { base } = await startHub();
    const { nodeId } = await pairNode(base);

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
      }
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: 'NODE_OFFLINE', retryable: true },
    });
  });

  it('returns NODE_UNSUPPORTED when the node cannot host tmux PTY sessions', async () => {
    const { base } = await startHub();
    const { nodeId } = await pairNode(
      base,
      manifest({
        capabilities: {
          ...manifest().capabilities,
          tmux: {
            id: 'tmux',
            label: 'tmux',
            status: 'unavailable',
            message: 'missing',
          },
        },
      })
    );

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
      }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'NODE_UNSUPPORTED', retryable: false },
    });
  });

  it('routes session creation to the selected connected node and scopes the returned session', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
      }
    );

    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      nodeId,
      channel: 'rpc',
      type: 'sessions.create',
      payload: { repoPath: '/srv/relay-ide', type: 'terminal' },
    });
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            ...remoteSession(nodeId),
            nodeId: undefined,
            globalSessionId: undefined,
          },
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      id: 'remote-session-1',
      nodeId,
      globalSessionId: `${nodeId}:remote-session-1`,
      mode: 'pty',
    });
  });

  it('forces routed-node envelope semantics when the node returns a local compatibility envelope', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
      }
    );

    const request = await nextJson(nodeWs);
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            ...remoteSession(nodeId),
            sessionEnvelope: createLocalCompatibilitySessionEnvelope({
              sessionId: 'remote-session-1',
              nodeId,
              cwd: '/srv/relay-ide',
              repoPath: '/srv/relay-ide',
              worktreePath: null,
              issuedAt: '2026-01-02T03:04:05.000Z',
            }),
          },
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(201);
    const scoped = (await res.json()) as SessionSummary;
    expect(scoped.sessionEnvelope).toMatchObject({
      sessionId: 'remote-session-1',
      nodeId,
      globalSessionId: `${nodeId}:remote-session-1`,
      intent: { kind: 'routed-node-session' },
      peerIdentity: { kind: 'relay-node', nodeId },
      scope: {
        kind: 'repo',
        nodeId,
        cwd: '/srv/relay-ide',
        repoPath: '/srv/relay-ide',
        worktreePath: null,
      },
    });
  });

  it('routes remote session delete to the selected connected node', async () => {
    const { base, wsBase, sessionEnvelopes, registry } = await startHub();
    const { token, nodeId } = await pairNode(base);
    grantNodeCapabilitiesForTest(registry, nodeId, ['session:control:kill']);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const deletePromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/remote-session-1`,
      {
        method: 'DELETE',
        headers: { 'x-test-auth': 'yes' },
      }
    );

    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      nodeId,
      channel: 'rpc',
      type: 'sessions.kill',
      payload: { id: 'remote-session-1' },
    });
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'sessions.kill.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: { ok: true },
      })
    );

    const res = await deletePromise;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns NODE_OFFLINE when deleting a remote session on a node with no live reverse link', async () => {
    const { base } = await startHub();
    const { nodeId } = await pairNode(base);

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/remote-session-1`,
      {
        method: 'DELETE',
        headers: { 'x-test-auth': 'yes' },
      }
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: 'NODE_OFFLINE', retryable: true },
    });
  });

  it('does not trust node-provided scoped identity fields when worktree scope is absent', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
      }
    );

    const request = await nextJson(nodeWs);
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            ...remoteSession(nodeId),
            nodeId: 'spoofed-node',
            globalSessionId: 'spoofed-global-session',
            repoInstanceId: 'spoofed-repo-instance',
            worktreeInstanceId: 'stale-worktree-instance',
            worktreePath: null,
          },
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(201);
    const scoped = (await res.json()) as Record<string, unknown>;
    expect(scoped).toMatchObject({
      nodeId,
      globalSessionId: `${nodeId}:remote-session-1`,
      repoInstanceId: `${nodeId}:%2Fsrv%2Frelay-ide`,
      worktreePath: null,
    });
    expect(scoped).not.toHaveProperty('worktreeInstanceId');
  });

  it('routes a non-repo session (no repoPath/worktreePath/branchName) without inventing repoInstanceId or worktreeInstanceId', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ type: 'terminal' }),
      }
    );

    const request = await nextJson(nodeWs);
    // Per CodeRabbit review on PR #457: explicitly assert the hub
    // forwards the create request to the node WITHOUT synthesising
    // repo fields. This pins the contract that the node side gets the
    // opaque payload as-sent and can decide for itself whether it's a
    // repo-bound session.
    expect(request.channel).toBe('rpc');
    expect(request.type).toBe('sessions.create');
    expect(request.payload).toEqual({ type: 'terminal' });
    expect(request.payload as Record<string, unknown>).not.toHaveProperty(
      'repoPath'
    );
    expect(request.payload as Record<string, unknown>).not.toHaveProperty(
      'worktreePath'
    );
    expect(request.payload as Record<string, unknown>).not.toHaveProperty(
      'branchName'
    );

    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'sessions.create.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          session: {
            id: 'non-repo-session-1',
            type: 'terminal',
            agent: 'claude',
            mode: 'pty',
            // No repoPath / worktreePath / branchName — non-repo session.
            cwd: '/home/user',
            repoName: '',
            displayName: 'raw shell',
            createdAt: '2026-01-02T03:04:05.000Z',
            lastActivity: '2026-01-02T03:04:05.000Z',
            idle: false,
            customCommand: null,
            useTmux: true,
            tmuxSessionName: 'relay-non-repo-1',
            status: 'active',
            needsBranchRename: false,
            agentState: 'idle',
          },
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(201);
    const scoped = (await res.json()) as Record<string, unknown>;
    expect(scoped).toMatchObject({
      nodeId,
      globalSessionId: `${nodeId}:non-repo-session-1`,
      id: 'non-repo-session-1',
      cwd: '/home/user',
    });
    expect(scoped).not.toHaveProperty('repoInstanceId');
    expect(scoped).not.toHaveProperty('worktreeInstanceId');
    expect(scoped).not.toHaveProperty('repoPath');
    expect(scoped).not.toHaveProperty('worktreePath');
    expect(scoped).not.toHaveProperty('branchName');
  });

  it('preserves typed node RPC errors when session creation fails on the node link', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const createPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
      }
    );

    const request = await nextJson(nodeWs);
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'sessions.create.error',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        error: {
          code: 'NODE_OFFLINE',
          message: 'remote node lost its tmux session host',
          retryable: true,
        },
      })
    );

    const res = await createPromise;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        code: 'NODE_OFFLINE',
        message: 'remote node lost its tmux session host',
        retryable: true,
      },
    });
  });

  it('proxies browser PTY attach through the hub to the node-owned session', async () => {
    const { base, wsBase, sessionEnvelopes } = await startHub();
    const { token, nodeId } = await pairNode(base);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const browserWs = new WebSocket(
      `${wsBase}/nodes/${encodeURIComponent(nodeId)}/ws/sessions/remote-session-1`
    );
    cleanup.push(() => browserWs.close());
    await waitForOpen(browserWs);

    const attach = await nextJson(nodeWs);
    expect(attach).toMatchObject({
      nodeId,
      channel: 'pty',
      type: 'pty.attach',
      payload: { sessionId: 'remote-session-1' },
    });
    expect(attach.streamId).toBeTruthy();

    const browserMessage = new Promise<string>((resolve) => {
      browserWs.once('message', (data) => resolve(data.toString()));
    });
    nodeWs.send(
      JSON.stringify({
        protocol: attach.protocol,
        protocolVersion: attach.protocolVersion,
        nodeId,
        channel: 'pty',
        type: 'pty.data',
        streamId: attach.streamId,
        timestamp: new Date().toISOString(),
        payload: { data: 'hello from node' },
      })
    );
    expect(await browserMessage).toBe('hello from node');

    browserWs.send('input from browser');
    const input = await nextJson(nodeWs);
    expect(input).toMatchObject({
      channel: 'pty',
      type: 'pty.input',
      streamId: attach.streamId,
      payload: { data: 'input from browser' },
    });

    browserWs.send(JSON.stringify({ type: 'resize', cols: 101, rows: 33 }));
    const resize = await nextJson(nodeWs);
    expect(resize).toMatchObject({
      channel: 'pty',
      type: 'pty.resize',
      streamId: attach.streamId,
      payload: { cols: 101, rows: 33 },
    });

    const browserClose = new Promise<CloseEvent>((resolve) => {
      browserWs.once('close', (code, reason) =>
        resolve({ code, reason } as unknown as CloseEvent)
      );
    });
    nodeWs.send(
      JSON.stringify({
        protocol: attach.protocol,
        protocolVersion: attach.protocolVersion,
        nodeId,
        channel: 'pty',
        type: 'pty.exit',
        streamId: attach.streamId,
        timestamp: new Date().toISOString(),
      })
    );
    expect((await browserClose).code).toBe(1000);
  });

  it('rejects pending RPCs promptly when a node reverse link is replaced', async () => {
    const { base, wsBase, nodeLinks } = await startHub();
    const { token, nodeId } = await pairNode(base);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const pending = nodeLinks.request(nodeId, 'sessions.create', {
      repoPath: '/srv/relay-ide',
      type: 'terminal',
    });
    const pendingFailure = pending.then(
      () => new Error('pending RPC unexpectedly resolved'),
      (error: unknown) => error
    );
    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      nodeId,
      channel: 'rpc',
      type: 'sessions.create',
    });

    const replacementWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => replacementWs.close());
    await waitForOpen(replacementWs);

    await expect(pendingFailure).resolves.toMatchObject({
      relayNodeError: {
        code: 'NODE_OFFLINE',
        message: `node ${nodeId} link closed`,
        retryable: true,
      },
    });
  });

  it('closes browser PTY streams promptly when a node reverse link is replaced', async () => {
    const { base, wsBase, sessionEnvelopes } = await startHub();
    const { token, nodeId } = await pairNode(base);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const browserWs = new WebSocket(
      `${wsBase}/nodes/${encodeURIComponent(nodeId)}/ws/sessions/remote-session-1`
    );
    cleanup.push(() => browserWs.close());
    await waitForOpen(browserWs);

    const attach = await nextJson(nodeWs);
    expect(attach).toMatchObject({
      nodeId,
      channel: 'pty',
      type: 'pty.attach',
      payload: { sessionId: 'remote-session-1' },
    });

    const browserClose = new Promise<{ code: number; reason: string }>(
      (resolve) => {
        browserWs.once('close', (code, reason) =>
          resolve({ code, reason: reason.toString() })
        );
      }
    );
    const replacementWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => replacementWs.close());
    await waitForOpen(replacementWs);

    await expect(
      Promise.race([
        browserClose,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error('browser PTY stream stayed open after replacement')
              ),
            250
          )
        ),
      ])
    ).resolves.toMatchObject({ code: 1011, reason: 'node link closed' });
  });

  it('broadcasts remote node session events with node-scoped identity', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const eventsWs = new WebSocket(`${wsBase}/ws/events`);
    cleanup.push(() => eventsWs.close());
    await waitForOpen(eventsWs);

    const eventPromise = nextEvent(eventsWs);
    nodeWs.send(
      JSON.stringify({
        protocol: RELAY_NODE_LINK_PROTOCOL,
        protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
        nodeId,
        channel: 'events',
        type: 'events.publish',
        timestamp: new Date().toISOString(),
        payload: {
          type: 'session-activity-changed',
          sessionId: 'remote-session-1',
          timestamp: '2026-01-02T03:04:05.000Z',
        },
      })
    );

    await expect(eventPromise).resolves.toMatchObject({
      type: 'session-activity-changed',
      nodeId,
      sessionId: 'remote-session-1',
      localSessionId: 'remote-session-1',
      globalSessionId: `${nodeId}:remote-session-1`,
      timestamp: '2026-01-02T03:04:05.000Z',
    });
  });

  it('routes read-only File RPC requests with scoped root and bounds', async () => {
    const { base, wsBase, sessionEnvelopes } = await startHub();
    const { token, nodeId } = await pairNode(base);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const readPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/remote-session-1/files/read`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ path: 'README.md', maxBytes: 999_999, maxLines: 1 }),
      }
    );

    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      nodeId,
      channel: 'rpc',
      type: 'fs.read',
      payload: {
        sessionId: 'remote-session-1',
        root: '/srv/relay-ide',
        cwd: '/srv/relay-ide',
        path: '/srv/relay-ide/README.md',
        maxBytes: 65536,
        maxLines: 1,
      },
    });
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'fs.read.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          operation: 'read',
          root: '/srv/relay-ide',
          cwd: '/srv/relay-ide',
          path: '/srv/relay-ide/README.md',
          encoding: 'utf8',
          content: '# Relay',
          bytesRead: 7,
          truncatedBytes: false,
          truncatedLines: false,
          maxBytes: 65536,
          maxLines: 1,
        },
      })
    );

    const res = await readPromise;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ operation: 'read', content: '# Relay' });
  });

  it('routes read-only File RPC tail requests with scoped root and follow bounds', async () => {
    const { base, wsBase, sessionEnvelopes } = await startHub();
    const { token, nodeId } = await pairNode(base);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const tailPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/remote-session-1/files/tail`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ path: 'logs/app.log', maxBytes: 999_999, maxLines: 1 }),
      }
    );

    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      nodeId,
      channel: 'rpc',
      type: 'fs.tail',
      payload: {
        sessionId: 'remote-session-1',
        root: '/srv/relay-ide',
        cwd: '/srv/relay-ide',
        path: '/srv/relay-ide/logs/app.log',
        maxBytes: 65536,
        maxLines: 1,
        follow: false,
        maxFollowChunkBytes: 16384,
      },
    });
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'fs.tail.result',
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        payload: {
          operation: 'tail',
          root: '/srv/relay-ide',
          cwd: '/srv/relay-ide',
          path: '/srv/relay-ide/logs/app.log',
          encoding: 'utf8',
          content: 'last line\n',
          bytesRead: 10,
          startOffset: 100,
          endOffset: 110,
          fileSize: 110,
          truncatedBytes: true,
          truncatedLines: false,
          follow: false,
          maxBytes: 65536,
          maxLines: 1,
          maxFollowChunkBytes: 16384,
        },
      })
    );

    const res = await tailPromise;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ operation: 'tail', content: 'last line\n' });
  });

  it('returns typed JSON errors for initial File RPC tail follow denials before opening text stream', async () => {
    const { base, wsBase, sessionEnvelopes } = await startHub();
    const { token, nodeId } = await pairNode(base);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const tailPromise = fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/remote-session-1/files/tail`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ path: 'logs', follow: true }),
      }
    );

    const request = await nextJson(nodeWs);
    expect(request).toMatchObject({
      nodeId,
      channel: 'rpc',
      type: 'fs.tail',
      payload: { follow: true, path: '/srv/relay-ide/logs' },
    });
    nodeWs.send(
      JSON.stringify({
        protocol: request.protocol,
        protocolVersion: request.protocolVersion,
        nodeId,
        channel: 'rpc',
        type: 'fs.tail.error',
        requestId: request.requestId,
        streamId: request.streamId,
        timestamp: new Date().toISOString(),
        error: {
          code: 'INVALID_REQUEST',
          message: 'path is not a regular file',
          retryable: false,
          details: { reasonCode: 'FILE_RPC_NOT_FILE', path: '/srv/relay-ide/logs' },
        },
      })
    );

    const res = await tailPromise;
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', details: { reasonCode: 'FILE_RPC_NOT_FILE' } },
    });
  });

  it('denies File RPC traversal before it reaches the node link', async () => {
    const { base, wsBase, sessionEnvelopes } = await startHub();
    const { token, nodeId } = await pairNode(base);
    seedRemoteSessionEnvelope(sessionEnvelopes, nodeId);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/remote-session-1/files/list`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ path: '../secret' }),
      }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', details: { reasonCode: 'FILE_RPC_ROOT_ESCAPE' } },
    });
    expect(nodeWs.readyState).toBe(WebSocket.OPEN);
  });

  it('denies File RPC for wrong or missing scoped sessions', async () => {
    const { base, wsBase } = await startHub();
    const { token, nodeId } = await pairNode(base);
    const nodeWs = new WebSocket(`${wsBase}/hub/node-link`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanup.push(() => nodeWs.close());
    await waitForOpen(nodeWs);

    const res = await fetch(
      `${base}/hub/nodes/${encodeURIComponent(nodeId)}/sessions/missing-session/files/stat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
        body: JSON.stringify({ path: 'README.md' }),
      }
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: 'NOT_FOUND', details: { reasonCode: 'SESSION_ENVELOPE_NOT_FOUND' } },
    });
  });

  it('rejects malformed routed PTY path escapes with a controlled 400', async () => {
    const { port } = await startHub();

    await expect(
      rawUpgrade(port, '/nodes/%E0%A4%A/ws/sessions/remote-session-1')
    ).resolves.toContain('HTTP/1.1 400 Bad Request');
  });
});
