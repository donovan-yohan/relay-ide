import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkspaceRouter,
  type WorkspaceDeps,
} from '../server/workspaces.js';
import { DEFAULTS, loadConfig, saveConfig } from '../server/config.js';
import { createTestServer } from './helpers/test-server.js';

const LEGACY_TMUX_LAUNCH_KEY = 'launchInTmux';

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

/** Simulate a git exit-128 "not a git repository" error, as node's execFile produces. */
function makeGitExit128Error(): Error & { code: number; stderr: string } {
  const err = new Error('not a git repository') as Error & {
    code: number;
    stderr: string;
  };
  err.code = 128;
  err.stderr =
    'fatal: not a git repository (or any of the parent directories): .git';
  return err;
}

function makeExec(gitDir: string): ExecFn {
  // Simulates: git rev-parse --git-dir succeeds for gitDir, fails for others
  const impl = async (
    file: string,
    args: string[],
    opts?: { cwd?: string }
  ): Promise<ExecResult> => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--git-dir') {
      if (opts?.cwd === gitDir) {
        return { stdout: '.git', stderr: '' } as ExecResult;
      }
      throw makeGitExit128Error();
    }
    if (file === 'git' && args[0] === 'symbolic-ref') {
      if (opts?.cwd === gitDir) {
        return { stdout: 'main\n', stderr: '' } as ExecResult;
      }
      throw makeGitExit128Error();
    }
    if (file === 'git' && args[0] === 'remote') {
      if (opts?.cwd === gitDir) {
        return { stdout: '', stderr: '' } as ExecResult;
      }
      throw makeGitExit128Error();
    }
    return { stdout: '', stderr: '' } as ExecResult;
  };
  // `execFileAsync` is an overloaded promisified signature; this stub only
  // implements the `(file, args, options)` form the workspace router calls.
  return impl as unknown as ExecFn;
}

async function makeApp(exec: ExecFn) {
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use(
    '/workspaces',
    createWorkspaceRouter({ configPath, execAsync: exec })
  );
  return app;
}

describe('PATCH /workspaces/settings — terminal backend selection', () => {
  it('rejects the removed legacy tmux launch flag', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const params = new URLSearchParams({ path: gitRepoPath });
      const res = await fetch(`${server.url}/workspaces/settings?${params}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [LEGACY_TMUX_LAUNCH_KEY]: true }),
      });

      expect(res.status).toBe(400);
      expect(
        loadConfig(configPath).repoSettings?.[path.resolve(gitRepoPath)]
      ).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('rejects tmux-compat terminalBackend settings', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const params = new URLSearchParams({ path: gitRepoPath });
      const res = await fetch(`${server.url}/workspaces/settings?${params}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminalBackend: 'tmux-compat' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('terminalBackend must be "relay-pty"');

      const saved = loadConfig(configPath);
      expect(saved.repoSettings?.[path.resolve(gitRepoPath)]).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe('GET /workspaces — kind field', () => {
  it('returns kind: "repo" for a git-initialized path and kind: "directory" for a non-git path', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const res = await fetch(`${server.url}/workspaces`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        workspaces: Array<{ path: string; kind?: string; isGitRepo: boolean }>;
      };
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
      const res = await fetch(
        `${server.url}/workspaces/current-branch?${params}`
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('NOT_GIT');
    } finally {
      await server.close();
    }
  });
});

describe('GET /workspaces/divergence — NOT_GIT guard', () => {
  it('returns 400 with code NOT_GIT for a non-git configured path', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const params = new URLSearchParams({ path: nonGitPath });
      const res = await fetch(`${server.url}/workspaces/divergence?${params}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('NOT_GIT');
    } finally {
      await server.close();
    }
  });
});

describe('GET /workspaces/changed-files — NOT_GIT guard', () => {
  it('returns 400 with code NOT_GIT for a non-git configured path', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const params = new URLSearchParams({ path: nonGitPath });
      const res = await fetch(
        `${server.url}/workspaces/changed-files?${params}`
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('NOT_GIT');
    } finally {
      await server.close();
    }
  });
});

describe('GET /workspaces/file-diff — NOT_GIT guard', () => {
  it('returns 400 with code NOT_GIT for a non-git configured path', async () => {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      const params = new URLSearchParams({
        path: nonGitPath,
        file: 'README.md',
      });
      const res = await fetch(`${server.url}/workspaces/file-diff?${params}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('NOT_GIT');
    } finally {
      await server.close();
    }
  });
});

describe('PUT /workspaces/file-content', () => {
  async function withServer(
    fn: (server: Awaited<ReturnType<typeof createTestServer>>) => Promise<void>
  ) {
    const exec = makeExec(gitRepoPath);
    const app = await makeApp(exec);
    const server = await createTestServer(app);
    try {
      await fn(server);
    } finally {
      await server.close();
    }
  }

  it('writes utf-8 content atomically and returns the new file metadata', async () => {
    await withServer(async (server) => {
      const filePath = path.join(gitRepoPath, 'README.md');
      fs.writeFileSync(filePath, 'old\n');
      const before = fs.statSync(filePath).mtimeMs;
      const params = new URLSearchParams({
        path: gitRepoPath,
        file: 'README.md',
      });

      const res = await fetch(
        `${server.url}/workspaces/file-content?${params}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'new\n', expectedMtimeMs: before }),
        }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { mtimeMs: number; sizeBytes: number };
      expect(body.sizeBytes).toBe(Buffer.byteLength('new\n'));
      expect(body.mtimeMs).toBeGreaterThanOrEqual(before);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('new\n');
    });
  });

  it('rejects traversal attempts before writing', async () => {
    await withServer(async (server) => {
      const params = new URLSearchParams({
        path: gitRepoPath,
        file: '../escape.txt',
      });
      const res = await fetch(
        `${server.url}/workspaces/file-content?${params}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'nope' }),
        }
      );

      expect(res.status).toBe(400);
      expect(fs.existsSync(path.join(tmpDir, 'escape.txt'))).toBe(false);
    });
  });

  it('rejects symlinked parent directories before writing', async () => {
    await withServer(async (server) => {
      const outsideDir = fs.mkdtempSync(path.join(tmpDir, 'outside-'));
      fs.writeFileSync(path.join(outsideDir, 'escape.txt'), 'outside');
      fs.symlinkSync(outsideDir, path.join(gitRepoPath, 'linked-dir'), 'dir');
      const params = new URLSearchParams({
        path: gitRepoPath,
        file: 'linked-dir/escape.txt',
      });

      const res = await fetch(
        `${server.url}/workspaces/file-content?${params}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'nope' }),
        }
      );

      expect(res.status).toBe(400);
      expect(
        fs.readFileSync(path.join(outsideDir, 'escape.txt'), 'utf-8')
      ).toBe('outside');
    });
  });

  it('returns 413 when the new content exceeds the edit cap', async () => {
    await withServer(async (server) => {
      fs.writeFileSync(path.join(gitRepoPath, 'big.txt'), 'small');
      const params = new URLSearchParams({
        path: gitRepoPath,
        file: 'big.txt',
      });
      const content = 'x'.repeat(2 * 1024 * 1024 + 1);

      const res = await fetch(
        `${server.url}/workspaces/file-content?${params}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        }
      );

      expect(res.status).toBe(413);
      const body = (await res.json()) as {
        sizeBytes: number;
        maxBytes: number;
      };
      expect(body.sizeBytes).toBe(Buffer.byteLength(content));
      expect(body.maxBytes).toBe(2 * 1024 * 1024);
      expect(fs.readFileSync(path.join(gitRepoPath, 'big.txt'), 'utf-8')).toBe(
        'small'
      );
    });
  });

  it('returns 412 with current hash when expected mtime is stale', async () => {
    await withServer(async (server) => {
      const filePath = path.join(gitRepoPath, 'conflict.txt');
      fs.writeFileSync(filePath, 'disk\n');
      const current = fs.statSync(filePath);
      const params = new URLSearchParams({
        path: gitRepoPath,
        file: 'conflict.txt',
      });

      const res = await fetch(
        `${server.url}/workspaces/file-content?${params}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: 'mine\n',
            expectedMtimeMs: current.mtimeMs - 1,
          }),
        }
      );

      expect(res.status).toBe(412);
      const body = (await res.json()) as {
        code: string;
        mtimeMs: number;
        sizeBytes: number;
        contentHash: string;
      };
      expect(body.code).toBe('mtime_mismatch');
      expect(body.mtimeMs).toBe(current.mtimeMs);
      expect(body.sizeBytes).toBe(current.size);
      expect(body.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('disk\n');
    });
  });
});
