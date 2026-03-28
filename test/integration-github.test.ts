import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';

import { createIntegrationGitHubRouter, type IntegrationGitHubDeps } from '../server/integration-github.js';
import { saveConfig, DEFAULTS } from '../server/config.js';
import type { GitHubIssuesResponse } from '../server/types.js';

// Loose mock type — cast to IntegrationGitHubDeps['execAsync'] at call sites
type MockExec = (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>;

let tmpDir: string;
let configPath: string;
let server: Server;
let baseUrl: string;

const WORKSPACE_PATH_A = '/fake/workspace/repo-a';
const WORKSPACE_PATH_B = '/fake/workspace/repo-b';

/**
 * Builds a minimal GhIssueItem for use in mock stdout payloads.
 */
function makeIssueItem(overrides: {
  number?: number;
  title?: string;
  url?: string;
  updatedAt?: string;
  createdAt?: string;
}): object {
  const {
    number = 1,
    title = 'Test Issue',
    url = `https://github.com/fake/repo/issues/${overrides.number ?? 1}`,
    updatedAt = '2026-03-21T00:00:00Z',
    createdAt = '2026-03-20T00:00:00Z',
  } = overrides;

  return {
    number,
    title,
    url,
    state: 'OPEN',
    labels: [],
    assignees: [],
    createdAt,
    updatedAt,
  };
}

/**
 * Creates a mock execAsync that routes calls based on the command and cwd.
 * - `gh issue list` in a given cwd → returns configured issues list or throws
 */
function makeMockExec(opts: {
  issuesByPath?: Record<string, object[]>;
  errorByPath?: Record<string, Error>;
  globalError?: Error;
}): MockExec {
  return async (cmd: unknown, args: unknown, options: unknown) => {
    const command = cmd as string;
    const argv = args as string[];
    const cwd = (options as { cwd?: string }).cwd ?? '';

    if (command === 'gh' && argv[0] === 'issue' && argv[1] === 'list') {
      if (opts.globalError) throw opts.globalError;
      if (opts.errorByPath?.[cwd]) throw opts.errorByPath[cwd]!;
      const items = opts.issuesByPath?.[cwd] ?? [];
      return { stdout: JSON.stringify(items), stderr: '' };
    }

    throw new Error(`Unexpected exec call: ${command} ${argv.join(' ')}`);
  };
}

function startServer(execAsyncFn: MockExec): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    const deps = { configPath, execAsync: execAsyncFn } as unknown as IntegrationGitHubDeps;
    app.use('/integration-github', createIntegrationGitHubRouter(deps));
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

async function getIssues(): Promise<GitHubIssuesResponse> {
  const res = await fetch(`${baseUrl}/integration-github/issues`);
  return res.json() as Promise<GitHubIssuesResponse>;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-github-test-'));
  configPath = path.join(tmpDir, 'config.json');
});

after(async () => {
  await stopServer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('returns issues from all workspace repos merged and sorted', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A, WORKSPACE_PATH_B],
  });

  const exec = makeMockExec({
    issuesByPath: {
      [WORKSPACE_PATH_A]: [
        makeIssueItem({ number: 10, title: 'Issue A', updatedAt: '2026-03-21T10:00:00Z' }),
        makeIssueItem({ number: 11, title: 'Issue A2', updatedAt: '2026-03-19T10:00:00Z' }),
      ],
      [WORKSPACE_PATH_B]: [
        makeIssueItem({ number: 20, title: 'Issue B', updatedAt: '2026-03-20T10:00:00Z' }),
      ],
    },
  });

  await startServer(exec);

  const data = await getIssues();
  assert.equal(data.error, undefined, `Unexpected error: ${data.error}`);
  assert.equal(data.issues.length, 3, 'Should return all 3 issues from both repos');

  // Verify sorted descending by updatedAt
  const updatedAts = data.issues.map((i) => i.updatedAt);
  assert.deepEqual(updatedAts, [
    '2026-03-21T10:00:00Z',
    '2026-03-20T10:00:00Z',
    '2026-03-19T10:00:00Z',
  ]);

  // Verify repoPath and repoName are attached
  const issue10 = data.issues.find((i) => i.number === 10);
  assert.equal(issue10?.repoPath, WORKSPACE_PATH_A);
  assert.equal(issue10?.repoName, 'repo-a');

  const issue20 = data.issues.find((i) => i.number === 20);
  assert.equal(issue20?.repoPath, WORKSPACE_PATH_B);
  assert.equal(issue20?.repoName, 'repo-b');
});

test('returns no_workspaces error when empty', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [],
  });

  // execAsync should never be called — pass a mock that always throws to verify early-return
  const exec = makeMockExec({});

  await startServer(exec);

  const data = await getIssues();
  assert.equal(data.error, 'no_workspaces');
  assert.equal(data.issues.length, 0);
});

test('returns gh_not_in_path when gh not found', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
  });

  const err = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';

  const exec = makeMockExec({ globalError: err });

  await startServer(exec);

  const data = await getIssues();
  assert.equal(data.error, 'gh_not_in_path');
  assert.equal(data.issues.length, 0);
});

test('caches per-repo within TTL — gh called once per repo for two requests', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A, WORKSPACE_PATH_B],
  });

  let ghCallCount = 0;

  const baseExec = makeMockExec({
    issuesByPath: {
      [WORKSPACE_PATH_A]: [makeIssueItem({ number: 1 })],
      [WORKSPACE_PATH_B]: [makeIssueItem({ number: 2 })],
    },
  });

  const countingExec: MockExec = async (...args: unknown[]) => {
    const [cmd, argv] = args as [string, string[], ...unknown[]];
    if (cmd === 'gh' && argv[0] === 'issue') {
      ghCallCount++;
    }
    return baseExec(...args);
  };

  await startServer(countingExec);

  // First request — populates cache for both repos
  const first = await getIssues();
  assert.equal(first.error, undefined);
  assert.equal(first.issues.length, 2);
  assert.equal(ghCallCount, 2, 'gh should be called once per repo on first request');

  // Second request — should be served from per-repo cache, no additional calls
  const second = await getIssues();
  assert.equal(second.error, undefined);
  assert.equal(second.issues.length, 2);
  assert.equal(ghCallCount, 2, 'gh should not be called again within TTL (cache hit)');
});

test('partial failure: repo that throws still returns others', async () => {
  await stopServer();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A, WORKSPACE_PATH_B],
  });

  // repo-b will throw a generic error (not ENOENT, so non-fatal)
  const exec = makeMockExec({
    issuesByPath: {
      [WORKSPACE_PATH_A]: [makeIssueItem({ number: 99, title: 'Surviving issue' })],
    },
    errorByPath: {
      [WORKSPACE_PATH_B]: new Error('git command failed'),
    },
  });

  await startServer(exec);

  const data = await getIssues();
  // No top-level error — partial failures are silent
  assert.equal(data.error, undefined, `Unexpected error: ${data.error}`);
  assert.equal(data.issues.length, 1, 'Should return the one issue from the succeeding repo');
  assert.equal(data.issues[0]?.number, 99);
  assert.equal(data.issues[0]?.repoPath, WORKSPACE_PATH_A);
});
