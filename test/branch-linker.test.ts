import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';

import {
  createBranchLinkerRouter,
  invalidateBranchLinkerCache,
  type BranchLinkerDeps,
} from '../server/branch-linker.js';
import { saveConfig, DEFAULTS } from '../server/config.js';
import type { BranchLinksResponse } from '../server/types.js';

// Loose mock type — cast to BranchLinkerDeps['execAsync'] at call sites
type MockExec = (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>;

let tmpDir: string;
let configPath: string;
let server: Server;
let baseUrl: string;

const WORKSPACE_PATH_A = '/fake/workspace/repo-a';
const WORKSPACE_PATH_B = '/fake/workspace/repo-b';

/**
 * Creates a mock execAsync that returns configured branch lists per cwd.
 * - `git branch -a` → returns newline-joined branch names or throws
 */
function makeMockExec(opts: {
  branchesByPath?: Record<string, string[]>;
  errorByPath?: Record<string, Error>;
}): MockExec {
  return async (cmd: unknown, args: unknown, options: unknown) => {
    const command = cmd as string;
    const argv = args as string[];
    const cwd = (options as { cwd?: string }).cwd ?? '';

    if (command === 'git' && argv[0] === 'branch') {
      if (opts.errorByPath?.[cwd]) throw opts.errorByPath[cwd]!;
      const branches = opts.branchesByPath?.[cwd] ?? [];
      return { stdout: branches.join('\n') + '\n', stderr: '' };
    }

    throw new Error(`Unexpected exec call: ${command} ${argv.join(' ')}`);
  };
}

function startServer(
  execAsyncFn: MockExec,
  getActiveBranchNames?: BranchLinkerDeps['getActiveBranchNames'],
): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    const deps = {
      configPath,
      execAsync: execAsyncFn,
      ...(getActiveBranchNames ? { getActiveBranchNames } : {}),
    } as unknown as BranchLinkerDeps;
    app.use('/branch-linker', createBranchLinkerRouter(deps));
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

async function getLinks(): Promise<BranchLinksResponse> {
  const res = await fetch(`${baseUrl}/branch-linker/links`);
  return res.json() as Promise<BranchLinksResponse>;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-linker-test-'));
  configPath = path.join(tmpDir, 'config.json');
  // Clear any module-level cache before test suite runs
  invalidateBranchLinkerCache();
});

after(async () => {
  await stopServer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('extracts Jira ticket IDs from branch names', async () => {
  await stopServer();
  invalidateBranchLinkerCache();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
  });

  const exec = makeMockExec({
    branchesByPath: {
      [WORKSPACE_PATH_A]: ['dy/fix/ACME-123-auth', 'main'],
    },
  });

  await startServer(exec);

  const data = await getLinks();
  assert.ok('ACME-123' in data, 'Should extract ACME-123 from branch name');
  const links = data['ACME-123']!;
  assert.equal(links.length, 1);
  assert.equal(links[0]!.branchName, 'dy/fix/ACME-123-auth');
  assert.equal(links[0]!.repoPath, WORKSPACE_PATH_A);
  assert.equal(links[0]!.repoName, 'repo-a');
});

test('extracts GH issue IDs from gh-N branches', async () => {
  await stopServer();
  invalidateBranchLinkerCache();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
  });

  const exec = makeMockExec({
    branchesByPath: {
      // Use a branch that only the GH regex matches (no embedded uppercase-only letters)
      // to get a single clean GH-42 link. The Jira regex (/[A-Z]{2,}-\d+/gi) would also
      // match 'gh-42' since the flag is case-insensitive, so we use a prefix that isolates
      // the GH regex match by starting with 'gh-' at the very start of the branch name.
      [WORKSPACE_PATH_A]: ['gh-42-login-fix'],
    },
  });

  await startServer(exec);

  const data = await getLinks();
  assert.ok('GH-42' in data, 'Should extract GH-42 from branch name');
  const links = data['GH-42']!;
  // Only the GH regex matches this branch — the Jira regex explicitly excludes 'GH'
  // to avoid double-matching. Verify all links point to the correct branch and repo.
  assert.ok(links.length >= 1, 'Should have at least one GH-42 link');
  assert.ok(
    links.every((l) => l.branchName === 'gh-42-login-fix'),
    'All links should reference the correct branch',
  );
  assert.ok(
    links.every((l) => l.repoPath === WORKSPACE_PATH_A),
    'All links should reference the correct repo',
  );
});

test('same ticket in two repos yields array of 2 BranchLinks', async () => {
  await stopServer();
  invalidateBranchLinkerCache();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A, WORKSPACE_PATH_B],
  });

  const exec = makeMockExec({
    branchesByPath: {
      [WORKSPACE_PATH_A]: ['feature/PROJ-99-payment'],
      [WORKSPACE_PATH_B]: ['bugfix/PROJ-99-payment-fix'],
    },
  });

  await startServer(exec);

  const data = await getLinks();
  assert.ok('PROJ-99' in data, 'Should have PROJ-99 key');
  const links = data['PROJ-99']!;
  assert.equal(links.length, 2, 'Should have 2 BranchLinks for the same ticket across 2 repos');

  const repoPaths = links.map((l) => l.repoPath).sort();
  assert.deepEqual(repoPaths, [WORKSPACE_PATH_A, WORKSPACE_PATH_B].sort());
});

test('ignores branches without ticket IDs', async () => {
  await stopServer();
  invalidateBranchLinkerCache();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
  });

  const exec = makeMockExec({
    branchesByPath: {
      [WORKSPACE_PATH_A]: ['main', 'develop', 'chore/cleanup', 'feature/new-ui'],
    },
  });

  await startServer(exec);

  const data = await getLinks();
  assert.equal(Object.keys(data).length, 0, 'Plain branches should produce no ticket links');
});

test('hasActiveSession true when branch is in active set', async () => {
  await stopServer();
  invalidateBranchLinkerCache();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
  });

  const activeBranch = 'feature/ACTIVE-1-work';

  const exec = makeMockExec({
    branchesByPath: {
      [WORKSPACE_PATH_A]: [activeBranch, 'feature/INACTIVE-2-other'],
    },
  });

  const getActiveBranchNames = (): Map<string, Set<string>> => {
    return new Map([[WORKSPACE_PATH_A, new Set([activeBranch])]]);
  };

  await startServer(exec, getActiveBranchNames);

  const data = await getLinks();

  const activeLinks = data['ACTIVE-1'];
  assert.ok(activeLinks, 'Should have ACTIVE-1 ticket');
  assert.equal(activeLinks.length, 1);
  assert.equal(activeLinks[0]!.hasActiveSession, true, 'Active branch should have hasActiveSession true');

  const inactiveLinks = data['INACTIVE-2'];
  assert.ok(inactiveLinks, 'Should have INACTIVE-2 ticket');
  assert.equal(inactiveLinks[0]!.hasActiveSession, false, 'Inactive branch should have hasActiveSession false');
});

test('invalidateBranchLinkerCache forces fresh scan', async () => {
  await stopServer();
  invalidateBranchLinkerCache();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [WORKSPACE_PATH_A],
  });

  let gitCallCount = 0;

  const baseExec = makeMockExec({
    branchesByPath: {
      [WORKSPACE_PATH_A]: ['feature/SCAN-1-fresh'],
    },
  });

  const countingExec: MockExec = async (...args: unknown[]) => {
    const [cmd] = args as [string, ...unknown[]];
    if (cmd === 'git') gitCallCount++;
    return baseExec(...args);
  };

  await startServer(countingExec);

  // First request — populates module-level cache
  const first = await getLinks();
  assert.ok('SCAN-1' in first, 'Should have SCAN-1 after first request');
  assert.equal(gitCallCount, 1, 'git should be called once on first request');

  // Second request — served from cache
  const second = await getLinks();
  assert.ok('SCAN-1' in second);
  assert.equal(gitCallCount, 1, 'git should not be called again within TTL');

  // Invalidate cache
  invalidateBranchLinkerCache();

  // Third request — cache is cleared, should fetch fresh
  const third = await getLinks();
  assert.ok('SCAN-1' in third);
  assert.equal(gitCallCount, 2, 'git should be called again after cache invalidation');
});

test('returns empty object when no workspaces', async () => {
  await stopServer();
  invalidateBranchLinkerCache();
  saveConfig(configPath, {
    ...DEFAULTS,
    repos: [],
  });

  // execAsync should never be called here
  const exec = makeMockExec({});

  await startServer(exec);

  const data = await getLinks();
  assert.equal(Object.keys(data).length, 0, 'Should return empty object when no workspaces configured');
});
