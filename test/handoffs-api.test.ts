import express from 'express';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCAL_NODE_ID,
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../shared/identity.js';
import {
  HANDOFF_SCHEMA_VERSION,
  type HandoffConflict,
  type HandoffRequest,
} from '../shared/handoff.js';
import { ENVIRONMENT_OPTION_SCHEMA_VERSION } from '../shared/environment-option.js';
import { HandoffService, createHandoffRouter } from '../server/handoffs.js';
import type { HandoffPlannerDryRun } from '../server/handoff-planner.js';
import { createTestServer } from './helpers/test-server.js';

const now = '2026-05-21T10:00:00.000Z';
const sourceNodeId = DEFAULT_LOCAL_NODE_ID;
const destinationNodeId = 'devbox-1';
const sourceCwd = '/repos/relay-ide/.worktrees/feature-a';
const destinationCwd = '/srv/relay-ide/.worktrees/feature-a';

function request(): HandoffRequest {
  const repoInstanceId = createRepoInstanceId(
    destinationNodeId,
    '/srv/relay-ide'
  );
  const worktreeInstanceId = createWorktreeInstanceId(
    destinationNodeId,
    destinationCwd
  );
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: 'handoff-request-api-test',
    requestedAt: now,
    requestedByActorId: 'operator',
    source: {
      nodeId: sourceNodeId,
      sessionId: 'source-terminal-1',
      workContextId: 'wc:handoff:api-test',
      cwd: sourceCwd,
      disposition: 'left-running',
      durabilityState: 'running-attached',
    },
    destination: {
      nodeId: destinationNodeId,
      option: {
        schemaVersion: ENVIRONMENT_OPTION_SCHEMA_VERSION,
        id: `env:${destinationNodeId}:${destinationCwd}`,
        node: {
          nodeId: destinationNodeId,
          kind: 'remote',
          displayName: 'devbox',
          online: true,
        },
        capabilities: ['session:read', 'rpc:fs:read', 'rpc:fs:write'],
        cwd: destinationCwd,
        cwdMode: 'repo',
        freshness: 'fresh',
        repoInstance: {
          repoInstanceId,
          localPath: '/srv/relay-ide',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          name: 'relay-ide',
          currentBranch: 'feat/plan-only-handoff',
        },
        bench: {
          worktreeInstanceId,
          localPath: destinationCwd,
          branchName: 'feat/plan-only-handoff',
        },
        generatedAt: now,
      },
      cwd: destinationCwd,
      repoInstanceId,
      worktreeInstanceId,
    },
  };
}

function dryRun(conflicts: HandoffConflict[] = []): HandoffPlannerDryRun {
  return {
    branchName: 'feat/plan-only-handoff',
    baseCommit: 'a'.repeat(40),
    isClean: true,
    stagedFiles: [],
    unstagedFiles: [],
    untrackedCandidates: [],
    excludedPaths: [],
    includedGroups: ['source-summary'],
    excludedGroups: [],
    fileCount: 0,
    byteCount: 0,
    transferMode: 'metadata-only',
    conflicts,
  };
}

async function startApi(service: HandoffService) {
  const app = express();
  app.use(express.json());
  app.use(
    '/handoffs',
    createHandoffRouter({
      service,
      getCapabilities(req) {
        return (req.header('x-relay-capabilities') ?? '')
          .split(',')
          .filter(Boolean);
      },
    })
  );
  return createTestServer(app);
}

describe('plan-only handoff API', () => {
  it('builds a read-only plan with filesystem grants only', async () => {
    const service = new HandoffService({
      now: () => new Date(now),
      createId: () => 'plan-1',
    });

    const planned = await service.plan({
      request: request(),
      dryRun: dryRun(),
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.requiredGrants).toEqual([
      expect.objectContaining({
        leg: 'source-read',
        capability: 'rpc:fs:read',
      }),
      expect.objectContaining({
        leg: 'destination-write',
        capability: 'rpc:fs:write',
      }),
    ]);
  });

  it('rejects invalid requests without creating a plan', async () => {
    const service = new HandoffService();
    const result = await service.plan({
      request: { ...request(), requestedAt: 'not-a-date' },
      dryRun: dryRun(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { body: { error: { code: 'INVALID_REQUEST' } } },
    });
  });

  it('serves plan and passive artifact reads while retired execution routes are absent', async () => {
    const service = new HandoffService({
      now: () => new Date(now),
      createId: () => 'plan-1',
    });
    const api = await startApi(service);
    try {
      const planResponse = await fetch(`${api.url}/handoffs/plan`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-relay-capabilities': 'session:read,rpc:fs:read',
        },
        body: JSON.stringify({ request: request() }),
      });
      expect(planResponse.status).toBe(200);
      expect(await planResponse.json()).toMatchObject({
        plan: { id: 'plan-1' },
        readOnly: true,
      });

      const artifactResponse = await fetch(
        `${api.url}/handoffs/artifacts/plan-1`,
        { headers: { 'x-relay-capabilities': 'session:read' } }
      );
      expect(artifactResponse.status).toBe(200);
      expect(await artifactResponse.json()).toMatchObject({
        artifact: {
          planId: 'plan-1',
          rawPayloadAvailable: false,
          transcriptExportAvailable: false,
        },
      });

      for (const path of [
        '/handoffs/create',
        '/handoffs/run-1/status',
        '/handoffs/run-1/cancel',
        '/handoffs/run-1/resume',
        '/handoffs/run-1/launch',
      ]) {
        const response = await fetch(`${api.url}${path}`, { method: 'POST' });
        expect(response.status).toBe(404);
      }
    } finally {
      await api.close();
    }
  });

  it('fails closed without validated capability context', async () => {
    const service = new HandoffService();
    const api = await startApi(service);
    try {
      const response = await fetch(`${api.url}/handoffs/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: request() }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'CAPABILITY_DENIED' },
      });
    } finally {
      await api.close();
    }
  });
});
