// @vitest-environment happy-dom
//
// Regression for issue #897 BUG 1: clicking a file in the evidence files
// section unmounted the whole app with React error #185 ("maximum update depth
// exceeded"). The loop ran through the shiki-gc store's setEntry, fired from
// WorkspaceEvidencePreview rendering CodeBlock → useShikiHighlight.
//
// This test mounts the REAL WorkspaceEvidencePreview (real CodeBlock, real
// useShikiHighlight, real shiki-gc store) with a successful preview query and
// asserts the component renders without throwing. `tokenizeCode` is stubbed
// with a never-resolving promise so the test reproduces the pre-fix loop, which
// occurred synchronously on every render BEFORE tokenization ever resolved.

import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type {
  WorkspaceEvidencePreviewResponse,
  WorkspaceEvidenceRoot,
} from '../shared/workspace-evidence.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  previewResponse: undefined as WorkspaceEvidencePreviewResponse | undefined,
}));

// Successful preview query for a text file.
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    if (opts.queryKey[0] === 'workspace-evidence-preview' && opts.enabled) {
      return {
        data: mocks.previewResponse,
        isLoading: false,
        isError: false,
      };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
}));

vi.mock('../frontend/src/lib/api.js', () => ({
  fetchWorkspaceEvidencePreview: vi.fn(),
}));

// Stub tokenizeCode with a promise that never resolves. The pre-fix loop fired
// synchronously (setEntry → re-render → effect → setEntry …) before any
// tokenization completed, so a pending promise is sufficient to reproduce it.
vi.mock('../frontend/src/lib/shiki.js', () => ({
  tokenizeCode: vi.fn(() => new Promise<unknown>(() => {})),
}));

const { WorkspaceEvidencePreview } = await import(
  '../frontend/src/components/WorkspaceEvidencePreview.js'
);

function repoRoot(): WorkspaceEvidenceRoot {
  return {
    ref: { id: 'wer:local:/repo', nodeId: 'local', kind: 'repo' },
    name: 'repo',
    path: '/repo',
    nodeId: 'local',
    kind: 'repo',
    backing: 'repo',
    status: 'available',
    capabilities: {
      list: true,
      stat: true,
      read: true,
      preview: true,
      write: false,
    },
    repo: { repoPath: '/repo', isGitRepo: true, currentBranch: 'main' },
  };
}

function textPreview(): WorkspaceEvidencePreviewResponse {
  return {
    operation: 'preview',
    root: repoRoot(),
    path: 'src/index.ts',
    preview: {
      state: 'available',
      kind: 'text',
      encoding: 'utf8',
      content: 'const greeting = "hello world";\nexport default greeting;\n',
      bytesRead: 56,
      maxBytes: 32768,
      truncated: false,
    },
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  mocks.previewResponse = undefined;
});

describe('WorkspaceEvidencePreview (BUG 1: shiki GC loop)', () => {
  it('renders a selected text file without looping the GC store / crashing', async () => {
    mocks.previewResponse = textPreview();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // Before the fix this threw a React "maximum update depth exceeded" error
    // (minified #185) during the synchronous render storm.
    await act(async () => {
      root!.render(
        React.createElement(WorkspaceEvidencePreview, {
          root: repoRoot(),
          selectedPath: 'src/index.ts',
        })
      );
    });

    // The preview header and plain-text body (tokens still pending) render.
    expect(container.textContent).toContain('index.ts');
    expect(container.textContent).toContain('hello world');
    expect(container.querySelector('.code-block')).toBeTruthy();
  });
});
