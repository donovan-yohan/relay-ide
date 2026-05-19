import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createWorkspaceRouter, type WorkspaceDeps } from '../server/workspaces.js';
import { DEFAULTS, saveConfig } from '../server/config.js';
import { createTestServer } from './helpers/test-server.js';

type ExecFn = NonNullable<WorkspaceDeps['execAsync']>;
type ExecResult = { stdout: string; stderr: string };

let tmpDir = '';
let configPath = '';
let gitRepoPath = '';
let nonGitPath = '';

beforeEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspaces-routes-test-'));
  configPath = path.join(tmpDir, 'config.json');
  gitRepoPath = path.join(tmpDir, 'git-repo');
  nonGitPath = path.join(tmpDir, 'non-git');
  fs.mkdirSync(gitRepoPath, { recursive: true });
  fs.mkdirSync(nonGitPath, { recursive: true });
  saveConfig(configPath, { ...DEFAULTS, repos: [gitRepoPath, nonGitPath] });
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeExec(gitDir: string): ExecFn {
  // Simulates: git rev-parse --git-dir succeeds for gitDir, fails for others
  return async (file: string, args: string[], opts?: { cwd?: string }) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--git-dir') {
      if (opts?.cwd === gitDir) {
        return { stdout: '.git', stderr: '' } as ExecResult;
      }
      throw new Error('not a git repository');
    }
    if (file === 'git' && args[0] === 'symbolic-ref') {
      if (opts?.cwd === gitDir) {
        return { stdout: 'main\n', stderr: '' } as ExecResult;
      }
      throw new Error('not a git repository');
    }
    if (file === 'git' && args[0] === 'remote') {
      if (opts?.cwd === gitDir) {
        return { stdout: '', stderr: '' } as ExecResult;
      }
      throw new Error('not a git repository');
    }
    return { stdout: '', stderr: '' } as ExecResult;
  };
}

async function makeApp(exec: ExecFn) {
  const app = express();
  app.use(express.json());
  app.use('/workspaces', createWorkspaceRouter({ configPath, execAsync: exec }));
  return app;
}

describe('GET /workspaces — kind field', () => {
  it('returns kind: "repo" for a git-initialized path and kind: "directory" for a non-git path', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const res = await fetch(`${server.url}/workspaces`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { workspaces: Array<{ path: string; kind?: string; isGitRepo: boolean }> };
      const git = data.workspaces.find((w) => w.path === gitRepoPath);
      const dir = data.workspaces.find((w) => w.path === nonGitPath);

      expect(git).toBeDefined();
      expect(git?.isGitRepo).toBe(true);
      expect(git?.kind).toBe('repo');

      expect(dir).toBeDefined();
      expect(dir?.isGitRepo).toBe(false);
      expect(dir?.kind).toBe('directory');
    } finally {
      await server.close();
    }
  });
});

describe('GET /workspaces/dashboard — NOT_GIT guard', () => {
  it('returns 400 with code NOT_GIT for a non-git configured path', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const params = new URLSearchParams({ path: nonGitPath });
      const res = await fetch(`${server.url}/workspaces/dashboard?${params}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('NOT_GIT');
    } finally {
      await server.close();
    }
  });

  it('does not return 400 for a git-configured path (falls through to auth/data fetch)', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const params = new URLSearchParams({ path: gitRepoPath });
      const res = await fetch(`${server.url}/workspaces/dashboard?${params}`);
      // dashboard will return 200 or some valid response (gh not authenticated etc)
      // What it must NOT return is 400 with NOT_GIT
      const body = (await res.json()) as { code?: string };
      expect(body.code).not.toBe('NOT_GIT');
    } finally {
      await server.close();
    }
  });
});

describe('POST /workspaces/branch — NOT_GIT guard', () => {
  it('returns 400 with code NOT_GIT for a non-git path', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const params = new URLSearchParams({ path: nonGitPath });
      const res = await fetch(`${server.url}/workspaces/branch?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'main' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('NOT_GIT');
    } finally {
      await server.close();
    }
  });
});

describe('POST /workspaces/worktree — NOT_GIT guard', () => {
  it('returns 400 with code NOT_GIT for a non-git path', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const params = new URLSearchParams({ path: nonGitPath });
      const res = await fetch(`${server.url}/workspaces/worktree?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('NOT_GIT');
    } finally {
      await server.close();
    }
  });
});

describe('GET /workspaces/current-branch — NOT_GIT guard', () => {
  it('returns 400 with code NOT_GIT for a non-git path', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const params = new URLSearchParams({ path: nonGitPath });
      const res = await fetch(`${server.url}/workspaces/current-branch?${params}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('NOT_GIT');
    } finally {
      await server.close();
    }
  });
});
