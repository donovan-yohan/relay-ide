import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { enrichBranches, type GhRouterDeps } from '../server/gh-routes.js';

type ExecFn = GhRouterDeps['execFileAsync'];

function makeExec(
  responses: Record<string, { stdout: string; stderr?: string }>
): ExecFn {
  return async (file: string, args: string[], _opts: { cwd: string }) => {
    const key = `${file} ${args.slice(0, 3).join(' ')}`;
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.startsWith(pattern)) {
        return { stdout: response.stdout, stderr: response.stderr ?? '' };
      }
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
}

describe('enrichBranches', () => {
  it('returns PR + staleness per branch keyed by repoPath::branchName', async () => {
    const prList = JSON.stringify([
      {
        number: 42,
        title: 'Add login',
        url: 'https://github.com/o/r/pull/42',
        state: 'OPEN',
        headRefName: 'feat/login',
        baseRefName: 'main',
        isDraft: false,
        reviewDecision: 'APPROVED',
        additions: 10,
        deletions: 2,
        mergeable: 'MERGEABLE',
        updatedAt: new Date().toISOString(),
      },
    ]);

    const results = await enrichBranches(
      [{ repoPath: '/repos/my-repo', branchName: 'feat/login' }],
      makeExec({
        'gh pr list': { stdout: prList },
        'git rev-list': { stdout: '3\n' },
      })
    );

    const key = '/repos/my-repo::feat/login';
    assert.ok(results[key], `expected key ${key} in results`);
    assert.equal(results[key]!.pr!.number, 42);
    assert.equal(results[key]!.stale, false);
  });

  it('handles partial failure (one repo fails, others succeed)', async () => {
    const prList = JSON.stringify([
      {
        number: 1,
        title: 'Fix',
        url: 'https://github.com/o/r/pull/1',
        state: 'OPEN',
        headRefName: 'fix/bug',
        baseRefName: 'main',
        isDraft: false,
        reviewDecision: null,
        additions: 1,
        deletions: 1,
        mergeable: 'MERGEABLE',
        updatedAt: new Date().toISOString(),
      },
    ]);

    const exec: ExecFn = async (
      file: string,
      args: string[],
      opts: { cwd: string }
    ) => {
      if (opts.cwd === '/repos/bad-repo' && file === 'gh') {
        throw new Error('gh: not logged in');
      }
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return { stdout: prList, stderr: '' };
      }
      if (file === 'git' && args[0] === 'rev-list') {
        return { stdout: '1\n', stderr: '' };
      }
      throw new Error(`unexpected: ${file} ${args.join(' ')}`);
    };

    const results = await enrichBranches(
      [
        { repoPath: '/repos/good-repo', branchName: 'fix/bug' },
        { repoPath: '/repos/bad-repo', branchName: 'feat/x' },
      ],
      exec
    );

    // Good repo should have data
    assert.ok(results['/repos/good-repo::fix/bug']);
    assert.equal(results['/repos/good-repo::fix/bug']!.pr!.number, 1);

    // Bad repo should have null pr and default stale=false
    assert.equal(results['/repos/bad-repo::feat/x']!.pr, null);
    assert.equal(results['/repos/bad-repo::feat/x']!.stale, false);
  });

  it('returns empty results for empty input', async () => {
    const results = await enrichBranches([], async () => ({
      stdout: '',
      stderr: '',
    }));
    assert.deepEqual(results, {});
  });

  it('degrades when gh CLI is missing (ENOENT)', async () => {
    const exec: ExecFn = async (file: string, args: string[]) => {
      if (file === 'gh') {
        const err = new Error('spawn gh ENOENT') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      if (file === 'git' && args[0] === 'rev-list') {
        return { stdout: '0\n', stderr: '' };
      }
      throw new Error(`unexpected: ${file} ${args.join(' ')}`);
    };

    const results = await enrichBranches(
      [{ repoPath: '/repos/my-repo', branchName: 'feat/x' }],
      exec
    );

    const entry = results['/repos/my-repo::feat/x']!;
    assert.equal(entry.pr, null);
    assert.equal(entry.stale, true); // 0 commits ahead = stale
  });

  it('batches PR lookups per unique repo (one gh call per repo)', async () => {
    const callLog: string[] = [];

    const prList = JSON.stringify([
      {
        number: 1,
        title: 'A',
        url: 'u',
        state: 'OPEN',
        headRefName: 'a',
        baseRefName: 'main',
        isDraft: false,
        reviewDecision: null,
        additions: 0,
        deletions: 0,
        mergeable: 'MERGEABLE',
        updatedAt: new Date().toISOString(),
      },
      {
        number: 2,
        title: 'B',
        url: 'u',
        state: 'OPEN',
        headRefName: 'b',
        baseRefName: 'main',
        isDraft: false,
        reviewDecision: null,
        additions: 0,
        deletions: 0,
        mergeable: 'MERGEABLE',
        updatedAt: new Date().toISOString(),
      },
    ]);

    const exec: ExecFn = async (
      file: string,
      args: string[],
      opts: { cwd: string }
    ) => {
      callLog.push(`${file} ${args[0]} ${args[1] ?? ''} [${opts.cwd}]`);
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return { stdout: prList, stderr: '' };
      }
      if (file === 'git' && args[0] === 'rev-list') {
        return { stdout: '1\n', stderr: '' };
      }
      throw new Error(`unexpected`);
    };

    await enrichBranches(
      [
        { repoPath: '/repos/repo1', branchName: 'a' },
        { repoPath: '/repos/repo1', branchName: 'b' },
      ],
      exec
    );

    // Should have exactly 1 gh pr list call for repo1 (not 2)
    const ghCalls = callLog.filter((c) => c.startsWith('gh pr list'));
    assert.equal(
      ghCalls.length,
      1,
      `expected 1 gh pr list call, got ${ghCalls.length}`
    );
  });
});
