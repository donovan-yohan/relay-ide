/**
 * Round-trip + resume tests for Workbench block environment metadata (#631).
 *
 * Covers (per #631 acceptance):
 *   1. `buildBlockEnvironmentRef` captures ONLY typed env IDs from a picker
 *      option — never free-form path strings beyond `cwd`.
 *   2. `isWorkbenchBlockEnvironmentRef` rejects malformed inputs (bad schema
 *      version, missing required fields, wrong cwdMode, capability strings
 *      not in the closed enum, free + repoInstance invariant violation).
 *   3. JSON.stringify → JSON.parse round-trip preserves every typed ID and
 *      the picker option id / version. Repo, worktree, and free / non-git
 *      shapes all survive.
 *   4. `WorkbenchBlockDescriptor.environment` round-trips through the
 *      layout serialiser/deserialiser without landing in `_unknown`.
 *   5. Resume / attach via `resolveBlockEnvironment` returns `ok` when the
 *      same picker option is fresh, `block-on-launch` with a typed reason
 *      when the option is stale/offline/missing/capability-shrunk, and
 *      `legacy-no-environment` when the descriptor predates #631.
 */

import { describe, it, expect } from 'vitest';

import type { EnvironmentOption } from '../../shared/environment-option.js';
import {
  WORKBENCH_BLOCK_ENVIRONMENT_SCHEMA_VERSION,
  buildBlockEnvironmentRef,
  isWorkbenchBlockEnvironmentRef,
  resolveBlockEnvironment,
  type WorkbenchBlockEnvironmentRef,
} from '../../shared/workbench-block-environment.js';
import {
  WORKBENCH_LAYOUT_SCHEMA_VERSION,
  deserialiseWorkbenchLayout,
  serialiseWorkbenchLayout,
  type WorkbenchLayout,
  type WorkbenchBlockPlacement,
} from '../../shared/workbench-layout-types.js';

const CREATED_AT = '2026-05-19T12:00:00.000Z';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function repoOption(overrides: Partial<EnvironmentOption> = {}): EnvironmentOption {
  return {
    schemaVersion: 1,
    id: 'opt-relay-nightly',
    node: { nodeId: 'local', kind: 'local', displayName: 'this host', online: true },
    capabilities: ['session:create:terminal', 'rpc:fs:read', 'rpc:git:read'],
    cwd: '/Users/dev/repos/relay-ide',
    cwdMode: 'repo',
    freshness: 'fresh',
    repoInstance: {
      repoInstanceId: 'local:%2FUsers%2Fdev%2Frepos%2Frelay-ide',
      localPath: '/Users/dev/repos/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      name: 'relay-ide',
      currentBranch: 'nightly',
      defaultBranch: 'master',
    },
    generatedAt: CREATED_AT,
    ...overrides,
  };
}

function worktreeOption(): EnvironmentOption {
  return {
    ...repoOption(),
    id: 'opt-relay-631-worktree',
    cwd: '/Users/dev/repos/relay-ide/.worktrees/631',
    bench: {
      worktreeInstanceId:
        'local:%2FUsers%2Fdev%2Frepos%2Frelay-ide%2F.worktrees%2F631',
      localPath: '/Users/dev/repos/relay-ide/.worktrees/631',
      branchName: 'feature/631-workbench-picker',
      displayName: '631-workbench-picker',
    },
  };
}

function freeOption(): EnvironmentOption {
  return {
    schemaVersion: 1,
    id: 'opt-free-scratch',
    node: { nodeId: 'local', kind: 'local', online: true },
    capabilities: ['session:create:terminal'],
    cwd: '/tmp/scratch',
    cwdMode: 'free',
    freshness: 'fresh',
    generatedAt: CREATED_AT,
  };
}

function placementWithEnv(
  env: WorkbenchBlockEnvironmentRef | undefined,
  id = 'block-1'
): WorkbenchBlockPlacement {
  return {
    descriptor: {
      kind: 'terminal',
      id,
      title: 'shell',
      capabilityRequirements: ['session:create:terminal'],
      meta: {
        sessionRef: {
          nodeId: 'local',
          sessionId: 'sess-1',
          globalSessionId: 'local:sess-1',
          tabKind: 'terminal',
          cwd: env?.cwd ?? '/',
        },
      },
      ...(env !== undefined ? { environment: env } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test scaffold
    } as any,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 200 },
    minimized: false,
  };
}

function makeLayout(blocks: WorkbenchBlockPlacement[]): WorkbenchLayout {
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    workspaceScope: { id: 'ws:test' },
    blocks,
  };
}

// ---------------------------------------------------------------------------
// buildBlockEnvironmentRef — captures only typed IDs
// ---------------------------------------------------------------------------

describe('buildBlockEnvironmentRef', () => {
  it('captures nodeId, repoIdentity, repoInstanceId, cwd, cwdMode from a repo option', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    expect(env.schemaVersion).toBe(WORKBENCH_BLOCK_ENVIRONMENT_SCHEMA_VERSION);
    expect(env.nodeId).toBe('local');
    expect(env.repoIdentity).toBe('github.com/donovan-yohan/relay-ide');
    expect(env.repoInstanceId).toBe(
      'local:%2FUsers%2Fdev%2Frepos%2Frelay-ide'
    );
    expect(env.cwd).toBe('/Users/dev/repos/relay-ide');
    expect(env.cwdMode).toBe('repo');
    expect(env.pickerOptionId).toBe('opt-relay-nightly');
    expect(env.pickerVersion).toBe(1);
    expect(env.createdAt).toBe(CREATED_AT);
    expect(env.capabilities).toEqual([
      'session:create:terminal',
      'rpc:fs:read',
      'rpc:git:read',
    ]);
  });

  it('captures benchId / worktreeInstanceId when the picker option carries a bench', () => {
    const env = buildBlockEnvironmentRef({
      option: worktreeOption(),
      createdAt: CREATED_AT,
    });
    expect(env.worktreeInstanceId).toBe(
      'local:%2FUsers%2Fdev%2Frepos%2Frelay-ide%2F.worktrees%2F631'
    );
    expect(env.benchId).toBe(env.worktreeInstanceId);
    // benchId implies repoInstanceId is set.
    expect(env.repoInstanceId).toBeDefined();
  });

  it('represents a free / non-git cwd with null repoIdentity and no repoInstanceId', () => {
    const env = buildBlockEnvironmentRef({
      option: freeOption(),
      createdAt: CREATED_AT,
    });
    expect(env.cwdMode).toBe('free');
    expect(env.repoIdentity).toBeNull();
    expect(env.repoInstanceId).toBeUndefined();
    expect(env.worktreeInstanceId).toBeUndefined();
    expect(env.benchId).toBeUndefined();
  });

  it('contains no free-form path string fields beyond cwd', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    // Allow-list of known string fields; reject any new free-form path bag.
    // If a future change adds a `localPath` or similar verbatim path it MUST
    // be a typed ID or it fails this test (regression on the #615 acceptance
    // criterion that agent tasks specify env by typed IDs not prose paths).
    const allowedStringKeys = new Set([
      'nodeId',
      'repoIdentity',
      'repoInstanceId',
      'worktreeInstanceId',
      'benchId',
      'cwd',
      'cwdMode',
      'pickerOptionId',
      'createdAt',
    ]);
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') {
        expect(allowedStringKeys.has(key)).toBe(true);
      }
    }
  });

  it('does not mutate its input option', () => {
    const opt = repoOption();
    const before = JSON.stringify(opt);
    buildBlockEnvironmentRef({ option: opt, createdAt: CREATED_AT });
    expect(JSON.stringify(opt)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// isWorkbenchBlockEnvironmentRef — structural guard
// ---------------------------------------------------------------------------

describe('isWorkbenchBlockEnvironmentRef', () => {
  it('accepts a valid repo ref', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    expect(isWorkbenchBlockEnvironmentRef(env)).toBe(true);
  });

  it('accepts a valid free ref', () => {
    const env = buildBlockEnvironmentRef({
      option: freeOption(),
      createdAt: CREATED_AT,
    });
    expect(isWorkbenchBlockEnvironmentRef(env)).toBe(true);
  });

  it('rejects a wrong schemaVersion', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    const broken = { ...env, schemaVersion: 99 };
    expect(isWorkbenchBlockEnvironmentRef(broken)).toBe(false);
  });

  it('rejects missing nodeId', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    const broken: Record<string, unknown> = { ...env };
    delete broken.nodeId;
    expect(isWorkbenchBlockEnvironmentRef(broken)).toBe(false);
  });

  it('rejects a capability string that is not in the closed enum', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    const broken = { ...env, capabilities: ['not:a:real:bit'] };
    expect(isWorkbenchBlockEnvironmentRef(broken)).toBe(false);
  });

  it('rejects cwdMode: free combined with a repoInstanceId', () => {
    const env = buildBlockEnvironmentRef({
      option: freeOption(),
      createdAt: CREATED_AT,
    });
    const broken = { ...env, repoInstanceId: 'local:%2Ffoo' };
    expect(isWorkbenchBlockEnvironmentRef(broken)).toBe(false);
  });

  it('rejects a worktreeInstanceId without a repoInstanceId', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    const broken: Record<string, unknown> = {
      ...env,
      worktreeInstanceId: 'local:%2Fwt',
    };
    delete broken.repoInstanceId;
    expect(isWorkbenchBlockEnvironmentRef(broken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSON round-trip — typed IDs survive
// ---------------------------------------------------------------------------

describe('JSON serialize/deserialize round-trip', () => {
  it('preserves every typed ID for a repo-anchored env', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    const restored = JSON.parse(JSON.stringify(env));
    expect(restored).toEqual(env);
    expect(isWorkbenchBlockEnvironmentRef(restored)).toBe(true);
  });

  it('preserves bench / worktreeInstanceId on round-trip', () => {
    const env = buildBlockEnvironmentRef({
      option: worktreeOption(),
      createdAt: CREATED_AT,
    });
    const restored = JSON.parse(JSON.stringify(env));
    expect(restored.worktreeInstanceId).toBe(env.worktreeInstanceId);
    expect(restored.benchId).toBe(env.benchId);
    expect(restored.repoInstanceId).toBe(env.repoInstanceId);
  });

  it('preserves the null repoIdentity for a free / non-git env', () => {
    const env = buildBlockEnvironmentRef({
      option: freeOption(),
      createdAt: CREATED_AT,
    });
    const restored = JSON.parse(JSON.stringify(env));
    expect(restored.repoIdentity).toBeNull();
    expect(restored.repoInstanceId).toBeUndefined();
    expect(restored.cwdMode).toBe('free');
  });

  it('survives a layout serialise → deserialise round-trip on the descriptor', () => {
    const env = buildBlockEnvironmentRef({
      option: worktreeOption(),
      createdAt: CREATED_AT,
    });
    const layout = makeLayout([placementWithEnv(env, 'block-w')]);
    const serialised = serialiseWorkbenchLayout(layout);
    const restored = deserialiseWorkbenchLayout(
      JSON.parse(JSON.stringify(serialised))
    );
    expect(restored).not.toBeNull();
    const descriptor = restored!.blocks[0]!.descriptor as {
      environment?: WorkbenchBlockEnvironmentRef;
    };
    expect(descriptor.environment).toBeDefined();
    expect(descriptor.environment).toEqual(env);
    // The environment MUST be on the descriptor itself, not stashed in _unknown.
    expect(restored!.blocks[0]!._unknown).toBeUndefined();
  });

  it('survives the round-trip via the existing _unknown forward-compat path for legacy blocks', () => {
    const layout = makeLayout([placementWithEnv(undefined, 'block-legacy')]);
    const serialised = serialiseWorkbenchLayout(layout);
    const restored = deserialiseWorkbenchLayout(
      JSON.parse(JSON.stringify(serialised))
    );
    expect(restored).not.toBeNull();
    const descriptor = restored!.blocks[0]!.descriptor as {
      environment?: WorkbenchBlockEnvironmentRef;
    };
    expect(descriptor.environment).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveBlockEnvironment — resume / attach contract
// ---------------------------------------------------------------------------

describe('resolveBlockEnvironment', () => {
  it('returns legacy-no-environment when the descriptor has no environment metadata', () => {
    const result = resolveBlockEnvironment(undefined, [repoOption()]);
    expect(result.kind).toBe('legacy-no-environment');
  });

  it('returns ok when the same picker option is fresh', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    const result = resolveBlockEnvironment(env, [repoOption()]);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.option.id).toBe(env.pickerOptionId);
    }
  });

  it('returns block-on-launch / option-missing when the picker option is no longer offered', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    // Candidates do not include opt-relay-nightly any more.
    const other = repoOption({ id: 'opt-relay-master' });
    const result = resolveBlockEnvironment(env, [other]);
    expect(result.kind).toBe('block-on-launch');
    if (result.kind === 'block-on-launch') {
      expect(result.reason).toBe('option-missing');
      expect(result.ref).toBe(env);
    }
  });

  it('returns block-on-launch / option-stale when the candidate is stale', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    const stale = repoOption({
      freshness: 'stale',
      degradedReasons: [
        { kind: 'node-stale', lastSeenAt: '2026-05-19T11:00:00.000Z' },
      ],
    });
    const result = resolveBlockEnvironment(env, [stale]);
    expect(result.kind).toBe('block-on-launch');
    if (result.kind === 'block-on-launch') {
      expect(result.reason).toBe('option-stale');
    }
  });

  it('returns block-on-launch / option-offline when the candidate is offline', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    const offline = repoOption({
      freshness: 'offline',
      degradedReasons: [{ kind: 'node-offline' }],
    });
    const result = resolveBlockEnvironment(env, [offline]);
    expect(result.kind).toBe('block-on-launch');
    if (result.kind === 'block-on-launch') {
      expect(result.reason).toBe('option-offline');
    }
  });

  it('returns block-on-launch / capability-shrunk when create-time bits are no longer advertised', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    // Picker now advertises fewer bits than at create time.
    const shrunk = repoOption({ capabilities: ['session:create:terminal'] });
    const result = resolveBlockEnvironment(env, [shrunk]);
    expect(result.kind).toBe('block-on-launch');
    if (result.kind === 'block-on-launch') {
      expect(result.reason).toBe('capability-shrunk');
    }
  });

  it('never silently substitutes a different node when the original is unavailable', () => {
    const env = buildBlockEnvironmentRef({
      option: repoOption(),
      createdAt: CREATED_AT,
    });
    const fresh = repoOption({
      id: 'opt-different-node',
      node: { nodeId: 'mac', kind: 'remote', displayName: 'mac', online: true },
    });
    const result = resolveBlockEnvironment(env, [fresh]);
    // Even with a fresh candidate available, the original picker option is
    // missing so the contract MUST refuse to silently switch nodes.
    expect(result.kind).toBe('block-on-launch');
    if (result.kind === 'block-on-launch') {
      expect(result.reason).toBe('option-missing');
    }
  });
});
