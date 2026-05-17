import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubNodeRouter } from '../server/hub-node-router.js';
import type { HubNodeLinkManager } from '../server/hub-node-link.js';
import type { HubNodeRegistry } from '../server/hub-node-registry.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';
import {
  aggregateRemoteSessions,
  createRemoteSessionReadModelCache,
} from '../server/hub-session-aggregator.js';
import { createWorkContextStore, type WorkContextStore } from '../server/work-contexts.js';
import {
  createLegacyDefaultNodeAcl,
  summarizeAcl,
  type RelayCapabilityBit,
} from '../shared/security-policy.js';
import type { HubNodeSummary, RelayNodeError } from '../shared/relay-node-protocol.js';
import type { SessionSummary } from '../server/types.js';

const NOW = new Date('2026-01-02T03:04:05.000Z');

function nodeSummary(
  allowed: RelayCapabilityBit[] = ['session:read', 'session:create:terminal']
): HubNodeSummary {
  const acl = createLegacyDefaultNodeAcl({
    nodeId: 'node_prod',
    credentialId: 'cred_prod',
    trustTier: 'prod',
    createdAt: NOW.toISOString(),
  });
  acl.grants = { allowed, requiresConfirmation: [] };
  return {
    nodeId: 'node_prod',
    displayName: 'prod box',
    hostname: 'prod.example',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '0.1.0-test',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'reverse-link', status: 'connected' },
    trust: { state: 'active', level: 'prod', tier: 'prod', policy: summarizeAcl(acl) },
    credentialState: 'active',
    version: { state: 'compatible', nodeProtocolVersion: '1.0', hubProtocolVersion: '1.0' },
    capabilities: {
      totals: { available: 2, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        tmux: 'available',
        git: 'available',
        browserAutomation: 'unavailable',
        clipboardImage: 'unavailable',
        ssh: 'unavailable',
        tailscale: 'unavailable',
      },
      agents: {},
      serviceManager: 'launchd',
      wsl: false,
    },
    createdAt: NOW.toISOString(),
    pairedAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    credentialId: 'cred_prod',
  };
}

function remoteSession(): SessionSummary {
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
    createdAt: NOW.toISOString(),
    lastActivity: NOW.toISOString(),
    idle: false,
    customCommand: null,
    useTmux: true,
    tmuxSessionName: 'relay-ide-remote-session-1',
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

describe('routed create remote session read model', () => {
  const cleanup: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  it('keeps a just-created WorkContext session visible through an immediate transient sessions.list failure', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-routed-create-readmodel-'));
    const workContextStore: WorkContextStore = createWorkContextStore(
      path.join(tmp, 'work-contexts.db')
    );
    cleanup.push(() => {
      workContextStore.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    const workContextId = 'github-issue-574-active-work-live-state';
    workContextStore.create({ id: workContextId, title: 'Issue #574', source: 'test' });

    const node = nodeSummary();
    const registry = {
      listNodes: () => [node],
      errorBody: (error: unknown) => ({
        error:
          error instanceof Error
            ? ({ code: 'INTERNAL', message: error.message, retryable: false } satisfies RelayNodeError)
            : ({ code: 'INTERNAL', message: 'unknown error', retryable: false } satisfies RelayNodeError),
      }),
      revokeNode: () => node,
    } as unknown as HubNodeRegistry;
    const nodeLinks = {
      hasActiveNode: () => true,
      request: vi.fn(async (_nodeId: string, type: string) => {
        if (type === 'sessions.create') return { session: remoteSession() };
        if (type === 'sessions.list') {
          throw new Error('transient sessions.list failure immediately after create');
        }
        throw new Error(`unexpected ${type}`);
      }),
    };
    const sessionEnvelopes = createSessionEnvelopeRegistry();
    const readModelCache = createRemoteSessionReadModelCache();
    const app = express();
    app.use(express.json());
    app.use(
      createHubNodeRouter({
        registry,
        nodeLinks,
        sessionEnvelopes,
        workContextStore,
        readModelCache,
        now: () => NOW,
        requireAuth: (_req, _res, next) => next(),
      })
    );
    const server = http.createServer(app);
    cleanup.push(
      () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    );
    const base = `http://127.0.0.1:${await listen(server)}`;

    const created = await fetch(`${base}/hub/nodes/node_prod/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal', workContextId }),
    });
    expect(created.status).toBe(201);
    const createdSession = (await created.json()) as SessionSummary;
    expect(createdSession).toMatchObject({
      id: 'remote-session-1',
      nodeId: 'node_prod',
      workContextId,
    });

    const afterTransientFailure = await aggregateRemoteSessions({
      registry,
      nodeLinks: nodeLinks as unknown as HubNodeLinkManager,
      workContextStore,
      sessionEnvelopes,
      readModelCache,
      now: () => NOW.getTime() + 100,
    });

    expect(afterTransientFailure).toHaveLength(1);
    expect(afterTransientFailure[0]).toMatchObject({
      id: 'remote-session-1',
      nodeId: 'node_prod',
      workContextId,
      status: 'active',
    });
  });
});
