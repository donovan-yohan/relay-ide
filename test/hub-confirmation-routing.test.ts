import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfirmationChallengeStore } from '../server/confirmation-challenges.js';
import { createHubNodeRouter, type RoutedSessionAuditSink } from '../server/hub-node-router.js';
import type { HubNodeRegistry } from '../server/hub-node-registry.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';
import {
  createLegacyDefaultNodeAcl,
  summarizeAcl,
  type RelayCapabilityBit,
  type RelayNodeAcl,
} from '../shared/security-policy.js';
import type { HubNodeSummary, RelayNodeError } from '../shared/relay-node-protocol.js';

const NOW = new Date('2026-01-02T03:04:05.000Z');

function nodeSummary(input: {
  allowed?: RelayCapabilityBit[];
  requiresConfirmation?: RelayCapabilityBit[];
} = {}): HubNodeSummary {
  const acl: RelayNodeAcl = {
    ...createLegacyDefaultNodeAcl({
      nodeId: 'node_prod',
      credentialId: 'cred_prod',
      trustTier: 'prod',
      createdAt: NOW.toISOString(),
    }),
    grants: {
      allowed: input.allowed ?? ['session:read'],
      requiresConfirmation: input.requiresConfirmation ?? ['session:create:terminal'],
    },
  };
  return {
    nodeId: 'node_prod',
    displayName: 'prod box',
    hostname: 'prod.example',
    platform: 'linux',
    arch: 'x64',
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
      serviceManager: 'systemd-user',
      wsl: false,
    },
    createdAt: NOW.toISOString(),
    pairedAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    credentialId: 'cred_prod',
  };
}

function sessionPayload() {
  return {
    session: {
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
    },
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('hub confirmation routing', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  async function startHub() {
    const nodeLinks = {
      requests: [] as Array<{ nodeId: string; type: string; payload: unknown }>,
      hasActiveNode: () => true,
      request: async (nodeId: string, type: string, payload: unknown): Promise<unknown> => {
        nodeLinks.requests.push({ nodeId, type, payload });
        return sessionPayload();
      },
    };
    const auditEntries: Parameters<RoutedSessionAuditSink['append']>[0][] = [];
    const app = express();
    app.use(express.json());
    app.use(
      createHubNodeRouter({
        registry: {
          listNodes: () => [nodeSummary()],
          errorBody: (error: unknown) => ({
            error: error instanceof Error
              ? ({ code: 'INTERNAL', message: error.message, retryable: false } satisfies RelayNodeError)
              : ({ code: 'INTERNAL', message: 'unknown error', retryable: false } satisfies RelayNodeError),
          }),
          revokeNode: () => nodeSummary(),
        } as unknown as HubNodeRegistry,
        nodeLinks,
        sessionEnvelopes: createSessionEnvelopeRegistry(),
        confirmations: createConfirmationChallengeStore({
          now: () => NOW,
          randomId: () => 'challenge-1',
          randomToken: () => 'raw-confirmation-token',
        }),
        auditSink: { append: (entry) => auditEntries.push(entry) },
        now: () => NOW,
        requireAuth: (req, res, next) => {
          if (req.header('x-test-auth') === 'yes') next();
          else res.status(401).json({ error: 'Unauthorized' });
        },
      })
    );
    const server = http.createServer(app);
    const port = await listen(server);
    cleanup.push(() => close(server));
    return { base: `http://127.0.0.1:${port}`, nodeLinks, auditEntries };
  }

  it('creates challenge without routing node RPC, then requires distinct approval before exact-token redemption', async () => {
    const { base, nodeLinks, auditEntries } = await startHub();
    const originalBody = { repoPath: '/srv/relay-ide', type: 'terminal' };
    const first = await fetch(`${base}/hub/nodes/node_prod/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
      body: JSON.stringify(originalBody),
    });
    const firstJson = await first.json();
    expect(firstJson).toMatchObject({
      error: { details: { reasonCode: 'CONFIRMATION_REQUIRED' } },
    });
    expect(first.status).toBe(409);
    expect(nodeLinks.requests).toHaveLength(0);
    expect(firstJson).toMatchObject({
      error: {
        code: 'CONFIRMATION_REQUIRED',
        details: {
          reasonCode: 'CONFIRMATION_REQUIRED',
          challenge: {
            challengeId: 'challenge-1',
            nodeId: 'node_prod',
            intent: { action: 'sessions.create', target: 'node_prod' },
            requiredBits: ['session:create:terminal'],
            challengeBits: ['session:create:terminal'],
          },
        },
      },
    });

    const sameSessionApproval = await fetch(`${base}/hub/confirmations/challenge-1/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(sameSessionApproval.status).toBe(401);
    expect(await sameSessionApproval.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED', details: { reasonCode: 'CONFIRMATION_SAME_SESSION' } },
    });

    const approval = await fetch(`${base}/hub/confirmations/challenge-1/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'approver-browser',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(approval.status).toBe(200);
    const approvalJson = await approval.json();
    expect(approvalJson).toMatchObject({
      confirmationToken: 'raw-confirmation-token',
      challenge: { challengeId: 'challenge-1', status: 'approved' },
    });

    const tampered = await fetch(`${base}/hub/nodes/node_prod/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
      body: JSON.stringify({ ...originalBody, method: 'cold-reopen', confirmationToken: 'raw-confirmation-token' }),
    });
    expect(tampered.status).toBe(401);
    expect(await tampered.json()).toMatchObject({
      error: { details: { reasonCode: 'CONFIRMATION_PARAM_MISMATCH' } },
    });
    expect(nodeLinks.requests).toHaveLength(0);

    const redeemed = await fetch(`${base}/hub/nodes/node_prod/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
      body: JSON.stringify({ ...originalBody, confirmationToken: 'raw-confirmation-token' }),
    });
    expect(redeemed.status).toBe(201);
    expect(await redeemed.json()).toMatchObject({ id: 'remote-session-1', nodeId: 'node_prod' });
    expect(nodeLinks.requests).toHaveLength(1);
    expect(nodeLinks.requests[0]).toMatchObject({ type: 'sessions.create', payload: originalBody });
    expect(auditEntries.map((entry) => entry.eventType)).toEqual(
      expect.arrayContaining(['challenge', 'same_session_approval_attempt', 'approval', 'failed_redemption', 'grant'])
    );
  });
});
