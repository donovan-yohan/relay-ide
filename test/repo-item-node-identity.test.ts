// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoItem } from '../frontend/src/components/RepoItem.js';
import type { Repo } from '../frontend/src/lib/types.js';
import type { SummaryNodeInfo } from '../frontend/src/lib/workspace-summary.js';
import { makeSession } from './helpers/frontend-factories.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

const NODE_INDEX: Record<string, SummaryNodeInfo> = {
  mac: { label: 'macbook', status: 'online' },
  wsl: { label: 'wsl-dev', status: 'stale' },
  pi: { label: 'raspi', status: 'offline' },
};

const findNode = (id: string): SummaryNodeInfo | undefined => NODE_INDEX[id];

describe('RepoItem — node identity in session list (#864)', () => {
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

  async function renderWith(
    session: ReturnType<typeof makeSession>,
    repoOverrides: Partial<Repo> = {}
  ): Promise<void> {
    const sessionGroups = new Map([
      [session.worktreePath ?? session.repoPath ?? session.cwd, [session]],
    ]);
    await act(async () => {
      root.render(
        React.createElement(RepoItem, {
          repo: makeRepo(repoOverrides),
          sessionGroups,
          isActive: false,
          activeSessionId: null,
          onSelectWorkspace: noop,
          onSelectSession: noop,
          onNewWorktree: noop,
          onOpenSettings: noop,
          findNode,
        })
      );
    });
  }

  function nodeBadge(): Element | null {
    return container.querySelector('.session-node-badge');
  }

  it('local repo session shows no node badge (common case stays quiet)', async () => {
    await renderWith(
      makeSession({ id: 's-local', nodeId: 'local', type: 'terminal' })
    );
    expect(nodeBadge()).toBeNull();
  });

  it('session with no nodeId shows no node badge', async () => {
    const s = makeSession({ id: 's-none', type: 'terminal' });
    delete (s as { nodeId?: string }).nodeId;
    await renderWith(s);
    expect(nodeBadge()).toBeNull();
  });

  it('remote terminal session shows the node label + online status', async () => {
    await renderWith(
      makeSession({ id: 's-mac', nodeId: 'mac', type: 'terminal' })
    );
    const badge = nodeBadge();
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('macbook');
    expect(badge?.getAttribute('title')).toBe('node: macbook (online)');
    expect(badge?.querySelector('.session-node-dot--online')).toBeTruthy();
  });

  it('remote agent session shows the node label', async () => {
    await renderWith(
      makeSession({ id: 's-agent', nodeId: 'mac', type: 'agent', agent: 'claude' })
    );
    expect(nodeBadge()?.textContent).toContain('macbook');
  });

  it('renders a stale-node signal for a stale remote node', async () => {
    await renderWith(
      makeSession({ id: 's-wsl', nodeId: 'wsl', type: 'terminal' })
    );
    const badge = nodeBadge();
    expect(badge?.classList.contains('session-node-badge--stale')).toBe(true);
    expect(badge?.querySelector('.session-node-dot--stale')).toBeTruthy();
  });

  it('renders an offline-node signal for an offline remote node', async () => {
    await renderWith(
      makeSession({ id: 's-pi', nodeId: 'pi', type: 'terminal' })
    );
    const badge = nodeBadge();
    expect(badge?.classList.contains('session-node-badge--offline')).toBe(true);
    expect(badge?.querySelector('.session-node-dot--offline')).toBeTruthy();
  });

  it('free/non-git cwd remote session shows node identity without repo/worktree leakage', async () => {
    // A free session: no repo/worktree binding. It still surfaces the node it
    // runs on, but must not invent repo/branch context.
    const free = makeSession({
      id: 's-free',
      nodeId: 'mac',
      type: 'terminal',
      worktreePath: null,
      repoName: undefined,
      branchName: undefined,
      cwd: '/tmp/scratch',
    });
    await renderWith(free);
    const badge = nodeBadge();
    expect(badge?.textContent).toContain('macbook');
    // No branch metadata fabricated for a free session row.
    expect(container.querySelector('.secondary-branch')).toBeNull();
  });

  it('falls back to the raw node id when the node summary is not loaded', async () => {
    await renderWith(
      makeSession({ id: 's-unknown', nodeId: 'ghost', type: 'terminal' })
    );
    const badge = nodeBadge();
    expect(badge?.textContent).toContain('ghost');
    expect(badge?.getAttribute('title')).toBe('node: ghost (unknown)');
  });
});
