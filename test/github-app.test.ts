import { test, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

import {
  createGitHubAppRouter,
  _getDeviceFlowState,
} from '../server/github-app.js';
import { saveConfig, DEFAULTS } from '../server/config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type MockResponse =
  | { json: unknown; status?: number }
  | { error: unknown; status?: number }
  | { throw: Error };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a mock fetch function from a map of URL substrings to response sequences.
 * Each call to a matching URL pops the next response from the front of that sequence.
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
        if ('throw' in next) {
          throw next.throw;
        }
        const status = next.status ?? 200;
        const body = 'error' in next ? next.error : next.json;
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    throw new Error(`Mock fetch: no pattern matched url: ${url}`);
  };
}

function startServer(opts: {
  configPath: string;
  clientId?: string;
  fetchFn?: typeof globalThis.fetch;
  onConnected?: () => void;
}): Promise<{ srv: Server; url: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    const routerDeps: Parameters<typeof createGitHubAppRouter>[0] = {
      configPath: opts.configPath,
      clientId: opts.clientId ?? 'test-client-id',
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(opts.onConnected ? { onConnected: opts.onConnected } : {}),
    };
    app.use('/auth/github', createGitHubAppRouter(routerDeps));
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

/** Waits for a promise to resolve within timeoutMs, otherwise rejects. */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for: ${label}`)),
      timeoutMs
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** Returns a promise that resolves after ms milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the status endpoint until deviceFlowStatus matches the expected value,
 * or rejects after timeoutMs.
 */
async function waitForFlowStatus(
  url: string,
  expected: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${url}/auth/github/status`);
    const data = (await res.json()) as { deviceFlowStatus?: string };
    if (data.deviceFlowStatus === expected) return;
    await delay(50);
  }
  throw new Error(
    `Timeout after ${timeoutMs}ms waiting for deviceFlowStatus=${expected}`
  );
}

// ── Mock responses ────────────────────────────────────────────────────────────

const DEVICE_CODE_RESPONSE = {
  device_code: 'dc_test',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 1,
};

const DEVICE_CODE_RESPONSE_5S = { ...DEVICE_CODE_RESPONSE, interval: 5 };

const ACCESS_TOKEN_RESPONSE = { access_token: 'ghs_mock_token_123' };

const GRAPHQL_RESPONSE = { data: { viewer: { login: 'octocat' } } };

// ── Shared state ─────────────────────────────────────────────────────────────

let tmpDir: string;
let baseConfigPath: string;

/** Default server (no mock fetch — for the "no token" status test) */
let defaultServer: Server;
let defaultBaseUrl: string;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-app-test-'));
  baseConfigPath = path.join(tmpDir, 'config.json');
  saveConfig(baseConfigPath, { ...DEFAULTS });

  const result = await startServer({ configPath: baseConfigPath });
  defaultServer = result.srv;
  defaultBaseUrl = result.url;
});

afterAll(async () => {
  await stopServer(defaultServer);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /auth/github initiates device flow and returns userCode', async () => {
  const configPath = path.join(tmpDir, 'config-initiate.json');
  saveConfig(configPath, { ...DEFAULTS });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: DEVICE_CODE_RESPONSE_5S }],
  });

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });
  try {
    const res = await fetch(`${url}/auth/github`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      userCode: string;
      verificationUri: string;
      expiresIn: number;
    };
    expect(data.userCode).toBe('ABCD-1234');
    expect(data.verificationUri).toBe('https://github.com/login/device');
    expect(data.expiresIn).toBe(900);
  } finally {
    await stopServer(srv);
  }
});

test('GET /auth/github/status returns { connected: false } when no token', async () => {
  const res = await fetch(`${defaultBaseUrl}/auth/github/status`);
  expect(res.status).toBe(200);

  const data = (await res.json()) as {
    connected: boolean;
    username: string | null;
  };
  expect(data.connected).toBe(false);
  expect(data.username === null || data.username === undefined).toBeTruthy();
});

test('Device flow poll completes and saves token to config', async () => {
  const configPath = path.join(tmpDir, 'config-poll-complete.json');
  saveConfig(configPath, { ...DEFAULTS });

  let resolveConnected!: () => void;
  const connectedPromise = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: DEVICE_CODE_RESPONSE }],
    'login/oauth/access_token': [
      { json: { error: 'authorization_pending' } },
      { json: ACCESS_TOKEN_RESPONSE },
    ],
    'api.github.com/graphql': [{ json: GRAPHQL_RESPONSE }],
  });

  const { srv, url } = await startServer({
    configPath,
    fetchFn: mockFetch,
    onConnected: resolveConnected,
  });

  try {
    const res = await fetch(`${url}/auth/github`);
    expect(res.status).toBe(200);

    await withTimeout(connectedPromise, 10_000, 'onConnected callback');

    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      github?: { accessToken?: string; username?: string };
    };
    expect(savedConfig.github?.accessToken).toBe('ghs_mock_token_123');
    expect(savedConfig.github?.username).toBe('octocat');
  } finally {
    await stopServer(srv);
  }
});

test('GET /auth/github/status returns connected after device flow', async () => {
  const configPath = path.join(tmpDir, 'config-status-connected.json');
  saveConfig(configPath, { ...DEFAULTS });

  let resolveConnected!: () => void;
  const connectedPromise = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: DEVICE_CODE_RESPONSE }],
    'login/oauth/access_token': [{ json: ACCESS_TOKEN_RESPONSE }],
    'api.github.com/graphql': [{ json: GRAPHQL_RESPONSE }],
  });

  const { srv, url } = await startServer({
    configPath,
    fetchFn: mockFetch,
    onConnected: resolveConnected,
  });

  try {
    await fetch(`${url}/auth/github`);
    await withTimeout(connectedPromise, 10_000, 'onConnected callback');

    const res = await fetch(`${url}/auth/github/status`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      connected: boolean;
      username: string | null;
    };
    expect(data.connected).toBe(true);
    expect(data.username).toBe('octocat');
  } finally {
    await stopServer(srv);
  }
});

test('access_denied sets deviceFlowStatus to denied', async () => {
  const configPath = path.join(tmpDir, 'config-denied.json');
  saveConfig(configPath, { ...DEFAULTS });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: DEVICE_CODE_RESPONSE }],
    'login/oauth/access_token': [{ json: { error: 'access_denied' } }],
  });

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });

  try {
    const res = await fetch(`${url}/auth/github`);
    expect(res.status).toBe(200);

    // Poll until the flow status changes to denied (or time out)
    await waitForFlowStatus(url, 'denied', 5_000);

    const statusRes = await fetch(`${url}/auth/github/status`);
    expect(statusRes.status).toBe(200);

    const data = (await statusRes.json()) as {
      connected: boolean;
      username: string | null;
      deviceFlowStatus?: string;
    };
    expect(data.connected).toBe(false);
    expect(data.username).toBe(null);
    expect(data.deviceFlowStatus).toBe('denied');
  } finally {
    await stopServer(srv);
  }
});

test('expired_token sets deviceFlowStatus to expired', async () => {
  const configPath = path.join(tmpDir, 'config-expired.json');
  saveConfig(configPath, { ...DEFAULTS });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: DEVICE_CODE_RESPONSE }],
    'login/oauth/access_token': [{ json: { error: 'expired_token' } }],
  });

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });

  try {
    const res = await fetch(`${url}/auth/github`);
    expect(res.status).toBe(200);

    // Poll until the flow status changes to expired (or time out)
    await waitForFlowStatus(url, 'expired', 5_000);

    const statusRes = await fetch(`${url}/auth/github/status`);
    expect(statusRes.status).toBe(200);

    const data = (await statusRes.json()) as {
      connected: boolean;
      username: string | null;
      deviceFlowStatus?: string;
    };
    expect(data.connected).toBe(false);
    expect(data.username).toBe(null);
    expect(data.deviceFlowStatus).toBe('expired');
  } finally {
    await stopServer(srv);
  }
});

test('Device code initiation failure returns 500', async () => {
  const configPath = path.join(tmpDir, 'config-init-fail.json');
  saveConfig(configPath, { ...DEFAULTS });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: { error: 'server_error' }, status: 500 }],
  });

  const { srv, url } = await startServer({ configPath, fetchFn: mockFetch });

  try {
    const res = await fetch(`${url}/auth/github`);
    expect(res.status).toBe(500);

    const data = (await res.json()) as { error: string };
    expect(data.error).toBeTruthy();
  } finally {
    await stopServer(srv);
  }
});

test('slow_down increases poll interval', async () => {
  const configPath = path.join(tmpDir, 'config-slowdown.json');
  saveConfig(configPath, { ...DEFAULTS });

  let resolveConnected!: () => void;
  const connectedPromise = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  // Use interval: 1 so the first poll fires quickly, then slow_down bumps it to 6
  const deviceCodeWith1sInterval = { ...DEVICE_CODE_RESPONSE, interval: 1 };

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: deviceCodeWith1sInterval }],
    'login/oauth/access_token': [
      { json: { error: 'slow_down' } },
      { json: { error: 'authorization_pending' } },
      { json: ACCESS_TOKEN_RESPONSE },
    ],
    'api.github.com/graphql': [{ json: GRAPHQL_RESPONSE }],
  });

  const { srv, url } = await startServer({
    configPath,
    fetchFn: mockFetch,
    onConnected: resolveConnected,
  });

  try {
    await fetch(`${url}/auth/github`);

    // Wait long enough for the first poll (slow_down) to fire but not the second
    // Initial interval is 1s; after slow_down it becomes 6s
    await delay(1500);

    const state = _getDeviceFlowState();
    expect(state.interval).toBe(6);

    // Let the flow finish to clean up timers
    await withTimeout(connectedPromise, 15_000, 'onConnected after slow_down');
  } finally {
    await stopServer(srv);
  }
});

test('Network error during poll continues polling', async () => {
  const configPath = path.join(tmpDir, 'config-network-error.json');
  saveConfig(configPath, { ...DEFAULTS });

  let resolveConnected!: () => void;
  const connectedPromise = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: DEVICE_CODE_RESPONSE }],
    'login/oauth/access_token': [
      { throw: new Error('Network error') },
      { json: ACCESS_TOKEN_RESPONSE },
    ],
    'api.github.com/graphql': [{ json: GRAPHQL_RESPONSE }],
  });

  const { srv, url } = await startServer({
    configPath,
    fetchFn: mockFetch,
    onConnected: resolveConnected,
  });

  try {
    const res = await fetch(`${url}/auth/github`);
    expect(res.status).toBe(200);

    await withTimeout(
      connectedPromise,
      10_000,
      'onConnected after network error recovery'
    );

    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      github?: { accessToken?: string };
    };
    expect(savedConfig.github?.accessToken).toBe('ghs_mock_token_123');
  } finally {
    await stopServer(srv);
  }
});

test('Concurrent flow cancels previous', async () => {
  const configPath = path.join(tmpDir, 'config-concurrent.json');
  saveConfig(configPath, { ...DEFAULTS });

  let resolveConnected!: () => void;
  const connectedPromise = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  const firstDeviceCode = { ...DEVICE_CODE_RESPONSE, device_code: 'dc_first' };
  const secondDeviceCode = {
    ...DEVICE_CODE_RESPONSE,
    device_code: 'dc_second',
  };
  const secondAccessToken = { access_token: 'ghs_second_token' };

  // The mock uses pattern matching: both calls to login/device/code consume from the same queue
  const mockFetch = createMockFetch({
    'login/device/code': [
      { json: firstDeviceCode },
      { json: secondDeviceCode },
    ],
    'login/oauth/access_token': [{ json: secondAccessToken }],
    'api.github.com/graphql': [{ json: GRAPHQL_RESPONSE }],
  });

  const { srv, url } = await startServer({
    configPath,
    fetchFn: mockFetch,
    onConnected: resolveConnected,
  });

  try {
    // Fire both requests close together; the second supersedes the first
    await fetch(`${url}/auth/github`);
    await fetch(`${url}/auth/github`);

    await withTimeout(
      connectedPromise,
      10_000,
      'onConnected for second (winning) flow'
    );

    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      github?: { accessToken?: string };
    };
    expect(savedConfig.github?.accessToken).toBe('ghs_second_token');
  } finally {
    await stopServer(srv);
  }
});

test('POST /disconnect preserves webhookSecret and smeeUrl', async () => {
  const configPath = path.join(tmpDir, 'config-disconnect.json');
  saveConfig(configPath, {
    ...DEFAULTS,
    github: {
      accessToken: 'ghs_to_remove',
      username: 'testuser',
      webhookSecret: 'whsec_keep',
      smeeUrl: 'https://smee.io/keep',
    },
  });

  const { srv, url } = await startServer({ configPath });

  try {
    const res = await fetch(`${url}/auth/github/disconnect`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);

    // Verify token and username removed, but webhook config preserved
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      github?: {
        accessToken?: string;
        username?: string;
        webhookSecret?: string;
        smeeUrl?: string;
      };
    };
    expect(saved.github?.accessToken).toBe(undefined);
    expect(saved.github?.username).toBe(undefined);
    expect(saved.github?.webhookSecret).toBe('whsec_keep');
    expect(saved.github?.smeeUrl).toBe('https://smee.io/keep');

    // Status should show disconnected
    const statusRes = await fetch(`${url}/auth/github/status`);
    const statusData = (await statusRes.json()) as { connected: boolean };
    expect(statusData.connected).toBe(false);
  } finally {
    await stopServer(srv);
  }
});

test('Token saved without username when GraphQL fails', async () => {
  const configPath = path.join(tmpDir, 'config-no-username.json');
  saveConfig(configPath, { ...DEFAULTS });

  let resolveConnected!: () => void;
  const connectedPromise = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: DEVICE_CODE_RESPONSE }],
    'login/oauth/access_token': [{ json: ACCESS_TOKEN_RESPONSE }],
    'api.github.com/graphql': [{ json: {}, status: 500 }],
  });

  const { srv, url } = await startServer({
    configPath,
    fetchFn: mockFetch,
    onConnected: resolveConnected,
  });

  try {
    await fetch(`${url}/auth/github`);
    await withTimeout(
      connectedPromise,
      10_000,
      'onConnected after GraphQL failure'
    );

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      github?: { accessToken?: string; username?: string };
    };
    expect(saved.github?.accessToken).toBe('ghs_mock_token_123');
    expect(saved.github?.username).toBe(undefined);
  } finally {
    await stopServer(srv);
  }
});
