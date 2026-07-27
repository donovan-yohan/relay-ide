import { describe, expect, it } from 'vitest';

import { ENVIRONMENT_OPTION_SCHEMA_VERSION } from '../shared/environment-option.js';
import {
  detectHandoffDestinationConflicts,
  proposeHandoffDestination,
  resolveHandoffPathMappings,
  validateHandoffDestinationRoot,
  validateHandoffMirrorRoot,
  type HandoffMirrorRoot,
} from '../shared/handoff-destination.js';
import {
  HANDOFF_CONFLICT_CODES,
  HANDOFF_REASON_CODES,
  HANDOFF_SCHEMA_VERSION,
  type HandoffSourceRef,
} from '../shared/handoff.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../shared/identity.js';
import type { EnvironmentOption } from '../shared/environment-option.js';
import type {
  RepoInventoryDirtySummary,
  RepoInventoryRepoInstance,
} from '../shared/repo-inventory.js';

const now = '2026-05-21T12:00:00.000Z';
const sourceNodeId = DEFAULT_LOCAL_NODE_ID;
const destinationNodeId = 'hub-node';
const sourceCwd = '/Users/ebi/src/relay-ide/.worktrees/feature-x';
const destinationRepo = '/srv/relay/repos/relay-ide';
const destinationWorktree = '/srv/relay/repos/relay-ide/.worktrees/feature-x';
const repoIdentity = 'github.com/donovan-yohan/relay-ide';
const repoInstanceId = createRepoInstanceId(destinationNodeId, destinationRepo);
const worktreeInstanceId = createWorktreeInstanceId(
  destinationNodeId,
  destinationWorktree
);

function source(): HandoffSourceRef {
  return {
    nodeId: sourceNodeId,
    sessionId: 'session-source',
    workContextId: 'wc:handoff:689',
    cwd: sourceCwd,
    disposition: 'left-running',
    durabilityState: 'running-attached',
  };
}

function environmentOption(
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  return {
    schemaVersion: ENVIRONMENT_OPTION_SCHEMA_VERSION,
    id: 'env:hub:relay-ide',
    node: {
      nodeId: destinationNodeId,
      kind: 'remote',
      displayName: 'hub',
      online: true,
    },
    capabilities: [
      'session:create:terminal',
      'rpc:fs:read',
      'rpc:fs:write',
      'rpc:git:read',
      'rpc:git:write',
    ],
    cwd: destinationWorktree,
    cwdMode: 'repo',
    freshness: 'fresh',
    repoInstance: {
      repoInstanceId,
      localPath: destinationRepo,
      repoIdentity,
      name: 'relay-ide',
      currentBranch: 'feat/689-handoff-destination-mapping',
      defaultBranch: 'nightly',
    },
    bench: {
      worktreeInstanceId,
      localPath: destinationWorktree,
      branchName: 'feat/689-handoff-destination-mapping',
      displayName: 'feature-x',
    },
    generatedAt: now,
    ...overrides,
  };
}

function cleanDirty(): RepoInventoryDirtySummary {
  return {
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    files: [],
    truncated: false,
  };
}

function inventory(
  overrides: Partial<RepoInventoryRepoInstance> = {},
  worktreeOverrides: Partial<
    RepoInventoryRepoInstance['worktrees'][number]
  > = {}
): RepoInventoryRepoInstance {
  return {
    repoInstanceId,
    nodeId: destinationNodeId,
    localPath: destinationRepo,
    name: 'relay-ide',
    isGitRepo: true,
    defaultBranch: 'nightly',
    currentBranch: 'feat/689-handoff-destination-mapping',
    repoIdentity,
    selectedRemote: null,
    remotes: [],
    repoIdentityWarnings: [],
    dirty: cleanDirty(),
    divergence: {
      upstreamRef: 'origin/nightly',
      aheadCount: 0,
      behindCount: 0,
      headSha: 'base-a',
    },
    worktrees: [
      {
        worktreeInstanceId,
        localPath: destinationWorktree,
        branchName: 'feat/689-handoff-destination-mapping',
        dirty: cleanDirty(),
        divergence: {
          upstreamRef: 'origin/nightly',
          aheadCount: 0,
          behindCount: 0,
          headSha: 'base-a',
        },
        ...worktreeOverrides,
      },
    ],
    reportedAt: now,
    ...overrides,
  };
}

function mirrorRoot(
  overrides: Partial<HandoffMirrorRoot> = {}
): HandoffMirrorRoot {
  return {
    sourceNodeId,
    destinationNodeId,
    sourceRoot: sourceCwd,
    destinationRoot: destinationWorktree,
    label: 'relay worktree',
    ...overrides,
  };
}

describe('handoff destination mapping', () => {
  it('exports destination-specific conflict and reason codes', () => {
    expect(HANDOFF_SCHEMA_VERSION).toBe(1);
    expect(HANDOFF_CONFLICT_CODES).toContain('DESTINATION_UNAVAILABLE');
    expect(HANDOFF_CONFLICT_CODES).toContain('MISSING_PATH_MAPPING');
    expect(HANDOFF_REASON_CODES).toContain('FAILED_DESTINATION_UNAVAILABLE');
    expect(HANDOFF_REASON_CODES).toContain('FAILED_MISSING_PATH_MAPPING');
  });

  it('proposes reuse for an existing worktree and create for a repo-only destination', () => {
    const reuse = proposeHandoffDestination({
      source: source(),
      destination: environmentOption(),
      sourceBranchName: 'feat/689-handoff-destination-mapping',
    });
    const repoOnly = environmentOption({
      bench: undefined,
      cwd: destinationRepo,
    });
    const create = proposeHandoffDestination({
      source: source(),
      destination: repoOnly,
      sourceBranchName: 'feat/689-handoff-destination-mapping',
    });

    expect(reuse).toMatchObject({
      action: 'reuse-worktree',
      cwd: destinationWorktree,
      worktreeInstanceId,
      sourceCwd,
      sourceNodeId,
    });
    expect(create).toMatchObject({
      action: 'create-worktree',
      repoInstanceId,
      sourceCwd,
    });
    expect(create.cwd).toBe(
      `${destinationRepo}/.worktrees/feat-689-handoff-destination-mapping`
    );
    expect(create.summary).toContain('source cwd kept as metadata only');
  });

  it('maps paths only through configured mirror roots under allowed hub roots', () => {
    const result = resolveHandoffPathMappings({
      sourceNodeId,
      destinationNodeId,
      sourcePaths: [`${sourceCwd}/shared/handoff.ts`],
      mirrorRoots: [mirrorRoot()],
      allowedDestinationRoots: ['/srv/relay'],
    });

    expect(result.conflicts).toEqual([]);
    expect(result.mappings).toEqual([
      {
        kind: 'file',
        source: {
          nodeId: sourceNodeId,
          path: `${sourceCwd}/shared/handoff.ts`,
        },
        destination: {
          nodeId: destinationNodeId,
          path: `${destinationWorktree}/shared/handoff.ts`,
          mode: 'create',
        },
      },
    ]);
  });

  it('does not path-match mirror roots scoped to another source node', () => {
    const result = resolveHandoffPathMappings({
      sourceNodeId,
      destinationNodeId,
      sourcePaths: [`${sourceCwd}/shared/handoff.ts`],
      mirrorRoots: [mirrorRoot({ sourceNodeId: 'other-source-node' })],
      allowedDestinationRoots: ['/srv/relay'],
    });

    expect(result.mappings).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        code: 'MISSING_PATH_MAPPING',
        message: `no configured path mapping for source path ${sourceCwd}/shared/handoff.ts`,
        nodeId: destinationNodeId,
        reasonCode: 'FAILED_MISSING_PATH_MAPPING',
      },
    ]);
  });

  it('does not path-match mirror roots scoped to another destination node', () => {
    const result = resolveHandoffPathMappings({
      sourceNodeId,
      destinationNodeId,
      sourcePaths: [`${sourceCwd}/shared/handoff.ts`],
      mirrorRoots: [
        mirrorRoot({ destinationNodeId: 'other-destination-node' }),
      ],
      allowedDestinationRoots: ['/srv/relay'],
    });

    expect(result.mappings).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        code: 'MISSING_PATH_MAPPING',
        message: `no configured path mapping for source path ${sourceCwd}/shared/handoff.ts`,
        nodeId: destinationNodeId,
        reasonCode: 'FAILED_MISSING_PATH_MAPPING',
      },
    ]);
  });

  it('blocks unsafe mapping roots, traversal, and broad home mirroring', () => {
    const broad = validateHandoffMirrorRoot({
      mirrorRoot: mirrorRoot({ sourceRoot: '/Users/ebi' }),
      allowedDestinationRoots: ['/srv/relay'],
    });
    const traversal = resolveHandoffPathMappings({
      sourceNodeId,
      destinationNodeId,
      sourcePaths: [`${sourceCwd}/shared/handoff.ts`],
      mirrorRoots: [
        mirrorRoot({ destinationRoot: `${destinationWorktree}/../elsewhere` }),
      ],
      allowedDestinationRoots: ['/srv/relay'],
    });
    const escaped = resolveHandoffPathMappings({
      sourceNodeId,
      destinationNodeId,
      sourcePaths: [`${sourceCwd}/shared/handoff.ts`],
      mirrorRoots: [mirrorRoot({ destinationRoot: '/private/tmp/handoff' })],
      allowedDestinationRoots: ['/srv/relay'],
    });

    expect(broad.ok).toBe(false);
    const broadDestination = validateHandoffDestinationRoot({
      path: '/',
      allowedDestinationRoots: [],
    });
    expect(broadDestination).toEqual({
      ok: false,
      reason: '/ is too broad for handoff mirroring',
    });
    expect(traversal.conflicts.map((item) => item.code)).toEqual([
      'MISSING_PATH_MAPPING',
      'UNSAFE_PATH_MAPPING',
    ]);
    expect(escaped.conflicts.map((item) => item.code)).toEqual([
      'MISSING_PATH_MAPPING',
      'UNSAFE_PATH_MAPPING',
    ]);
  });

  it('detects missing path mapping as a typed blocker', () => {
    const conflicts = detectHandoffDestinationConflicts({
      source: source(),
      destination: environmentOption(),
      sourcePaths: [`${sourceCwd}/shared/handoff.ts`],
      mirrorRoots: [],
      allowedDestinationRoots: ['/srv/relay'],
    });

    expect(conflicts).toEqual([
      {
        code: 'MISSING_PATH_MAPPING',
        message: `no configured path mapping for source path ${sourceCwd}/shared/handoff.ts`,
        nodeId: destinationNodeId,
        reasonCode: 'FAILED_MISSING_PATH_MAPPING',
      },
    ]);
  });

  it('detects base mismatch, dirty destination, and untracked collisions', () => {
    const dirty: RepoInventoryDirtySummary = {
      stagedCount: 1,
      unstagedCount: 2,
      untrackedCount: 1,
      conflictedCount: 0,
      files: [{ path: 'shared/handoff.ts', status: 'untracked' }],
      truncated: false,
    };
    const conflicts = detectHandoffDestinationConflicts({
      source: source(),
      destination: environmentOption(),
      sourceBranchName: 'feat/source-branch',
      sourceBaseCommit: 'base-source',
      destinationInventory: inventory(
        {},
        {
          branchName: 'feat/destination-branch',
          dirty,
          divergence: {
            upstreamRef: 'origin/nightly',
            aheadCount: 0,
            behindCount: 0,
            headSha: 'base-destination',
          },
        }
      ),
      sourcePaths: [`${sourceCwd}/shared/handoff.ts`],
      mirrorRoots: [mirrorRoot()],
      allowedDestinationRoots: ['/srv/relay'],
    });

    expect(conflicts.map((item) => item.code)).toEqual([
      'BASE_MISMATCH',
      'BASE_MISMATCH',
      'DESTINATION_DIRTY',
      'UNTRACKED_COLLISION',
    ]);
    expect(conflicts[0].message).toContain('destination head');
    expect(conflicts[1].message).toContain('destination branch');
    expect(conflicts[2].message).toContain('3 tracked/conflicted');
    expect(conflicts[3].message).toContain('shared/handoff.ts');
  });

  it('resolves untracked collision paths from the destination worktree root, not cwd subdirectories', () => {
    const dirty: RepoInventoryDirtySummary = {
      ...cleanDirty(),
      untrackedCount: 1,
      files: [{ path: 'shared/handoff.ts', status: 'untracked' }],
    };
    const conflicts = detectHandoffDestinationConflicts({
      source: source(),
      destination: environmentOption({
        cwd: `${destinationWorktree}/packages/app`,
      }),
      destinationInventory: inventory({}, { dirty }),
      sourcePaths: [`${sourceCwd}/shared/handoff.ts`],
      mirrorRoots: [mirrorRoot()],
      allowedDestinationRoots: ['/srv/relay'],
    });

    expect(conflicts).toEqual([
      {
        code: 'UNTRACKED_COLLISION',
        message:
          'destination untracked path may be overwritten: shared/handoff.ts',
        nodeId: destinationNodeId,
        reasonCode: 'FAILED_DESTINATION_CONFLICT',
      },
    ]);
  });

  it('ignores unrelated untracked paths when mapped writes target different destinations', () => {
    const dirty: RepoInventoryDirtySummary = {
      ...cleanDirty(),
      untrackedCount: 1,
      files: [{ path: 'docs/notes.md', status: 'untracked' }],
    };
    const conflicts = detectHandoffDestinationConflicts({
      source: source(),
      destination: environmentOption({
        cwd: `${destinationWorktree}/packages/app`,
      }),
      destinationInventory: inventory({}, { dirty }),
      sourcePaths: [`${sourceCwd}/shared/handoff.ts`],
      mirrorRoots: [mirrorRoot()],
      allowedDestinationRoots: ['/srv/relay'],
    });

    expect(conflicts).toEqual([]);
  });

  it('does not report untracked collisions for metadata-only handoffs without mapped writes', () => {
    const dirty: RepoInventoryDirtySummary = {
      ...cleanDirty(),
      untrackedCount: 1,
      files: [{ path: 'shared/handoff.ts', status: 'untracked' }],
    };
    const conflicts = detectHandoffDestinationConflicts({
      source: source(),
      destination: environmentOption(),
      destinationInventory: inventory({}, { dirty }),
      allowedDestinationRoots: ['/srv/relay'],
    });

    expect(conflicts).toEqual([]);
  });

  it('detects stale/offline destination and missing capabilities with deterministic output', () => {
    const conflicts = detectHandoffDestinationConflicts({
      source: source(),
      destination: environmentOption({
        capabilities: ['session:create:terminal'],
        freshness: 'offline',
        node: {
          nodeId: destinationNodeId,
          kind: 'remote',
          online: false,
        },
        degradedReasons: [
          { kind: 'capability-missing', capability: 'rpc:fs:write' },
          { kind: 'worktree-missing', localPath: destinationWorktree },
        ],
      }),
      requiredCapabilities: ['rpc:fs:write', 'rpc:git:read'],
      sourcePaths: [`${sourceCwd}/shared/handoff.ts`],
      mirrorRoots: [],
      allowedDestinationRoots: ['/srv/relay'],
    });

    expect(conflicts.map((item) => item.code)).toEqual([
      'DESTINATION_CONFLICT',
      'DESTINATION_UNAVAILABLE',
      'MISSING_CAPABILITY_GRANT',
      'MISSING_CAPABILITY_GRANT',
      'MISSING_PATH_MAPPING',
    ]);
    expect(conflicts).toEqual(
      [...conflicts].sort((a, b) => {
        const code = a.code.localeCompare(b.code);
        if (code !== 0) return code;
        const node = (a.nodeId ?? '').localeCompare(b.nodeId ?? '');
        if (node !== 0) return node;
        return a.message.localeCompare(b.message);
      })
    );
  });
});
