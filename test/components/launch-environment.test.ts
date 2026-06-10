// launch-environment (#630) — unit tests for the shared launch hook that
// the palette dialog (#630) and the new-session dialog (#629) both call to
// turn an `EnvironmentOption` into a `createSession` invocation.

import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentOption } from '../../shared/environment-option.js';
import {
  canLaunchEnvironment,
  environmentToCreateSessionOptions,
  launchEnvironment,
} from '../../frontend/src/lib/launch-environment.js';

const GENERATED_AT = '2026-05-19T12:00:00.000Z';

function freshOption(
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  return {
    schemaVersion: 1,
    id: 'opt-fresh',
    node: {
      nodeId: 'local',
      kind: 'local',
      displayName: 'this host',
      online: true,
    },
    capabilities: ['session:create:terminal'],
    cwd: '/Users/dev/repos/relay-ide',
    cwdMode: 'repo',
    freshness: 'fresh',
    repoInstance: {
      repoInstanceId: 'local:/Users/dev/repos/relay-ide',
      localPath: '/Users/dev/repos/relay-ide',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      name: 'relay-ide',
      currentBranch: 'nightly',
      defaultBranch: 'master',
    },
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

describe('canLaunchEnvironment', () => {
  it('returns true for fresh', () => {
    expect(canLaunchEnvironment(freshOption({ freshness: 'fresh' }))).toBe(
      true
    );
  });
  it('returns false for stale', () => {
    expect(canLaunchEnvironment(freshOption({ freshness: 'stale' }))).toBe(
      false
    );
  });
  it('returns false for offline', () => {
    expect(canLaunchEnvironment(freshOption({ freshness: 'offline' }))).toBe(
      false
    );
  });
});

describe('environmentToCreateSessionOptions', () => {
  it('maps nodeId, cwd, repoPath from EnvironmentOption', () => {
    const opts = environmentToCreateSessionOptions(freshOption());
    expect(opts.nodeId).toBe('local');
    expect(opts.cwd).toBe('/Users/dev/repos/relay-ide');
    expect(opts.repoPath).toBe('/Users/dev/repos/relay-ide');
    // Default type is `terminal` — the palette entry launches a bare shell
    // unless the dialog overrides it.
    expect(opts.type).toBe('terminal');
  });

  it('forwards worktree localPath as worktreePath when bench is present', () => {
    const opt = freshOption({
      bench: {
        worktreeInstanceId: 'local:wt-1',
        localPath: '/Users/dev/repos/relay-ide/.worktrees/feature',
        branchName: 'feature/foo',
      },
    });
    const opts = environmentToCreateSessionOptions(opt);
    expect(opts.worktreePath).toBe(
      '/Users/dev/repos/relay-ide/.worktrees/feature'
    );
  });

  it('omits repoPath for free / non-git launches', () => {
    const opt = freshOption({
      cwdMode: 'free',
      cwd: '/tmp/scratch',
    });
    delete (opt as { repoInstance?: unknown }).repoInstance;
    const opts = environmentToCreateSessionOptions(opt);
    expect(opts.repoPath).toBeUndefined();
    expect(opts.cwd).toBe('/tmp/scratch');
  });

  it('forwards agent + type overrides', () => {
    const opts = environmentToCreateSessionOptions(freshOption(), {
      type: 'agent',
      agent: 'claude',
    });
    expect(opts.type).toBe('agent');
    expect(opts.agent).toBe('claude');
  });
});

describe('launchEnvironment', () => {
  it('calls createSession with mapped options for a fresh environment', async () => {
    const createSession = vi.fn(async () => ({
      session: undefined,
      error: null,
    }));
    const result = await launchEnvironment(freshOption(), {}, createSession);
    expect(result.kind).toBe('launched');
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0]?.nodeId).toBe('local');
  });

  it('refuses to call createSession for a stale environment (typed block)', async () => {
    const createSession = vi.fn(async () => ({
      session: undefined,
      error: null,
    }));
    const stale = freshOption({
      freshness: 'stale',
      degradedReasons: [{ kind: 'node-stale', lastSeenAt: GENERATED_AT }],
    });
    const result = await launchEnvironment(stale, {}, createSession);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason.code).toBe('stale');
      expect(result.reason.degradedReasons?.[0]?.kind).toBe('node-stale');
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  it('refuses to call createSession for an offline environment', async () => {
    const createSession = vi.fn(async () => ({
      session: undefined,
      error: null,
    }));
    const offline = freshOption({
      freshness: 'offline',
      degradedReasons: [{ kind: 'node-offline' }],
    });
    const result = await launchEnvironment(offline, {}, createSession);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason.code).toBe('offline');
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  it('blocks an updating environment with a distinct code (#861(A))', async () => {
    // Injection (createSession override), not vi.mock — the launch boundary
    // must never reach the network for a node mid-update.
    const createSession = vi.fn(async () => ({
      session: undefined,
      error: null,
    }));
    const updating = freshOption({
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
    const result = await launchEnvironment(updating, {}, createSession);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason.code).toBe('updating');
      expect(result.reason.degradedReasons?.[0]?.kind).toBe('other');
    }
    expect(createSession).not.toHaveBeenCalled();
  });
});
