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
  // keyed by workContextId → { data?, isLoading?, isError? }
  artifactsByContext: {} as Record<
    string,
    { data?: unknown[]; isLoading?: boolean; isError?: boolean }
  >,
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
  useQueries: (opts: { queries: { queryKey: unknown[] }[] }) =>
    opts.queries.map((query) => {
      const wcId = query.queryKey[1] as string;
      const entry = mocks.artifactsByContext[wcId] ?? {};
      return {
        data: entry.data ?? [],
        isLoading: entry.isLoading ?? false,
        isError: entry.isError ?? false,
      };
    }),
  useQueryClient: () => ({ fetchQuery: vi.fn() }),
}));

vi.mock('../frontend/src/lib/api.js', () => ({
  fetchWorkspaceEvidenceRoots: vi.fn(),
  fetchWorkspaceEvidenceList: vi.fn(),
  fetchWorkspaceEvidencePreview: vi.fn(),
  fetchActiveWork: vi.fn(),
  fetchPipelineHandoffArtifacts: vi.fn(),
  copyPipelineHandoffArtifact: vi.fn(),
}));

vi.mock('../frontend/src/lib/stores/sessions.js', () => {
  const useSessionsStore = (
    selector: (s: {
      backendConnectionStatus: string;
      sessions: unknown[];
    }) => unknown
  ) =>
    selector({
      backendConnectionStatus: mocks.backendConnectionStatus,
      sessions: [],
    });
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
  mocks.artifactsByContext = {};
});

function activeGroupForRepo(
  groupId: string,
  contextId: string,
  repoPath: string
) {
  return {
    id: groupId,
    context: { id: contextId, anchors: { repo: { localPath: repoPath } } },
    node: { nodeId: 'local', status: 'unknown' },
    sessions: [],
    staleReadModel: false,
  };
}

function artifactEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      id: 'art-1',
      workContextId: 'wc-1',
      kind: 'report',
      title: 'qa evidence',
      summary: 'qa passed all checks',
      visibility: 'public',
      capturedAt: '2026-06-10T00:00:00.000Z',
      payloadKind: 'pipeline-handoff-artifact',
      payloadSha256: 'abcdef0123456789',
      payloadBytes: 128,
      stage: 'qa',
      headSha: 'deadbeefcafebabe',
      taskRef: { kind: 'github-issue', id: '898' },
      ...overrides,
    },
  };
}

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

  it('keeps files/artifacts/sessions/surfaces as distinct data-track sections', async () => {
    mocks.roots = [repoRoot()];
    await renderDashboard('/repo');
    expect(
      container!.querySelector('[data-track="evidence.files"]')
    ).toBeTruthy();
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

  it('renders artifact cards preserving kind/visibility/headSha from a matched context', async () => {
    mocks.roots = [repoRoot()];
    mocks.activeWork = [activeGroupForRepo('g1', 'wc-1', '/repo')];
    mocks.artifactsByContext = { 'wc-1': { data: [artifactEnvelope()] } };
    await renderDashboard('/repo');
    const cards = container!.querySelectorAll(
      '[data-track="evidence.artifact-card"]'
    );
    expect(cards.length).toBe(1);
    const text = cards[0]!.textContent ?? '';
    expect(text).toContain('qa evidence');
    expect(text).toContain('report');
    expect(text).toContain('public');
    expect(text).toContain('qa');
    expect(text).toContain('github-issue:898');
    // headSha rendered short (7 chars), full in title attr
    expect(text).toContain('deadbee');
  });

  it('shows the no-work-context empty state when no context binds the repo', async () => {
    mocks.roots = [repoRoot()];
    mocks.activeWork = [activeGroupForRepo('g1', 'wc-1', '/other-repo')];
    await renderDashboard('/repo');
    const section = container!.querySelector(
      '[data-track="evidence.artifacts"]'
    );
    expect(section!.textContent).toContain('no work context bound');
    expect(
      section!.querySelector('[data-track="evidence.artifact-card"]')
    ).toBeNull();
  });

  it('shows the no-typed-evidence-refs state when a context has zero artifacts', async () => {
    mocks.roots = [repoRoot()];
    mocks.activeWork = [activeGroupForRepo('g1', 'wc-1', '/repo')];
    mocks.artifactsByContext = { 'wc-1': { data: [] } };
    await renderDashboard('/repo');
    const section = container!.querySelector(
      '[data-track="evidence.artifacts"]'
    );
    expect(section!.textContent).toContain('no typed evidence refs yet');
  });

  it('renders an inline error for a failed artifact query without crashing siblings', async () => {
    mocks.roots = [repoRoot()];
    mocks.activeWork = [activeGroupForRepo('g1', 'wc-1', '/repo')];
    mocks.artifactsByContext = { 'wc-1': { isError: true } };
    await renderDashboard('/repo');
    const section = container!.querySelector(
      '[data-track="evidence.artifacts"]'
    );
    expect(section!.textContent).toContain('failed to load artifacts');
    // sibling sections still render
    expect(
      container!.querySelector('[data-track="evidence.sessions"]')
    ).toBeTruthy();
  });

  it('disables copy button with private-artifact title for a private artifact', async () => {
    mocks.roots = [repoRoot()];
    mocks.activeWork = [activeGroupForRepo('g1', 'wc-1', '/repo')];
    mocks.artifactsByContext = {
      'wc-1': { data: [artifactEnvelope({ visibility: 'private' })] },
    };
    await renderDashboard('/repo');
    const card = container!.querySelector(
      '[data-track="evidence.artifact-card"]'
    );
    const copyBtn = Array.from(card!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('copy summary')
    );
    expect(copyBtn).toBeTruthy();
    expect((copyBtn as HTMLButtonElement).disabled).toBe(true);
    expect((copyBtn as HTMLButtonElement).title).toBe(
      'private artifact — copy/export requires public visibility'
    );
  });

  it('renders copy button enabled for a public artifact', async () => {
    mocks.roots = [repoRoot()];
    mocks.activeWork = [activeGroupForRepo('g1', 'wc-1', '/repo')];
    mocks.artifactsByContext = {
      'wc-1': { data: [artifactEnvelope({ visibility: 'public' })] },
    };
    await renderDashboard('/repo');
    const card = container!.querySelector(
      '[data-track="evidence.artifact-card"]'
    );
    const copyBtn = Array.from(card!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('copy summary')
    );
    expect(copyBtn).toBeTruthy();
    expect((copyBtn as HTMLButtonElement).disabled).toBe(false);
    expect((copyBtn as HTMLButtonElement).title).toBeFalsy();
  });
});
