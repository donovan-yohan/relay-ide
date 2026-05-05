import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FullPageDiff } from './components/FullPageDiff.js';
import { useUiStore } from './lib/stores/ui.js';
import './App.css';

type MockChangedFile = {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
};

const workspacePath = '/tmp/relay-review-workspace';
const changedFilesByBase: Record<string, MockChangedFile[]> = {
  working: [
    { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
    { path: 'src/b.ts', status: 'added', additions: 4, deletions: 0 },
  ],
  cached: [{ path: 'src/staged.ts', status: 'modified', additions: 1, deletions: 1 }],
  nightly: [{ path: 'src/base.ts', status: 'deleted', additions: 0, deletions: 3 }],
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function diffFor(filePath: string, base: string | null): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'index 1111111..2222222 100644',
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    '@@ -1,3 +1,3 @@',
    `-old ${filePath}`,
    `+new ${filePath}`,
    ` context ${base ?? 'working'}`,
  ].join('\n');
}

const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(rawUrl, window.location.origin);

  if (url.pathname === '/workspaces/default-branch') {
    return jsonResponse({ branch: 'nightly' });
  }

  if (url.pathname === '/workspaces/changed-files') {
    const base = url.searchParams.get('base') ?? 'working';
    const files = changedFilesByBase[base] ?? [];
    return jsonResponse({
      files,
      aggregate: {
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        fileCount: files.length,
      },
    });
  }

  if (url.pathname === '/workspaces/file-diff') {
    const filePath = url.searchParams.get('file') ?? 'src/a.ts';
    const base = url.searchParams.get('base');
    return jsonResponse({ diff: diffFor(filePath, base) });
  }

  return originalFetch(input, init);
};

useUiStore.setState({
  fullPageDiff: { workspacePath, file: 'src/a.ts' },
});

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness() {
  const fullPageDiff = useUiStore((state) => state.fullPageDiff);
  return fullPageDiff ? (
    <QueryClientProvider client={queryClient}>
      <div className="full-page-diff-overlay">
        <FullPageDiff
          workspacePath={fullPageDiff.workspacePath}
          {...(fullPageDiff.file !== undefined ? { initialFile: fullPageDiff.file } : {})}
          {...(fullPageDiff.base !== undefined ? { initialBase: fullPageDiff.base } : {})}
          onClose={() => useUiStore.setState({ fullPageDiff: null })}
        />
      </div>
    </QueryClientProvider>
  ) : (
    <div className="utility-empty">closed</div>
  );
}

createRoot(document.getElementById('app')!).render(<Harness />);
