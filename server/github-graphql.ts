/**
 * GitHub GraphQL client for fetching pull requests involving the current user.
 *
 * Provides:
 *   buildPrSearchQuery()    — GraphQL query string
 *   mapGraphQLResponse()    — maps raw response to PullRequest[]
 *   fetchPrsGraphQL()       — fetches from GitHub GraphQL API
 */

import type { PullRequest } from './types.js';
import { createLogger } from './logger.js';

const logger = createLogger('github-graphql');

// ─── GraphQL query ────────────────────────────────────────────────────────────

/**
 * Returns the GraphQL query string for searching PRs involving the current user.
 */
export function buildPrSearchQuery(): string {
  return `
    query InvolvedPRs($query: String!) {
      search(query: $query, type: ISSUE, first: 100) {
        nodes {
          ... on PullRequest {
            number
            title
            state
            isDraft
            url
            updatedAt
            createdAt
            author {
              login
            }
            headRefName
            baseRefName
            repository {
              nameWithOwner
            }
            reviewDecision
            reviewRequests(first: 20) {
              nodes {
                requestedReviewer {
                  ... on User {
                    login
                  }
                }
              }
            }
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    state
                  }
                }
              }
            }
            mergeable
            additions
            deletions
          }
        }
      }
      viewer {
        login
      }
    }
  `.trim();
}

// ─── GraphQL response types ───────────────────────────────────────────────────

interface GraphQLUser {
  login: string;
}

interface GraphQLReviewRequest {
  requestedReviewer: GraphQLUser | null;
}

interface GraphQLCommit {
  commit: {
    statusCheckRollup: {
      state: string;
    } | null;
  };
}

interface GraphQLPullRequest {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  updatedAt: string;
  createdAt: string;
  author: GraphQLUser | null;
  headRefName: string;
  baseRefName: string;
  repository: {
    nameWithOwner: string;
  };
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  reviewRequests: {
    nodes: GraphQLReviewRequest[];
  };
  commits: {
    nodes: GraphQLCommit[];
  };
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  additions: number;
  deletions: number;
}

export interface GraphQLResponse {
  data: {
    search: {
      nodes: Array<GraphQLPullRequest | Record<string, unknown>>;
    };
    viewer: {
      login: string;
    };
  };
}

// ─── Response mapper ──────────────────────────────────────────────────────────

/**
 * Maps a raw GitHub GraphQL response to a list of PullRequest objects.
 *
 * @param response - The raw GraphQL response from GitHub
 * @param repoMap  - Map of "owner/repo" (lowercased) → local workspace path
 * @returns { prs, username } — filtered and mapped PR list plus authenticated username
 */
export function mapGraphQLResponse(
  response: GraphQLResponse,
  repoMap: Map<string, string>
): { prs: PullRequest[]; username: string } {
  const username = response.data.viewer.login;
  const nodes = response.data.search.nodes;

  const prs: PullRequest[] = [];

  for (const node of nodes) {
    // Type guard: only process PullRequest nodes (not Issue nodes)
    if (!('number' in node) || !('headRefName' in node)) continue;
    const pr = node as GraphQLPullRequest;

    const nameWithOwner = pr.repository.nameWithOwner.toLowerCase();
    const wsPath = repoMap.get(nameWithOwner);
    if (!wsPath) continue;

    const author = pr.author?.login ?? '';

    const isAuthor = author === username;
    const isReviewer =
      !isAuthor &&
      pr.reviewRequests.nodes.some(
        (rr) => rr.requestedReviewer?.login === username
      );

    if (!isAuthor && !isReviewer) continue;

    const role: 'author' | 'reviewer' = isAuthor ? 'author' : 'reviewer';

    // Extract CI status from last commit's statusCheckRollup
    const lastCommit = pr.commits.nodes[0];
    const rollupState = lastCommit?.commit?.statusCheckRollup?.state ?? null;
    let ciStatus: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | null = null;
    if (rollupState === 'SUCCESS') ciStatus = 'SUCCESS';
    else if (rollupState === 'FAILURE') ciStatus = 'FAILURE';
    else if (rollupState === 'ERROR') ciStatus = 'ERROR';
    else if (rollupState === 'PENDING' || rollupState === 'EXPECTED')
      ciStatus = 'PENDING';

    // Derive repoName from the nameWithOwner (the part after the slash)
    const repoName =
      pr.repository.nameWithOwner.split('/')[1] ?? pr.repository.nameWithOwner;

    // Map state
    let state: 'OPEN' | 'CLOSED' | 'MERGED';
    if (pr.state === 'OPEN') state = 'OPEN';
    else if (pr.state === 'MERGED') state = 'MERGED';
    else state = 'CLOSED';

    prs.push({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      state,
      author,
      role,
      updatedAt: pr.updatedAt,
      additions: pr.additions,
      deletions: pr.deletions,
      reviewDecision: pr.reviewDecision,
      mergeable: pr.mergeable,
      ciStatus,
      isDraft: pr.isDraft,
      repoName,
      repoPath: wsPath,
    });
  }

  return { prs, username };
}

// ─── Fetch function ───────────────────────────────────────────────────────────

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

/**
 * Fetches pull requests from the GitHub GraphQL API.
 *
 * @param token    - GitHub personal access token (Bearer)
 * @param repoMap  - Map of "owner/repo" (lowercased) → local workspace path
 * @param fetchFn  - Optional fetch implementation (defaults to global fetch); injectable for testing
 * @returns { prs, username }
 * @throws Error on non-2xx HTTP responses
 */
export async function fetchPrsGraphQL(
  token: string,
  repoMap: Map<string, string>,
  fetchFn: typeof fetch = fetch
): Promise<{ prs: PullRequest[]; username: string }> {
  const query = buildPrSearchQuery();
  const variables = { query: 'is:pr is:open involves:@me' };

  const response = await fetchFn(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'relay-ide',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub GraphQL request failed: ${response.status} ${response.statusText}`
    );
  }

  const json = (await response.json()) as {
    errors?: Array<{ message: string }>;
    data?: GraphQLResponse['data'];
  };

  // GitHub GraphQL returns HTTP 200 even for errors (expired tokens, insufficient scopes)
  if (json.errors && !json.data) {
    throw new Error(
      `GitHub GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`
    );
  }

  if (json.errors) {
    // Partial errors: data is present but some fields failed — log and continue
    logger.warn(
      '[github-graphql] GraphQL returned partial errors:',
      json.errors.map((e: any) => e.message).join('; ')
    );
  }

  if (!json.data) {
    throw new Error('GitHub GraphQL returned no data');
  }

  return mapGraphQLResponse({ data: json.data }, repoMap);
}
