// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoItem } from '../frontend/src/components/RepoItem.js';
import type { Repo, SidebarItem } from '../frontend/src/lib/types.js';
import { makeSession, makeWorktree } from './helpers/frontend-factories.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = vi.fn();

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    path: '/path/to/repo',
    name: 'repo',
    isGitRepo: true,
    defaultBranch: 'nightly',
    currentBranch: 'nightly',
    ...overrides,
  };
}

function makeSidebarItem(overrides: Partial<SidebarItem> = {}): SidebarItem {
  return {
    id: '/path/to/worktree',
    kind: 'worktree',
    path: '/path/to/worktree',
    repoPath: '/path/to/repo',
    displayName: 'feat/test',
    branchName: 'feat/test',
    lastActivity: '2026-03-29T00:00:00Z',
    displayState: 'running',
    lastKnownBackendState: 'running',
    sessions: [],
    ...overrides,
  };
}

describe('RepoItem source indicators', () => {
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
    vi.clearAllMocks();
  });

  it('renders source dots for branch rows but not active session rows', async () => {
    const session = makeSession({
      id: 'sess-1',
      repoPath: '/path/to/repo',
      worktreePath: '/path/to/worktree',
      cwd: '/path/to/worktree',
      branchName: 'feat/test',
    });
    const sessionGroups = new Map([[session.worktreePath ?? session.repoPath, [session]]]);

    await act(async () => {
      root.render(
        React.createElement(RepoItem, {
          repo: makeRepo({ webhookStatus: 'limited' }),
          sessionGroups,
          inactiveWorktrees: [makeWorktree({ path: '/path/to/inactive', branchName: 'feat/inactive' })],
          isActive: false,
          activeSessionId: null,
          onSelectWorkspace: noop,
          onSelectSession: noop,
          onNewWorktree: noop,
          onOpenSettings: noop,
          onResumeWorktree: noop,
          sidebarItems: [makeSidebarItem()],
        })
      );
    });

    const rows = Array.from(container.querySelectorAll('.session-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('[data-testid="repo-source-dot"]')).toBeNull();

    const inactiveSource = rows[1]?.querySelector('[data-testid="repo-source-dot"]');
    expect(inactiveSource?.getAttribute('title')).toBe('manual fetch · no admin on this repo');
    expect(inactiveSource?.outerHTML).toMatchInlineSnapshot(
      `"<span class=\"repo-source-dot repo-source-dot--limited\" data-testid=\"repo-source-dot\" title=\"manual fetch · no admin on this repo\" aria-label=\"manual fetch · no admin on this repo\" role=\"img\">○<svg class=\"repo-source-dot__lock\" viewBox=\"0 0 8 8\" aria-hidden=\"true\"><rect x=\"1.5\" y=\"3.5\" width=\"5\" height=\"3\" fill=\"none\"></rect><path d=\"M2.5 3.5V2.5a1.5 1.5 0 0 1 3 0v1\" fill=\"none\"></path></svg></span>"`
    );
  });

  it('does not render starting or in-progress chips for loading rows', async () => {
    const loadingItems = new Set(['/path/to/worktree']);

    await act(async () => {
      root.render(
        React.createElement(RepoItem, {
          repo: makeRepo(),
          sessionGroups: new Map(),
          inactiveWorktrees: [makeWorktree()],
          isActive: false,
          activeSessionId: null,
          onSelectWorkspace: noop,
          onSelectSession: noop,
          onNewWorktree: noop,
          onOpenSettings: noop,
          onResumeWorktree: noop,
          loadingItems,
        })
      );
    });

    expect(container.querySelector('.state-initializing .pulse-slow')).toBeTruthy();
    const chipText = Array.from(container.querySelectorAll('.fleet-status'))
      .map((node) => node.textContent?.trim())
      .join(' ');
    expect(chipText).not.toContain('starting');
    expect(chipText).not.toContain('in-progress');
    expect(chipText).not.toContain('resuming');
  });
});
