import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

import { createWebhookManagerRouter } from '../server/webhook-manager.js';
import { saveConfig, DEFAULTS } from '../server/config.js';
import type { Config } from '../server/types.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface MockResponse {
  json?: unknown;
  status?: number;
  headers?: Record<string, string>;
  throw?: Error;
}

// ── Mock fetch ─────────────────────────────────────────────────────────────────

/**
 * Creates a mock fetch function from a map of URL substrings → response sequences.
 * Each call to a matching URL pops the next response from the front of that sequence.
 * Supports `headers` override for redirect simulation (e.g., 302 with Location).
 */
function createMockFetch(
  urlMap: Record<string, MockResponse[]>
): typeof globalThis.fetch {
  const queues = new Map<string, MockResponse[]>(
    Object.entries(urlMap).map(([k, v]) => [k, [...v]])
  );

  return async (
    input: RequestInfo | URL,
    _init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    for (const [pattern, queue] of queues) {
      if (url.includes(pattern)) {
        const next = queue.shift();
        if (!next) {
          throw new Error(
            `Mock fetch: exhausted responses for pattern "${pattern}", url: ${url}`
          );
        }
        if (next.throw) {
          throw next.throw;
        }

        const status = next.status ?? 200;
        const body = next.json != null ? JSON.stringify(next.json) : '';
        const responseHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          ...next.headers,
        };
        return new Response(body, { status, headers: responseHeaders });
      }
    }

    throw new Error(`Mock fetch: no pattern matched url: ${url}`);
  };
}

// ── Server helpers ─────────────────────────────────────────────────────────────

/** No-op requireAuth middleware for testing (bypasses auth). */
const noopAuth = (
  _req: express.Request,
  _res: express.Response,
  next: express.NextFunction
): void => next();

function startServer(opts: {
  configPath: string;
  fetchFn?: typeof globalThis.fetch;
}): Promise<{ srv: Server; url: string }> {
  return new Promise((resolve) => {
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

    const srv = app.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      let url = '';
      if (typeof addr === 'object' && addr) {
        url = `http://127.0.0.1:${addr.port}`;
      }
      resolve({ srv, url });
    });
  });
}

function stopServer(srv: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (srv) srv.close(() => resolve());
    else resolve();
  });
}

// ── Shared state ───────────────────────────────────────────────────────────────

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-manager-test-'));
});

after(() => {
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
  execFileSync('git', ['init', dir], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', `https://github.com/${owner}/${repo}.git`],
    {
      cwd: dir,
      stdio: 'ignore',
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

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/setup`, { method: 'POST' });
    assert.equal(res.status, 200);

    const data = (await res.json()) as { ok: boolean; smeeUrl: string };
    assert.equal(data.ok, true);
    assert.equal(data.smeeUrl, 'https://smee.io/abc123def456');

    // Verify config was saved
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      github?: { smeeUrl?: string; webhookSecret?: string };
    };
    assert.equal(saved.github?.smeeUrl, 'https://smee.io/abc123def456');
    assert.ok(saved.github?.webhookSecret, 'webhookSecret should be set');
    assert.equal(
      saved.github!.webhookSecret!.length,
      40,
      'webhookSecret should be 20 bytes hex = 40 chars'
    );
  } finally {
    await stopServer(srv);
  }
});

// 2. POST /setup — smee.io unreachable: mock fetch throws, verify error response

test('POST /setup — smee.io unreachable returns error', async () => {
  const configPath = makeTempConfig('setup-unreachable');

  const mockFetch = createMockFetch({
    'smee.io/new': [{ throw: new Error('ECONNREFUSED') }],
  });

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/setup`, { method: 'POST' });
    assert.equal(res.status, 502);

    const data = (await res.json()) as { error: string };
    assert.equal(data.error, 'smee_unreachable');
  } finally {
    await stopServer(srv);
  }
});

// 3. POST /repos — happy path: mock GitHub API 201, verify webhookId saved

test('POST /repos — happy path creates webhook and saves webhookId', async () => {
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

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    assert.equal(res.status, 200);

    const data = (await res.json()) as { ok: boolean; webhookId: number };
    assert.equal(data.ok, true);
    assert.equal(data.webhookId, 99001);

    // Verify webhookId saved in config
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      repoSettings?: Record<
        string,
        { webhookId?: number; webhookEnabled?: boolean }
      >;
    };
    assert.equal(saved.repoSettings?.[repoDir]?.webhookId, 99001);
    assert.equal(saved.repoSettings?.[repoDir]?.webhookEnabled, true);
  } finally {
    await stopServer(srv);
  }
});

// 4. POST /repos — 403 forbidden: verify webhookError set to 'not-admin'

test('POST /repos — 403 forbidden sets webhookError to not-admin', async () => {
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

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    assert.equal(res.status, 403);

    const data = (await res.json()) as { error: string; webhookError: string };
    assert.equal(data.webhookError, 'not-admin');

    // Verify webhookError saved in config
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      repoSettings?: Record<string, { webhookError?: string }>;
    };
    assert.equal(saved.repoSettings?.[repoDir]?.webhookError, 'not-admin');
  } finally {
    await stopServer(srv);
  }
});

// 5. POST /repos — 422 conflict: verify treated as success

test('POST /repos — 422 conflict is treated as success (webhook already exists)', async () => {
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

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    assert.equal(res.status, 200);

    const data = (await res.json()) as { ok: boolean; webhookId: number };
    assert.equal(data.ok, true);
    assert.equal(data.webhookId, 77777);
  } finally {
    await stopServer(srv);
  }
});

// 6. POST /repos — 401 unauthorized: verify scope error response

test('POST /repos — 401 unauthorized returns unauthorized error', async () => {
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

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    assert.equal(res.status, 400);

    const data = (await res.json()) as { error: string };
    assert.equal(data.error, 'unauthorized');
  } finally {
    await stopServer(srv);
  }
});

// 7. POST /repos/remove — happy path: verify webhookId cleared

test('POST /repos/remove — happy path clears webhookId from config', async () => {
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

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    assert.equal(res.status, 200);

    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);

    // Verify webhookId cleared
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      repoSettings?: Record<
        string,
        { webhookId?: number; webhookEnabled?: boolean }
      >;
    };
    assert.equal(saved.repoSettings?.[repoDir]?.webhookId, undefined);
    assert.equal(saved.repoSettings?.[repoDir]?.webhookEnabled, undefined);
  } finally {
    await stopServer(srv);
  }
});

// 8. DELETE /repos/remove with 404 — verify treated as success

test('POST /repos/remove — GitHub 404 is still treated as success', async () => {
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

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/repos/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repoDir }),
    });
    assert.equal(res.status, 200);

    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);

    // Local state cleared
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      repoSettings?: Record<string, { webhookId?: number }>;
    };
    assert.equal(saved.repoSettings?.[repoDir]?.webhookId, undefined);
  } finally {
    await stopServer(srv);
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

  const { srv, url } = await startServer({ configPath });
  try {
    const res = await fetch(`${url}/webhooks/status`);
    assert.equal(res.status, 200);

    const data = (await res.json()) as {
      configured: boolean;
      smeeConnected: boolean;
      lastEventAt: string | null;
      autoProvision: boolean;
      secretPreview: string | null;
    };
    assert.equal(data.configured, true);
    assert.equal(typeof data.smeeConnected, 'boolean');
    assert.equal(data.autoProvision, true);
    assert.ok(data.secretPreview, 'secretPreview should be set');
    assert.ok(
      data.secretPreview!.startsWith('****'),
      'secretPreview should start with ****'
    );
    assert.equal(
      data.secretPreview!.slice(-4),
      'c42'.padStart(4, data.secretPreview!.at(-4) ?? '0')
    );
  } finally {
    await stopServer(srv);
  }
});

test('GET /status — returns not configured when no webhook secret', async () => {
  const configPath = makeTempConfig('status-unconfigured', {
    github: { accessToken: 'ghs_token' },
  });

  const { srv, url } = await startServer({ configPath });
  try {
    const res = await fetch(`${url}/webhooks/status`);
    assert.equal(res.status, 200);

    const data = (await res.json()) as {
      configured: boolean;
      secretPreview: string | null;
    };
    assert.equal(data.configured, false);
    assert.equal(data.secretPreview, null);
  } finally {
    await stopServer(srv);
  }
});

// 10. POST /backfill — partial failure (2 succeed, 1 fails with 403)

test('POST /backfill — partial failure returns correct totals', async () => {
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

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/webhooks/backfill`, { method: 'POST' });
    assert.equal(res.status, 200);

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

    assert.equal(data.total, 3);
    assert.equal(data.success, 2);
    assert.equal(data.failed, 1);
    assert.equal(data.results.length, 3);

    const failedResult = data.results.find((r) => !r.ok);
    assert.ok(failedResult, 'Should have one failed result');
    assert.equal(failedResult!.error, 'forbidden');
  } finally {
    await stopServer(srv);
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
  const { srv, url } = await startServer({ configPath });
  try {
    const res = await fetch(`${url}/webhooks/ping`, { method: 'POST' });
    assert.equal(res.status, 200);

    const data = (await res.json()) as { error: string };
    assert.equal(data.error, 'no_webhook');
  } finally {
    await stopServer(srv);
  }
});
