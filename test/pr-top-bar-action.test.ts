// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { CiStatus, PrInfo } from '../frontend/src/lib/types.js';

const mocks = vi.hoisted(() => ({
  fetchPrForBranchOrNull: vi.fn(),
  fetchCiStatusOrNull: vi.fn(),
  fetchCurrentBranch: vi.fn(),
  renameBranch: vi.fn(),
  createRepoWebhook: vi.fn(),
  sendPtyData: vi.fn(),
  forceRefresh: vi.fn(),
  refreshAll: vi.fn(),
  showToast: vi.fn(),
  repos: [] as Array<{
    path: string;
    name: string;
    isGitRepo: boolean;
    defaultBranch: string | null;
    currentBranch: string | null;
    webhookStatus?: 'live' | 'manual' | 'limited' | 'error';
    webhookError?: string;
  }>,
  repoEnrichmentMeta: {} as Record<
    string,
    { lastEnrichedAt: number; source: 'webhook' | 'manual' }
  >,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../frontend/src/lib/api.js', () => ({
  fetchPrForBranchOrNull: mocks.fetchPrForBranchOrNull,
  fetchCiStatusOrNull: mocks.fetchCiStatusOrNull,
  fetchCurrentBranch: mocks.fetchCurrentBranch,
  renameBranch: mocks.renameBranch,
  createRepoWebhook: mocks.createRepoWebhook,
}));

vi.mock('../frontend/src/lib/ws.js', () => ({
  sendPtyData: mocks.sendPtyData,
}));

vi.mock('../frontend/src/lib/stores/toasts.js', () => ({
  showToast: mocks.showToast,
}));

vi.mock('../frontend/src/lib/stores/sessions.js', () => ({
  useSessionsStore: (selector: (state: unknown) => unknown) =>
    selector({
      repos: mocks.repos,
      repoEnrichmentMeta: mocks.repoEnrichmentMeta,
      forceRefresh: mocks.forceRefresh,
      refreshAll: mocks.refreshAll,
    }),
}));

vi.mock('../frontend/src/lib/stores/ui.js', () => ({
  DEFAULT_UTILITY_RAIL_STATE: {
    visible: true,
    selectedRailTab: null,
    width: 320,
  },
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      utilityRailByWorkspace: {},
      getUtilityRailState: () => ({
        visible: true,
        selectedRailTab: null,
        width: 320,
      }),
      hydrateUtilityRailState: vi.fn(),
      toggleUtilityRailVisible: vi.fn(),
      setActiveModal: vi.fn(),
    }),
}));

vi.mock('../frontend/src/components/BranchSwitcher.js', () => ({
  default: ({ currentBranch }: { currentBranch: string }) =>
    React.createElement('button', { type: 'button' }, currentBranch),
}));

vi.mock('../frontend/src/components/TargetBranchSwitcher.js', () => ({
  default: ({ currentBase }: { currentBase: string }) =>
    React.createElement('span', null, currentBase),
}));

vi.mock('../frontend/src/components/CipherText.js', () => ({
  default: ({ text }: { text: string }) =>
    React.createElement('span', null, text),
}));

vi.mock('../frontend/src/components/dialogs/RenameWarningModal.js', () => ({
  default: () => React.createElement('div', null, 'rename warning'),
}));

const { PrTopBar } = await import('../frontend/src/components/PrTopBar.tsx');

function samplePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 115,
    title: 'Fix merge button',
    url: 'https://github.com/donovan-yohan/relay-ide/pull/115',
    state: 'OPEN',
    headRefName: 'fix/115-merge-button',
    baseRefName: 'nightly',
    isDraft: false,
    reviewDecision: null,
    additions: 4,
    deletions: 0,
    mergeable: 'MERGEABLE',
    unresolvedCommentCount: 0,
    updatedAt: '2026-04-23T00:00:00Z',
    ...overrides,
  };
}

function passingCi(): CiStatus {
  return {
    total: 1,
    passing: 1,
    failing: 0,
    pending: 0,
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('PrTopBar actions', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.repos.splice(0);
    Object.keys(mocks.repoEnrichmentMeta).forEach((key) => {
      delete mocks.repoEnrichmentMeta[key];
    });
  });

  it('opens mergeable PRs in a new tab without archiving the session', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onArchive = vi.fn();
    mocks.fetchPrForBranchOrNull.mockResolvedValue(samplePr());
    mocks.fetchCiStatusOrNull.mockResolvedValue(passingCi());

    await act(async () => {
      root.render(
        React.createElement(PrTopBar, {
          workspacePath: '/repo',
          branchName: 'fix/115-merge-button',
          sessionId: 'session-1',
          onArchive,
        })
      );
    });
    await flushEffects();

    const mergeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Merge'
    );
    expect(mergeButton).toBeTruthy();

    await act(async () => {
      mergeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/donovan-yohan/relay-ide/pull/115',
      '_blank',
      'noopener,noreferrer'
    );
    expect(onArchive).not.toHaveBeenCalled();
    expect(mocks.sendPtyData).not.toHaveBeenCalled();
  });

  it('renders source freshness and calls forceRefresh from the manual refresh button', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.repos.push({
      path: '/repo',
      name: 'repo',
      isGitRepo: true,
      defaultBranch: 'nightly',
      currentBranch: 'fix/115-merge-button',
      webhookStatus: 'manual',
    });
    const baseTime = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    mocks.repoEnrichmentMeta['/repo'] = {
      lastEnrichedAt: baseTime - 4 * 60 * 1000,
      source: 'manual',
    };
    mocks.fetchPrForBranchOrNull.mockResolvedValue(samplePr());
    mocks.fetchCiStatusOrNull.mockResolvedValue(passingCi());
    mocks.forceRefresh.mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        React.createElement(PrTopBar, {
          workspacePath: '/repo',
          branchName: 'fix/115-merge-button',
          sessionId: 'session-1',
        })
      );
    });
    await flushEffects();

    const source = container.querySelector('[data-testid="pr-source-indicator"]');
    expect(source?.textContent).toContain('manual');
    expect(source?.textContent).toContain('updated 4m ago');

    const refreshButton = container.querySelector(
      'button[aria-label="Refresh repo data"]'
    ) as HTMLButtonElement | null;
    expect(refreshButton).toBeTruthy();

    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.forceRefresh).toHaveBeenCalledWith('/repo', 'manual');
  });

  it('reports webhook retry failures while still forcing a manual refresh', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.repos.push({
      path: '/repo',
      name: 'repo',
      isGitRepo: true,
      defaultBranch: 'nightly',
      currentBranch: 'fix/115-merge-button',
      webhookStatus: 'error',
      webhookError: 'hook failed',
    });
    mocks.fetchPrForBranchOrNull.mockResolvedValue(samplePr());
    mocks.fetchCiStatusOrNull.mockResolvedValue(passingCi());
    mocks.createRepoWebhook.mockRejectedValue(new Error('webhook denied'));
    mocks.forceRefresh.mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        React.createElement(PrTopBar, {
          workspacePath: '/repo',
          branchName: 'fix/115-merge-button',
          sessionId: 'session-1',
        })
      );
    });
    await flushEffects();

    const retryButton = container.querySelector(
      'button[aria-label="Retry webhook provisioning"]'
    ) as HTMLButtonElement | null;
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.createRepoWebhook).toHaveBeenCalledWith('/repo');
    expect(mocks.showToast).toHaveBeenCalledWith('webhook denied');
    expect(mocks.forceRefresh).toHaveBeenCalledWith('/repo', 'manual');
  });
});
