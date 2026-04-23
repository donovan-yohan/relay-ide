import { test, beforeAll, afterAll, expect, vi } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createWebhookManagerRouter } from '../server/webhook-manager.js';
import {
  startSmartPolling,
  stopSmartPolling,
} from '../server/webhook-manager.js';
import { saveConfig, DEFAULTS } from '../server/config.js';
import type { Config } from '../server/types.js';
import { createMockFetch } from './helpers/mock-fetch.js';
import { createTestServer } from './helpers/test-server.js';

/** Isolate child git processes from the host worktree environment. */
const GIT_ISOLATED_ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
};

// ── Server helpers ─────────────────────────────────────────────────────────────

/** No-op requireAuth middleware for testing (bypasses auth). */
const noopAuth = (
  _req: express.Request,
  _res: express.Response,
  next: express.NextFunction
): void => next();

async function startServer(opts: {
  configPath: string;
  fetchFn?: typeof globalThis.fetch;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());

  const router = createWebhookManagerRouter({
    configPath: opts.configPath,
    broadcastEvent: () => {
      /* no-op */
    },
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    requireAuth: noopAuth,
  });

  app.use('/webhooks', router);

  const { url, close } = await createTestServer(app);
  return { url, close };
}

// ── Shared state ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-manager-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTempConfig(name: string, overrides: Partial<Config> = {}): string {
  const configPath = path.join(tmpDir, `${name}.json`);
  saveConfig(configPath, { ...DEFAULTS, ...overrides });
  return configPath;
}

/**
 * Creates a real git repo at the given path with origin set to a fake GitHub remote URL.
 * Uses `git init` + `git remote add` so `git remote get-url origin` works correctly.
 */
function makeGitRepo(dir: string, owner: string, repo: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', dir], {
    stdio: 'ignore',
    env: GIT_ISOLATED_ENV,
  });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', `https://github.com/${owner}/${repo}.git`],
    {
      cwd: dir,
      stdio: 'ignore',
      env: GIT_ISOLATED_ENV,
    }
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

// 1. POST /setup — happy path: mock smee.io/new (302 redirect), verify config saved

test('POST /setup — happy path creates smee channel and saves config', async () => {
  const configPath = makeTempConfig('setup-happy', {
    github: { accessToken: 'ghs_test' },
  });

  // Simulate smee.io/new → 302 with Location header
  const mockFetch = createMockFetch({
    'smee.io/new': [
      {
        status: 302,
        headers: {
          location: 'https://smee.io/abc123def456',
          'Content-Type': 'text/html',
        },
      },
    ],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/setup`, { method: 'POST' });
    expect(res.status).toBe(200);

    const data = (await res.json()) as { ok: boolean; smeeUrl: string };
    expect(data.ok).toBe(true);
    expect(data.smeeUrl).toBe('https://smee.io/abc123def456');

    // Verify config was saved
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      github?: { smeeUrl?: string; webhookSecret?: string };
    };
    expect(saved.github?.smeeUrl).toBe('https://smee.io/abc123def456');
    expect(saved.github?.webhookSecret).toBeTruthy();
    expect(saved.github!.webhookSecret!.length).toBe(40);
  } finally {
    await close();
  }
});

// 2. POST /setup — smee.io unreachable: mock fetch throws, verify error response

test('POST /setup — smee.io unreachable returns error', async () => {
  const configPath = makeTempConfig('setup-unreachable');

  const mockFetch = createMockFetch({
    'smee.io/new': [{ throw: new Error('ECONNREFUSED') }],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/setup`, { method: 'POST' });
    expect(res.status).toBe(502);

    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('smee_unreachable');
  } finally {
    await close();
  }
});

// 3. POST /repos — happy path: mock GitHub API 201, verify webhookId saved

test('[needs:git-init] POST /repos — happy path creates webhook and saves webhookId', async () => {
  const repoDir = path.join(tmpDir, 'repos-happy-repo');
  makeGitRepo(repoDir, 'testowner', 'testrepo');

  const configPath = makeTempConfig('repos-happy', {
    github: {
      accessToken: 'ghs_token',
      webhookSecret: 'test_secret_abc',
      smeeUrl: 'https://smee.io/test123',
    },
  });

  const mockFetch = createMockFetch({
    'api.github.com': [
      // POST /repos/testowner/testrepo/hooks → 201 Created
      { json: { id: 99001 }, status: 201 },
    ],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as { ok: boolean; webhookId: number };
    expect(data.ok).toBe(true);
    expect(data.webhookId).toBe(99001);

    // Verify webhookId saved in config
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      repoSettings?: Record<
        string,
        { webhookId?: number; webhookEnabled?: boolean }
      >;
    };
    expect(saved.repoSettings?.[repoDir]?.webhookId).toBe(99001);
    expect(saved.repoSettings?.[repoDir]?.webhookEnabled).toBe(true);
  } finally {
    await close();
  }
});

// 4. POST /repos — 403 forbidden: verify webhookError set to 'not-admin'

test('[needs:git-init] POST /repos — 403 forbidden sets webhookError to not-admin', async () => {
  const repoDir = path.join(tmpDir, 'repos-403-repo');
  makeGitRepo(repoDir, 'testowner', 'forbiddenrepo');

  const configPath = makeTempConfig('repos-403', {
    github: {
      accessToken: 'ghs_token',
      webhookSecret: 'test_secret',
      smeeUrl: 'https://smee.io/test123',
    },
  });

  const mockFetch = createMockFetch({
    'api.github.com': [
      { json: { message: 'Must have admin rights' }, status: 403 },
    ],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    expect(res.status).toBe(403);

    const data = (await res.json()) as { error: string; webhookError: string };
    expect(data.webhookError).toBe('not-admin');

    // Verify webhookError saved in config
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      repoSettings?: Record<string, { webhookError?: string }>;
    };
    expect(saved.repoSettings?.[repoDir]?.webhookError).toBe('not-admin');
  } finally {
    await close();
  }
});

// 5. POST /repos — 422 conflict: verify treated as success

test('[needs:git-init] POST /repos — 422 conflict is treated as success (webhook already exists)', async () => {
  const repoDir = path.join(tmpDir, 'repos-422-repo');
  makeGitRepo(repoDir, 'testowner', 'existingrepo');

  const configPath = makeTempConfig('repos-422', {
    github: {
      accessToken: 'ghs_token',
      webhookSecret: 'test_secret',
      smeeUrl: 'https://smee.io/test123',
    },
  });

  const mockFetch = createMockFetch({
    'api.github.com': [
      // POST /hooks → 422
      { json: { message: 'Hook already exists' }, status: 422 },
      // GET /hooks → 200 with existing hook
      {
        json: [{ id: 77777, config: { url: 'https://smee.io/test123' } }],
        status: 200,
      },
    ],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as { ok: boolean; webhookId: number };
    expect(data.ok).toBe(true);
    expect(data.webhookId).toBe(77777);
  } finally {
    await close();
  }
});

// 6. POST /repos — 401 unauthorized: verify scope error response

test('[needs:git-init] POST /repos — 401 unauthorized returns unauthorized error', async () => {
  const repoDir = path.join(tmpDir, 'repos-401-repo');
  makeGitRepo(repoDir, 'testowner', 'privaterepo');

  const configPath = makeTempConfig('repos-401', {
    github: {
      accessToken: 'ghs_expired_token',
      webhookSecret: 'test_secret',
      smeeUrl: 'https://smee.io/test123',
    },
  });

  const mockFetch = createMockFetch({
    'api.github.com': [{ json: { message: 'Bad credentials' }, status: 401 }],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    expect(res.status).toBe(400);

    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('unauthorized');
  } finally {
    await close();
  }
});

// 7. POST /repos/remove — happy path: verify webhookId cleared

test('[needs:git-init] POST /repos/remove — happy path clears webhookId from config', async () => {
  const repoDir = path.join(tmpDir, 'repos-remove-happy-repo');
  makeGitRepo(repoDir, 'testowner', 'removerepo');

  const configPath = makeTempConfig('repos-remove-happy', {
    github: {
      accessToken: 'ghs_token',
      webhookSecret: 'test_secret',
      smeeUrl: 'https://smee.io/test123',
    },
    repoSettings: {
      [repoDir]: {
        webhookId: 55555,
        webhookEnabled: true,
      },
    },
  });

  const mockFetch = createMockFetch({
    'api.github.com': [
      // DELETE /repos/.../hooks/55555 → 200 (GitHub returns 204 in real life, but 204 + body is invalid)
      { json: {}, status: 200 },
    ],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);

    // Verify webhookId cleared
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      repoSettings?: Record<
        string,
        { webhookId?: number; webhookEnabled?: boolean }
      >;
    };
    expect(saved.repoSettings?.[repoDir]?.webhookId).toBe(undefined);
    expect(saved.repoSettings?.[repoDir]?.webhookEnabled).toBe(undefined);
  } finally {
    await close();
  }
});

// 8. DELETE /repos/remove with 404 — verify treated as success

test('[needs:git-init] POST /repos/remove — GitHub 404 is still treated as success', async () => {
  const repoDir = path.join(tmpDir, 'repos-remove-404-repo');
  makeGitRepo(repoDir, 'testowner', 'alreadydeleted');

  const configPath = makeTempConfig('repos-remove-404', {
    github: {
      accessToken: 'ghs_token',
      webhookSecret: 'test_secret',
      smeeUrl: 'https://smee.io/test123',
    },
    repoSettings: {
      [repoDir]: {
        webhookId: 11111,
        webhookEnabled: true,
      },
    },
  });

  const mockFetch = createMockFetch({
    'api.github.com': [
      // DELETE → 404 (already deleted)
      { json: { message: 'Not Found' }, status: 404 },
    ],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);

    // Local state cleared
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      repoSettings?: Record<string, { webhookId?: number }>;
    };
    expect(saved.repoSettings?.[repoDir]?.webhookId).toBe(undefined);
  } finally {
    await close();
  }
});

// 9. GET /status — returns correct state

test('GET /status — returns correct configured state', async () => {
  const configPath = makeTempConfig('status-configured', {
    github: {
      accessToken: 'ghs_token',
      webhookSecret: 'aabbccddeeff00112233445566778899aabbccec42',
      smeeUrl: 'https://smee.io/test123',
      autoProvision: true,
    },
  });

  const { url, close } = await startServer({ configPath });
  try {
    const res = await fetch(`${url}/webhooks/status`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      configured: boolean;
      smeeConnected: boolean;
      lastEventAt: string | null;
      autoProvision: boolean;
      secretPreview: string | null;
    };
    expect(data.configured).toBe(true);
    expect(typeof data.smeeConnected).toBe('boolean');
    expect(data.autoProvision).toBe(true);
    expect(data.secretPreview).toBeTruthy();
    expect(data.secretPreview!.startsWith('****')).toBe(true);
    expect(data.secretPreview!.slice(-4)).toBe(
      'c42'.padStart(4, data.secretPreview!.at(-4) ?? '0')
    );
  } finally {
    await close();
  }
});

test('GET /status — returns not configured when no webhook secret', async () => {
  const configPath = makeTempConfig('status-unconfigured', {
    github: { accessToken: 'ghs_token' },
  });

  const { url, close } = await startServer({ configPath });
  try {
    const res = await fetch(`${url}/webhooks/status`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      configured: boolean;
      secretPreview: string | null;
    };
    expect(data.configured).toBe(false);
    expect(data.secretPreview).toBe(null);
  } finally {
    await close();
  }
});

// 10. POST /backfill — partial failure (2 succeed, 1 fails with 403)

test('[needs:git-init] POST /backfill — partial failure returns correct totals', async () => {
  // Create 3 fake repos
  const repoA = path.join(tmpDir, 'backfill-repo-a');
  const repoB = path.join(tmpDir, 'backfill-repo-b');
  const repoC = path.join(tmpDir, 'backfill-repo-c');

  makeGitRepo(repoA, 'ownerA', 'repoA');
  makeGitRepo(repoB, 'ownerB', 'repoB');
  makeGitRepo(repoC, 'ownerC', 'repoC');

  const configPath = makeTempConfig('backfill-partial', {
    repos: [repoA, repoB, repoC],
    github: {
      accessToken: 'ghs_token',
      webhookSecret: 'test_secret',
      smeeUrl: 'https://smee.io/test123',
    },
  });

  // repoA → 201 success
  // repoB → 201 success
  // repoC → 403 forbidden
  const mockFetch = createMockFetch({
    'ownerA/repoA': [{ json: { id: 10001 }, status: 201 }],
    'ownerB/repoB': [{ json: { id: 10002 }, status: 201 }],
    'ownerC/repoC': [
      { json: { message: 'Must have admin rights' }, status: 403 },
    ],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/backfill`, { method: 'POST' });
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      total: number;
      success: number;
      failed: number;
      results: Array<{
        path: string;
        ownerRepo: string | null;
        ok: boolean;
        error?: string;
      }>;
    };

    expect(data.total).toBe(3);
    expect(data.success).toBe(2);
    expect(data.failed).toBe(1);
    expect(data.results.length).toBe(3);

    const failedResult = data.results.find((r) => !r.ok);
    expect(failedResult).toBeTruthy();
    expect(failedResult!.error).toBe('forbidden');
  } finally {
    await close();
  }
});

// 11. POST /ping — no webhook exists → error response

test('POST /ping — no webhook registered returns no_webhook error', async () => {
  const configPath = makeTempConfig('ping-no-webhook', {
    github: {
      accessToken: 'ghs_token',
      webhookSecret: 'test_secret',
      smeeUrl: 'https://smee.io/test123',
    },
    // No workspaceSettings with webhookId
  });

  // No mock fetch needed — shouldn't call GitHub API
  const { url, close } = await startServer({ configPath });
  try {
    const res = await fetch(`${url}/webhooks/ping`, { method: 'POST' });
    expect(res.status).toBe(200);

    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('no_webhook');
  } finally {
    await close();
  }
});

// ── Smart polling ──────────────────────────────────────────────────────────────

test('startSmartPolling broadcasts pr-updated and ci-updated for unwebhooked repos', async () => {
  const repoDir = path.join(tmpDir, 'smart-polling-repo');
  makeGitRepo(repoDir, 'testowner', 'testrepo');

  const configPath = makeTempConfig('smart-polling', {
    repos: [repoDir],
    repoSettings: {
      [repoDir]: { webhookEnabled: false },
    },
  });

  const broadcasts: Array<{ type: string; data?: Record<string, unknown> }> =
    [];
  const broadcastEvent = (type: string, data?: Record<string, unknown>) => {
    broadcasts.push({ type, data });
  };

  vi.useFakeTimers();
  startSmartPolling(configPath, broadcastEvent, {
    intervalMs: 1_000,
    buildRepoMap: async () => new Map([['testowner/testrepo', repoDir]]),
  });

  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(0);

  stopSmartPolling();
  vi.useRealTimers();

  expect(broadcasts.some((b) => b.type === 'pr-updated')).toBe(true);
  expect(broadcasts.some((b) => b.type === 'ci-updated')).toBe(true);
  const prUpdate = broadcasts.find((b) => b.type === 'pr-updated');
  expect(prUpdate?.data?.repos).toContain('testowner/testrepo');
});
