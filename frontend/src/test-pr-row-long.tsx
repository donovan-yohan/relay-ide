import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrRow } from './components/PrRow.js';
import type { PullRequest } from './lib/types.js';
import './App.css';

const longBranchPr: PullRequest = {
  number: 995,
  title: 'Fix mobile branch overflow in PR rows',
  url: 'https://github.com/donovan-yohan/relay-ide/pull/995',
  headRefName:
    'feature/super-long-mobile-branch-name-that-used-to-force-the-pr-row-to-scroll-sideways-on-small-screens',
  baseRefName:
    'release/another-extremely-long-base-branch-name-that-must-truncate-inside-the-row',
  state: 'OPEN',
  author: 'donovan-yohan',
  role: 'author',
  updatedAt: '2026-06-20T22:00:00.000Z',
  additions: 12,
  deletions: 3,
  reviewDecision: null,
  mergeable: 'MERGEABLE',
  ciStatus: 'SUCCESS',
  isDraft: false,
  repoName: 'relay-ide',
  repoPath: '/repo/relay-ide',
};

function Harness() {
  return (
    <main
      className="pr-row-long-fixture"
      aria-label="long branch PR row fixture"
      style={{ width: '358px', maxWidth: 'calc(100vw - 32px)', margin: '16px' }}
    >
      <PrRow
        pr={longBranchPr}
        onOpen={() => undefined}
        onAction={() => undefined}
        showRepo
        showCi
      />
    </main>
  );
}

createRoot(document.getElementById('app')!).render(<Harness />);
