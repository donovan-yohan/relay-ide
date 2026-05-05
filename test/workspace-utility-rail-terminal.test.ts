// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../frontend/src/lib/types.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../frontend/src/components/UtilityRailFilesPanel.js', () => ({
  default: () => React.createElement('div', { 'data-testid': 'files-panel' }),
}));
vi.mock('../frontend/src/components/UtilityRailGitChangesPanel.js', () => ({
  default: () => React.createElement('div', { 'data-testid': 'changes-panel' }),
}));
vi.mock('../frontend/src/components/UtilityRailBranchPanel.js', () => ({
  default: () => React.createElement('div', { 'data-testid': 'branch-panel' }),
}));
vi.mock('../frontend/src/components/UtilityRailReviewPanel.js', () => ({
  default: () => React.createElement('div', { 'data-testid': 'review-panel' }),
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
import type { WorkspaceUtilityRailState } from '../frontend/src/lib/stores/ui.js';

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

function railState(overrides: Partial<WorkspaceUtilityRailState> = {}): WorkspaceUtilityRailState {
  return {
    visible: true,
    selectedRailTab: 'terminal',
    width: 320,
    utilityTerminalIds: ['term-1', 'term-2'],
    selectedUtilityTerminalId: 'term-2',
    ...overrides,
  };
}

describe('WorkspaceUtilityRail utility terminal panel', () => {
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

  it('mounts only the selected utility terminal and wires close/promote callbacks', async () => {
    const onCloseUtilityTerminal = vi.fn();
    const onPromoteUtilityTerminal = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(WorkspaceUtilityRail, {
          workspacePath: '/repo/a',
          railState: railState(),
          activeSession: session({ id: 'agent-1', type: 'agent' }),
          workspaceSessions: [session({ id: 'agent-1', type: 'agent' })],
          utilityTerminalSessions: [
            session({ id: 'term-1' }),
            session({ id: 'term-2', displayName: 'db shell' }),
          ],
          onCloseUtilityTerminal,
          onPromoteUtilityTerminal,
        })
      );
    });

    expect(
      container
        .querySelector('[data-testid="utility-terminal-mount"]')
        ?.getAttribute('data-session-id')
    ).toBe('term-2');
    expect(container.textContent).toContain('terminal 1 · a');
    expect(container.textContent).toContain('db shell');

    await act(async () => {
      (container.querySelector('button[aria-label="close db shell"]') as HTMLButtonElement).click();
    });
    expect(onCloseUtilityTerminal).toHaveBeenCalledWith('term-2');

    await act(async () => {
      (container.querySelector('.utility-terminal-actions button') as HTMLButtonElement).click();
    });
    expect(onPromoteUtilityTerminal).toHaveBeenCalledWith('term-2');
  });

  it('renders an empty state that creates utility terminals without mounting a PTY', async () => {
    const onCreateUtilityTerminal = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(WorkspaceUtilityRail, {
          workspacePath: '/repo/a',
          railState: railState({
            utilityTerminalIds: [],
            selectedUtilityTerminalId: null,
          }),
          workspaceSessions: [],
          utilityTerminalSessions: [],
          onCreateUtilityTerminal,
        })
      );
    });

    expect(container.textContent).toContain('no utility terminals yet.');
    expect(container.querySelector('[data-testid="utility-terminal-mount"]')).toBeNull();

    await act(async () => {
      (container.querySelector('.utility-empty button') as HTMLButtonElement).click();
    });
    expect(onCreateUtilityTerminal).toHaveBeenCalledTimes(1);
  });

  it('clears copy mode when the terminal panel unmounts', async () => {
    const onCopyModeChange = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(WorkspaceUtilityRail, {
          workspacePath: '/repo/a',
          railState: railState(),
          workspaceSessions: [],
          utilityTerminalSessions: [session({ id: 'term-1' })],
          onCopyModeChange,
        })
      );
    });

    await act(async () => {
      root.render(
        React.createElement(WorkspaceUtilityRail, {
          workspacePath: '/repo/a',
          railState: railState({ selectedRailTab: 'logs' }),
          workspaceSessions: [],
          utilityTerminalSessions: [session({ id: 'term-1' })],
          onCopyModeChange,
        })
      );
    });

    expect(onCopyModeChange).toHaveBeenCalledWith(false);
  });

  it('supports roving focus arrow keys for utility terminal tabs', async () => {
    const onSelectUtilityTerminal = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(WorkspaceUtilityRail, {
          workspacePath: '/repo/a',
          railState: railState({ selectedUtilityTerminalId: 'term-1' }),
          workspaceSessions: [],
          utilityTerminalSessions: [
            session({ id: 'term-1' }),
            session({ id: 'term-2' }),
          ],
          onSelectUtilityTerminal,
        })
      );
    });

    const firstTab = container.querySelector(
      '#utility-terminal-tab-term-1'
    ) as HTMLButtonElement;
    const secondTab = container.querySelector(
      '#utility-terminal-tab-term-2'
    ) as HTMLButtonElement;
    expect(firstTab.tabIndex).toBe(0);
    expect(secondTab.tabIndex).toBe(-1);

    await act(async () => {
      firstTab.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
      );
    });

    expect(onSelectUtilityTerminal).toHaveBeenCalledWith('term-2');
  });
});
