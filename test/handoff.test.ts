import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCAL_NODE_ID,
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../shared/identity.js';
import {
  HANDOFF_CONFLICT_CODES,
  HANDOFF_REASON_CODES,
  HANDOFF_RUN_STATES,
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_SOURCE_DISPOSITIONS,
  isHandoffConflictCode,
  isHandoffPlan,
  isHandoffReasonCode,
  isHandoffRequest,
  isHandoffRun,
  isHandoffRunState,
  isHandoffRunTransitionAllowed,
  isHandoffSnapshot,
  isHandoffSourceDisposition,
  type HandoffPlan,
  type HandoffRequest,
  type HandoffRun,
  type HandoffSnapshot,
} from '../shared/handoff.js';
import { ENVIRONMENT_OPTION_SCHEMA_VERSION } from '../shared/environment-option.js';
import type { FileResourceRef } from '../shared/file-resource-ref.js';

const now = '2026-05-21T10:00:00.000Z';
const later = '2026-05-21T10:01:00.000Z';
const nodeId = DEFAULT_LOCAL_NODE_ID;
const destinationNodeId = 'devbox-1';
const workContextId = 'wc:handoff:test';
const sessionId = 'session-source-1';
const sourceCwd = '/repos/relay-ide/.worktrees/feature-a';
const destinationCwd = '/srv/relay-ide/.worktrees/feature-a';
const sourceHash = 'a'.repeat(64);
const destinationHash = 'b'.repeat(64);
const contentHash = 'c'.repeat(64);

function fileRef(
  path: string,
  intent: FileResourceRef['intent'] = 'read'
): FileResourceRef {
  return {
    nodeId,
    path,
    intent,
    capturedAt: now,
    size: 123,
    sha256: contentHash,
  };
}

function destinationOption() {
  const repoInstanceId = createRepoInstanceId(
    destinationNodeId,
    '/srv/relay-ide'
  );
  const worktreeInstanceId = createWorktreeInstanceId(
    destinationNodeId,
    destinationCwd
  );
  return {
    schemaVersion: ENVIRONMENT_OPTION_SCHEMA_VERSION,
    id: `env:${destinationNodeId}:${destinationCwd}`,
    node: {
      nodeId: destinationNodeId,
      kind: 'remote' as const,
      displayName: 'devbox',
      online: true,
    },
    capabilities: [
      'session:read' as const,
      'session:create:agent' as const,
      'rpc:fs:read' as const,
      'rpc:fs:write' as const,
      'rpc:git:read' as const,
    ],
    cwd: destinationCwd,
    cwdMode: 'repo' as const,
    freshness: 'fresh' as const,
    repoInstance: {
      repoInstanceId,
      localPath: '/srv/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      name: 'relay-ide',
      currentBranch: 'feat/685-handoff-schemas',
    },
    bench: {
      worktreeInstanceId,
      localPath: destinationCwd,
      branchName: 'feat/685-handoff-schemas',
    },
    generatedAt: now,
  };
}

function baseSource() {
  return {
    nodeId,
    sessionId,
    workContextId,
    cwd: sourceCwd,
    disposition: 'left-running' as const,
    durabilityState: 'running-attached' as const,
  };
}

function baseRequest(overrides: Partial<HandoffRequest> = {}): HandoffRequest {
  const option = destinationOption();
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: 'handoff-request-1',
    requestedAt: now,
    requestedByActorId: 'kani-backend',
    source: baseSource(),
    destination: {
      nodeId: destinationNodeId,
      option,
      cwd: destinationCwd,
      repoInstanceId: option.repoInstance.repoInstanceId,
      worktreeInstanceId: option.bench.worktreeInstanceId,
    },
    desiredRuntime: {
      kind: 'agent',
      providerId: 'hermes',
      commandSummary: 'resume agent in destination worktree',
      requiredCapabilities: ['session:create:agent'],
    },
    ...overrides,
  };
}

function basePlan(overrides: Partial<HandoffPlan> = {}): HandoffPlan {
  const option = destinationOption();
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: 'handoff-plan-1',
    requestId: 'handoff-request-1',
    createdAt: now,
    source: baseSource(),
    route: {
      sourceNodeId: nodeId,
      destinationNodeId,
      workContextId,
    },
    transferMode: 'tracked-patch',
    includedGroups: ['tracked-patch', 'source-summary'],
    excludedGroups: ['excluded-secret', 'excluded-cache'],
    fileCount: 2,
    byteCount: 246,
    destinationProposal: {
      nodeId: destinationNodeId,
      cwd: destinationCwd,
      repoInstanceId: option.repoInstance.repoInstanceId,
      worktreeInstanceId: option.bench.worktreeInstanceId,
      branchName: 'feat/685-handoff-schemas',
      summary: 'apply tracked patch and launch a new agent session',
    },
    pathMappings: [
      {
        kind: 'patch',
        source: {
          nodeId,
          path: `${sourceCwd}/.relay/handoff/patch.diff`,
          pathHashSha256: sourceHash,
          fileRef: fileRef(`${sourceCwd}/.relay/handoff/patch.diff`),
        },
        destination: {
          nodeId: destinationNodeId,
          path: `${destinationCwd}/.relay/handoff/patch.diff`,
          pathHashSha256: destinationHash,
          mode: 'create',
        },
        bytes: 123,
        sha256: contentHash,
        summary: 'tracked dirty state patch ref only; no raw diff payload here',
      },
    ],
    conflicts: [],
    requiredGrants: [
      {
        leg: 'source-read',
        nodeId,
        capability: 'rpc:fs:read',
        decision: 'allow',
        grantRef: 'acl:source:read',
        scope: { kind: 'path', pathPrefixes: [sourceCwd] },
      },
      {
        leg: 'destination-write',
        nodeId: destinationNodeId,
        capability: 'rpc:fs:write',
        decision: 'requiresConfirmation',
        grantRef: 'acl:dest:write',
        scope: { kind: 'path', pathPrefixes: [destinationCwd] },
      },
      {
        leg: 'destination-session-create',
        nodeId: destinationNodeId,
        capability: 'session:create:agent',
        decision: 'allow',
        grantRef: 'acl:dest:session',
        scope: { kind: 'node' },
      },
    ],
    launchPreview: {
      nodeId: destinationNodeId,
      cwd: destinationCwd,
      runtime: {
        kind: 'agent',
        providerId: 'hermes',
        requiredCapabilities: ['session:create:agent'],
      },
      summary: 'start Hermes in destination worktree after apply succeeds',
      workContextId,
    },
    ...overrides,
  };
}

function snapshotRef(group: 'tracked-patch' | 'source-summary') {
  return {
    group,
    ref: fileRef(
      group === 'tracked-patch'
        ? `${sourceCwd}/.relay/handoff/patch.diff`
        : `${sourceCwd}/.relay/handoff/source-summary.json`
    ),
    size: 123,
    sha256: contentHash,
    summary: `${group} ref, bounded and hashed`,
  };
}

function baseSnapshot(
  overrides: Partial<HandoffSnapshot> = {}
): HandoffSnapshot {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: 'handoff-snapshot-1',
    planId: 'handoff-plan-1',
    capturedAt: now,
    source: baseSource(),
    baseCommit: 'e6ca5ce1',
    branchName: 'feat/685-handoff-schemas',
    trackedPatchRefs: [snapshotRef('tracked-patch')],
    stagedMetadataRefs: [],
    approvedUntrackedRefs: [],
    excludedGroups: ['excluded-secret', 'excluded-cache'],
    cwd: sourceCwd,
    sourceSummaryRefs: [snapshotRef('source-summary')],
    summary: 'snapshot manifest stores refs, hashes, sizes, and summaries only',
    ...overrides,
  };
}

function baseRun(overrides: Partial<HandoffRun> = {}): HandoffRun {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: 'handoff-run-1',
    requestId: 'handoff-request-1',
    planId: 'handoff-plan-1',
    snapshotId: 'handoff-snapshot-1',
    state: 'snapshotting',
    sourceDisposition: 'left-running',
    reasonCode: 'SNAPSHOT_CAPTURED',
    conflicts: [],
    transitions: [
      {
        from: 'planned',
        to: 'snapshotting',
        at: later,
        reasonCode: 'SNAPSHOT_CAPTURED',
        actorId: 'kani-backend',
      },
    ],
    createdAt: now,
    updatedAt: later,
    ...overrides,
  };
}

describe('handoff shared contract', () => {
  it('exports closed enum constants and type guards', () => {
    expect(HANDOFF_SOURCE_DISPOSITIONS).toContain('handed-off');
    expect(HANDOFF_CONFLICT_CODES).toContain('UNSAFE_PATH_MAPPING');
    expect(HANDOFF_REASON_CODES).toContain('FAILED_LAUNCH');
    expect(HANDOFF_RUN_STATES).toEqual([
      'planned',
      'snapshotting',
      'transferring',
      'applying',
      'launching',
      'verifying',
      'complete',
      'failed',
      'cancelled',
    ]);
    expect(isHandoffSourceDisposition('stale-source')).toBe(true);
    expect(isHandoffConflictCode('DESTINATION_CONFLICT')).toBe(true);
    expect(isHandoffReasonCode('VERIFY_COMPLETED')).toBe(true);
    expect(isHandoffRunState('applying')).toBe(true);
  });

  it('accepts request, plan, snapshot, and run shapes with node/session/WorkContext identities', () => {
    expect(isHandoffRequest(baseRequest())).toBe(true);
    expect(isHandoffPlan(basePlan())).toBe(true);
    expect(isHandoffSnapshot(baseSnapshot())).toBe(true);
    expect(isHandoffRun(baseRun())).toBe(true);
  });

  it('rejects missing source node/session/WorkContext ids', () => {
    const missingNode = baseRequest({
      source: { ...baseSource(), nodeId: '' },
    });
    const missingSession = baseRequest({
      source: { ...baseSource(), sessionId: '' },
    });
    const missingWorkContext = baseRequest({
      source: { ...baseSource(), workContextId: '' },
    });
    expect(isHandoffRequest(missingNode)).toBe(false);
    expect(isHandoffRequest(missingSession)).toBe(false);
    expect(isHandoffRequest(missingWorkContext)).toBe(false);
  });

  it('rejects invalid destination and path mapping fields', () => {
    const badDestination = baseRequest({
      destination: {
        ...baseRequest().destination,
        nodeId,
      },
    });
    const badRelativePath = basePlan({
      pathMappings: [
        {
          ...basePlan().pathMappings[0],
          destination: {
            ...basePlan().pathMappings[0].destination,
            path: 'relative/path.diff',
          },
        },
      ],
    });
    const badHash = basePlan({
      pathMappings: [
        {
          ...basePlan().pathMappings[0],
          source: {
            ...basePlan().pathMappings[0].source,
            pathHashSha256: 'not-a-hash',
          },
        },
      ],
    });
    expect(isHandoffRequest(badDestination)).toBe(false);
    expect(isHandoffPlan(badRelativePath)).toBe(false);
    expect(isHandoffPlan(badHash)).toBe(false);
  });

  it('models required grants as explicit source read, destination write, and destination launch grants', () => {
    expect(isHandoffPlan(basePlan())).toBe(true);
    const vagueSuperPermission = basePlan({
      requiredGrants: [
        {
          leg: 'source-read',
          nodeId,
          capability: 'rpc:fs:read',
        },
      ],
    });
    const wrongCapabilityForLeg = basePlan({
      requiredGrants: [
        ...basePlan().requiredGrants.slice(0, 2),
        {
          leg: 'destination-session-create',
          nodeId: destinationNodeId,
          capability: 'rpc:fs:write' as never,
        },
      ],
    });
    expect(isHandoffPlan(vagueSuperPermission)).toBe(false);
    expect(isHandoffPlan(wrongCapabilityForLeg)).toBe(false);
  });

  it('rejects unknown conflict and reason codes', () => {
    const badConflict = basePlan({
      conflicts: [
        {
          code: 'SPOOKY_ACTION_AT_A_DISTANCE' as never,
          message: 'nope',
        },
      ],
    });
    const badReason = baseRun({ reasonCode: 'IT_EXPLODED_SOMEHOW' as never });
    expect(isHandoffPlan(badConflict)).toBe(false);
    expect(isHandoffRun(badReason)).toBe(false);
  });

  it('rejects invalid run states and invalid transitions', () => {
    expect(isHandoffRunTransitionAllowed('planned', 'snapshotting')).toBe(true);
    expect(isHandoffRunTransitionAllowed('planned', 'applying')).toBe(false);
    const invalidState = baseRun({ state: 'teleported' as never });
    const invalidTransition = baseRun({
      state: 'applying',
      transitions: [
        {
          from: 'planned',
          to: 'applying',
          at: later,
          reasonCode: 'APPLY_STARTED',
        },
      ],
    });
    const staleCurrentState = baseRun({
      state: 'transferring',
      transitions: [
        {
          from: 'planned',
          to: 'snapshotting',
          at: later,
          reasonCode: 'SNAPSHOT_CAPTURED',
        },
      ],
    });
    expect(isHandoffRun(invalidState)).toBe(false);
    expect(isHandoffRun(invalidTransition)).toBe(false);
    expect(isHandoffRun(staleCurrentState)).toBe(false);
  });

  it('rejects raw secret/auth/transcript payload storage', () => {
    const rawRequest = {
      ...baseRequest(),
      providerAuth: { token: 'nope' },
    };
    const rawSnapshot = {
      ...baseSnapshot(),
      sourceSummaryRefs: [
        {
          ...snapshotRef('source-summary'),
          transcript: 'unbounded raw transcript text',
        },
      ],
    };
    expect(isHandoffRequest(rawRequest)).toBe(false);
    expect(isHandoffSnapshot(rawSnapshot)).toBe(false);
  });
});
