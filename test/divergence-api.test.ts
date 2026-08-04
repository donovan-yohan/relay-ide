import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDivergence } from '../frontend/src/lib/api.js';

function mockFetch(response: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    text: async () => JSON.stringify(response),
    json: async () => response,
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function divergenceSummary(overrides: Record<string, unknown> = {}) {
  return {
    repoPath: '/repo with spaces',
    currentBranch: 'feature/a',
    headSha: 'abc123',
    selectedBase: { ref: 'origin/nightly', sha: 'def456' },
    baseCandidates: [],
    aheadCount: 2,
    behindCount: 1,
    lineDelta: { additions: 12, deletions: 3, fileCount: 4 },
    dirty: {
      stagedCount: 1,
      unstagedCount: 2,
      untrackedCount: 1,
      conflictedCount: 0,
      files: [],
      truncated: false,
    },
    commits: { ahead: [], behind: [] },
    state: 'ok',
    warnings: [],
    generatedAt: '2026-05-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('fetchDivergence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests the divergence endpoint with path and selected base', async () => {
    const fetchMock = mockFetch(divergenceSummary());

    const data = await fetchDivergence('/repo with spaces', 'origin/nightly');

    expect(data.aheadCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/workspaces/divergence?');
    expect(url).toContain('path=%2Frepo+with+spaces');
    expect(url).toContain('base=origin%2Fnightly');
  });

  it('preserves backend divergence summaries returned with HTTP errors', async () => {
    mockFetch(
      divergenceSummary({
        repoPath: '/repo',
        state: 'invalid_base',
        error: 'base ref is not valid',
        selectedBase: null,
      }),
      false,
      400
    );

    const data = await fetchDivergence('/repo', 'not a ref');

    expect(data).toMatchObject({
      repoPath: '/repo',
      state: 'invalid_base',
      error: 'base ref is not valid',
    });
  });

  it('returns fallback error data for non-summary non-ok responses', async () => {
    mockFetch({ error: 'not found' }, false, 404);

    const data = await fetchDivergence('/missing');

    expect(data).toMatchObject({
      repoPath: '/missing',
      currentBranch: null,
      selectedBase: null,
      aheadCount: 0,
      behindCount: 0,
      state: 'missing_base',
      error: 'HTTP 404',
    });
  });
});
