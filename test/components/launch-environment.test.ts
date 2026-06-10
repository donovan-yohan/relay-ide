// launch-environment (#630) — unit tests for the shared launch hook that
// the palette dialog (#630) and the new-session dialog (#629) both call to
// turn an `EnvironmentOption` into a `createSession` invocation.

import { describe, expect, it, vi } from 'vitest';
import type {
  EnvironmentAgentProvider,
  EnvironmentOption,
} from '../../shared/environment-option.js';
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

/**
 * #863: a fresh option whose node advertises the given agent providers. Used to
 * exercise the launch-boundary provider gate without changing freshness (the
 * node row stays launchable for a shell regardless of agent availability).
 */
function freshOptionWithProviders(
  providers: EnvironmentAgentProvider[],
  overrides: Partial<EnvironmentOption> = {}
): EnvironmentOption {
  const base = freshOption(overrides);
  return {
    ...base,
    node: { ...base.node, agentProviders: providers },
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

  // #862: a fully free-cwd terminal launch (no repoInstance, no bench — the
  // repo-less tab-plus → env-picker path) must leak NEITHER repoPath NOR
  // worktreePath. Guards the acceptance "no stale repo metadata leak".
  it('maps a free-cwd terminal launch with no repoPath/worktreePath', () => {
    const opt = freshOption({
      cwdMode: 'free',
      cwd: '/tmp/scratch',
    });
    delete (opt as { repoInstance?: unknown }).repoInstance;
    const opts = environmentToCreateSessionOptions(opt, { type: 'terminal' });
    expect(opts.type).toBe('terminal');
    expect(opts.cwd).toBe('/tmp/scratch');
    expect(opts).not.toHaveProperty('repoPath');
    expect(opts).not.toHaveProperty('worktreePath');
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

// #863: agent launches flow the per-option provider choice into
// `launchEnvironment` overrides `{ type: 'agent', agent }`, gated fail-closed
// against `option.node.agentProviders`. cwd/repo/worktree context is the same
// mapping the terminal path uses — these tests assert the agent field rides
// alongside that context intact across free / repo / worktree cwd shapes.
describe('launchEnvironment — agent launches (#863)', () => {
  function captureCreateSession() {
    return vi.fn(async () => ({ session: undefined, error: null }));
  }

  it('maps {type:agent, agent} with repo cwd context preserved', async () => {
    const createSession = captureCreateSession();
    const option = freshOptionWithProviders([
      { id: 'claude', availability: 'available' },
    ]);
    const result = await launchEnvironment(
      option,
      { type: 'agent', agent: 'claude' },
      createSession
    );
    expect(result.kind).toBe('launched');
    expect(createSession).toHaveBeenCalledTimes(1);
    const opts = createSession.mock.calls[0]?.[0];
    expect(opts?.type).toBe('agent');
    expect(opts?.agent).toBe('claude');
    expect(opts?.nodeId).toBe('local');
    expect(opts?.cwd).toBe('/Users/dev/repos/relay-ide');
    // Repo cwd context rides alongside the agent field.
    expect(opts?.repoPath).toBe('/Users/dev/repos/relay-ide');
  });

  it('maps an agent launch on a free / non-git cwd with no repo leak', async () => {
    const createSession = captureCreateSession();
    const option = freshOptionWithProviders(
      [{ id: 'codex', availability: 'available' }],
      { cwdMode: 'free', cwd: '/tmp/scratch' }
    );
    delete (option as { repoInstance?: unknown }).repoInstance;
    const result = await launchEnvironment(
      option,
      { type: 'agent', agent: 'codex' },
      createSession
    );
    expect(result.kind).toBe('launched');
    const opts = createSession.mock.calls[0]?.[0];
    expect(opts?.type).toBe('agent');
    expect(opts?.agent).toBe('codex');
    expect(opts?.cwd).toBe('/tmp/scratch');
    expect(opts).not.toHaveProperty('repoPath');
    expect(opts).not.toHaveProperty('worktreePath');
  });

  it('maps an agent launch with worktree cwd context preserved', async () => {
    const createSession = captureCreateSession();
    const option = freshOptionWithProviders(
      [{ id: 'claude', availability: 'available' }],
      {
        cwd: '/Users/dev/repos/relay-ide/.worktrees/feature',
        bench: {
          worktreeInstanceId: 'local:wt-1',
          localPath: '/Users/dev/repos/relay-ide/.worktrees/feature',
          branchName: 'feature/foo',
        },
      }
    );
    const result = await launchEnvironment(
      option,
      { type: 'agent', agent: 'claude' },
      createSession
    );
    expect(result.kind).toBe('launched');
    const opts = createSession.mock.calls[0]?.[0];
    expect(opts?.type).toBe('agent');
    expect(opts?.agent).toBe('claude');
    expect(opts?.repoPath).toBe('/Users/dev/repos/relay-ide');
    expect(opts?.worktreePath).toBe(
      '/Users/dev/repos/relay-ide/.worktrees/feature'
    );
  });

  it('blocks an agent launch when the provider is unavailable, with typed reason', async () => {
    const createSession = captureCreateSession();
    const option = freshOptionWithProviders([
      {
        id: 'claude',
        availability: 'unavailable',
        reason: 'UNSUPPORTED_CAPABILITY',
      },
    ]);
    const result = await launchEnvironment(
      option,
      { type: 'agent', agent: 'claude' },
      createSession
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason.code).toBe('provider-unavailable');
      if (result.reason.code === 'provider-unavailable') {
        expect(result.reason.agent).toBe('claude');
        expect(result.reason.availability).toBe('unavailable');
        expect(result.reason.providerReason).toBe('UNSUPPORTED_CAPABILITY');
      }
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  it('blocks a degraded provider fail-closed (e.g. auth/login required)', async () => {
    const createSession = captureCreateSession();
    const option = freshOptionWithProviders([
      {
        id: 'codex',
        availability: 'degraded',
        reason: 'REPAIR_REQUIRED',
        authStatus: 'logged-out',
      },
    ]);
    const result = await launchEnvironment(
      option,
      { type: 'agent', agent: 'codex' },
      createSession
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked' && result.reason.code === 'provider-unavailable') {
      expect(result.reason.availability).toBe('degraded');
      expect(result.reason.authStatus).toBe('logged-out');
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  it('blocks an agent launch for a provider the node did not advertise (unknown)', async () => {
    const createSession = captureCreateSession();
    // Node advertises only `claude`; choosing `codex` must fail closed as
    // `unknown` rather than silently launching an unconfigured provider.
    const option = freshOptionWithProviders([
      { id: 'claude', availability: 'available' },
    ]);
    const result = await launchEnvironment(
      option,
      { type: 'agent', agent: 'codex' },
      createSession
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked' && result.reason.code === 'provider-unavailable') {
      expect(result.reason.agent).toBe('codex');
      expect(result.reason.availability).toBe('unknown');
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  it('blocks an agent launch when the node advertises no providers at all', async () => {
    const createSession = captureCreateSession();
    // No `agentProviders` key on the node summary — agent launch fails closed.
    const option = freshOption();
    const result = await launchEnvironment(
      option,
      { type: 'agent', agent: 'claude' },
      createSession
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason.code).toBe('provider-unavailable');
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  it('terminal launch on the same node is unaffected by an unavailable agent', async () => {
    const createSession = captureCreateSession();
    // Same node, every agent provider down — a TERMINAL launch must still
    // succeed (acceptance: unavailable agents never block a plain shell).
    const option = freshOptionWithProviders([
      { id: 'claude', availability: 'unavailable', reason: 'UNSUPPORTED_CAPABILITY' },
      { id: 'codex', availability: 'degraded', reason: 'REPAIR_REQUIRED' },
    ]);
    const result = await launchEnvironment(
      option,
      { type: 'terminal' },
      createSession
    );
    expect(result.kind).toBe('launched');
    expect(createSession).toHaveBeenCalledTimes(1);
    const opts = createSession.mock.calls[0]?.[0];
    expect(opts?.type).toBe('terminal');
    // Terminal path never inspects agentProviders and never sets `agent`.
    expect(opts?.agent).toBeUndefined();
  });

  it('default (no type override) launch ignores agentProviders entirely', async () => {
    const createSession = captureCreateSession();
    const option = freshOptionWithProviders([
      { id: 'claude', availability: 'unavailable', reason: 'UNSUPPORTED_CAPABILITY' },
    ]);
    // No overrides → defaults to terminal; the unavailable agent is irrelevant.
    const result = await launchEnvironment(option, {}, createSession);
    expect(result.kind).toBe('launched');
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});

// #863 configured-command honesty: the issue requires configured/default
// commands be exposed ONLY when already known from trusted Relay/node config.
// An audit of `shared/` + `server/` found NO trusted configured-command /
// default-command field on node summaries, the node manifest, or the
// `EnvironmentAgentProvider` shape — `node.capabilities.agents` is a bare
// `Record<string, NodeCapabilityStatus>` (availability only). This test pins
// that honest absence: the provider shape carries no command/argv affordance,
// so the launcher must not fabricate one. If a trusted field is ever added,
// this guard fails and the read-only exposure can be wired then.
describe('configured-command honesty (#863)', () => {
  it('EnvironmentAgentProvider carries no configured/default command field', () => {
    const provider: EnvironmentAgentProvider = {
      id: 'claude',
      availability: 'available',
      authStatus: 'logged-in',
      reason: undefined,
    };
    // The full set of keys the data layer (#861) populates — id + availability
    // + optional authStatus/reason. No command, argv, defaultCommand, etc.
    const keys = Object.keys(provider).sort();
    expect(keys).toEqual(['authStatus', 'availability', 'id', 'reason']);
    expect(provider).not.toHaveProperty('command');
    expect(provider).not.toHaveProperty('defaultCommand');
    expect(provider).not.toHaveProperty('configuredCommand');
    expect(provider).not.toHaveProperty('argv');
  });
});
