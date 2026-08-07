import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UtilityRailBranchPanel from './components/UtilityRailBranchPanel.js';
import { useUiStore } from './lib/stores/ui.js';
import type { BranchDivergenceSummary } from './lib/types.js';
import './App.css';
import './components/WorkspaceUtilityRail.css';
import './components/UtilityRailBranchPanel.css';
import './test-utility-rail-branch-panel.css';

const nativeFetch = window.fetch.bind(window);

function summaryFor(base: string | null): BranchDivergenceSummary {
  const selected = base ?? 'origin/nightly';
  return {
    repoPath: '/fixture/repo',
    currentBranch: 'feat/branch-panel',
    headSha: 'aaaaaaaa',
    selectedBase: { ref: selected, sha: 'bbbbbbbb' },
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
    aheadCount: selected === 'origin/main' ? 3 : 2,
    behindCount: 1,
    lineDelta: { additions: 42, deletions: 7, fileCount: 5 },
    dirty: {
      stagedCount: 1,
      unstagedCount: 2,
      untrackedCount: 1,
      conflictedCount: 0,
      files: [],
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
}

window.fetch = async (input, init) => {
  const url = new URL(String(input), window.location.origin);
  if (url.pathname === '/workspaces/divergence') {
    const body = JSON.stringify(summaryFor(url.searchParams.get('base')));
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return nativeFetch(input, init);
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function BranchPanelHarness() {
  const branchBase = useUiStore(
    (s) => s.getUtilityRailState('/fixture/repo').branchBase ?? ''
  );

  return (
    <div className="branch-panel-harness">
      <div className="branch-panel-frame">
        <QueryClientProvider client={queryClient}>
          <UtilityRailBranchPanel workspacePath="/fixture/repo" />
        </QueryClientProvider>
      </div>
      <output data-testid="branch-base-state">{branchBase}</output>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <BranchPanelHarness />
  </React.StrictMode>
);
