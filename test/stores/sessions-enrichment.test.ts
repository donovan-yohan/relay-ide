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

import {
  resetRepoEnrichmentRuntime,
  useSessionsStore,
} from '../../frontend/src/lib/stores/sessions.js';

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
    resetRepoEnrichmentRuntime();
    resetStore();
    apiMocks.enrichBranches.mockResolvedValue({ results: {} });
  });

  it('ensureFreshAll skips repos inside ttl and fetches them again after ttl expires', async () => {
    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);
    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(1);
    expect(apiMocks.enrichBranches).toHaveBeenLastCalledWith([
      { repoPath: repoA.path, branchName: 'feature-a' },
      { repoPath: repoB.path, branchName: 'feature-b' },
    ]);

    vi.setSystemTime(new Date('2026-05-07T00:05:00.000Z'));
    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);
    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-05-07T00:11:00.000Z'));
    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);
    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh bypasses a fresh ttl window for one repo only', async () => {
    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);
    await (useSessionsStore.getState() as any).forceRefresh(repoA.path);

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);
    expect(apiMocks.enrichBranches).toHaveBeenLastCalledWith([
      { repoPath: repoA.path, branchName: 'feature-a' },
    ]);
  });

  it('ensureFreshAll calls stale visible repos without fanning out through one global enrichment request', async () => {
    await (useSessionsStore.getState() as any).forceRefresh(repoA.path);
    vi.setSystemTime(new Date('2026-05-07T00:05:00.000Z'));

    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);
    expect(apiMocks.enrichBranches).toHaveBeenLastCalledWith([
      { repoPath: repoB.path, branchName: 'feature-b' },
    ]);
  });

  it('ensureFreshAll batches every stale repo into one request and demuxes by key', async () => {
    apiMocks.enrichBranches.mockResolvedValueOnce({
      results: {
        [`${repoA.path}::feature-a`]: { pr: { number: 1 }, stale: false },
        [`${repoB.path}::feature-b`]: { pr: null, stale: true },
      },
    });

    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(1);
    expect(apiMocks.enrichBranches).toHaveBeenCalledWith([
      { repoPath: repoA.path, branchName: 'feature-a' },
      { repoPath: repoB.path, branchName: 'feature-b' },
    ]);

    const state = useSessionsStore.getState() as any;
    expect(state.getEnrichment(repoA.path, 'feature-a')).toEqual({
      pr: { number: 1 },
      stale: false,
    });
    expect(state.getEnrichment(repoB.path, 'feature-b')).toEqual({
      pr: null,
      stale: true,
    });
    expect(state.repoEnrichmentMeta[repoA.path]).toEqual({
      lastEnrichedAt: Date.now(),
      source: 'manual',
    });
    expect(state.repoEnrichmentMeta[repoB.path]).toEqual({
      lastEnrichedAt: Date.now(),
      source: 'manual',
    });
  });

  it('a batched pass only prunes the results of the repos it enriched', async () => {
    useSessionsStore.setState({
      enrichmentResults: {
        [`${repoA.path}::gone`]: { pr: null, stale: true },
        ['/repos/other::keep']: { pr: null, stale: true },
      },
    });
    apiMocks.enrichBranches.mockResolvedValueOnce({
      results: { [`${repoA.path}::feature-a`]: { pr: null, stale: false } },
    });

    await (useSessionsStore.getState() as any).forceRefresh(repoA.path);

    expect(useSessionsStore.getState().enrichmentResults).toEqual({
      ['/repos/other::keep']: { pr: null, stale: true },
      [`${repoA.path}::feature-a`]: { pr: null, stale: false },
    });
  });

  it('a freshness-gated pass joins an in-flight batch instead of duplicating it', async () => {
    let release: (value: {
      results: Record<string, unknown>;
    }) => void = () => {};
    apiMocks.enrichBranches.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    // Mount: force a cold batch, then the nav effect re-arms before it lands.
    const mount = (useSessionsStore.getState() as any).ensureFreshAll(0);
    const nav = (useSessionsStore.getState() as any).ensureFreshAll(600_000);

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(1);

    release({ results: {} });
    await Promise.all([mount, nav]);

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(1);

    // Once the batch settles the map is clear again: a later stale pass runs.
    vi.setSystemTime(new Date('2026-05-07T00:11:00.000Z'));
    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);
    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);
  });

  it('a batch that fails leaves freshness metadata unset so the next pass retries', async () => {
    // `api.enrichBranches` rejects on a non-2xx response or a timeout, so an
    // HTTP error is never mistaken for "these repos have no pull requests".
    apiMocks.enrichBranches.mockRejectedValueOnce(new Error('boom'));

    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);

    expect(useSessionsStore.getState().repoEnrichmentMeta).toEqual({});

    apiMocks.enrichBranches.mockResolvedValueOnce({ results: {} });
    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);
    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);
  });

  it('stamps a branchless repo inside a mixed batch without sending its key', async () => {
    useSessionsStore.setState({
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
      ],
    });

    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(1);
    expect(apiMocks.enrichBranches).toHaveBeenCalledWith([
      { repoPath: repoA.path, branchName: 'feature-a' },
    ]);
    expect(useSessionsStore.getState().repoEnrichmentMeta[repoB.path]).toEqual({
      lastEnrichedAt: Date.now(),
      source: 'manual',
    });
  });

  it('prunes stale keys for every repo in a batch and leaves other repos alone', async () => {
    useSessionsStore.setState({
      enrichmentResults: {
        [`${repoA.path}::gone`]: { pr: null, stale: true },
        [`${repoB.path}::gone`]: { pr: null, stale: true },
        ['/repos/other::keep']: { pr: null, stale: true },
      },
    });
    apiMocks.enrichBranches.mockResolvedValueOnce({
      results: {
        [`${repoA.path}::feature-a`]: { pr: null, stale: false },
        [`${repoB.path}::feature-b`]: { pr: null, stale: false },
      },
    });

    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);

    expect(useSessionsStore.getState().enrichmentResults).toEqual({
      ['/repos/other::keep']: { pr: null, stale: true },
      [`${repoA.path}::feature-a`]: { pr: null, stale: false },
      [`${repoB.path}::feature-b`]: { pr: null, stale: false },
    });
  });

  it('a ttl-bypassing pass still issues its own request while a batch is pending', async () => {
    let release: (value: {
      results: Record<string, unknown>;
    }) => void = () => {};
    apiMocks.enrichBranches.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const pending = (useSessionsStore.getState() as any).ensureFreshAll(0);
    await (useSessionsStore.getState() as any).ensureFreshAll(0);

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);

    release({ results: {} });
    await pending;
  });

  it('a webhook refresh that lands mid-batch is not overwritten by the older batch', async () => {
    let releaseBatch: (value: {
      results: Record<string, unknown>;
    }) => void = () => {};
    apiMocks.enrichBranches.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseBatch = resolve;
      })
    );

    const batch = (useSessionsStore.getState() as any).ensureFreshAll(0);

    // The webhook starts and finishes while the batch is still in flight.
    apiMocks.enrichBranches.mockResolvedValueOnce({
      results: {
        [`${repoA.path}::feature-a`]: { pr: { number: 9 }, stale: false },
      },
    });
    await (useSessionsStore.getState() as any).forceRefresh(
      repoA.path,
      'webhook'
    );

    releaseBatch({
      results: {
        [`${repoA.path}::feature-a`]: { pr: null, stale: false },
        [`${repoB.path}::feature-b`]: { pr: null, stale: true },
      },
    });
    await batch;

    const state = useSessionsStore.getState() as any;
    expect(state.getEnrichment(repoA.path, 'feature-a')).toEqual({
      pr: { number: 9 },
      stale: false,
    });
    expect(state.repoEnrichmentMeta[repoA.path].source).toBe('webhook');
    // The batch still owns every repo the webhook did not claim.
    expect(state.getEnrichment(repoB.path, 'feature-b')).toEqual({
      pr: null,
      stale: true,
    });
  });

  it('forceRefreshRepos sends one request for a whole webhook burst and demuxes by key', async () => {
    apiMocks.enrichBranches.mockResolvedValueOnce({
      results: {
        [`${repoA.path}::feature-a`]: { pr: { number: 4 }, stale: false },
        [`${repoB.path}::feature-b`]: { pr: { number: 5 }, stale: true },
      },
    });

    await (useSessionsStore.getState() as any).forceRefreshRepos(
      [repoA.path, repoB.path],
      'webhook'
    );

    // #1457: two repos in the burst, one POST /gh/enrich-branches.
    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(1);
    expect(apiMocks.enrichBranches).toHaveBeenCalledWith([
      { repoPath: repoA.path, branchName: 'feature-a' },
      { repoPath: repoB.path, branchName: 'feature-b' },
    ]);

    const state = useSessionsStore.getState() as any;
    expect(state.getEnrichment(repoA.path, 'feature-a')).toEqual({
      pr: { number: 4 },
      stale: false,
    });
    expect(state.getEnrichment(repoB.path, 'feature-b')).toEqual({
      pr: { number: 5 },
      stale: true,
    });
    expect(state.repoEnrichmentMeta[repoA.path]).toEqual({
      lastEnrichedAt: Date.now(),
      source: 'webhook',
    });
    expect(state.repoEnrichmentMeta[repoB.path]).toEqual({
      lastEnrichedAt: Date.now(),
      source: 'webhook',
    });
  });

  it('forceRefreshRepos ignores the ttl for repos that were just enriched', async () => {
    await (useSessionsStore.getState() as any).ensureFreshAll(600_000);
    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(1);

    await (useSessionsStore.getState() as any).forceRefreshRepos(
      [repoA.path, repoB.path],
      'webhook'
    );

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);
    expect(
      (useSessionsStore.getState() as any).repoEnrichmentMeta[repoA.path].source
    ).toBe('webhook');
  });

  it('forceRefreshRepos never joins a batch that was already in flight', async () => {
    let release: (value: {
      results: Record<string, unknown>;
    }) => void = () => {};
    apiMocks.enrichBranches.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const pending = (useSessionsStore.getState() as any).ensureFreshAll(
      600_000
    );
    // The webhook event arrived after that request left, so its answer cannot
    // be the one already in flight.
    await (useSessionsStore.getState() as any).forceRefreshRepos(
      [repoA.path, repoB.path],
      'webhook'
    );

    expect(apiMocks.enrichBranches).toHaveBeenCalledTimes(2);

    release({ results: {} });
    await pending;
  });

  it('a manual refresh that lands mid webhook batch keeps its own result', async () => {
    let releaseBurst: (value: {
      results: Record<string, unknown>;
    }) => void = () => {};
    apiMocks.enrichBranches.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseBurst = resolve;
      })
    );

    const burst = (useSessionsStore.getState() as any).forceRefreshRepos(
      [repoA.path, repoB.path],
      'webhook'
    );

    // A PrTopBar refresh for one repo starts and finishes inside the burst's
    // window; the burst must not roll it back when it lands.
    apiMocks.enrichBranches.mockResolvedValueOnce({
      results: {
        [`${repoA.path}::feature-a`]: { pr: { number: 12 }, stale: false },
      },
    });
    await (useSessionsStore.getState() as any).forceRefresh(
      repoA.path,
      'manual'
    );

    releaseBurst({
      results: {
        [`${repoA.path}::feature-a`]: { pr: null, stale: true },
        [`${repoB.path}::feature-b`]: { pr: { number: 13 }, stale: false },
      },
    });
    await burst;

    const state = useSessionsStore.getState() as any;
    expect(state.getEnrichment(repoA.path, 'feature-a')).toEqual({
      pr: { number: 12 },
      stale: false,
    });
    expect(state.repoEnrichmentMeta[repoA.path].source).toBe('manual');
    // Repos the manual pass did not claim still take the burst's result.
    expect(state.getEnrichment(repoB.path, 'feature-b')).toEqual({
      pr: { number: 13 },
      stale: false,
    });
    expect(state.repoEnrichmentMeta[repoB.path].source).toBe('webhook');
  });

  it('records webhook metadata even when the affected repo has no local branches to enrich', async () => {
    useSessionsStore.setState({ worktrees: [] });

    await (useSessionsStore.getState() as any).forceRefresh(
      repoA.path,
      'webhook'
    );

    expect(apiMocks.enrichBranches).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().repoEnrichmentMeta[repoA.path]).toEqual({
      lastEnrichedAt: Date.now(),
      source: 'webhook',
    });
  });
});
