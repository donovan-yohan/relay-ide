// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceEvidenceRoot } from '../shared/workspace-evidence.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  roots: [] as WorkspaceEvidenceRoot[],
  listEntries: [] as unknown[],
  activeWork: [] as unknown[],
  backendConnectionStatus: 'connected' as string,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    const key = opts.queryKey[0];
    if (key === 'workspace-evidence-roots') {
      return { data: mocks.roots, isLoading: false, isError: false };
    }
    if (key === 'workspace-evidence-list') {
      return {
        data: { entries: mocks.listEntries },
        isLoading: false,
        isError: false,
      };
    }
    if (key === 'active-work') {
      return { data: mocks.activeWork, isLoading: false, isError: false };
    }
    if (key === 'workspace-evidence-preview') {
      return { data: undefined, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useQueryClient: () => ({ fetchQuery: vi.fn() }),
}));

vi.mock('../frontend/src/lib/api.js', () => ({
  fetchWorkspaceEvidenceRoots: vi.fn(),
  fetchWorkspaceEvidenceList: vi.fn(),
  fetchWorkspaceEvidencePreview: vi.fn(),
  fetchActiveWork: vi.fn(),
}));

vi.mock('../frontend/src/lib/stores/sessions.js', () => {
  const useSessionsStore = (
    selector: (s: { backendConnectionStatus: string }) => unknown
  ) => selector({ backendConnectionStatus: mocks.backendConnectionStatus });
  return { useSessionsStore };
});

vi.mock('../frontend/src/components/CodeBlock.js', async () => {
  const ReactModule = await import('react');
  return { default: () => ReactModule.createElement('div') };
});

vi.mock('../frontend/src/components/DiffViewer.js', async () => {
  const ReactModule = await import('react');
  return { default: () => ReactModule.createElement('div') };
});

const { WorkspaceEvidenceDashboard } = await import(
  '../frontend/src/components/WorkspaceEvidenceDashboard.js'
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

function directoryRoot(): WorkspaceEvidenceRoot {
  return {
    ref: { id: 'wer:local:/dir', nodeId: 'local', kind: 'directory' },
    name: 'dir',
    path: '/dir',
    nodeId: 'local',
    kind: 'directory',
    backing: 'directory',
    status: 'available',
    capabilities: {
      list: true,
      stat: true,
      read: true,
      preview: true,
      write: false,
    },
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderDashboard(repoPath: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(WorkspaceEvidenceDashboard, { repoPath })
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
  mocks.roots = [];
  mocks.listEntries = [];
  mocks.activeWork = [];
  mocks.backendConnectionStatus = 'connected';
});

describe('WorkspaceEvidenceDashboard', () => {
  it('renders files section and repo decoration for a repo-backed root', async () => {
    mocks.roots = [repoRoot()];
    await renderDashboard('/repo');
    expect(
      container!.querySelector('[data-track="evidence.files"]')
    ).toBeTruthy();
    expect(
      container!.querySelector('[data-track="evidence.repo-decoration"]')
    ).toBeTruthy();
  });

  it('renders files section without decoration for a free-directory root', async () => {
    mocks.roots = [directoryRoot()];
    await renderDashboard('/dir');
    expect(
      container!.querySelector('[data-track="evidence.files"]')
    ).toBeTruthy();
    expect(
      container!.querySelector('[data-track="evidence.repo-decoration"]')
    ).toBeNull();
    expect(
      container!.querySelector('[data-track="evidence.worktree-decoration"]')
    ).toBeNull();
  });

  it('shows no-filesystem-root state but still renders other sections when no root resolves', async () => {
    mocks.roots = [repoRoot()];
    await renderDashboard('/unknown');
    expect(
      container!.querySelector('[data-track="evidence.files"]')
    ).toBeNull();
    expect(container!.textContent).toContain('no filesystem root');
    expect(
      container!.querySelector('[data-track="evidence.artifacts"]')
    ).toBeTruthy();
    expect(
      container!.querySelector('[data-track="evidence.sessions"]')
    ).toBeTruthy();
    expect(
      container!.querySelector('[data-track="evidence.surfaces"]')
    ).toBeTruthy();
  });

  it('shows offline notice in the files section when the node is offline', async () => {
    mocks.roots = [{ ...repoRoot(), status: 'offline' }];
    await renderDashboard('/repo');
    expect(container!.textContent).toContain('node offline');
    expect(
      container!.querySelector('[data-track="evidence.files"]')
    ).toBeNull();
  });
});
