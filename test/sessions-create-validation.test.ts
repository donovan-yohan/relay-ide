import { describe, expect, it } from 'vitest';
import {
  buildAgentArgs,
  parseRenderedScreenMaxLines,
  resolveSessionDisplayName,
  resolveSessionLaunchPaths,
  validateSessionCreateRequest,
} from '../server/index.js';
import {
  AGENT_CONTINUE_ARGS,
  AGENT_YOLO_ARGS,
  type Config,
} from '../server/types.js';
import type { WorkContextStore } from '../server/work-context.js';

// Minimal config stub with the two repos we'll test with
function makeConfig(repos: string[]): Config {
  return {
    host: '0.0.0.0',
    port: 3000,
    cookieTTL: '30d',
    repos,
    claudeArgs: [],
    defaultFramework: 'claude',
    defaultContinue: false,
    defaultYolo: false,
    maxPtySessions: 10,
    terminalBackend: 'relay-pty',
    defaultNotifications: false,
    claudeFullscreen: false,
  };
}

// Minimal WorkContextStore stub
function makeStore(): WorkContextStore {
  const contexts = new Map<string, unknown>();
  return {
    get(id: string) {
      return contexts.get(id);
    },
    associateSession() {},
    findSessionWorkContextIds() {
      return [];
    },
    // @ts-expect-error partial stub
  } as WorkContextStore;
}

// Captures res.status(N).json(body) calls
function makeRes() {
  let capturedStatus = 200;
  let capturedBody: unknown = undefined;
  return {
    get status() {
      return capturedStatus;
    },
    get body() {
      return capturedBody;
    },
    resObj: {
      status(code: number) {
        capturedStatus = code;
        return {
          json(body: unknown) {
            capturedBody = body;
            return this;
          },
        };
      },
    },
  };
}

describe('validateSessionCreateRequest', () => {
  const configuredPath = '/configured/repo';
  const nonGitPath = '/configured/non-git';
  const unconfiguredPath = '/not/configured';

  const config = makeConfig([configuredPath, nonGitPath]);
  const store = makeStore();

  it('returns true for agent session with configured repoPath', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      configuredPath,
      undefined,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200); // no error response sent
  });

  it('returns true for agent session with cwd inside a configured repo (worktree)', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      `${configuredPath}/.worktrees/issue-123`,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200);
  });

  it('rejects cwd that only shares a path prefix with a configured repo', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      `${configuredPath}-evil`,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
  });

  it('returns true for agent session with configured cwd (no repoPath)', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      nonGitPath,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200);
  });

  it('returns false with 400 for agent session with no launch anchor', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      undefined,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'agent sessions require a repoPath or cwd launch anchor',
    });
  });

  it('returns false with 400 for agent session with unconfigured repoPath', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      unconfiguredPath,
      undefined,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'repoPath must be a configured project path when provided',
    });
  });

  it('returns true for terminal session with configured cwd (no repoPath)', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      nonGitPath,
      'terminal',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200);
  });

  it('returns true for terminal session with configured repoPath (legacy)', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      configuredPath,
      configuredPath,
      'terminal',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200);
  });

  it('returns false with 400 for terminal session with unconfigured cwd', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      unconfiguredPath,
      'terminal',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error:
        'terminal sessions require a repoPath or cwd inside a configured project path',
    });
  });

  it('returns false with 400 for terminal session with all paths undefined (fail-closed)', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      undefined,
      'terminal',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'terminal sessions require a repoPath or cwd launch anchor',
    });
  });

  it('defaults to agent type when type is undefined', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      nonGitPath,
      undefined,
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200);
  });

  it('allows cwd-only launch anchors when no project list is configured', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      undefined,
      '/unlisted/dev/repo',
      'agent',
      makeConfig([]),
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200);
  });

  it('returns false with 404 when workContextId is set but not found', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      configuredPath,
      undefined,
      'agent',
      config,
      store,
      'missing-context-id',
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'work_context_not_found' });
  });

  // Security: a configured repoPath must not be usable to smuggle an out-of-tree
  // launch cwd past the boundary. The session launches in the resolved `cwd`
  // (worktreePath ?? requestCwd ?? repoPath), so `cwd` — not `repoPath` — is
  // what has to be inside a configured project.
  it('rejects a configured repoPath paired with an out-of-tree cwd (launch-anchor bypass)', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      configuredPath,
      '/home/user/.ssh',
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error:
        'agent sessions require a repoPath or cwd inside a configured project path',
    });
  });

  it('allows a configured repoPath paired with a worktree cwd inside it', () => {
    const res = makeRes();
    const result = validateSessionCreateRequest(
      configuredPath,
      `${configuredPath}/.worktrees/issue-9`,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(true);
    expect(res.status).toBe(200);
  });

  // End-to-end: the real request path resolves the launch cwd first, then
  // validates it. A configured repoPath + arbitrary cwd must fail closed at the
  // integration boundary, not just in isolation.
  it('closes the launch-anchor bypass through resolveSessionLaunchPaths + validate', () => {
    const { requestedRepoPath, cwd } = resolveSessionLaunchPaths({
      repoPath: configuredPath,
      cwd: '/etc',
      config,
    });
    expect(cwd).toBe('/etc'); // requestCwd wins over repoPath as the launch dir
    const res = makeRes();
    const result = validateSessionCreateRequest(
      requestedRepoPath,
      cwd,
      'agent',
      config,
      store,
      undefined,
      res.resObj as never
    );
    expect(result).toBe(false);
    expect(res.status).toBe(400);
  });
});

describe('resolveSessionLaunchPaths', () => {
  it('uses cwd as the launch anchor without synthesizing repoPath', () => {
    expect(
      resolveSessionLaunchPaths({
        cwd: ' /configured/non-git ',
        config: makeConfig(['/configured/repo']),
      })
    ).toEqual({
      requestedRepoPath: undefined,
      requestedWorktreePath: undefined,
      cwd: '/configured/non-git',
      settingsAnchorPath: '/configured/non-git',
    });
  });

  it('falls back to the local dev cwd when no project is configured', () => {
    expect(
      resolveSessionLaunchPaths({
        config: makeConfig([]),
        devCwdFallback: '/home/dev/relay-ide',
      })
    ).toEqual({
      requestedRepoPath: undefined,
      requestedWorktreePath: undefined,
      cwd: '/home/dev/relay-ide',
      settingsAnchorPath: '/home/dev/relay-ide',
    });
  });
});

describe('resolveSessionDisplayName', () => {
  it('honors and trims an explicit terminal sessions.create displayName', () => {
    expect(
      resolveSessionDisplayName('  Build worker  ', () => 'Terminal 1')
    ).toBe('Build worker');
  });

  it('falls back to the generated terminal name for blank or omitted input', () => {
    expect(resolveSessionDisplayName('   ', () => 'Terminal 2')).toBe(
      'Terminal 2'
    );
    expect(resolveSessionDisplayName(undefined, () => 'Terminal 3')).toBe(
      'Terminal 3'
    );
  });
});

describe('buildAgentArgs claudeArgs leak gate', () => {
  // config.claudeArgs holds Claude-only flags (--model/--effort). Folding them
  // into codex/opencode/hermes spawns exits those CLIs with code 2 within ~1s.
  const claudeArgs = ['--model', 'opus', '--effort', 'high'];

  it('omits claudeArgs from codex spawns when config.claudeArgs is non-empty', () => {
    const args = buildAgentArgs('codex', claudeArgs, false, undefined);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(args).toEqual([]);
  });

  it('omits claudeArgs from opencode and hermes spawns', () => {
    for (const agent of ['opencode', 'hermes'] as const) {
      const args = buildAgentArgs(agent, claudeArgs, false, undefined);
      expect(args).not.toContain('--model');
      expect(args).not.toContain('--effort');
    }
  });

  it('still passes claudeArgs to claude spawns', () => {
    const args = buildAgentArgs('claude', claudeArgs, false, undefined);
    expect(args).toEqual(['--model', 'opus', '--effort', 'high']);
  });

  it('keeps yolo + continue composition around claudeArgs for claude', () => {
    const args = buildAgentArgs('claude', claudeArgs, true, 'always');
    expect(args).toEqual([
      ...(AGENT_CONTINUE_ARGS['claude'] ?? []),
      ...claudeArgs,
      ...(AGENT_YOLO_ARGS['claude'] ?? []),
    ]);
  });

  it('keeps yolo + continue composition for codex without leaking claudeArgs', () => {
    const args = buildAgentArgs('codex', claudeArgs, true, 'always');
    expect(args).toEqual([
      ...(AGENT_CONTINUE_ARGS['codex'] ?? []),
      ...(AGENT_YOLO_ARGS['codex'] ?? []),
    ]);
    expect(args).not.toContain('--model');
  });
});

describe('parseRenderedScreenMaxLines', () => {
  it('accepts string and pre-parsed numeric query values', () => {
    expect(parseRenderedScreenMaxLines('5')).toBe(5);
    expect(parseRenderedScreenMaxLines(5)).toBe(5);
  });

  it('rejects blank, fractional, zero, and negative query values', () => {
    expect(parseRenderedScreenMaxLines('')).toBeUndefined();
    expect(parseRenderedScreenMaxLines('1.5')).toBeUndefined();
    expect(parseRenderedScreenMaxLines(1.5)).toBeUndefined();
    expect(parseRenderedScreenMaxLines('0')).toBeUndefined();
    expect(parseRenderedScreenMaxLines(0)).toBeUndefined();
    expect(parseRenderedScreenMaxLines(-1)).toBeUndefined();
  });
});
