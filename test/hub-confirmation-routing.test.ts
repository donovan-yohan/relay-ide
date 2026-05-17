import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfirmationChallengeStore, hashAuthSessionIdentity } from '../server/confirmation-challenges.js';
import { createRepoFeatureRouter } from '../server/features/repo-router.js';
import { createHubNodeRouter, type RoutedSessionAuditSink } from '../server/hub-node-router.js';
import type { HubNodeRegistry } from '../server/hub-node-registry.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';
import { createRoutedNodeSessionEnvelope } from '../shared/session-envelope.js';
import { createWorkContextStore, type WorkContextStore } from '../server/work-contexts.js';
import {
  createLegacyDefaultNodeAcl,
  summarizeAcl,
  type RelayCapabilityBit,
  type RelayNodeAcl,
  type RelayTrustTier,
} from '../shared/security-policy.js';
import type { HubNodeSummary, RelayNodeError } from '../shared/relay-node-protocol.js';

const NOW = new Date('2026-01-02T03:04:05.000Z');

function nodeSummary(input: {
  allowed?: RelayCapabilityBit[];
  requiresConfirmation?: RelayCapabilityBit[];
  trustTier?: RelayTrustTier;
} = {}): HubNodeSummary {
  const trustTier = input.trustTier ?? 'prod';
  const acl: RelayNodeAcl = {
    ...createLegacyDefaultNodeAcl({
      nodeId: 'node_prod',
      credentialId: 'cred_prod',
      trustTier,
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
    trust: { state: 'active', level: trustTier, tier: trustTier, policy: summarizeAcl(acl) },
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

  async function startHub(
    options: {
      auditSink?: RoutedSessionAuditSink;
      node?: HubNodeSummary;
      workContextStore?: WorkContextStore;
      sessionPayload?: unknown;
    } = {}
  ) {
    const nodeLinks = {
      requests: [] as Array<{ nodeId: string; type: string; payload: unknown }>,
      hasActiveNode: () => true,
      request: async (nodeId: string, type: string, payload: unknown): Promise<unknown> => {
        nodeLinks.requests.push({ nodeId, type, payload });
        return options.sessionPayload ?? sessionPayload();
      },
    };
    const auditEntries: Parameters<RoutedSessionAuditSink['append']>[0][] = [];
    const auditSink = options.auditSink ?? { append: (entry) => auditEntries.push(entry) };
    const sessionEnvelopes = createSessionEnvelopeRegistry();
    const app = express();
    app.use((req, _res, next) => {
      const cookie = req.header('cookie') ?? '';
      const token = cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1];
      if (token) req.cookies = { token };
      next();
    });
    app.use(express.json());
    app.use(
      createHubNodeRouter({
        registry: {
          listNodes: () => [options.node ?? nodeSummary()],
          errorBody: (error: unknown) => ({
            error: error instanceof Error
              ? ({ code: 'INTERNAL', message: error.message, retryable: false } satisfies RelayNodeError)
              : ({ code: 'INTERNAL', message: 'unknown error', retryable: false } satisfies RelayNodeError),
          }),
          revokeNode: () => options.node ?? nodeSummary(),
        } as unknown as HubNodeRegistry,
        nodeLinks,
        sessionEnvelopes,
        confirmations: createConfirmationChallengeStore({
          now: () => NOW,
          randomId: () => 'challenge-1',
          randomToken: () => 'raw-confirmation-token',
        }),
        auditSink,
        workContextStore: options.workContextStore,
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
    return { base: `http://127.0.0.1:${port}`, nodeLinks, auditEntries, sessionEnvelopes };
  }

  async function startColdReopenHub() {
    const confirmations = createConfirmationChallengeStore({
      now: () => NOW,
      randomId: () => 'challenge-reopen',
      randomToken: () => 'raw-reopen-token',
    });
    const nodeLinks = {
      requests: [] as Array<{ nodeId: string; type: string; payload: unknown }>,
      hasActiveNode: () => true,
      request: async (nodeId: string, type: string, payload: unknown): Promise<unknown> => {
        nodeLinks.requests.push({ nodeId, type, payload });
        return sessionPayload();
      },
    };
    const report = {
      nodeId: 'node_prod',
      generatedAt: NOW.toISOString(),
      repos: [
        {
          repoInstanceId: 'repo-1',
          nodeId: 'node_prod',
          localPath: '/srv/relay-ide',
          name: 'relay-ide',
          isGitRepo: true,
          defaultBranch: 'nightly',
          currentBranch: 'nightly',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          selectedRemote: null,
          remotes: [],
          repoIdentityWarnings: [],
          dirty: { stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0, files: [], truncated: false },
          divergence: { upstreamRef: 'origin/nightly', aheadCount: 0, behindCount: 0 },
          worktrees: [],
          reportedAt: NOW.toISOString(),
        },
      ],
    };
    const repoInventoryFeature = {
      listInventoryReports: () => [report],
      aggregateInventoryReports: () => ({ nodes: [], repos: [] }),
      validateInventoryPayload: () => ({ ok: true, payload: report }),
    };
    const registry = {
      listNodes: () => [nodeSummary({ requiresConfirmation: ['session:create:terminal'] })],
      errorBody: (error: unknown) => ({
        error: error instanceof Error
          ? ({ code: 'INTERNAL', message: error.message, retryable: false } satisfies RelayNodeError)
          : ({ code: 'INTERNAL', message: 'unknown error', retryable: false } satisfies RelayNodeError),
      }),
      revokeNode: () => nodeSummary(),
    } as unknown as HubNodeRegistry;
    const auditEntries: Parameters<RoutedSessionAuditSink['append']>[0][] = [];
    const app = express();
    app.use(express.json());
    const requireAuth: express.RequestHandler = (req, res, next) => {
      if (req.header('x-test-auth') === 'yes') next();
      else res.status(401).json({ error: 'Unauthorized' });
    };
    app.use(
      createHubNodeRouter({
        registry,
        nodeLinks,
        confirmations,
        requireAuth,
        auditSink: { append: (entry) => auditEntries.push(entry) },
        now: () => NOW,
      })
    );
    app.use(
      createRepoFeatureRouter({
        registry,
        nodeLinks: nodeLinks as never,
        confirmations,
        requireAuth,
        repoInventoryFeature: repoInventoryFeature as never,
        auditSink: { append: (entry) => auditEntries.push(entry) },
        now: () => NOW,
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

    const wrongRequesterPickup = await fetch(
      `${base}/hub/confirmations/challenge-1/requester-token`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-auth': 'yes',
          'x-auth-session': 'approver-browser',
        },
      }
    );
    expect(wrongRequesterPickup.status).toBe(401);
    expect(await wrongRequesterPickup.json()).toMatchObject({
      error: { details: { reasonCode: 'CONFIRMATION_REQUESTER_MISMATCH' } },
    });

    const requesterPickup = await fetch(`${base}/hub/confirmations/challenge-1/requester-token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
    });
    expect(requesterPickup.status).toBe(200);
    const requesterPickupJson = await requesterPickup.json();
    expect(requesterPickupJson).toMatchObject({
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
    const requesterHash = hashAuthSessionIdentity('test-header:requester-browser');
    const approverHash = hashAuthSessionIdentity('test-header:approver-browser');
    const approvalAudit = auditEntries.find((entry) => entry.eventType === 'approval');
    const failedRedemptionAudit = auditEntries.find((entry) => entry.eventType === 'failed_redemption');
    const grantAudit = auditEntries.find((entry) => entry.eventType === 'grant');
    expect(approvalAudit?.peer.principalHash).toBe(approverHash);
    expect(approvalAudit?.peer.principalHash).not.toBe(requesterHash);
    expect(failedRedemptionAudit?.peer.principalHash).toBe(requesterHash);
    expect(grantAudit?.peer.principalHash).toBe(requesterHash);
  });

  it('associates routed session creates with existing WorkContext metadata and Active Work groups', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-work-context-test-'));
    const workContextStore = createWorkContextStore(path.join(tmp, 'work-contexts.db'));
    cleanup.push(() => {
      workContextStore.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    const workContextId = 'github-issue-572-safe-relay-development';
    workContextStore.create({
      id: workContextId,
      title: 'Issue #572 dogfood routed session',
      source: 'test',
    });
    const node = nodeSummary({
      allowed: ['session:read', 'session:create:terminal'],
      requiresConfirmation: [],
    });
    const { base, nodeLinks } = await startHub({ workContextStore, node });

    const body = {
      repoPath: '/srv/relay-ide',
      type: 'terminal',
      workContextId,
    };
    const response = await fetch(`${base}/hub/nodes/node_prod/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(201);
    const session = await response.json();
    expect(session).toMatchObject({
      id: 'remote-session-1',
      nodeId: 'node_prod',
      workContextId,
    });
    expect(nodeLinks.requests[0]).toMatchObject({
      type: 'sessions.create',
      payload: body,
    });
    expect(workContextStore.findSessionWorkContextIds(session)).toEqual([workContextId]);

    const groups = workContextStore.listActiveWork({ sessions: [session], nodes: [node] });
    const group = groups.find((candidate) => candidate.id === workContextId);
    expect(group).toBeDefined();
    expect(group?.sessions[0]).toMatchObject({
      id: 'remote-session-1',
      nodeId: 'node_prod',
      live: true,
    });
  });

  it('strips unvalidated node-provided WorkContext ids from routed session creates', async () => {
    const spoofedWorkContextId = 'node-owned-untrusted-context';
    const payload = sessionPayload();
    (payload.session as typeof payload.session & { workContextId?: string }).workContextId =
      spoofedWorkContextId;
    const node = nodeSummary({
      allowed: ['session:read', 'session:create:terminal'],
      requiresConfirmation: [],
    });
    const { base } = await startHub({ node, sessionPayload: payload });

    const response = await fetch(`${base}/hub/nodes/node_prod/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
      },
      body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
    });

    expect(response.status).toBe(201);
    const session = await response.json();
    expect(session).toMatchObject({ id: 'remote-session-1', nodeId: 'node_prod' });
    expect(session.workContextId).toBeUndefined();
  });

  it('ignores spoofable x-auth-session when an authenticated cookie is present', async () => {
    const { base } = await startHub();
    const headers = {
      'content-type': 'application/json',
      'x-test-auth': 'yes',
      cookie: 'token=trusted-browser-cookie',
    };
    const first = await fetch(`${base}/hub/nodes/node_prod/sessions`, {
      method: 'POST',
      headers: { ...headers, 'x-auth-session': 'requester-browser' },
      body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
    });
    expect(first.status).toBe(409);

    const spoofedApproval = await fetch(`${base}/hub/confirmations/challenge-1/approve`, {
      method: 'POST',
      headers: { ...headers, 'x-auth-session': 'spoofed-approver-browser' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(spoofedApproval.status).toBe(401);
    expect(await spoofedApproval.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED', details: { reasonCode: 'CONFIRMATION_SAME_SESSION' } },
    });
  });

  it('fails closed when confirmation challenge audit append fails for prod/high-risk policy', async () => {
    const { base, nodeLinks } = await startHub({
      auditSink: { append: () => { throw new Error('audit sink unavailable'); } },
    });
    const response = await fetch(`${base}/hub/nodes/node_prod/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
      body: JSON.stringify({ repoPath: '/srv/relay-ide', type: 'terminal' }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: 'INTERNAL', details: { reasonCode: 'POLICY_AUDIT_WRITE_FAILED_CLOSED' } },
    });
    expect(nodeLinks.requests).toHaveLength(0);
  });

  it('denies routed session kill when ACL only grants attach', async () => {
    const { base, nodeLinks, auditEntries, sessionEnvelopes } = await startHub({
      node: nodeSummary({
        trustTier: 'dev',
        allowed: ['session:read', 'session:attach'],
        requiresConfirmation: [],
      }),
    });
    sessionEnvelopes.upsert(
      createRoutedNodeSessionEnvelope({
        nodeId: 'node_prod',
        sessionId: 'remote-session-1',
        cwd: '/srv/relay-ide',
        repoPath: '/srv/relay-ide',
        issuedAt: NOW.toISOString(),
      })
    );

    const response = await fetch(`${base}/hub/nodes/node_prod/sessions/remote-session-1`, {
      method: 'DELETE',
      headers: {
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'UNAUTHORIZED',
        details: {
          reasonCode: 'POLICY_CAPABILITY_DENIED',
          deniedBits: ['session:control:kill'],
        },
      },
    });
    expect(nodeLinks.requests).toHaveLength(0);
    expect(auditEntries.at(-1)).toMatchObject({
      eventType: 'denial',
      reasonCode: 'POLICY_CAPABILITY_DENIED',
      requiredBits: ['session:control:kill'],
      deniedBits: ['session:control:kill'],
    });
  });

  it('invalidates an approved requester token when approval audit append fails closed', async () => {
    const auditEntries: Parameters<RoutedSessionAuditSink['append']>[0][] = [];
    const { base, nodeLinks } = await startHub({
      auditSink: {
        append: (entry) => {
          if (entry.eventType === 'approval') throw new Error('approval audit sink unavailable');
          auditEntries.push(entry);
        },
      },
    });
    const originalBody = { repoPath: '/srv/relay-ide', type: 'terminal' };
    const response = await fetch(`${base}/hub/nodes/node_prod/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
      body: JSON.stringify(originalBody),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reasonCode: 'CONFIRMATION_REQUIRED' } },
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
    expect(approval.status).toBe(500);
    expect(await approval.json()).toMatchObject({
      error: { code: 'INTERNAL', details: { reasonCode: 'POLICY_AUDIT_WRITE_FAILED_CLOSED' } },
    });

    const requesterPickup = await fetch(`${base}/hub/confirmations/challenge-1/requester-token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
    });
    expect(requesterPickup.status).toBe(401);
    expect(await requesterPickup.json()).toMatchObject({
      error: { details: { reasonCode: 'CONFIRMATION_NOT_APPROVED' } },
    });

    const redeemed = await fetch(`${base}/hub/nodes/node_prod/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
      body: JSON.stringify({ ...originalBody, confirmationToken: 'raw-confirmation-token' }),
    });
    expect(redeemed.status).toBe(401);
    expect(await redeemed.json()).toMatchObject({
      error: { details: { reasonCode: 'CONFIRMATION_TOKEN_INVALID' } },
    });
    expect(nodeLinks.requests).toHaveLength(0);
    expect(auditEntries.map((entry) => entry.eventType)).toEqual(['challenge']);
  });

  it('requires the same two-token confirmation flow for repo cold reopen sessions.create', async () => {
    const { base, nodeLinks, auditEntries } = await startColdReopenHub();
    const reopenBody = {
      source: { repoIdentity: 'github.com/donovan-yohan/relay-ide', branchName: 'nightly' },
      type: 'terminal',
    };
    const first = await fetch(`${base}/hub/nodes/node_prod/sessions/reopen`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
      body: JSON.stringify(reopenBody),
    });
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({
      error: {
        details: {
          reasonCode: 'CONFIRMATION_REQUIRED',
          challenge: { challengeId: 'challenge-reopen', intent: { action: 'sessions.create' } },
        },
      },
    });
    expect(nodeLinks.requests).toHaveLength(0);

    const approval = await fetch(`${base}/hub/confirmations/challenge-reopen/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'approver-browser',
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({ confirmationToken: 'raw-reopen-token' });

    const redeemed = await fetch(`${base}/hub/nodes/node_prod/sessions/reopen`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth': 'yes',
        'x-auth-session': 'requester-browser',
      },
      body: JSON.stringify({ ...reopenBody, confirmationToken: 'raw-reopen-token' }),
    });
    expect(redeemed.status).toBe(201);
    expect(await redeemed.json()).toMatchObject({ session: { id: 'remote-session-1', nodeId: 'node_prod' } });
    expect(nodeLinks.requests).toHaveLength(1);
    expect(nodeLinks.requests[0]).toMatchObject({ type: 'sessions.create' });
    expect(JSON.stringify(nodeLinks.requests[0]?.payload)).not.toContain('raw-reopen-token');
    expect(auditEntries.map((entry) => entry.eventType)).toEqual(
      expect.arrayContaining(['challenge', 'approval', 'grant'])
    );
  });
});
