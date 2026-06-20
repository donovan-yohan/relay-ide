// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { PrRow } from '../frontend/src/components/PrRow.js';
import type { PullRequest } from '../frontend/src/lib/types.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const basePr: PullRequest = {
  number: 133,
  title: 'show branch info in pr table',
  url: 'https://github.com/donovan-yohan/relay-ide/pull/133',
  headRefName: 'issue-133-pr-table-branch-info',
  baseRefName: 'nightly',
  state: 'OPEN',
  author: 'donovan-yohan',
  role: 'author',
  updatedAt: '2026-06-20T22:00:00.000Z',
  additions: 12,
  deletions: 3,
  reviewDecision: null,
  mergeable: 'MERGEABLE',
  ciStatus: null,
  isDraft: false,
  repoName: 'relay-ide',
  repoPath: '/repo/relay-ide',
};

async function renderPrRow(pr: PullRequest = basePr) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(
      React.createElement(PrRow, {
        pr,
        onOpen: vi.fn(),
      })
    );
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('PrRow', () => {
  it('renders head and base branch identity in the metadata row', async () => {
    await renderPrRow();

    const branch = container!.querySelector('.pr-row__branch');
    expect(branch).toBeTruthy();
    expect(branch!.textContent).toBe('issue-133-pr-table-branch-info→nightly');
    expect(branch!.getAttribute('title')).toBe(
      'branch issue-133-pr-table-branch-info → nightly'
    );
    expect(branch!.getAttribute('aria-label')).toBe(
      'branch issue-133-pr-table-branch-info → nightly'
    );
  });

  it('uses truncation-safe branch cells for long branch names', async () => {
    await renderPrRow({
      ...basePr,
      headRefName:
        'very-long-feature-branch-name-that-should-not-break-pr-table-layout',
      baseRefName: 'release/2026-06-nightly-candidate',
    });

    const refs = Array.from(
      container!.querySelectorAll<HTMLSpanElement>('.pr-row__branch-ref')
    );
    expect(refs.map((ref) => ref.textContent)).toEqual([
      'very-long-feature-branch-name-that-should-not-break-pr-table-layout',
      'release/2026-06-nightly-candidate',
    ]);
    expect(refs.every((ref) => ref.className === 'pr-row__branch-ref')).toBe(
      true
    );
  });
});
