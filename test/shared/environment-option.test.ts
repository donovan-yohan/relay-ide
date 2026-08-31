import { describe, expect, it } from 'vitest';

import {
  createRepoInstanceId,
  createWorktreeInstanceId,
  DEFAULT_LOCAL_NODE_ID,
} from '../../shared/identity.js';
import { RELAY_CAPABILITY_BITS } from '../../shared/security-policy.js';
import {
  ENVIRONMENT_DEGRADED_REASONS,
  ENVIRONMENT_FRESHNESS_VALUES,
  ENVIRONMENT_OPTION_SCHEMA_VERSION,
  hasBench,
  hasRepoInstance,
  isEnvironmentDegradedReason,
  isEnvironmentFreshness,
  isEnvironmentOption,
  type EnvironmentDegradedReason,
  type EnvironmentFreshness,
  type EnvironmentOption,
} from '../../shared/environment-option.js';

function baseRepoInstance(localPath = '/repos/relay-ide') {
  return {
    repoInstanceId: createRepoInstanceId(DEFAULT_LOCAL_NODE_ID, localPath),
    localPath,
    repoIdentity: 'github.com/donovan-yohan/relay-ide',
    name: 'relay-ide',
    currentBranch: 'nightly',
  };
}

function baseBench(localPath = '/repos/relay-ide/.worktrees/623') {
  return {
    worktreeInstanceId: createWorktreeInstanceId(
      DEFAULT_LOCAL_NODE_ID,
      localPath
    ),
    localPath,
    branchName: 'feature/623-environment-option',
  };
}

function baseNode() {
  return {
    nodeId: DEFAULT_LOCAL_NODE_ID,
    kind: 'local' as const,
    displayName: 'this-mac',
    online: true,
  };
}

// Explicit `undefined` is part of what these guards are asserted against
// (an option whose `repoInstance` key is present but unset), so the override
// bag deliberately admits it where `Partial<EnvironmentOption>` would not.
type EnvironmentOptionOverrides = {
  [K in keyof EnvironmentOption]?: EnvironmentOption[K] | undefined;
};

function baseOption(
  overrides: EnvironmentOptionOverrides = {}
): EnvironmentOption {
  return {
    schemaVersion: ENVIRONMENT_OPTION_SCHEMA_VERSION,
    id: `env:${DEFAULT_LOCAL_NODE_ID}:/repos/relay-ide`,
    node: baseNode(),
    capabilities: ['session:read', 'session:create:terminal'],
    cwd: '/repos/relay-ide',
    cwdMode: 'repo',
    freshness: 'fresh',
    repoInstance: baseRepoInstance(),
    generatedAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  } as EnvironmentOption;
}

describe('environment-option type guards', () => {
  it('accepts a minimal free/non-git cwd option (no repo, no bench)', () => {
    const option = baseOption({
      cwdMode: 'free',
      cwd: '/tmp/scratch',
      repoInstance: undefined,
      bench: undefined,
    });
    expect(isEnvironmentOption(option)).toBe(true);
    expect(hasRepoInstance(option)).toBe(false);
    expect(hasBench(option)).toBe(false);
  });

  it('accepts a repo-backed option with bench', () => {
    const option = baseOption({ bench: baseBench() });
    expect(isEnvironmentOption(option)).toBe(true);
    expect(hasRepoInstance(option)).toBe(true);
    expect(hasBench(option)).toBe(true);
  });

  it('rejects non-objects, missing fields, and unknown freshness', () => {
    expect(isEnvironmentOption(null)).toBe(false);
    expect(isEnvironmentOption('env')).toBe(false);
    expect(isEnvironmentOption({})).toBe(false);
    const bad = baseOption() as unknown as Record<string, unknown>;
    delete bad.cwd;
    expect(isEnvironmentOption(bad)).toBe(false);
    const badFreshness = { ...baseOption(), freshness: 'haunted' };
    expect(isEnvironmentOption(badFreshness)).toBe(false);
  });

  it('rejects bench without repoInstance (shape invariant)', () => {
    const option = baseOption({ bench: baseBench(), repoInstance: undefined });
    expect(isEnvironmentOption(option)).toBe(false);
  });

  it('rejects unknown capability bits', () => {
    const option = baseOption({
      capabilities: ['session:read', 'session:make:sandwich' as never],
    });
    expect(isEnvironmentOption(option)).toBe(false);
  });

  it('enforces cwd containment when cwdMode is "repo"', () => {
    const option = baseOption({
      cwd: '/elsewhere/not-in-repo',
      cwdMode: 'repo',
    });
    expect(isEnvironmentOption(option)).toBe(false);
  });

  it('allows cwd outside repo when cwdMode is "explicit-outside-repo"', () => {
    const option = baseOption({
      cwd: '/elsewhere/explicit',
      cwdMode: 'explicit-outside-repo',
    });
    expect(isEnvironmentOption(option)).toBe(true);
  });

  it('allows cwd inside a bench worktree', () => {
    const benchPath = '/repos/relay-ide/.worktrees/623';
    const option = baseOption({
      cwd: benchPath,
      cwdMode: 'repo',
      bench: baseBench(benchPath),
    });
    expect(isEnvironmentOption(option)).toBe(true);
  });

  it('accepts cwd containment regardless of trailing-slash differences', () => {
    // Regression: previous isCwdInsideRepo failed when repoLocalPath had a
    // trailing slash but cwd did not (PR #634 / Gemini review).
    const repo = baseRepoInstance('/repos/relay-ide/');
    const option = baseOption({
      cwd: '/repos/relay-ide',
      cwdMode: 'repo',
      repoInstance: repo,
    });
    expect(isEnvironmentOption(option)).toBe(true);

    const optionInverse = baseOption({
      cwd: '/repos/relay-ide/',
      cwdMode: 'repo',
      repoInstance: baseRepoInstance('/repos/relay-ide'),
    });
    expect(isEnvironmentOption(optionInverse)).toBe(true);
  });

  it('rejects sibling path that shares a prefix with repoLocalPath', () => {
    const option = baseOption({
      cwd: '/repos/relay-ide-other/src',
      cwdMode: 'repo',
      repoInstance: baseRepoInstance('/repos/relay-ide'),
    });
    expect(isEnvironmentOption(option)).toBe(false);
  });

  it('rejects repoInstance missing required repoIdentity field', () => {
    // Regression: isOptionalStringOrNull previously accepted undefined where
    // the interface requires string | null (PR #634 / Gemini review).
    const repo = baseRepoInstance() as Record<string, unknown>;
    delete repo.repoIdentity;
    const option = baseOption({
      repoInstance: repo as unknown as ReturnType<typeof baseRepoInstance>,
    });
    expect(isEnvironmentOption(option)).toBe(false);
  });

  it('accepts a node summary carrying agentProviders (#861(B))', () => {
    const option = baseOption({
      node: {
        ...baseNode(),
        agentProviders: [
          { id: 'claude', availability: 'available' },
          {
            id: 'codex',
            availability: 'unavailable',
            reason: 'UNSUPPORTED_CAPABILITY',
          },
          { id: 'hermes', availability: 'unknown', authStatus: 'logged-out' },
        ],
      },
    });
    expect(isEnvironmentOption(option)).toBe(true);
  });

  it('rejects an agentProvider with an invalid availability (#861(B))', () => {
    const option = baseOption({
      node: {
        ...baseNode(),
        agentProviders: [
          { id: 'claude', availability: 'maybe' as never },
        ],
      },
    });
    expect(isEnvironmentOption(option)).toBe(false);
  });
});

describe('environment-option freshness + degraded reasons', () => {
  it('freshness enum is exhaustively fresh/stale/offline/updating', () => {
    // #861(A): 'updating' is a distinct freshness for a node mid-update.
    expect(ENVIRONMENT_FRESHNESS_VALUES).toEqual([
      'fresh',
      'stale',
      'offline',
      'updating',
    ]);
    for (const value of ENVIRONMENT_FRESHNESS_VALUES) {
      expect(isEnvironmentFreshness(value)).toBe(true);
    }
    expect(isEnvironmentFreshness('haunted')).toBe(false);
    expect(isEnvironmentFreshness(undefined)).toBe(false);
  });

  it('typed switch over freshness is exhaustive (compile-time)', () => {
    function describeFreshness(value: EnvironmentFreshness): string {
      switch (value) {
        case 'fresh':
          return 'fresh';
        case 'stale':
          return 'stale';
        case 'offline':
          return 'offline';
        case 'updating':
          return 'updating';
        default: {
          const exhaustive: never = value;
          return exhaustive;
        }
      }
    }
    expect(describeFreshness('fresh')).toBe('fresh');
    expect(describeFreshness('stale')).toBe('stale');
    expect(describeFreshness('offline')).toBe('offline');
    expect(describeFreshness('updating')).toBe('updating');
  });

  it('degraded reason discriminator covers every known variant', () => {
    const expectedKinds = new Set([
      'node-offline',
      'node-stale',
      'capability-missing',
      'repo-missing',
      'worktree-missing',
      'auth-failed',
      // #861(C)/(D): version-skew + cwd-invalid join the union.
      'version-skew',
      'cwd-invalid',
      'other',
    ]);
    expect(new Set(ENVIRONMENT_DEGRADED_REASONS)).toEqual(expectedKinds);

    function describeReason(reason: EnvironmentDegradedReason): string {
      switch (reason.kind) {
        case 'node-offline':
          return `offline since ${reason.lastSeenAt ?? 'unknown'}`;
        case 'node-stale':
          return `stale since ${reason.lastSeenAt}`;
        case 'capability-missing':
          return `missing ${reason.capability}`;
        case 'repo-missing':
          return `repo ${reason.repoIdentity ?? reason.localPath} missing`;
        case 'worktree-missing':
          return `worktree ${reason.localPath} missing`;
        case 'auth-failed':
          return `auth failed: ${reason.message}`;
        case 'version-skew':
          return `${reason.scope} skew (${reason.category}): ${reason.message}`;
        case 'cwd-invalid':
          return `cwd invalid ${reason.cwd}: ${reason.message}`;
        case 'other':
          return `other: ${reason.message}`;
        default: {
          const exhaustive: never = reason;
          return exhaustive;
        }
      }
    }

    expect(
      describeReason({ kind: 'capability-missing', capability: 'rpc:git:read' })
    ).toBe('missing rpc:git:read');
    expect(
      describeReason({
        kind: 'node-offline',
        lastSeenAt: '2026-05-19T00:00:00.000Z',
      })
    ).toContain('offline');
    expect(
      describeReason({
        kind: 'worktree-missing',
        localPath: '/missing',
      })
    ).toContain('worktree');
  });

  it('isEnvironmentDegradedReason recognizes each kind', () => {
    expect(
      isEnvironmentDegradedReason({
        kind: 'capability-missing',
        capability: 'session:read',
      })
    ).toBe(true);
    expect(isEnvironmentDegradedReason({ kind: 'unknown' })).toBe(false);
    expect(isEnvironmentDegradedReason(null)).toBe(false);
    expect(
      isEnvironmentDegradedReason({
        kind: 'capability-missing',
        capability: 'not-a-bit',
      })
    ).toBe(false);
  });

  it('isEnvironmentDegradedReason validates version-skew (#861(C))', () => {
    expect(
      isEnvironmentDegradedReason({
        kind: 'version-skew',
        scope: 'helper',
        category: 'major-skew-error',
        message: 'helper binary is too old',
        remediationHint: 'run relay-ide update',
      })
    ).toBe(true);
    expect(
      isEnvironmentDegradedReason({
        kind: 'version-skew',
        scope: 'protocol',
        category: 'incompatible',
        message: 'node protocol is incompatible',
      })
    ).toBe(true);
    // Bad scope rejected.
    expect(
      isEnvironmentDegradedReason({
        kind: 'version-skew',
        scope: 'wire',
        category: 'x',
        message: 'm',
      })
    ).toBe(false);
    // Missing message rejected.
    expect(
      isEnvironmentDegradedReason({
        kind: 'version-skew',
        scope: 'helper',
        category: 'minor-skew-warn',
      })
    ).toBe(false);
  });

  it('isEnvironmentDegradedReason validates cwd-invalid (#861(D))', () => {
    expect(
      isEnvironmentDegradedReason({
        kind: 'cwd-invalid',
        cwd: '/gone',
        message: 'cwd no longer exists',
        code: 'ENOENT',
      })
    ).toBe(true);
    // message required.
    expect(
      isEnvironmentDegradedReason({ kind: 'cwd-invalid', cwd: '/gone' })
    ).toBe(false);
    // cwd required.
    expect(
      isEnvironmentDegradedReason({ kind: 'cwd-invalid', message: 'm' })
    ).toBe(false);
  });

  it('attaches degradedReasons array on stale/offline options', () => {
    const option = baseOption({
      freshness: 'stale',
      degradedReasons: [
        { kind: 'node-stale', lastSeenAt: '2026-05-18T00:00:00.000Z' },
        { kind: 'capability-missing', capability: 'rpc:git:write' },
      ],
    });
    expect(isEnvironmentOption(option)).toBe(true);
  });

  it('rejects degradedReasons when freshness is fresh', () => {
    const option = baseOption({
      freshness: 'fresh',
      degradedReasons: [{ kind: 'node-stale', lastSeenAt: 'x' }],
    });
    expect(isEnvironmentOption(option)).toBe(false);
  });

  it('allows degradedReasons on an updating option (#861(A))', () => {
    const option = baseOption({
      freshness: 'updating',
      degradedReasons: [
        {
          kind: 'other',
          message:
            'node is updating — new sessions blocked until update completes',
          code: 'updating',
        },
      ],
    });
    expect(isEnvironmentOption(option)).toBe(true);
  });
});

describe('environment-option capability bit coverage', () => {
  it('every known capability bit in security-policy is representable', () => {
    for (const bit of RELAY_CAPABILITY_BITS) {
      const option = baseOption({ capabilities: [bit] });
      expect(isEnvironmentOption(option)).toBe(true);
    }
  });
});

describe('environment-option JSON round trip', () => {
  it('preserves every field and discriminant through JSON', () => {
    const option = baseOption({
      bench: baseBench(),
      cwd: '/repos/relay-ide/.worktrees/623',
      freshness: 'stale',
      degradedReasons: [
        { kind: 'node-stale', lastSeenAt: '2026-05-18T00:00:00.000Z' },
        { kind: 'capability-missing', capability: 'rpc:git:write' },
        { kind: 'auth-failed', message: 'token expired' },
      ],
    });
    const round = JSON.parse(JSON.stringify(option)) as unknown;
    expect(isEnvironmentOption(round)).toBe(true);
    expect(round).toEqual(option);
  });

  it('rejects shape with rogue extra discriminator after round trip', () => {
    const option = baseOption();
    const round = JSON.parse(JSON.stringify(option)) as Record<string, unknown>;
    round.freshness = 'sometimes';
    expect(isEnvironmentOption(round)).toBe(false);
  });
});
