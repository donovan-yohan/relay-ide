import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCAL_NODE_ID, createRepoInstanceId, createWorktreeInstanceId } from '../shared/identity.js';
import {
  HANDOFF_SCHEMA_VERSION,
  type HandoffConflict,
  type HandoffRequest,
  type HandoffRequiredGrant,
} from '../shared/handoff.js';
import { ENVIRONMENT_OPTION_SCHEMA_VERSION } from '../shared/environment-option.js';
import { HandoffService, HANDOFF_PLAN_MAX_AGE_MS } from '../server/handoffs.js';
import type { HandoffPlannerDryRun } from '../server/handoff-planner.js';

const now = '2026-05-21T10:00:00.000Z';
const sourceNodeId = DEFAULT_LOCAL_NODE_ID;
const destinationNodeId = 'devbox-1';
const workContextId = 'wc:handoff:api-test';
const sourceCwd = '/repos/relay-ide/.worktrees/feature-a';
const destinationCwd = '/srv/relay-ide/.worktrees/feature-a';

function request(): HandoffRequest {
  const repoInstanceId = createRepoInstanceId(destinationNodeId, '/srv/relay-ide');
  const worktreeInstanceId = createWorktreeInstanceId(destinationNodeId, destinationCwd);
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: 'handoff-request-api-test',
    requestedAt: now,
    requestedByActorId: 'kani-backend',
    source: {
      nodeId: sourceNodeId,
      sessionId: 'source-session-1',
      workContextId,
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
        capabilities: [
          'session:read',
          'session:create:agent',
          'rpc:fs:read',
          'rpc:fs:write',
          'pty:exec:arbitrary',
        ],
        cwd: destinationCwd,
        cwdMode: 'repo',
        freshness: 'fresh',
        repoInstance: {
          repoInstanceId,
          localPath: '/srv/relay-ide',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          name: 'relay-ide',
          currentBranch: 'feat/691-handoff-api-cli',
        },
        bench: {
          worktreeInstanceId,
          localPath: destinationCwd,
          branchName: 'feat/691-handoff-api-cli',
        },
        generatedAt: now,
      },
      cwd: destinationCwd,
      repoInstanceId,
      worktreeInstanceId,
    },
    desiredRuntime: {
      kind: 'agent',
      providerId: 'hermes',
      commandSummary: 'resume cold handoff in destination worktree',
      requiredCapabilities: ['session:create:agent', 'pty:exec:arbitrary'],
    },
  };
}

function dryRun(conflicts: HandoffConflict[] = []): HandoffPlannerDryRun {
  return {
    branchName: 'feat/691-handoff-api-cli',
    baseCommit: 'a'.repeat(40),
    isClean: false,
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

function confirmedGrants(): HandoffRequiredGrant[] {
  return [
    { leg: 'source-read', nodeId: sourceNodeId, capability: 'rpc:fs:read', decision: 'allow' },
    { leg: 'destination-write', nodeId: destinationNodeId, capability: 'rpc:fs:write', decision: 'allow' },
    { leg: 'destination-session-create', nodeId: destinationNodeId, capability: 'session:create:agent', decision: 'allow' },
    { leg: 'destination-exec', nodeId: destinationNodeId, capability: 'pty:exec:arbitrary', decision: 'allow' },
  ];
}

describe('handoff API service', () => {
  it('plans read-only handoffs with all required execute grant legs unconfirmed', async () => {
    const service = new HandoffService({ now: () => new Date(now), createId: () => 'plan-1' });

    const planned = await service.plan({ request: request(), dryRun: dryRun() });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.id).toBe('plan-1');
    expect(planned.plan.transferMode).toBe('metadata-only');
    expect(planned.plan.requiredGrants.map((grant) => grant.leg)).toEqual([
      'source-read',
      'destination-write',
      'destination-session-create',
      'destination-exec',
    ]);
    expect(planned.plan.requiredGrants.every((grant) => grant.decision === undefined)).toBe(true);
  });

  it('rejects execute without confirmed source/destination grants and records a failed run', async () => {
    let nextId = 0;
    const service = new HandoffService({ now: () => new Date(now), createId: () => `id-${++nextId}` });
    const planned = await service.plan({ request: request(), dryRun: dryRun() });
    if (!planned.ok) throw new Error('plan failed unexpectedly');

    const created = await service.create({ planId: planned.plan.id });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.body.error.code).toBe('MISSING_CONFIRMED_GRANT');
    expect(created.run?.state).toBe('failed');
    expect(created.run?.conflicts.map((entry) => entry.code)).toContain('MISSING_CAPABILITY_GRANT');
    const status = service.getStatus(created.run?.id ?? '');
    expect(status?.redaction).toMatchObject({ rawSecretsAvailable: false, rawLogsAvailable: false });
  });

  it('refuses fake execute success even with confirmed grants when the transfer engine cannot run', async () => {
    let nextId = 0;
    const service = new HandoffService({ now: () => new Date(now), createId: () => `id-${++nextId}` });
    const planned = await service.plan({ request: request(), dryRun: dryRun() });
    if (!planned.ok) throw new Error('plan failed unexpectedly');

    const created = await service.create({
      planId: planned.plan.id,
      confirmedGrants: confirmedGrants(),
    });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.body.error.code).toBe('DESTINATION_UNAVAILABLE');
    expect(created.run?.state).toBe('failed');
    expect(created.run?.reasonCode).toBe('FAILED_DESTINATION_UNAVAILABLE');
    const resume = service.resume(created.run?.id ?? '');
    expect(resume?.resume.rawTranscriptAvailable).toBe(false);
    const artifact = service.readArtifact(`handoff-artifact:${created.run?.id}:resume-bundle`);
    expect(artifact).toMatchObject({ rawPayloadAvailable: false, transcriptExportAvailable: false });
  });

  it('requires stale plans to be refreshed before execute', async () => {
    let currentMs = Date.parse(now);
    const service = new HandoffService({
      now: () => new Date(currentMs),
      createId: () => 'plan-stale',
    });
    const planned = await service.plan({ request: request(), dryRun: dryRun() });
    if (!planned.ok) throw new Error('plan failed unexpectedly');
    currentMs += HANDOFF_PLAN_MAX_AGE_MS + 1;

    const created = await service.create({ planId: planned.plan.id, confirmedGrants: confirmedGrants() });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.body.error.code).toBe('STALE_PLAN');
  });

  it('returns typed source stale/offline failures during planning', async () => {
    const service = new HandoffService({ now: () => new Date(now), createId: () => 'plan-source-stale' });

    const planned = await service.plan({
      request: request(),
      dryRun: dryRun([
        {
          code: 'STALE_SOURCE',
          message: 'source node is offline',
          nodeId: sourceNodeId,
          reasonCode: 'FAILED_STALE_SOURCE',
        },
      ]),
    });

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.body.error.code).toBe('SOURCE_STALE_OR_OFFLINE');
    expect(planned.error.body.error.reasonCode).toBe('FAILED_STALE_SOURCE');
  });
});
