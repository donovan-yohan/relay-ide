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
  sendPtyData: vi.fn(),
}));

vi.mock('../frontend/src/lib/api.js', () => ({
  fetchPrForBranchOrNull: mocks.fetchPrForBranchOrNull,
  fetchCiStatusOrNull: mocks.fetchCiStatusOrNull,
  fetchCurrentBranch: mocks.fetchCurrentBranch,
  renameBranch: mocks.renameBranch,
}));

vi.mock('../frontend/src/lib/ws.js', () => ({
  sendPtyData: mocks.sendPtyData,
}));

vi.mock('../frontend/src/lib/stores/ui.js', () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      utilityRailByWorkspace: {},
      getUtilityRailState: () => ({
        visible: true,
        selectedRailTab: null,
        width: 320,
      }),
      toggleUtilityRailVisible: vi.fn(),
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
});
