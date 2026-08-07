import { test, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import {
  createGitHubAppRouter,
  _getDeviceFlowState,
} from '../server/github-app.js';
import { saveConfig, DEFAULTS } from '../server/config.js';
import { createMockFetch } from './helpers/mock-fetch.js';
import { createTestServer } from './helpers/test-server.js';

async function startServer(opts: {
  configPath: string;
  clientId?: string;
  fetchFn?: typeof globalThis.fetch;
  onConnected?: () => void;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  const routerDeps: Parameters<typeof createGitHubAppRouter>[0] = {
    configPath: opts.configPath,
    clientId: opts.clientId ?? 'test-client-id',
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.onConnected ? { onConnected: opts.onConnected } : {}),
  };
  app.use('/auth/github', createGitHubAppRouter(routerDeps));
  return createTestServer(app);
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
let defaultBaseUrl: string;
let closeDefaultServer: () => Promise<void>;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-app-test-'));
  baseConfigPath = path.join(tmpDir, 'config.json');
  saveConfig(baseConfigPath, { ...DEFAULTS });

  const result = await startServer({ configPath: baseConfigPath });
  defaultBaseUrl = result.url;
  closeDefaultServer = result.close;
});

afterAll(async () => {
  await closeDefaultServer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /auth/github initiates device flow and returns userCode', async () => {
  const configPath = path.join(tmpDir, 'config-initiate.json');
  saveConfig(configPath, { ...DEFAULTS });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: DEVICE_CODE_RESPONSE_5S }],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });
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
    await close();
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

  const { url, close } = await startServer({
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
    await close();
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

  const { url, close } = await startServer({
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
    await close();
  }
});

test('access_denied sets deviceFlowStatus to denied', async () => {
  const configPath = path.join(tmpDir, 'config-denied.json');
  saveConfig(configPath, { ...DEFAULTS });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: DEVICE_CODE_RESPONSE }],
    'login/oauth/access_token': [{ json: { error: 'access_denied' } }],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });

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
    await close();
  }
});

test('expired_token sets deviceFlowStatus to expired', async () => {
  const configPath = path.join(tmpDir, 'config-expired.json');
  saveConfig(configPath, { ...DEFAULTS });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: DEVICE_CODE_RESPONSE }],
    'login/oauth/access_token': [{ json: { error: 'expired_token' } }],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });

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
    await close();
  }
});

test('Device code initiation failure returns 500', async () => {
  const configPath = path.join(tmpDir, 'config-init-fail.json');
  saveConfig(configPath, { ...DEFAULTS });

  const mockFetch = createMockFetch({
    'login/device/code': [{ json: { error: 'server_error' }, status: 500 }],
  });

  const { url, close } = await startServer({ configPath, fetchFn: mockFetch });

  try {
    const res = await fetch(`${url}/auth/github`);
    expect(res.status).toBe(500);

    const data = (await res.json()) as { error: string };
    expect(data.error).toBeTruthy();
  } finally {
    await close();
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

  const { url, close } = await startServer({
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
    await close();
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

  const { url, close } = await startServer({
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
    await close();
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

  const { url, close } = await startServer({
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
    await close();
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

  const { url, close } = await startServer({ configPath });

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
    await close();
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

  const { url, close } = await startServer({
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
    await close();
  }
});
