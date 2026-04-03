import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

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
    assert.ok(
      typeof query === 'string' && query.length > 0,
      'query should be a non-empty string'
    );
  });

  test('contains key fields: number, title, isDraft, state', () => {
    const query = buildPrSearchQuery();
    assert.ok(query.includes('number'), 'query should include "number"');
    assert.ok(query.includes('title'), 'query should include "title"');
    assert.ok(query.includes('isDraft'), 'query should include "isDraft"');
    assert.ok(query.includes('state'), 'query should include "state"');
  });

  test('contains CI status rollup field', () => {
    const query = buildPrSearchQuery();
    assert.ok(
      query.includes('statusCheckRollup'),
      'query should include "statusCheckRollup"'
    );
  });

  test('contains reviewDecision and reviewRequests fields', () => {
    const query = buildPrSearchQuery();
    assert.ok(
      query.includes('reviewDecision'),
      'query should include "reviewDecision"'
    );
    assert.ok(
      query.includes('reviewRequests'),
      'query should include "reviewRequests"'
    );
  });

  test('contains repository nameWithOwner field', () => {
    const query = buildPrSearchQuery();
    assert.ok(
      query.includes('nameWithOwner'),
      'query should include "nameWithOwner"'
    );
  });

  test('contains viewer login field', () => {
    const query = buildPrSearchQuery();
    assert.ok(query.includes('viewer'), 'query should include "viewer"');
    assert.ok(query.includes('login'), 'query should include "login"');
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

    assert.equal(username, 'testuser');
    assert.equal(prs.length, 1);

    const pr = prs[0]!;
    assert.equal(pr.number, 42);
    assert.equal(pr.title, 'My PR');
    assert.equal(pr.reviewDecision, 'APPROVED');
    assert.equal(pr.ciStatus, 'SUCCESS');
    assert.equal(pr.isDraft, false);
    assert.equal(pr.role, 'author');
    assert.equal(pr.repoName, 'repo');
    assert.equal(pr.repoPath, '/workspace/repo');
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

    assert.equal(prs.length, 1);
    assert.equal(prs[0]!.role, 'reviewer');
    assert.equal(prs[0]!.author, 'otheruser');
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

    assert.equal(
      prs.length,
      0,
      'PR where user is neither author nor reviewer should be filtered out'
    );
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

    assert.equal(
      prs.length,
      0,
      'PR from repo not in workspace map should be filtered out'
    );
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
      assert.equal(
        prs[0]!.ciStatus,
        expectedCiStatus,
        `ciStatus should be ${expectedCiStatus} for rollup state ${rollupState}`
      );
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

    assert.equal(prs[0]!.isDraft, true);
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

    assert.equal(prs.length, 2);
    const numbers = prs.map((p) => p.number).sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 2]);
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

    assert.equal(prs.length, 1, 'Lookup should be case-insensitive');
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

    assert.equal(
      capturedUrl,
      'https://api.github.com/graphql',
      'Should call GitHub GraphQL endpoint'
    );
    assert.ok(capturedInit?.method === 'POST', 'Should use POST method');
    assert.ok(
      (capturedInit?.headers as Record<string, string>)?.['Authorization'] ===
        'Bearer my-token',
      'Should set Bearer token in Authorization header'
    );
  });

  test('throws on 401 Unauthorized response', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response('Unauthorized', {
        status: 401,
        statusText: 'Unauthorized',
      });
    };

    const repoMap = makeRepoMap([]);

    await assert.rejects(
      () => fetchPrsGraphQL('bad-token', repoMap, mockFetch),
      (err: Error) => {
        assert.ok(
          err.message.includes('401'),
          `Error should mention 401, got: ${err.message}`
        );
        return true;
      }
    );
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

    assert.equal(username, 'alice');
    assert.equal(prs.length, 1);
    assert.equal(prs[0]!.number, 11);
    assert.equal(prs[0]!.ciStatus, 'SUCCESS');
  });

  test('throws when response has errors but no data (expired token / bad credentials)', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ errors: [{ message: 'Bad credentials' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const repoMap = makeRepoMap([]);

    await assert.rejects(
      () => fetchPrsGraphQL('expired-token', repoMap, mockFetch),
      (err: Error) => {
        assert.ok(
          err.message.includes('Bad credentials'),
          `Error should include "Bad credentials", got: ${err.message}`
        );
        return true;
      }
    );
  });
});
