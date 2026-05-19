/**
 * Tests for server/session-rename-resolver.ts
 *
 * Covers all five precedence branches:
 *   1. explicit-user
 *   2. pinned
 *   3. agent-suggested  (claude / codex / custom-script / none)
 *   4. heuristic
 *   5. default
 *
 * CLI exec calls are intercepted by mocking node:child_process.
 * git.js and logger.js are also mocked so no real I/O occurs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist the mock function so the vi.mock factory can reference it.
// vi.hoisted() runs before vi.mock() hoisting, making the reference valid.
// ---------------------------------------------------------------------------
const { mockExecFileImpl } = vi.hoisted(() => ({
  mockExecFileImpl: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock dependencies — factories must not reference external variables
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: mockExecFileImpl,
}));

vi.mock('../server/git.js', () => ({
  phraseToBranchName: vi.fn((phrase: string) =>
    phrase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  ),
}));

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test after mocks are set up
// ---------------------------------------------------------------------------
import {
  resolveSessionRename,
  buildHeuristicName,
  buildDefaultName,
  safeBranchName,
  type RenamerConfig,
  type RenameInput,
} from '../server/session-rename-resolver.js';

// ---------------------------------------------------------------------------
// Stub helpers — promisify(execFile) calls execFile(cmd, args, opts, cb)
// ---------------------------------------------------------------------------

type ExecCallback = (
  err: NodeJS.ErrnoException | null,
  stdout: string,
  stderr: string
) => void;

function stubSuccess(stdout: string): void {
  mockExecFileImpl.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: ExecCallback
    ) => {
      cb(null, stdout, '');
    }
  );
}

function stubFailure(message = 'exec failed'): void {
  mockExecFileImpl.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: ExecCallback
    ) => {
      const err = Object.assign(new Error(message), {
        stdout: '',
        stderr: message,
      }) as NodeJS.ErrnoException & { stdout: string; stderr: string };
      cb(err, '', message);
    }
  );
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const BASE_INPUT: RenameInput = {
  promptText: 'fix the sidebar nav bug',
  cwd: '/repo/relay-ide',
  repoName: 'relay-ide',
  branchName: 'nightly',
  createdAt: '2026-05-19T14:30:00.000Z',
};

const CLAUDE_CONFIG: RenamerConfig = { tool: 'claude' };
const CODEX_CONFIG: RenamerConfig = { tool: 'codex' };
const NONE_CONFIG: RenamerConfig = { tool: 'none' };

// ---------------------------------------------------------------------------
// 1. Explicit user name (highest precedence)
// ---------------------------------------------------------------------------

describe('resolveSessionRename — explicit-user branch', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  it('returns the user-set name immediately without any exec', async () => {
    const result = await resolveSessionRename(
      'My Custom Session',
      'some-pinned-name',
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('explicit-user');
    expect(result.displayName).toBe('My Custom Session');
    expect(mockExecFileImpl).not.toHaveBeenCalled();
  });

  it('trims whitespace from user-set name', async () => {
    const result = await resolveSessionRename(
      '  padded  ',
      undefined,
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(result.source).toBe('explicit-user');
    expect(result.displayName).toBe('padded');
  });

  it('skips explicit-user when name is empty string', async () => {
    const result = await resolveSessionRename(
      '',
      undefined,
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(result.source).not.toBe('explicit-user');
  });

  it('skips explicit-user when name is whitespace-only', async () => {
    const result = await resolveSessionRename(
      '   ',
      undefined,
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(result.source).not.toBe('explicit-user');
  });
});

// ---------------------------------------------------------------------------
// 2. Pinned session name
// ---------------------------------------------------------------------------

describe('resolveSessionRename — pinned branch', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  it('uses pinned name when user name is absent', async () => {
    const result = await resolveSessionRename(
      undefined,
      'my-pinned-session',
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('pinned');
    expect(result.displayName).toBe('my-pinned-session');
    expect(mockExecFileImpl).not.toHaveBeenCalled();
  });

  it('uses pinned name when user name is empty', async () => {
    const result = await resolveSessionRename(
      '',
      'pinned-value',
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(result.source).toBe('pinned');
    expect(result.displayName).toBe('pinned-value');
  });

  it('skips pinned when pinned name is empty', async () => {
    const result = await resolveSessionRename(
      undefined,
      '',
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(result.source).not.toBe('pinned');
  });

  it('explicit-user wins over pinned', async () => {
    const result = await resolveSessionRename(
      'explicit',
      'pinned',
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('explicit-user');
    expect(result.displayName).toBe('explicit');
    expect(mockExecFileImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3a. Agent-suggested — claude
// ---------------------------------------------------------------------------

describe('resolveSessionRename — agent-suggested (claude)', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  it('calls claude and returns parsed display + branch name', async () => {
    stubSuccess('Fix sidebar nav bug\nfix-sidebar-nav-bug\n');
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('agent-suggested');
    expect(result.displayName).toBe('Fix sidebar nav bug');
    expect(result.branchName).toBeDefined();
    expect(mockExecFileImpl).toHaveBeenCalledOnce();
    const callArgs = mockExecFileImpl.mock.calls[0] as [string, ...unknown[]];
    expect(callArgs[0]).toBe('claude');
  });

  it('capitalises first character of display name', async () => {
    stubSuccess('fix sidebar nav bug\nfix-sidebar-nav-bug\n');
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.displayName.charAt(0)).toBe('F');
  });

  it('falls through to heuristic when claude returns empty output', async () => {
    stubSuccess('');
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('heuristic');
  });

  it('falls through to heuristic when claude exec fails', async () => {
    stubFailure('command not found: claude');
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('heuristic');
  });

  it('strips backticks and quotes from claude output', async () => {
    stubSuccess('`Fix "sidebar"` nav bug`\nfix-sidebar-nav-bug\n');
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.displayName).not.toContain('`');
    expect(result.displayName).not.toContain('"');
  });
});

// ---------------------------------------------------------------------------
// 3b. Agent-suggested — codex
// ---------------------------------------------------------------------------

describe('resolveSessionRename — agent-suggested (codex)', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  it('calls codex CLI with --quiet flag', async () => {
    stubSuccess('Fix sidebar nav bug\nfix-sidebar-nav-bug\n');
    await resolveSessionRename(undefined, undefined, BASE_INPUT, CODEX_CONFIG);
    const callArgs = mockExecFileImpl.mock.calls[0] as [
      string,
      string[],
      ...unknown[],
    ];
    expect(callArgs[0]).toBe('codex');
    expect(callArgs[1]).toContain('--quiet');
  });

  it('falls through to heuristic when codex fails', async () => {
    stubFailure('codex not found');
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CODEX_CONFIG
    );
    expect(result.source).toBe('heuristic');
  });
});

// ---------------------------------------------------------------------------
// 3c. Agent-suggested — none
// ---------------------------------------------------------------------------

describe('resolveSessionRename — agent-suggested (none)', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  it('skips exec entirely when tool is none', async () => {
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(mockExecFileImpl).not.toHaveBeenCalled();
    expect(['heuristic', 'default']).toContain(result.source);
  });
});

// ---------------------------------------------------------------------------
// 3d. Agent-suggested — custom-script
// ---------------------------------------------------------------------------

describe('resolveSessionRename — agent-suggested (custom-script)', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  const CUSTOM_CONFIG: RenamerConfig = {
    tool: 'custom-script',
    customScript: '/usr/local/bin/my-renamer',
  };

  it('calls the custom script and returns parsed output', async () => {
    stubSuccess('Custom Session Name\ncustom-session-name\n');
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CUSTOM_CONFIG
    );
    expect(result.source).toBe('agent-suggested');
    expect(result.displayName).toBe('Custom Session Name');
    expect(mockExecFileImpl).toHaveBeenCalledOnce();
    const callArgs = mockExecFileImpl.mock.calls[0] as [string, ...unknown[]];
    expect(callArgs[0]).toBe('/usr/local/bin/my-renamer');
  });

  it('passes RELAY_RENAME_PROMPT env var to the script', async () => {
    stubSuccess('Task Name\ntask-name\n');
    await resolveSessionRename(undefined, undefined, BASE_INPUT, CUSTOM_CONFIG);
    const callArgs = mockExecFileImpl.mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string> },
      ...unknown[],
    ];
    expect(callArgs[2]?.env?.['RELAY_RENAME_PROMPT']).toBeDefined();
    expect(typeof callArgs[2]?.env?.['RELAY_RENAME_PROMPT']).toBe('string');
  });

  it('falls through to heuristic when custom script fails', async () => {
    mockExecFileImpl.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        _opts: Record<string, unknown>,
        cb: ExecCallback
      ) => {
        const err = Object.assign(new Error('script error'), {
          stdout: '',
          stderr: 'script error',
        }) as NodeJS.ErrnoException & { stdout: string; stderr: string };
        cb(err, '', 'script error');
      }
    );
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CUSTOM_CONFIG
    );
    expect(result.source).toBe('heuristic');
  });

  it('falls through to heuristic when customScript is missing', async () => {
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      { tool: 'custom-script' } // no customScript
    );
    expect(result.source).toBe('heuristic');
    expect(mockExecFileImpl).not.toHaveBeenCalled();
  });

  it('falls through to heuristic for non-absolute script path', async () => {
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      { tool: 'custom-script', customScript: 'relative/path/script' }
    );
    expect(result.source).toBe('heuristic');
    expect(mockExecFileImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Heuristic name
// ---------------------------------------------------------------------------

describe('resolveSessionRename — heuristic branch', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  it('uses repoName/branchName when agent-suggested fails', async () => {
    stubFailure();
    const result = await resolveSessionRename(
      undefined,
      undefined,
      { ...BASE_INPUT, repoName: 'relay-ide', branchName: 'main' },
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('heuristic');
    expect(result.displayName).toContain('relay-ide');
  });

  it('uses basename of cwd when no repoName or branchName', async () => {
    const result = await resolveSessionRename(
      undefined,
      undefined,
      { ...BASE_INPUT, repoName: undefined, branchName: undefined },
      NONE_CONFIG
    );
    expect(result.source).toBe('heuristic');
    expect(result.displayName).toBe('relay-ide'); // basename of /repo/relay-ide
  });
});

describe('buildHeuristicName (unit)', () => {
  it('returns repoName/branchName when both present', () => {
    expect(buildHeuristicName('/repo/foo', 'foo', 'main')).toBe('foo/main');
  });

  it('returns repoName when no branchName', () => {
    expect(buildHeuristicName('/repo/foo', 'foo', undefined)).toBe('foo');
  });

  it('returns branchName when no repoName', () => {
    expect(buildHeuristicName('/repo/foo', undefined, 'my-branch')).toBe(
      'my-branch'
    );
  });

  it('returns basename of cwd when neither present', () => {
    expect(buildHeuristicName('/repo/my-project', undefined, undefined)).toBe(
      'my-project'
    );
  });

  it('returns cwd itself when basename is empty', () => {
    expect(buildHeuristicName('/', undefined, undefined)).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// 5. Default name (last resort)
// ---------------------------------------------------------------------------

describe('buildDefaultName (unit)', () => {
  it('includes truncated ISO timestamp and repoName', () => {
    const name = buildDefaultName(
      '2026-05-19T14:30:00.000Z',
      '/repo/foo',
      'relay-ide'
    );
    expect(name).toContain('relay-ide');
    expect(name).toContain('2026-05-19 14:30');
  });

  it('uses basename of cwd when no repoName', () => {
    const name = buildDefaultName(
      '2026-05-19T14:30:00.000Z',
      '/repo/my-project',
      undefined
    );
    expect(name).toContain('my-project');
  });

  it('returns timestamp alone when cwd and repoName are both missing context', () => {
    const name = buildDefaultName('2026-05-19T14:30:00.000Z', '/', undefined);
    expect(name).toContain('2026-05-19 14:30');
  });
});

// ---------------------------------------------------------------------------
// Precedence ordering integration
// ---------------------------------------------------------------------------

describe('precedence ordering', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  it('explicit-user > pinned > agent-suggested', async () => {
    const result = await resolveSessionRename(
      'User Name',
      'Pinned Name',
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('explicit-user');
    expect(mockExecFileImpl).not.toHaveBeenCalled();
  });

  it('pinned > agent-suggested when user name absent', async () => {
    const result = await resolveSessionRename(
      undefined,
      'Pinned Name',
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('pinned');
    expect(mockExecFileImpl).not.toHaveBeenCalled();
  });

  it('agent-suggested > heuristic when claude succeeds', async () => {
    stubSuccess('Agent Suggested\nagent-suggested\n');
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('agent-suggested');
  });

  it('heuristic > default when cwd basename is non-empty', async () => {
    const result = await resolveSessionRename(
      undefined,
      undefined,
      { ...BASE_INPUT, repoName: undefined, branchName: undefined },
      NONE_CONFIG
    );
    expect(result.source).toBe('heuristic');
    expect(result.displayName).toBe('relay-ide'); // basename of /repo/relay-ide
  });
});

// ---------------------------------------------------------------------------
// Telemetry: source field is always set
// ---------------------------------------------------------------------------

describe('source field is always populated', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  it('source is set for explicit-user', async () => {
    const result = await resolveSessionRename(
      'user',
      undefined,
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(result.source).toBe('explicit-user');
  });

  it('source is set for pinned', async () => {
    const result = await resolveSessionRename(
      undefined,
      'pinned',
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(result.source).toBe('pinned');
  });

  it('source is set for agent-suggested (claude success)', async () => {
    stubSuccess('Name\nname\n');
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.source).toBe('agent-suggested');
  });

  it('source is set for heuristic', async () => {
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(result.source).toBe('heuristic');
  });

  it('every result has a non-empty source from the known set', async () => {
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      NONE_CONFIG
    );
    expect([
      'explicit-user',
      'pinned',
      'agent-suggested',
      'heuristic',
      'default',
    ]).toContain(result.source);
  });
});

// ---------------------------------------------------------------------------
// Branch name derivation
// ---------------------------------------------------------------------------

describe('branch name derivation', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  it('derives branch name from display name for explicit-user', async () => {
    const result = await resolveSessionRename(
      'Fix Login Bug',
      undefined,
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(result.branchName).toBeTruthy();
    // phraseToBranchName is mocked to kebab-case lowercase
    expect(result.branchName).toBe('fix-login-bug');
  });

  it('derives branch name from pinned name', async () => {
    const result = await resolveSessionRename(
      undefined,
      'Add Tests',
      BASE_INPUT,
      NONE_CONFIG
    );
    expect(result.branchName).toBe('add-tests');
  });

  it('returns both display and branch name from agent-suggested output', async () => {
    stubSuccess('Improve Performance\nimprove-performance\n');
    const result = await resolveSessionRename(
      undefined,
      undefined,
      BASE_INPUT,
      CLAUDE_CONFIG
    );
    expect(result.displayName).toBe('Improve Performance');
    expect(result.branchName).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// safeBranchName helper
// ---------------------------------------------------------------------------

describe('safeBranchName (unit)', () => {
  const CREATED_AT = '2026-05-19T14:30:00.000Z';

  it('returns the slugified form when phraseToBranchName yields a non-empty string', () => {
    // The mock slugifies to kebab-case lowercase
    const result = safeBranchName('Fix Login Bug', CREATED_AT);
    expect(result).toBe('fix-login-bug');
  });

  it('falls back to session-<timestamp> for symbol-only input', () => {
    // The mock strips non-alphanumeric chars, so "!!!" → ""
    const result = safeBranchName('!!!', CREATED_AT);
    expect(result).toMatch(/^session-2026-05-19-14-30$/);
  });

  it('falls back to session-<timestamp> for empty string', () => {
    const result = safeBranchName('', CREATED_AT);
    expect(result).toMatch(/^session-/);
    expect(result).not.toBe('');
  });

  it('falls back to session-<timestamp> for whitespace-only input', () => {
    // The mock trims, so whitespace-only → ""
    const result = safeBranchName('   ', CREATED_AT);
    expect(result).toMatch(/^session-/);
    expect(result).not.toBe('');
  });

  it('fallback slug contains no colons or T separators', () => {
    const result = safeBranchName('###', CREATED_AT);
    expect(result).not.toContain(':');
    expect(result).not.toContain('T');
  });
});

// ---------------------------------------------------------------------------
// resolveSessionRename — symbol-only prompt inputs always produce valid branch names
// ---------------------------------------------------------------------------

describe('resolveSessionRename — symbol-only inputs produce valid branch names', () => {
  beforeEach(() => mockExecFileImpl.mockReset());

  it('heuristic branch: symbol-only repoName/branchName yields a valid branch name', async () => {
    const result = await resolveSessionRename(
      undefined,
      undefined,
      { ...BASE_INPUT, repoName: '!!!', branchName: '???', cwd: '/' },
      NONE_CONFIG
    );
    // source should be heuristic (repoName/branchName are truthy as strings, even if symbols)
    // branchName must never be empty
    expect(result.branchName).toBeTruthy();
    expect(result.branchName).toMatch(/^session-/); // safeBranchName fallback
  });

  it('default branch: symbol-only cwd basename yields a valid branch name', async () => {
    const result = await resolveSessionRename(
      undefined,
      undefined,
      { ...BASE_INPUT, repoName: undefined, branchName: undefined, cwd: '/' },
      NONE_CONFIG
    );
    expect(result.branchName).toBeTruthy();
    expect(result.branchName).not.toBe('');
  });
});
