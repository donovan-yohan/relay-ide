// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reactActGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true;
import UtilityRailBranchPanel from '../frontend/src/components/UtilityRailBranchPanel.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import type { BranchDivergenceSummary } from '../frontend/src/lib/types.js';

const baseSummary: BranchDivergenceSummary = {
  repoPath: '/repo',
  currentBranch: 'feat/branch-panel',
  headSha: 'aaaaaaaa',
  selectedBase: { ref: 'origin/nightly', sha: 'bbbbbbbb' },
  baseCandidates: [
    {
      ref: 'origin/nightly',
      sha: 'bbbbbbbb',
      label: 'origin/nightly',
      source: 'remoteDefault',
    },
    {
      ref: 'origin/main',
      sha: 'cccccccc',
      label: 'origin/main',
      source: 'remote',
    },
  ],
  aheadCount: 2,
  behindCount: 1,
  lineDelta: { additions: 42, deletions: 7, fileCount: 5 },
  dirty: {
    stagedCount: 1,
    unstagedCount: 2,
    untrackedCount: 1,
    conflictedCount: 0,
    files: [
      { path: 'src/app.ts', status: 'modified', staged: true, unstaged: false },
      { path: 'notes.txt', status: 'untracked', staged: false, unstaged: true },
    ],
    truncated: false,
  },
  commits: {
    ahead: [
      {
        hash: 'aaaaaaaa11111111',
        shortHash: 'aaaaaaaa',
        subject: 'add branch panel',
        author: 'ebi',
        date: '2026-05-05T00:00:00.000Z',
      },
    ],
    behind: [
      {
        hash: 'bbbbbbbb22222222',
        shortHash: 'bbbbbbbb',
        subject: 'backend contract',
        author: 'donovan',
        date: '2026-05-04T00:00:00.000Z',
      },
    ],
  },
  state: 'ok',
  warnings: ['commit list truncated'],
  generatedAt: '2026-05-05T00:00:00.000Z',
};

function mockDivergenceFetch() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const parsed = new URL(url, 'http://relay.test');
      const selected = parsed.searchParams.get('base') ?? 'origin/nightly';
      const response: BranchDivergenceSummary = {
        ...baseSummary,
        selectedBase: { ref: selected, sha: 'selected-sha' },
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(response),
        json: async () => response,
      };
    })
  );
  return calls;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function waitForText(container: HTMLElement, pattern: string | RegExp) {
  for (let i = 0; i < 20; i += 1) {
    await flush();
    const text = container.textContent ?? '';
    if (
      typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
    ) {
      return;
    }
  }
  expect(container.textContent ?? '').toMatch(pattern);
}

function renderPanel(root: Root, queryClient: QueryClient) {
  root.render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(UtilityRailBranchPanel, { workspacePath: '/repo' })
    )
  );
}

describe('UtilityRailBranchPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useUiStore.setState({ utilityRailByWorkspace: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it('renders branch metrics, commit lists, warnings, and dirty-tree links', async () => {
    mockDivergenceFetch();

    await act(async () => renderPanel(root, queryClient));
    await waitForText(container, 'feat/branch-panel');

    expect(container.textContent).toContain('divergence');
    expect(container.textContent).toContain('feat/branch-panel');
    expect(container.textContent).toContain('ahead');
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('+42');
    expect(container.textContent).toContain('−7');
    expect(container.textContent).toContain('add branch panel');
    expect(container.textContent).toContain('backend contract');
    expect(container.textContent).toContain('dirty tree');
    expect(container.textContent).toContain('commit list truncated');
  });

  it('refetches when the user chooses a base candidate', async () => {
    const calls = mockDivergenceFetch();

    await act(async () => renderPanel(root, queryClient));
    await waitForText(container, 'feat/branch-panel');

    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('origin/nightly');

    await act(async () => {
      select.value = 'origin/main';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(calls.some((url) => url.includes('base=origin%2Fmain'))).toBe(true);
    expect(useUiStore.getState().getUtilityRailState('/repo').branchBase).toBe(
      'origin/main'
    );
  });

  it('opens existing changes and review rail surfaces from summary links', async () => {
    mockDivergenceFetch();

    await act(async () => renderPanel(root, queryClient));
    await waitForText(container, 'feat/branch-panel');

    const changesButton = container.querySelector(
      '[data-testid="branch-open-changes"]'
    ) as HTMLButtonElement;
    await act(async () => changesButton.click());
    expect(
      useUiStore.getState().getUtilityRailState('/repo').selectedRailTab
    ).toBe('changes');

    const reviewButton = container.querySelector(
      '[data-testid="branch-open-review"]'
    ) as HTMLButtonElement;
    await act(async () => reviewButton.click());
    expect(
      useUiStore.getState().getUtilityRailState('/repo').selectedRailTab
    ).toBe('review');
  });

  it('shows the persisted missing base in the selector instead of falling back visually', async () => {
    useUiStore.getState().setUtilityBranchBase('/repo', 'missing-base-qa');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response: BranchDivergenceSummary = {
          ...baseSummary,
          selectedBase: null,
          state: 'missing_base',
          error: 'base ref not found: missing-base-qa',
        };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(response),
          json: async () => response,
        };
      })
    );

    await act(async () => renderPanel(root, queryClient));
    await waitForText(container, 'base ref not found: missing-base-qa');

    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('missing-base-qa');
    expect(
      Array.from(select.options).some(
        (option) => option.value === 'missing-base-qa' && option.disabled
      )
    ).toBe(true);
    expect(container.textContent).toContain('missing-base-qa');
  });

  it('describes clean, dirty-only, missing-base, and detached states clearly', async () => {
    const states: Array<Partial<BranchDivergenceSummary>> = [
      {
        aheadCount: 0,
        behindCount: 0,
        lineDelta: { additions: 0, deletions: 0, fileCount: 0 },
        dirty: {
          ...baseSummary.dirty,
          stagedCount: 0,
          unstagedCount: 0,
          untrackedCount: 0,
          conflictedCount: 0,
        },
        commits: { ahead: [], behind: [] },
      },
      { aheadCount: 0, behindCount: 0, commits: { ahead: [], behind: [] } },
      { state: 'missing_base', selectedBase: null, error: 'base not found' },
      { state: 'detached', currentBranch: null, error: 'detached head' },
    ];

    for (const patch of states) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          const response = { ...baseSummary, ...patch };
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(response),
            json: async () => response,
          };
        })
      );
      queryClient.clear();
      await act(async () => renderPanel(root, queryClient));
      await waitForText(
        container,
        /clean branch|dirty tree|missing base|detached head/
      );
      expect(container.textContent).toMatch(
        /clean branch|dirty tree|missing base|detached head/
      );
      vi.unstubAllGlobals();
    }
  });
});
