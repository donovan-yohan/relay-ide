import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../frontend/src/lib/types.js';
import { summaryForTab } from '../frontend/src/lib/workspace-summary.js';
import type { WorkspaceTab } from '../frontend/src/lib/workspace-layout.js';

const fileTab = (
  filePath: string,
  tabType: 'code' | 'diff' | 'html' = 'code'
): WorkspaceTab => ({ kind: 'file', filePath, tabType });

const sessionTab = (
  id: string,
  type: 'agent' | 'terminal' = 'agent'
): WorkspaceTab => ({ kind: 'session', sessionId: id, sessionType: type });

const session = (overrides: Partial<SessionSummary>): SessionSummary => ({
  id: 's',
  type: 'agent',
  agent: 'claude',
  repoName: 'relay-ide',
  repoPath: '/r',
  worktreePath: null,
  cwd: '/r/relay-ide',
  branchName: 'feat/x',
  displayName: 'feat/x',
  createdAt: '',
  lastActivity: '',
  idle: false,
  ...overrides,
});

describe('summaryForTab — file kind', () => {
  it('uses filename as primary and breadcrumb segments', () => {
    const s = summaryForTab(fileTab('frontend/src/components/Composer.tsx'));
    expect(s.primary).toBe('Composer.tsx');
    expect(s.breadcrumb?.segments).toEqual([
      'frontend',
      'src',
      'components',
      'Composer.tsx',
    ]);
    expect(s.icon).toBe('file-tsx');
  });

  it('adds unsaved pill when isFileChanged returns true', () => {
    const s = summaryForTab(fileTab('a.ts'), { isFileChanged: () => true });
    expect(s.pills.some((p) => p.label === 'unsaved')).toBe(true);
  });

  it('adds diff pill + diff icon for diff tabType', () => {
    const s = summaryForTab(fileTab('a.ts', 'diff'));
    expect(s.icon).toBe('file-diff');
    expect(s.pills.some((p) => p.label === 'diff')).toBe(true);
  });

  it('adds preview pill + html-preview icon for html tabType', () => {
    const s = summaryForTab(fileTab('mock.html', 'html'));
    expect(s.icon).toBe('file-html-preview');
    expect(s.pills.some((p) => p.label === 'preview')).toBe(true);
  });

  it('appends line count to lang pill when provided', () => {
    const s = summaryForTab(fileTab('a.ts'), { fileLineCount: () => 142 });
    expect(s.pills.some((p) => p.label === 'ts · 142 lines')).toBe(true);
  });

  it('falls back to file-generic icon for unknown ext', () => {
    const s = summaryForTab(fileTab('LICENSE'));
    expect(s.icon).toBe('file-generic');
  });

  it('passes repoLabel and repoColor through breadcrumb', () => {
    const s = summaryForTab(fileTab('a.ts'), {
      repoLabel: 'R',
      repoColor: '#d97757',
    });
    expect(s.breadcrumb?.repoLabel).toBe('R');
    expect(s.breadcrumb?.repoColor).toBe('#d97757');
  });
});

describe('summaryForTab — session kind', () => {
  it('returns claude icon for claude agent sessions', () => {
    const s = summaryForTab(sessionTab('s1'), {
      findSession: () => session({ id: 's1', agent: 'claude' }),
    });
    expect(s.icon).toBe('session-claude');
    expect(s.primary).toBe('feat/x');
  });

  it('returns codex icon for codex agent', () => {
    const s = summaryForTab(sessionTab('s1'), {
      findSession: () => session({ id: 's1', agent: 'codex' }),
    });
    expect(s.icon).toBe('session-codex');
  });

  it('returns terminal icon for terminal sessions regardless of agent', () => {
    const s = summaryForTab(sessionTab('s1', 'terminal'), {
      findSession: () => session({ id: 's1', type: 'terminal', agent: 'bash' }),
    });
    expect(s.icon).toBe('session-terminal');
  });

  it('uses displayName then branchName then fallback for primary', () => {
    expect(
      summaryForTab(sessionTab('s1'), {
        findSession: () => session({ displayName: 'my session' }),
      }).primary
    ).toBe('my session');
    expect(
      summaryForTab(sessionTab('s1'), {
        findSession: () =>
          session({ displayName: '', branchName: 'feat/branch' }),
      }).primary
    ).toBe('feat/branch');
    expect(
      summaryForTab(sessionTab('s1'), {
        findSession: () => undefined,
      }).primary
    ).toBe('session');
    expect(
      summaryForTab(sessionTab('s1', 'terminal'), {
        findSession: () => undefined,
      }).primary
    ).toBe('terminal');
  });

  it('maps agentState to correct dot', () => {
    const cases: Array<
      [
        'live' | 'attention' | 'error' | 'idle' | null,
        ReturnType<typeof session>,
      ]
    > = [
      ['error', session({ agentState: 'error' })],
      ['attention', session({ agentState: 'permission-prompt' })],
      ['attention', session({ agentState: 'waiting-for-input' })],
      ['live', session({ agentState: 'processing' })],
      ['idle', session({ idle: true })],
      [null, session({})],
    ];
    for (const [expected, ses] of cases) {
      const s = summaryForTab(sessionTab('s1'), { findSession: () => ses });
      expect(s.dot).toBe(expected);
    }
  });

  it('builds meta string from agent, cwd, repo, and state', () => {
    const s = summaryForTab(sessionTab('s1'), {
      findSession: () => session({ agent: 'claude', agentState: 'processing' }),
    });
    expect(s.meta).toBe('claude · relay-ide · processing');
  });

  it('appends cwd basename for terminal sessions', () => {
    const s = summaryForTab(sessionTab('s1', 'terminal'), {
      findSession: () =>
        session({
          type: 'terminal',
          agent: 'bash',
          repoName: null,
          cwd: '/Users/alice/code/relay-ide',
        }),
    });
    expect(s.meta).toContain('relay-ide');
  });

  it('shows cwd and optional repo identity for active agent work', () => {
    const s = summaryForTab(sessionTab('s1'), {
      findSession: () =>
        session({
          agent: 'claude',
          repoName: 'relay-ide',
          cwd: '/Users/alice/code/relay-ide/frontend',
        }),
    });
    expect(s.meta).toBe('claude · frontend · relay-ide');
  });

  it('does not duplicate repo identity when cwd already names the repo', () => {
    const s = summaryForTab(sessionTab('s1', 'terminal'), {
      findSession: () =>
        session({
          type: 'terminal',
          agent: 'bash',
          repoName: 'relay-ide',
          cwd: '/Users/alice/code/relay-ide',
        }),
    });
    expect(s.meta).toBe('bash · relay-ide');
  });

  it('returns no meta when session is missing', () => {
    const s = summaryForTab(sessionTab('s1'), { findSession: () => undefined });
    expect(s.meta).toBeUndefined();
  });
});

describe('summaryForTab — nodeBadge', () => {
  const remoteTab = (id: string, nodeId: string): WorkspaceTab => ({
    kind: 'session',
    sessionId: id,
    sessionType: 'terminal',
    nodeId,
  });

  it('returns nodeBadge when tab.nodeId is non-local and node is known', () => {
    const s = summaryForTab(remoteTab('s1', 'wsl-host'), {
      findNode: () => ({ label: 'WSL', status: 'online' }),
    });
    expect(s.nodeBadge).toEqual({ label: 'WSL', status: 'online' });
  });

  it('falls back to nodeId label when findNode has no entry', () => {
    const s = summaryForTab(remoteTab('s1', 'wsl-host'), {});
    expect(s.nodeBadge).toEqual({ label: 'wsl-host', status: 'unknown' });
  });

  it('omits nodeBadge for hub-local sessions', () => {
    const s = summaryForTab(remoteTab('s1', 'local'), {
      findNode: () => ({ label: 'this host', status: 'online' }),
    });
    expect(s.nodeBadge).toBeUndefined();
  });

  it('omits nodeBadge when tab has no nodeId and session has none', () => {
    const s = summaryForTab(sessionTab('s1'), {
      findSession: () => session({ id: 's1' }),
    });
    expect(s.nodeBadge).toBeUndefined();
  });

  it('reads nodeId from session when tab.nodeId is unset', () => {
    const s = summaryForTab(sessionTab('s1', 'terminal'), {
      findSession: () => session({ id: 's1', type: 'terminal', nodeId: 'mac' }),
      findNode: () => ({ label: 'macbook', status: 'stale' }),
    });
    expect(s.nodeBadge).toEqual({ label: 'macbook', status: 'stale' });
  });

  it('marks offline nodes in the badge status', () => {
    const s = summaryForTab(remoteTab('s1', 'wsl-host'), {
      findNode: () => ({ label: 'WSL', status: 'offline' }),
    });
    expect(s.nodeBadge?.status).toBe('offline');
  });
});
