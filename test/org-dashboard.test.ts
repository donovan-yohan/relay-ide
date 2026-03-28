import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';

import { createOrgDashboardRouter, type OrgDashboardDeps } from '../server/org-dashboard.js';
import { saveConfig, DEFAULTS } from '../server/config.js';
import type { PullRequestsResponse } from '../server/types.js';

// Loose mock type — cast to OrgDashboardDeps['execAsync'] at call sites
type MockExec = (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>;

let tmpDir: string;
let configPath: string;
let server: Server;
let baseUrl: string;

// A workspace path we can point git remote mocks at
const WORKSPACE_PATH_A = '/fake/workspace/repo-a';
const WORKSPACE_PATH_B = '/fake/workspace/repo-b';

/**
 * Creates a mock execAsync that routes calls based on the command.
 * - `git remote get-url origin` → returns configured remote URL or throws
 * - `gh api user ...` → returns configured user login or throws
 * - `gh api search/issues ...` → returns configured search response or throws
 */
function makeMockExec(opts: {
  remotes?: Record<string, string>;
  userLogin?: string;
  userError?: Error;
  searchItems?: object[];
  searchError?: Error;
}): MockExec {
  return async (cmd: unknown, args: unknown, options: unknown) => {
    const command = cmd as string;
    const argv = args as string[];

    if (command === 'git' && argv[0] === 'remote') {
      const cwd = (options as { cwd?: string }).cwd ?? '';
      const remote = opts.remotes?.[cwd];
      if (remote) return { stdout: remote + '\n', stderr: '' };
      throw Object.assign(new Error('not a git repository'), { code: 128 });
    }

    if (command === 'gh' && argv[0] === 'api' && argv[1] === 'user') {
      if (opts.userError) throw opts.userError;
      const login = opts.userLogin ?? 'testuser';
      return { stdout: login + '\n', stderr: '' };
    }

    if (command === 'gh' && argv[0] === 'api' && argv[1]?.startsWith('search/issues')) {
      if (opts.searchError) throw opts.searchError;
      const items = opts.searchItems ?? [];
      return { stdout: JSON.stringify({ items }), stderr: '' };
    }

    throw new Error(`Unexpected exec call: ${command} ${argv.join(' ')}`);
  };
}

/**
 * Builds a minimal GH search item for a given owner/repo and user.
 */
function makeSearchItem(overrides: {
  ownerRepo: string;
  number?: number;
  title?: string;
  author?: string;
  role?: 'author' | 'reviewer';
  currentUser?: string;
}): object {
  const {
    ownerRepo,
    number = 1,
    title = 'Test PR',
    author = 'testuser',
    role = 'author',
    currentUser = 'testuser',
  } = overrides;

  return {
    number,
    title,
    html_url: `https://github.com/${ownerRepo}/pull/${number}`,
    state: 'open',
    user: { login: author },
    pull_request: { head: { ref: 'feat/branch' }, base: { ref: 'main' } },
    updated_at: '2026-03-21T00:00:00Z',
    requested_reviewers: role === 'reviewer' ? [{ login: currentUser }] : [],
    repository_url: `https://api.github.com/repos/${ownerRepo}`,
  };
}

function startServer(execAsyncFn: MockExec): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    // Cast through unknown: the mock satisfies the runtime contract but the
    // overloaded promisify types don't align across module instances.
    const deps = { configPath, execAsync: execAsyncFn } as unknown as OrgDashboardDeps;
    app.use('/org-dashboard', createOrgDashboardRouter(deps));
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}

async function getPrs(): Promise<PullRequestsResponse> {
  const res = await fetch(`${baseUrl}/org-dashboard/prs`);
  return res.json() as Promise<PullRequestsResponse>;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-dashboard-test-'));
  configPath = path.join(tmpDir, 'config.json');
});

after(async () => {
  await stopServer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Each test gets a fresh server with its own router (and thus its own cache).
// We stop/start the server around each test to reset the in-router cache state.

test('returns prs filtered to workspace repos', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A, WORKSPACE_PATH_B],
  });

  const exec = makeMockExec({
    remotes: {
      [WORKSPACE_PATH_A]: 'git@github.com:myorg/repo-a.git',
      [WORKSPACE_PATH_B]: 'git@github.com:myorg/repo-b.git',
    },
    userLogin: 'testuser',
    searchItems: [
      // Matches WORKSPACE_PATH_A
      makeSearchItem({ ownerRepo: 'myorg/repo-a', number: 10, author: 'testuser' }),
      // Matches WORKSPACE_PATH_B
      makeSearchItem({ ownerRepo: 'myorg/repo-b', number: 20, author: 'testuser' }),
      // Not in any workspace — should be excluded
      makeSearchItem({ ownerRepo: 'myorg/other-repo', number: 30, author: 'testuser' }),
    ],
  });

  await startServer(exec);

  const data = await getPrs();
  assert.equal(data.error, undefined, `Unexpected error: ${data.error}`);
  assert.equal(data.prs.length, 2, 'Should return only the 2 workspace-matched PRs');
  const numbers = data.prs.map((p) => p.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [10, 20]);
  // Verify repoPath is attached
  const pr10 = data.prs.find((p) => p.number === 10);
  assert.equal(pr10?.repoPath, WORKSPACE_PATH_A);
});

test('returns gh_not_in_path error when gh not found', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
  });

  const notFoundError = Object.assign(
    new Error('spawn gh ENOENT'),
    { code: 'ENOENT' },
  );

  const exec = makeMockExec({
    remotes: { [WORKSPACE_PATH_A]: 'git@github.com:myorg/repo-a.git' },
    userError: notFoundError,
  });

  await startServer(exec);

  const data = await getPrs();
  assert.equal(data.error, 'gh_not_in_path');
  assert.equal(data.prs.length, 0);
});

test('returns gh_not_authenticated error', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
  });

  const authError = new Error('You are not logged into any GitHub hosts. Run gh auth login to authenticate.');

  const exec = makeMockExec({
    remotes: { [WORKSPACE_PATH_A]: 'git@github.com:myorg/repo-a.git' },
    userError: authError,
  });

  await startServer(exec);

  const data = await getPrs();
  assert.equal(data.error, 'gh_not_authenticated');
  assert.equal(data.prs.length, 0);
});

test('returns empty prs with no_workspaces error when workspaces is empty', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [],
  });

  // execAsync should never be called here — pass a mock that always throws to
  // verify the early-return path triggers before any exec
  const exec = makeMockExec({});

  await startServer(exec);

  const data = await getPrs();
  assert.equal(data.error, 'no_workspaces');
  assert.equal(data.prs.length, 0);
});

test('detects reviewer role when current user is in requested_reviewers but not the author', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
  });

  // PR authored by someone else; testuser is a requested reviewer
  const reviewerItem = makeSearchItem({
    ownerRepo: 'myorg/repo-a',
    number: 42,
    title: 'Review me',
    author: 'otheruser',
    role: 'reviewer',
    currentUser: 'testuser',
  });

  const exec = makeMockExec({
    remotes: { [WORKSPACE_PATH_A]: 'git@github.com:myorg/repo-a.git' },
    userLogin: 'testuser',
    searchItems: [reviewerItem],
  });

  await startServer(exec);

  const data = await getPrs();
  assert.equal(data.error, undefined, `Unexpected error: ${data.error}`);
  assert.equal(data.prs.length, 1, 'Should return the reviewer PR');
  const pr = data.prs[0];
  assert.equal(pr?.number, 42);
  assert.equal(pr?.role, 'reviewer', 'Role should be reviewer');
  assert.equal(pr?.author, 'otheruser', 'Author should be otheruser, not the current user');
});

test('caches results within TTL — exec called only once for two requests', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
  });

  let searchCallCount = 0;

  // Wrap makeMockExec with a counter on the search path
  const baseExec = makeMockExec({
    remotes: { [WORKSPACE_PATH_A]: 'git@github.com:myorg/repo-a.git' },
    userLogin: 'testuser',
    searchItems: [makeSearchItem({ ownerRepo: 'myorg/repo-a', number: 1, author: 'testuser' })],
  });

  const countingExec: MockExec = async (...args: unknown[]) => {
    const [cmd, argv] = args as [string, string[], ...unknown[]];
    if (cmd === 'gh' && typeof argv[1] === 'string' && argv[1].startsWith('search/issues')) {
      searchCallCount++;
    }
    return baseExec(...args);
  };

  await startServer(countingExec);

  // First request — populates cache
  const first = await getPrs();
  assert.equal(first.error, undefined);
  assert.equal(first.prs.length, 1);

  // Second request — should be served from cache, no additional exec call
  const second = await getPrs();
  assert.equal(second.error, undefined);
  assert.equal(second.prs.length, 1);

  assert.equal(searchCallCount, 1, 'gh search should have been called exactly once (cache hit on second request)');
});

test('uses GraphQL path when github accessToken is in config', async () => {
  // Use an isolated tmp dir, config, and server so this test does not
  // interfere with the shared server used by the other tests.
  const gqlTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-dashboard-gql-test-'));
  const gqlConfigPath = path.join(gqlTmpDir, 'config.json');

  saveConfig(gqlConfigPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
    github: { accessToken: 'ghp_test123', username: 'graphqluser' },
  });

  const graphqlPr: import('../server/types.js').PullRequest = {
    number: 99,
    title: 'GraphQL PR',
    url: 'https://github.com/myorg/repo-a/pull/99',
    headRefName: 'feat/graphql',
    baseRefName: 'main',
    state: 'OPEN',
    author: 'graphqluser',
    role: 'author',
    updatedAt: '2026-03-22T00:00:00Z',
    additions: 5,
    deletions: 2,
    reviewDecision: null,
    mergeable: null,
    isDraft: false,
    ciStatus: null,
    repoName: 'repo-a',
    repoPath: WORKSPACE_PATH_A,
  };

  let graphqlCallCount = 0;
  let capturedToken: string | undefined;
  let capturedRepoMap: Map<string, string> | undefined;

  const mockFetchGraphQL = async (token: string, repoMap: Map<string, string>) => {
    graphqlCallCount++;
    capturedToken = token;
    capturedRepoMap = repoMap;
    return { prs: [graphqlPr], username: 'graphqluser' };
  };

  // exec mock that handles git remote but should NOT be called for gh user/search
  const exec = makeMockExec({
    remotes: { [WORKSPACE_PATH_A]: 'git@github.com:myorg/repo-a.git' },
  });

  let gqlServer: Server | undefined;
  let gqlBaseUrl: string;

  await new Promise<void>((resolve) => {
    const app = express();
    app.use(express.json());
    const deps = {
      configPath: gqlConfigPath,
      execAsync: exec,
      fetchGraphQL: mockFetchGraphQL,
    } as unknown as OrgDashboardDeps;
    app.use('/org-dashboard', createOrgDashboardRouter(deps));
    gqlServer = app.listen(0, '127.0.0.1', () => {
      const addr = gqlServer!.address();
      if (typeof addr === 'object' && addr) {
        gqlBaseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });

  try {
    const res = await fetch(`${gqlBaseUrl!}/org-dashboard/prs`);
    const data = await res.json() as PullRequestsResponse;

    assert.equal(data.error, undefined, `Unexpected error: ${data.error}`);
    assert.equal(data.prs.length, 1, 'Should return the GraphQL PR');
    assert.equal(data.prs[0]?.number, 99, 'PR number should match GraphQL data');
    assert.equal(data.prs[0]?.title, 'GraphQL PR');

    assert.equal(graphqlCallCount, 1, 'fetchGraphQL should have been called exactly once');
    assert.equal(capturedToken, 'ghp_test123', 'fetchGraphQL should receive the configured access token');
    assert.ok(capturedRepoMap instanceof Map, 'fetchGraphQL should receive the repoMap');
  } finally {
    await new Promise<void>((resolve) => {
      if (gqlServer) gqlServer.close(() => resolve());
      else resolve();
    });
    fs.rmSync(gqlTmpDir, { recursive: true, force: true });
  }
});
