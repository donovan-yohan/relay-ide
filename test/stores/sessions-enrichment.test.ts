import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  enrichBranches: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorktrees: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchWorkspaceGroups: vi.fn(),
}));

vi.mock('../../frontend/src/lib/api.js', () => ({
  enrichBranches: apiMocks.enrichBranches,
  fetchSessions: apiMocks.fetchSessions,
  fetchWorktrees: apiMocks.fetchWorktrees,
  fetchWorkspaces: apiMocks.fetchWorkspaces,
  fetchWorkspaceGroups: apiMocks.fetchWorkspaceGroups,
}));

const storage: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
  },
  configurable: true,
});

import { useSessionsStore } from '../../frontend/src/lib/stores/sessions.js';

const repoA = {
  name: 'relay-ide',
  path: '/repos/relay-ide',
  isGitRepo: true,
  defaultBranch: 'nightly',
  currentBranch: 'nightly',
};
const repoB = {
  name: 'hermes-agent',
  path: '/repos/hermes-agent',
  isGitRepo: true,
  defaultBranch: 'dy-main',
  currentBranch: 'dy-main',
};

function resetStore(): void {
  useSessionsStore.setState({
    sessions: [],
    worktrees: [
      {
        name: 'feature-a',
        path: '/repos/relay-ide/.worktrees/feature-a',
        repoName: 'relay-ide',
        repoPath: repoA.path,
        displayName: 'feature-a',
        lastActivity: '2026-05-07T00:00:00.000Z',
        branchName: 'feature-a',
      },
      {
        name: 'feature-b',
        path: '/repos/hermes-agent/.worktrees/feature-b',
        repoName: 'hermes-agent',
        repoPath: repoB.path,
        displayName: 'feature-b',
        lastActivity: '2026-05-07T00:00:00.000Z',
        branchName: 'feature-b',
      },
    ],
    repos: [repoA, repoB],
    workspaceGroups: [],
    enrichmentResults: {},
    repoEnrichmentMeta: {},
  });
}

describe('sessions repo enrichment freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T00:00:00.000Z'));
    vi.clearAllMocks();
    resetStore();
    apiMocks.enrichBranches.mockResolvedValue({ results: {} });
  });

  it('ensureFresh skips a repo inside ttl and fetches it again after ttl expires', async () => {
    apiMocks.enrichBranches
      .mockResolvedValueOnce({
        results: {
          [`${repoA.path}::feature-a`]: { pr: null, stale: false },
        },
      })
      .mockResolvedValueOnce({ results: {} });

    await (useSessionsStore.getState() as any).ensureFresh(repoA.path, 600_000);
    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(1);
    expect(apiMocks.enrichBranches).toHaveBeenLastCalledWith([
      { repoPath: repoA.path, branchName: 'feature-a' },
    ]);

    vi.setSystemTime(new Date('2026-05-07T00:05:00.000Z'));
    await (useSessionsStore.getState() as any).ensureFresh(repoA.path, 600_000);
    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-05-07T00:11:00.000Z'));
    await (useSessionsStore.getState() as any).ensureFresh(repoA.path, 600_000);
    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh bypasses a fresh ttl window for one repo only', async () => {
    await (useSessionsStore.getState() as any).ensureFresh(repoA.path, 600_000);
    await (useSessionsStore.getState() as any).forceRefresh(repoA.path);

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);
    expect(apiMocks.enrichBranches).toHaveBeenLastCalledWith([
      { repoPath: repoA.path, branchName: 'feature-a' },
    ]);
  });

  it('ensureFreshAll calls stale visible repos without fanning out through one global enrichment request', async () => {
    await (useSessionsStore.getState() as any).ensureFresh(repoA.path, 600_000);
    vi.setSystemTime(new Date('2026-05-07T00:05:00.000Z'));

    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);
    expect(apiMocks.enrichBranches).toHaveBeenLastCalledWith([
      { repoPath: repoB.path, branchName: 'feature-b' },
    ]);
  });

  it('records webhook metadata even when the affected repo has no local branches to enrich', async () => {
    useSessionsStore.setState({ worktrees: [] });

    await (useSessionsStore.getState() as any).forceRefresh(repoA.path, 'webhook');

    expect(apiMocks.enrichBranches).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().repoEnrichmentMeta[repoA.path]).toEqual({
      lastEnrichedAt: Date.now(),
      source: 'webhook',
    });
  });
});
