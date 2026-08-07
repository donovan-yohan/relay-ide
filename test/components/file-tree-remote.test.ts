// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const mocks = vi.hoisted(() => ({
  browseFsDirectory: vi.fn(async (workspacePath: string) => ({
    resolved: workspacePath,
    entries: [],
    truncated: false,
    total: 0,
  })),
  fetchChangedFiles: vi.fn(async () => ({
    files: [],
    aggregate: { additions: 0, deletions: 0, fileCount: 0 },
  })),
  fetchDefaultBranch: vi.fn(async () => 'nightly'),
  fetchNodeFsList: vi.fn(async () => ({
    operation: 'list' as const,
    root: '/remote/repo',
    cwd: '/remote/repo',
    path: '/remote/repo',
    entries: [
      { name: 'src', path: '/remote/repo/src', type: 'directory', size: 0, mtimeMs: 0, mode: 0o755 },
      { name: 'README.md', path: '/remote/repo/README.md', type: 'file', size: 120, mtimeMs: 0, mode: 0o644 },
    ],
    truncated: false,
    maxEntries: 100,
  })),
}));

vi.mock('../../frontend/src/lib/api.js', () => ({
  browseFsDirectory: mocks.browseFsDirectory,
  fetchChangedFiles: mocks.fetchChangedFiles,
  fetchDefaultBranch: mocks.fetchDefaultBranch,
  fetchNodeFsList: mocks.fetchNodeFsList,
}));

import { FileTree } from '../../frontend/src/components/FileTree/index.js';
import {
  clearUtilityRailStateCacheForTesting,
  useUiStore,
} from '../../frontend/src/lib/stores/ui.js';

function resetUiStore() {
  clearUtilityRailStateCacheForTesting();
  useUiStore.setState({
    rightSidebarTab: 'all-files',
    fileDiffSource: 'working',
    fileDiffDefaultBranch: 'main',
    utilityRailByWorkspace: {},
    openFileTabs: [],
    activeFileTabKey: null,
  });
}

describe('FileTree remote node mode', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    resetUiStore();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  async function renderTree(props: React.ComponentProps<typeof FileTree>) {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FileTree, props)
        )
      );
    });

    await act(async () => {
      await flush();
      await flush();
    });
  }

  it('calls fetchNodeFsList (not browseFsDirectory) when nodeId and sessionId are set', async () => {
    await renderTree({
      workspacePath: '/remote/repo',
      nodeId: 'nodeB',
      sessionId: 's1',
      root: '/remote/repo',
      gitDisabledReason: 'remote-git-unavailable',
    });

    expect(mocks.fetchNodeFsList).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'nodeB',
        sessionId: 's1',
        cwd: '/remote/repo',
      })
    );
    expect(mocks.browseFsDirectory).not.toHaveBeenCalled();
  });

  it('renders entries returned by fetchNodeFsList', async () => {
    await renderTree({
      workspacePath: '/remote/repo',
      nodeId: 'nodeB',
      sessionId: 's1',
      root: '/remote/repo',
      gitDisabledReason: 'remote-git-unavailable',
    });

    expect(container.textContent).toContain('src');
    expect(container.textContent).toContain('README.md');
  });

  // local fallback path: covered exhaustively by test/components/FileTree.test.ts.
  // here we keep the file focused on the remote-mode contract introduced in C1.

  it('does not call git-dependent fetches for remote node mode', async () => {
    await renderTree({
      workspacePath: '/remote/repo',
      nodeId: 'nodeB',
      sessionId: 's1',
      root: '/remote/repo',
      gitWorkspacePath: '',
      gitDisabledReason: 'remote-git-unavailable',
    });

    expect(mocks.fetchDefaultBranch).not.toHaveBeenCalled();
    expect(mocks.fetchChangedFiles).not.toHaveBeenCalled();
  });
});
