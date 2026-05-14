// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../frontend/src/lib/types.js';
import type { WorkspaceUtilityRailState } from '../frontend/src/lib/stores/ui.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../frontend/src/components/UtilityRailFilesPanel.js', () => ({
  default: ({ workspacePath, stateKey }: { workspacePath: string; stateKey?: string }) =>
    React.createElement('div', {
      'data-testid': 'files-panel',
      'data-workspace-path': workspacePath,
      'data-state-key': stateKey ?? '',
    }),
}));
vi.mock('../frontend/src/components/UtilityRailGitChangesPanel.js', () => ({
  default: ({ workspacePath, stateKey }: { workspacePath: string; stateKey?: string }) =>
    React.createElement('div', {
      'data-testid': 'changes-panel',
      'data-workspace-path': workspacePath,
      'data-state-key': stateKey ?? '',
    }),
}));
vi.mock('../frontend/src/components/UtilityRailBranchPanel.js', () => ({
  default: ({ workspacePath, stateKey }: { workspacePath: string; stateKey?: string }) =>
    React.createElement('div', {
      'data-testid': 'branch-panel',
      'data-workspace-path': workspacePath,
      'data-state-key': stateKey ?? '',
    }),
}));
vi.mock('../frontend/src/components/UtilityRailReviewPanel.js', () => ({
  default: ({ workspacePath, stateKey }: { workspacePath: string; stateKey?: string }) =>
    React.createElement('div', {
      'data-testid': 'review-panel',
      'data-workspace-path': workspacePath,
      'data-state-key': stateKey ?? '',
    }),
}));
vi.mock('../frontend/src/components/UtilityRailLogsPanel.js', () => ({
  default: () => React.createElement('div', { 'data-testid': 'logs-panel' }),
}));
vi.mock('../frontend/src/components/UtilityRailStatsPanel.js', () => ({
  default: () => React.createElement('div', { 'data-testid': 'stats-panel' }),
}));
vi.mock('../frontend/src/components/Terminal.js', () => ({
  default: ({ sessionId }: { sessionId: string | null }) =>
    React.createElement('div', {
      'data-testid': 'utility-terminal-mount',
      'data-session-id': sessionId ?? '',
    }),
}));

import { WorkspaceUtilityRail } from '../frontend/src/components/WorkspaceUtilityRail.js';

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    id: overrides.id,
    repoName: 'a',
    repoPath: '/repo/a',
    worktreePath: null,
    cwd: '/repo/a',
    status: 'active',
    createdAt: '2026-05-05T00:00:00.000Z',
    lastActivity: '2026-05-05T00:00:00.000Z',
    branchName: 'nightly',
    displayName: '',
    idle: false,
    agent: 'claude',
    type: 'terminal',
    mode: 'pty',
    useTmux: true,
    ...overrides,
  };
}

function railState(selectedRailTab: WorkspaceUtilityRailState['selectedRailTab']): WorkspaceUtilityRailState {
  return {
    visible: true,
    selectedRailTab,
    width: 320,
  };
}

describe('WorkspaceUtilityRail resource context guards', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('passes local repo paths through to file and git panels while keeping the separate rail state key', async () => {
    await act(async () => {
      root.render(
        React.createElement(WorkspaceUtilityRail, {
          workspacePath: 'node:local:/repo/a',
          resourceContext: {
            displayWorkspacePath: '/repo/a',
            anchorLabel: 'local · /repo/a',
            repoBadge: 'repo',
            files: { workspacePath: '/repo/a', disabledReason: null },
            git: { workspacePath: '/repo/a', disabledReason: null },
          },
          railState: railState('changes'),
          activeSession: session({ id: 'agent-1', type: 'agent' }),
          workspaceSessions: [session({ id: 'agent-1', type: 'agent' })],
        })
      );
    });

    const changes = container.querySelector('[data-testid="changes-panel"]');
    expect(changes?.getAttribute('data-workspace-path')).toBe('/repo/a');
    expect(changes?.getAttribute('data-state-key')).toBe('node:local:/repo/a');
  });

  it('shows a remote files unavailable state instead of mounting the local file tree', async () => {
    await act(async () => {
      root.render(
        React.createElement(WorkspaceUtilityRail, {
          workspacePath: 'node:linux-box:/home/me/repo',
          resourceContext: {
            displayWorkspacePath: '/home/me/repo',
            anchorLabel: 'linux-box · /home/me/repo',
            repoBadge: null,
            files: { workspacePath: '', disabledReason: 'remote-files-unavailable' },
            git: { workspacePath: '', disabledReason: 'remote-git-unavailable' },
          },
          railState: railState('files'),
          activeSession: session({ id: 'remote-1', type: 'terminal', nodeId: 'linux-box', repoPath: undefined, cwd: '/home/me/repo' }),
          workspaceSessions: [],
        })
      );
    });

    expect(container.querySelector('[data-testid="files-panel"]')).toBeNull();
    expect(container.textContent).toContain('remote files unavailable');
    expect(container.textContent).toContain('/home/me/repo');
  });

  it('shows a normal no-git empty state for free local tabs instead of mounting git panels', async () => {
    await act(async () => {
      root.render(
        React.createElement(WorkspaceUtilityRail, {
          workspacePath: '/tmp/free-folder',
          resourceContext: {
            displayWorkspacePath: '/tmp/free-folder',
            anchorLabel: 'local · /tmp/free-folder',
            repoBadge: null,
            files: { workspacePath: '/tmp/free-folder', disabledReason: null },
            git: { workspacePath: '', disabledReason: 'no-git-context' },
          },
          railState: railState('branch'),
          activeSession: session({ id: 'free-1', type: 'terminal', repoPath: undefined, cwd: '/tmp/free-folder' }),
          workspaceSessions: [],
        })
      );
    });

    expect(container.querySelector('[data-testid="branch-panel"]')).toBeNull();
    expect(container.textContent).toContain('no git context');
    expect(container.textContent).toContain('/tmp/free-folder');
  });
});
