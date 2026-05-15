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
}));

vi.mock('../../frontend/src/lib/api.js', () => ({
  browseFsDirectory: mocks.browseFsDirectory,
  fetchChangedFiles: mocks.fetchChangedFiles,
  fetchDefaultBranch: mocks.fetchDefaultBranch,
}));

import { FileTree } from '../../frontend/src/components/FileTree/index.js';
import {
  clearUtilityRailStateCacheForTesting,
  useUiStore,
} from '../../frontend/src/lib/stores/ui.js';

function resetUiStore() {
  clearUtilityRailStateCacheForTesting();
  useUiStore.setState({
    rightSidebarTab: 'changes',
    fileDiffSource: 'working',
    fileDiffDefaultBranch: 'main',
    utilityRailByWorkspace: {},
    openFileTabs: [],
    activeFileTabKey: null,
  });
}

describe('FileTree git fetch guards', () => {
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

  it('does not issue git-dependent requests for free local folders', async () => {
    await renderTree({
      workspacePath: '/tmp/free-folder',
      gitWorkspacePath: '',
      gitDisabledReason: 'no-git-context',
    });

    expect(mocks.fetchDefaultBranch).not.toHaveBeenCalled();
    expect(mocks.fetchChangedFiles).not.toHaveBeenCalled();
    expect(container.textContent).toContain('no changes');
    expect(container.textContent).not.toContain('HTTP 403');
  });

  it('uses the dedicated git workspace path for changed-files requests', async () => {
    await renderTree({
      workspacePath: '/tmp/free-folder',
      gitWorkspacePath: '/repo/a',
      gitDisabledReason: null,
    });

    expect(mocks.fetchDefaultBranch).toHaveBeenCalledWith('/repo/a');
    expect(mocks.fetchChangedFiles).toHaveBeenCalledWith('/repo/a', '');
  });
});
