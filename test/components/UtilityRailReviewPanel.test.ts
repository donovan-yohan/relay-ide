// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangedFile } from '../../frontend/src/lib/types.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const mocks = vi.hoisted(() => {
  const files: ChangedFile[] = [
    {
      path: 'src/a.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      directory: 'src',
    },
    {
      path: 'src/b.ts',
      status: 'added',
      additions: 4,
      deletions: 0,
      directory: 'src',
    },
  ];
  return {
    fetchChangedFiles: vi.fn(async (_workspacePath: string, _base?: string) => ({
      files,
      aggregate: { additions: 6, deletions: 1, fileCount: 2 },
    })),
    fetchDefaultBranch: vi.fn(async () => 'nightly'),
    fetchFileDiff: vi.fn(async (_workspacePath: string, filePath: string) => ({
      diff: `diff --git a/${filePath} b/${filePath}\n@@ -1 +1 @@\n-old\n+new`,
    })),
  };
});

vi.mock('../../frontend/src/lib/api.js', () => ({
  fetchChangedFiles: mocks.fetchChangedFiles,
  fetchDefaultBranch: mocks.fetchDefaultBranch,
  fetchFileDiff: mocks.fetchFileDiff,
}));

vi.mock('../../frontend/src/components/DiffViewer.js', () => ({
  default: ({ filePath, diff, loading }: { filePath: string; diff: string; loading: boolean }) =>
    React.createElement(
      'div',
      {
        className: 'mock-diff-viewer',
        'data-file': filePath,
        'data-loading': String(loading),
      },
      diff
    ),
}));

import { UtilityRailReviewPanel } from '../../frontend/src/components/UtilityRailReviewPanel.js';
import {
  clearUtilityRailStateCacheForTesting,
  useUiStore,
} from '../../frontend/src/lib/stores/ui.js';

function resetUiStore() {
  clearUtilityRailStateCacheForTesting();
  useUiStore.setState({
    fullPageDiff: null,
    fileDiffSource: 'working',
    fileDiffDefaultBranch: 'main',
    fileDiffViewMode: 'unified',
    utilityRailByWorkspace: {},
    openFileTabs: [],
    activeFileTabKey: null,
  });
}

describe('UtilityRailReviewPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    resetUiStore();
    useUiStore.getState().openReviewWorkspace('/repo/a', { filePath: 'src/a.ts' });
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

  async function renderPanel(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(UtilityRailReviewPanel, {
            workspacePath: '/repo/a',
            ...props,
          })
        )
      );
    });

    await act(async () => {
      await flush();
      await flush();
    });
  }

  it('selects changed files in place and persists review selection per workspace', async () => {
    await renderPanel();

    const button = Array.from(container.querySelectorAll('.sidebar-file')).find((el) =>
      el.textContent?.includes('b.ts')
    ) as HTMLButtonElement | undefined;
    expect(button).toBeTruthy();

    await act(async () => {
      button!.click();
      await flush();
    });

    expect(useUiStore.getState().getUtilityRailState('/repo/a').review).toMatchObject({
      activeFilePath: 'src/b.ts',
      diffSource: 'working',
      defaultBranch: 'nightly',
    });
    expect(useUiStore.getState().openFileTabs).toEqual([]);
    expect(container.querySelector('.mock-diff-viewer')?.getAttribute('data-file')).toBe('src/b.ts');
  });

  it('handles review shortcuts immediately after opening without manually focusing the panel', async () => {
    const onRequestClose = vi.fn();
    await renderPanel({ onRequestClose });

    expect(document.activeElement).not.toBe(container.querySelector('.utility-review-panel'));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
      await flush();
    });

    expect(useUiStore.getState().getUtilityRailState('/repo/a').review).toMatchObject({
      activeFilePath: 'src/b.ts',
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await flush();
    });

    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('ignores review shortcuts while the review surface is inactive', async () => {
    await renderPanel({ active: false });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
      await flush();
    });

    expect(useUiStore.getState().getUtilityRailState('/repo/a').review).toMatchObject({
      activeFilePath: 'src/a.ts',
    });
  });

  it('ignores review shortcuts that originate from typing targets', async () => {
    await renderPanel();
    const input = document.createElement('input');
    container.appendChild(input);
    input.focus();

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
      await flush();
    });

    expect(useUiStore.getState().getUtilityRailState('/repo/a').review).toMatchObject({
      activeFilePath: 'src/a.ts',
    });
  });
});
