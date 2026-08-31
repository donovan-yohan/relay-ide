import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceRouter,
  clearDashboardPrCache,
  type WorkspaceDeps,
} from '../server/workspaces.js';
import { DEFAULTS, saveConfig } from '../server/config.js';
import { createTestServer } from './helpers/test-server.js';

type ExecResult = { stdout: string; stderr: string };
// The product dep is `typeof promisify(execFile)`, an overload set no hand-written
// double can satisfy structurally. Production code only ever calls the
// (file, args[, options]) form, which is what these fakes implement.
type ExecFn = (
  file: string,
  args: readonly string[],
  options?: unknown
) => Promise<ExecResult>;
const asExecAsync = (fn: ExecFn): NonNullable<WorkspaceDeps['execAsync']> =>
  fn as unknown as NonNullable<WorkspaceDeps['execAsync']>;

let tmpDir = '';
let configPath = '';
let repoPath = '';

beforeEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-cache-test-'));
  configPath = path.join(tmpDir, 'config.json');
  repoPath = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  saveConfig(configPath, { ...DEFAULTS, repos: [repoPath] });
  clearDashboardPrCache();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function fetchDashboard(exec: ExecFn): Promise<{
  pullRequests: { prs: Array<{ number: number; title: string }> };
}> {
  const app = express();
  app.use(express.json());
  app.use(
    '/workspaces',
    createWorkspaceRouter({ configPath, execAsync: asExecAsync(exec) })
  );
  const server = await createTestServer(app);
  try {
    const params = new URLSearchParams({ path: repoPath });
    const res = await fetch(`${server.url}/workspaces/dashboard?${params}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Promise<{
      pullRequests: { prs: Array<{ number: number; title: string }> };
    }>;
  } finally {
    await server.close();
  }
}

function makeDashboardExec(counter: { prListCalls: number }): ExecFn {
  return async (file, args) => {
    // requireGitRepo uses detectGitRepo which calls git rev-parse --git-dir
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--git-dir') {
      return { stdout: '.git', stderr: '' };
    }
    if (file === 'gh' && args[0] === 'api' && args[1] === 'user') {
      return { stdout: 'me\n', stderr: '' };
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      counter.prListCalls += 1;
      const role = args.includes('--author') ? 'author' : 'reviewer';
      const prs =
        role === 'author'
          ? [
              {
                number: counter.prListCalls,
                title: `pr call ${counter.prListCalls}`,
                url: 'https://github.com/o/r/pull/1',
                headRefName: 'feat/cache',
                baseRefName: 'nightly',
                state: 'OPEN',
                author: { login: 'me' },
                updatedAt: '2026-01-01T00:00:00Z',
                additions: 1,
                deletions: 0,
                reviewDecision: null,
                mergeable: 'MERGEABLE',
                isDraft: false,
              },
            ]
          : [];
      return { stdout: JSON.stringify(prs), stderr: '' };
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
}

describe('/workspaces/dashboard PR cache', () => {
  it('caches the combined PR result by repo path until invalidated', async () => {
    const counter = { prListCalls: 0 };
    const exec = makeDashboardExec(counter);

    const first = await fetchDashboard(exec);
    const second = await fetchDashboard(exec);

    expect(first.pullRequests.prs[0]?.title).toBe('pr call 1');
    expect(second.pullRequests.prs[0]?.title).toBe('pr call 1');
    expect(counter.prListCalls).toBe(2);

    clearDashboardPrCache(repoPath);
    const third = await fetchDashboard(exec);

    expect(third.pullRequests.prs[0]?.title).toBe('pr call 3');
    expect(counter.prListCalls).toBe(4);
  });

  it('deduplicates concurrent combined PR lookups for the same repo path', async () => {
    const counter = { prListCalls: 0 };
    const exec = makeDashboardExec(counter);

    const [first, second] = await Promise.all([
      fetchDashboard(exec),
      fetchDashboard(exec),
    ]);

    expect(first.pullRequests.prs[0]?.title).toBe('pr call 1');
    expect(second.pullRequests.prs[0]?.title).toBe('pr call 1');
    expect(counter.prListCalls).toBe(2);
  });

  it('keeps a newer in-flight lookup after an invalidated older lookup settles', async () => {
    const prListResolvers: Array<(value: ExecResult) => void> = [];
    let prListCalls = 0;
    const exec: ExecFn = async (file, args) => {
      // requireGitRepo needs git rev-parse --git-dir to succeed
      if (
        file === 'git' &&
        args[0] === 'rev-parse' &&
        args[1] === '--git-dir'
      ) {
        return { stdout: '.git', stderr: '' };
      }
      if (file === 'gh' && args[0] === 'api' && args[1] === 'user') {
        return { stdout: 'me\n', stderr: '' };
      }
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        prListCalls += 1;
        return new Promise((resolve) => {
          prListResolvers.push(resolve);
        });
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };

    const first = fetchDashboard(exec);
    await vi.waitFor(() => expect(prListCalls).toBe(2));
    clearDashboardPrCache(repoPath);
    const second = fetchDashboard(exec);
    await vi.waitFor(() => expect(prListCalls).toBe(4));

    prListResolvers[0]?.({ stdout: '[]', stderr: '' });
    prListResolvers[1]?.({ stdout: '[]', stderr: '' });
    await first;

    const third = fetchDashboard(exec);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prListCalls).toBe(4);

    prListResolvers[2]?.({ stdout: '[]', stderr: '' });
    prListResolvers[3]?.({ stdout: '[]', stderr: '' });
    await expect(Promise.all([second, third])).resolves.toHaveLength(2);
    expect(prListCalls).toBe(4);
  });
});
