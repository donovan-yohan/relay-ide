import { test, describe, expect } from 'vitest';

import {
  buildPrSearchQuery,
  mapGraphQLResponse,
  fetchPrsGraphQL,
  type GraphQLResponse,
} from '../server/github-graphql.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRepoMap(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

/**
 * Builds a minimal GraphQL PullRequest node for testing.
 */
function makePrNode(overrides: {
  number?: number;
  title?: string;
  state?: string;
  isDraft?: boolean;
  url?: string;
  updatedAt?: string;
  author?: string;
  headRefName?: string;
  baseRefName?: string;
  nameWithOwner?: string;
  reviewDecision?: string | null;
  reviewerLogins?: string[];
  ciRollupState?: string | null;
  mergeable?: string | null;
  additions?: number;
  deletions?: number;
}): Record<string, unknown> {
  const {
    number = 1,
    title = 'Test PR',
    state = 'OPEN',
    isDraft = false,
    url = 'https://github.com/owner/repo/pull/1',
    updatedAt = '2026-03-01T00:00:00Z',
    author = 'testuser',
    headRefName = 'feat/branch',
    baseRefName = 'main',
    nameWithOwner = 'owner/repo',
    reviewDecision = null,
    reviewerLogins = [],
    ciRollupState = null,
    mergeable = null,
    additions = 5,
    deletions = 2,
  } = overrides;

  return {
    number,
    title,
    state,
    isDraft,
    url,
    updatedAt,
    createdAt: updatedAt,
    author: { login: author },
    headRefName,
    baseRefName,
    repository: { nameWithOwner },
    reviewDecision,
    reviewRequests: {
      nodes: reviewerLogins.map((login) => ({
        requestedReviewer: { login },
      })),
    },
    commits: {
      nodes:
        ciRollupState !== undefined
          ? [
              {
                commit: {
                  statusCheckRollup: ciRollupState
                    ? { state: ciRollupState }
                    : null,
                },
              },
            ]
          : [],
    },
    mergeable,
    additions,
    deletions,
  };
}

function makeGraphQLResponse(
  prNodes: Record<string, unknown>[],
  viewerLogin = 'testuser'
): GraphQLResponse {
  return {
    data: {
      search: { nodes: prNodes },
      viewer: { login: viewerLogin },
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildPrSearchQuery', () => {
  test('returns a non-empty query string', () => {
    const query = buildPrSearchQuery();
    expect(query).toBeTypeOf('string');
    expect(query.length).toBeGreaterThan(0);
  });

  test('contains key fields: number, title, isDraft, state', () => {
    const query = buildPrSearchQuery();
    expect(query).toContain('number');
    expect(query).toContain('title');
    expect(query).toContain('isDraft');
    expect(query).toContain('state');
  });

  test('contains CI status rollup field', () => {
    const query = buildPrSearchQuery();
    expect(query).toContain('statusCheckRollup');
  });

  test('contains reviewDecision and reviewRequests fields', () => {
    const query = buildPrSearchQuery();
    expect(query).toContain('reviewDecision');
    expect(query).toContain('reviewRequests');
  });

  test('contains repository nameWithOwner field', () => {
    const query = buildPrSearchQuery();
    expect(query).toContain('nameWithOwner');
  });

  test('contains viewer login field', () => {
    const query = buildPrSearchQuery();
    expect(query).toContain('viewer');
    expect(query).toContain('login');
  });
});

describe('mapGraphQLResponse', () => {
  test('maps PR node fields correctly (number, reviewDecision, ciStatus, isDraft, role, repoName, repoPath)', () => {
    const repoMap = makeRepoMap([['owner/repo', '/workspace/repo']]);
    const prNode = makePrNode({
      number: 42,
      title: 'My PR',
      state: 'OPEN',
      isDraft: false,
      nameWithOwner: 'owner/repo',
      reviewDecision: 'APPROVED',
      ciRollupState: 'SUCCESS',
    });

    const response = makeGraphQLResponse([prNode]);
    const { prs, username } = mapGraphQLResponse(response, repoMap);

    expect(username).toBe('testuser');
    expect(prs.length).toBe(1);

    const pr = prs[0]!;
    expect(pr.number).toBe(42);
    expect(pr.title).toBe('My PR');
    expect(pr.reviewDecision).toBe('APPROVED');
    expect(pr.ciStatus).toBe('SUCCESS');
    expect(pr.isDraft).toBe(false);
    expect(pr.role).toBe('author');
    expect(pr.repoName).toBe('repo');
    expect(pr.repoPath).toBe('/workspace/repo');
  });

  test('assigns reviewer role when user is in reviewRequests (not author)', () => {
    const repoMap = makeRepoMap([['owner/repo', '/workspace/repo']]);
    const prNode = makePrNode({
      number: 10,
      author: 'otheruser',
      nameWithOwner: 'owner/repo',
      reviewerLogins: ['testuser'],
    });

    const response = makeGraphQLResponse([prNode]);
    const { prs } = mapGraphQLResponse(response, repoMap);

    expect(prs.length).toBe(1);
    expect(prs[0]!.role).toBe('reviewer');
    expect(prs[0]!.author).toBe('otheruser');
  });

  test('skips PRs where user is neither author nor reviewer', () => {
    const repoMap = makeRepoMap([['owner/repo', '/workspace/repo']]);
    const prNode = makePrNode({
      number: 5,
      author: 'someoneelse',
      nameWithOwner: 'owner/repo',
      reviewerLogins: ['anotheruser'],
    });

    const response = makeGraphQLResponse([prNode]);
    const { prs } = mapGraphQLResponse(response, repoMap);

    expect(prs.length).toBe(0);
  });

  test('filters out repos not in workspace map', () => {
    const repoMap = makeRepoMap([['owner/repo', '/workspace/repo']]);
    const prNode = makePrNode({
      number: 99,
      nameWithOwner: 'owner/other-repo', // not in map
      author: 'testuser',
    });

    const response = makeGraphQLResponse([prNode]);
    const { prs } = mapGraphQLResponse(response, repoMap);

    expect(prs.length).toBe(0);
  });

  test('maps ciStatus correctly for all states', () => {
    const repoMap = makeRepoMap([['owner/repo', '/workspace/repo']]);

    const testCases: Array<
      [string | null, 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | null]
    > = [
      ['SUCCESS', 'SUCCESS'],
      ['FAILURE', 'FAILURE'],
      ['ERROR', 'ERROR'],
      ['PENDING', 'PENDING'],
      ['EXPECTED', 'PENDING'],
      [null, null],
    ];

    for (const [rollupState, expectedCiStatus] of testCases) {
      const prNode = makePrNode({
        number: 1,
        nameWithOwner: 'owner/repo',
        author: 'testuser',
        ciRollupState: rollupState,
      });
      const response = makeGraphQLResponse([prNode]);
      const { prs } = mapGraphQLResponse(response, repoMap);
      expect(prs[0]!.ciStatus).toBe(expectedCiStatus);
    }
  });

  test('maps isDraft=true correctly', () => {
    const repoMap = makeRepoMap([['owner/repo', '/workspace/repo']]);
    const prNode = makePrNode({
      number: 7,
      nameWithOwner: 'owner/repo',
      author: 'testuser',
      isDraft: true,
    });

    const response = makeGraphQLResponse([prNode]);
    const { prs } = mapGraphQLResponse(response, repoMap);

    expect(prs[0]!.isDraft).toBe(true);
  });

  test('handles multiple PRs across multiple repos', () => {
    const repoMap = makeRepoMap([
      ['owner/repo-a', '/workspace/repo-a'],
      ['owner/repo-b', '/workspace/repo-b'],
    ]);

    const nodes = [
      makePrNode({
        number: 1,
        nameWithOwner: 'owner/repo-a',
        author: 'testuser',
      }),
      makePrNode({
        number: 2,
        nameWithOwner: 'owner/repo-b',
        author: 'testuser',
      }),
      makePrNode({
        number: 3,
        nameWithOwner: 'owner/unrelated',
        author: 'testuser',
      }),
    ];

    const response = makeGraphQLResponse(nodes);
    const { prs } = mapGraphQLResponse(response, repoMap);

    expect(prs.length).toBe(2);
    const numbers = prs.map((p) => p.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2]);
  });

  test('repoMap lookup is case-insensitive', () => {
    // Repo map uses lowercase keys; nameWithOwner from GitHub may vary in case
    const repoMap = makeRepoMap([['owner/repo', '/workspace/repo']]);
    const prNode = makePrNode({
      number: 1,
      nameWithOwner: 'Owner/Repo', // mixed case from API
      author: 'testuser',
    });

    const response = makeGraphQLResponse([prNode]);
    const { prs } = mapGraphQLResponse(response, repoMap);

    expect(prs.length).toBe(1);
  });
});

describe('fetchPrsGraphQL', () => {
  test('calls GitHub GraphQL endpoint with Bearer token', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input as string;
      capturedInit = init;
      const responseBody: GraphQLResponse = {
        data: {
          search: { nodes: [] },
          viewer: { login: 'testuser' },
        },
      };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const repoMap = makeRepoMap([]);
    await fetchPrsGraphQL('my-token', repoMap, mockFetch);

    expect(capturedUrl).toBe('https://api.github.com/graphql');
    expect(capturedInit?.method).toBe('POST');
    expect(
      (capturedInit?.headers as Record<string, string>)?.['Authorization']
    ).toBe('Bearer my-token');
  });

  test('throws on 401 Unauthorized response', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response('Unauthorized', {
        status: 401,
        statusText: 'Unauthorized',
      });
    };

    const repoMap = makeRepoMap([]);

    await expect(() =>
      fetchPrsGraphQL('bad-token', repoMap, mockFetch)
    ).rejects.toThrow('401');
  });

  test('returns mapped prs and username on success', async () => {
    const prNode = makePrNode({
      number: 11,
      nameWithOwner: 'owner/repo',
      author: 'alice',
      ciRollupState: 'SUCCESS',
    });

    const mockFetch: typeof fetch = async () => {
      const responseBody: GraphQLResponse = {
        data: {
          search: { nodes: [prNode] },
          viewer: { login: 'alice' },
        },
      };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const repoMap = makeRepoMap([['owner/repo', '/workspace/repo']]);
    const { prs, username } = await fetchPrsGraphQL(
      'token',
      repoMap,
      mockFetch
    );

    expect(username).toBe('alice');
    expect(prs.length).toBe(1);
    expect(prs[0]!.number).toBe(11);
    expect(prs[0]!.ciStatus).toBe('SUCCESS');
  });

  test('throws when response has errors but no data (expired token / bad credentials)', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ errors: [{ message: 'Bad credentials' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const repoMap = makeRepoMap([]);

    await expect(() =>
      fetchPrsGraphQL('expired-token', repoMap, mockFetch)
    ).rejects.toThrow('Bad credentials');
  });
});
