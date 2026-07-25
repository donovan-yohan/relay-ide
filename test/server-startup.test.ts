import { expect, test, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { hashPin } from '../server/auth.js';
import {
  closeRelayStateDb,
  initRelayStateDb,
  upsertWebSessionNow,
} from '../server/relay-state-db.js';
import type { SessionSummary, WebSession } from '../server/types.js';
import { emptyAgentSessionV2 } from '../shared/agent-chat-protocol-v2.js';
import {
  CLI_GATEWAY_ACTOR_AUDIENCE,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
} from '../server/cli-gateway-actor-auth.js';

const SERVER_SCRIPT = path.resolve(
  import.meta.dirname,
  '..',
  'dist',
  'server',
  'index.js'
);
const HANGING_CODEX_APP_SERVER = path.resolve(
  import.meta.dirname,
  'fixtures',
  'hanging-codex-app-server.mjs'
);

if (!fs.existsSync(SERVER_SCRIPT)) {
  throw new Error('dist/server/index.js missing — run npm run build first');
}

interface StartServerOpts {
  env: Record<string, string>;
}

async function waitForListeningPort(
  child: ChildProcess,
  timeoutMs = 10_000
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server did not start within ${timeoutMs}ms`));
    }, timeoutMs);
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/listening on [\w.]+:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with code ${code}. stderr: ${stderr}`));
    });
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  // Wait for the child to fully exit before cleaning up temp files.
  // Without this, SQLite WAL/SHM files may still be open, causing ENOTEMPTY.
  // Reject on timeout (not resolve) — a non-exiting server is a real bug and
  // should fail the test loudly instead of racing with the rmSync in finally.
  await new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      reject(new Error('Server did not exit within 10s of SIGTERM'));
    }, 10000);
    child.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function startServer(opts: StartServerOpts): ChildProcess {
  return spawn(process.execPath, [SERVER_SCRIPT], {
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function captureOutput(child: ChildProcess): {
  stdout(): string;
  stderr(): string;
} {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function seedHangingCodexSession(configDir: string): void {
  const id = 'startup-hanging-codex';
  const now = new Date().toISOString();
  const session = {
    mode: 'web',
    id,
    type: 'agent',
    agent: 'codex',
    cwd: configDir,
    displayName: 'Restored hanging Codex',
    createdAt: now,
    lastActivity: now,
    idle: true,
    customCommand: null,
    status: 'active',
    needsBranchRename: false,
    agentState: 'idle',
    adapterV2: {
      disconnect: async () => {},
    },
    adapterType: 'codex',
    agentSessionV2: emptyAgentSessionV2({
      id,
      provider: 'codex',
      cwd: configDir,
      capabilities: { resume: true },
      providerSession: { threadId: 'thread-that-never-reattaches' },
      config: {
        providerOptions: {
          command: process.execPath,
          args: [HANGING_CODEX_APP_SERVER],
        },
      },
    }),
    agentPatchesV2: [],
    protocolVersion: 2,
    currentTurnId: null,
    runtimeOwnership: 'spawned',
    hookToken: 'startup-hanging-codex-hook',
    hooksActive: true,
  } as unknown as WebSession;

  initRelayStateDb(configDir);
  try {
    upsertWebSessionNow(session);
  } finally {
    closeRelayStateDb();
  }
}

async function waitForRestoredSession(
  baseUrl: string,
  cookie: string,
  predicate: (session: SessionSummary) => boolean,
  timeoutMs = 5_000
): Promise<SessionSummary> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/sessions`, {
      headers: { cookie },
    });
    if (response.ok) {
      const sessions = (await response.json()) as SessionSummary[];
      const session = sessions.find(
        (candidate) =>
          candidate.id === 'startup-hanging-codex' && predicate(candidate)
      );
      if (session) return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    'restored hanging Codex session did not reach expected state'
  );
}

function cookieFromSetCookie(headers: Headers): string {
  const raw = headers.get('set-cookie');
  if (!raw) throw new Error('expected set-cookie header');
  return raw.split(';')[0] ?? raw;
}

async function expectJsonStatus<T>(
  res: Response,
  status: number,
  label: string
): Promise<T> {
  const body = (await res.json()) as T;
  expect(res.status, label).toBe(status);
  return body;
}

async function rawUpgradeStatus(
  port: number,
  pathName: string
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        [
          `GET ${pathName} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n')
      );
    });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for raw upgrade response'));
    }, 3000);
    let response = '';
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString();
      const match = response.match(/^HTTP\/1\.1\s+(\d+)/);
      if (match) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(Number(match[1]));
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    socket.on('end', () => {
      const match = response.match(/^HTTP\/1\.1\s+(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
  });
}

test('server starts without PIN in non-TTY mode and serves /auth/status', async () => {
  // Create a temporary config with no pinHash
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-test-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 0, host: '127.0.0.1' }));

  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
    },
  });

  try {
    const port = await waitForListeningPort(child);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      lagMs: expect.any(Number),
      rss: expect.any(Number),
    });

    // Hit GET /auth/status — should work without auth
    const res = await fetch(`http://127.0.0.1:${port}/auth/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasPIN: boolean };
    expect(body.hasPIN).toBe(false);
  } finally {
    await killAndWait(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('real server listens before a hanging serialized-session restore', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-listen-before-restore-')
  );
  const configPath = path.join(tmpDir, 'config.json');
  const pin = '246810';
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      port: 0,
      host: '127.0.0.1',
      pinHash: await hashPin(pin),
      cookieTTL: '1h',
    })
  );
  seedHangingCodexSession(tmpDir);

  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      RELAY_IDE_WEB_SESSION_REATTACH_TIMEOUT_MS: '500',
      RELAY_IDE_TEST_STARTUP_RESTORE_HOLD_MS: '1000',
      NODE_ENV: 'test',
      HOME: tmpDir,
    },
  });
  const output = captureOutput(child);

  try {
    const port = await waitForListeningPort(child);
    const baseUrl = `http://127.0.0.1:${String(port)}`;

    const [health, authStatus] = await Promise.all([
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/auth/status`),
    ]);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: 'ok' });
    expect(authStatus.status).toBe(200);
    await expect(authStatus.json()).resolves.toEqual({ hasPIN: true });
    // The real startup restore function is still held. This proves both public
    // routes answered while restore remained incomplete.
    expect(output.stdout()).not.toContain(
      'Restored 1 session(s) from previous update.'
    );

    const login = await fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    expect(login.status).toBe(200);
    const cookie = cookieFromSetCookie(login.headers);

    await waitForRestoredSession(
      baseUrl,
      cookie,
      (session) => session.restoreState === 'restoring'
    );
    const failed = await waitForRestoredSession(
      baseUrl,
      cookie,
      (session) => session.restoreState === 'reattach-failed'
    );
    expect(failed).toMatchObject({
      status: 'disconnected',
      agentState: 'error',
      restoreState: 'reattach-failed',
    });

    await vi.waitFor(() =>
      expect(output.stdout()).toContain(
        'Restored 1 session(s) from previous update.'
      )
    );
    const listeningAt = output
      .stdout()
      .indexOf('relay-ide listening on 127.0.0.1:');
    const restoredAt = output
      .stdout()
      .indexOf('Restored 1 session(s) from previous update.');
    expect(listeningAt, output.stderr()).toBeGreaterThanOrEqual(0);
    expect(restoredAt, output.stderr()).toBeGreaterThan(listeningAt);
  } finally {
    await killAndWait(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Regression: relay-ide --bg first-run crash loop (#151)
// When launchctl/systemd run the daemon in background mode (RELAY_IDE_BACKGROUND=1)
// and no PIN is yet configured, the server must stay running and listen on the
// configured port instead of throwing and exiting — otherwise the service manager
// respawns it forever in a crash loop.
test('--bg startup with no PIN configured does not crash-loop (#151)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bg-first-run-'));
  // Intentionally do NOT write a config file — simulate true first-run.
  const configPath = path.join(tmpDir, 'config.json');

  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      RELAY_IDE_BACKGROUND: '1',
      // Force a fresh HOME so initFileLogging / telemetry / push key paths
      // resolve under tmpDir instead of the developer's real config.
      HOME: tmpDir,
    },
  });

  try {
    const port = await waitForListeningPort(child);

    // /auth/status must report needs-setup (hasPIN=false), proving the server
    // came up cleanly without a configured PIN.
    const res = await fetch(`http://127.0.0.1:${port}/auth/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasPIN: boolean };
    expect(body.hasPIN).toBe(false);

    // Server must still be alive — if it had crashed, exitCode would be set.
    expect(child.exitCode).toBeNull();
  } finally {
    await killAndWait(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('legacy disabled PIN sentinel allows first-run setup instead of lockout', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-disabled-pin-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ port: 0, host: '127.0.0.1', pinHash: 'disabled' })
  );

  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      HOME: tmpDir,
    },
  });

  try {
    const port = await waitForListeningPort(child);
    const base = `http://127.0.0.1:${port}`;

    const status = await fetch(`${base}/auth/status`);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ hasPIN: false });

    const setup = await fetch(`${base}/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '246810', confirm: '246810' }),
    });
    await expectJsonStatus<{ ok: true }>(setup, 200, 'PIN setup');
    const cookie = cookieFromSetCookie(setup.headers);

    const protectedRoute = await fetch(`${base}/auth/check`, {
      headers: { cookie },
    });
    await expectJsonStatus<{ ok: true }>(
      protectedRoute,
      200,
      'browser session after setup'
    );
  } finally {
    await killAndWait(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('NO_PIN does not bypass protected browser or CLI gateway auth paths', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-no-pin-no-bypass-')
  );
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      port: 0,
      host: '127.0.0.1',
      pinHash: await hashPin('246810'),
      cookieTTL: '1h',
    })
  );

  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      NO_PIN: '1',
      HOME: tmpDir,
    },
  });

  try {
    const port = await waitForListeningPort(child);
    const base = `http://127.0.0.1:${port}`;

    const browserRoute = await fetch(`${base}/hub/confirmations`);
    expect(browserRoute.status).toBe(401);

    const badPinLogin = await fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'wrong' }),
    });
    expect(badPinLogin.status).toBe(401);

    const cliGatewayRoute = await fetch(`${base}/sessions`, {
      headers: { 'x-relay-cli-gateway': 'v1' },
    });
    expect(cliGatewayRoute.status).toBe(401);

    await expect(rawUpgradeStatus(port, '/ws/events')).resolves.toBe(401);
  } finally {
    await killAndWait(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('protected hub accepts grant-backed CLI actor credential for nodes.list without browser-cookie fallback', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-cli-actor-protected-')
  );
  const configPath = path.join(tmpDir, 'config.json');
  const pin = '246810';
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      port: 0,
      host: '127.0.0.1',
      pinHash: await hashPin(pin),
      cookieTTL: '1h',
    })
  );

  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      HOME: tmpDir,
    },
  });

  try {
    const port = await waitForListeningPort(child);
    const base = `http://127.0.0.1:${port}`;

    const unauthenticatedNodes = await fetch(`${base}/nodes`, {
      headers: { 'x-relay-cli-gateway': 'v1' },
    });
    expect(unauthenticatedNodes.status).toBe(401);

    const login = await fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    await expectJsonStatus<{ ok: true }>(login, 200, 'PIN login');
    const cookie = cookieFromSetCookie(login.headers);

    const grantRequest = await fetch(`${base}/hub/operator-handshake-grants`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: { type: 'cli', id: 'relay-cli-regression' },
        issuer: { id: 'browser-operator-test' },
        audience: CLI_GATEWAY_ACTOR_AUDIENCE,
        capabilities: ['session:read'],
        scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
        ttlMs: 60_000,
      }),
    });
    const requested = await expectJsonStatus<{ grant: { id: string } }>(
      grantRequest,
      201,
      'operator grant request'
    );

    const grantApproval = await fetch(
      `${base}/hub/operator-handshake-grants/${encodeURIComponent(requested.grant.id)}/approve`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ approvedBy: { id: 'browser-operator-test' } }),
      }
    );
    const approved = await expectJsonStatus<{ handle: string }>(
      grantApproval,
      200,
      'operator grant approval'
    );

    const minted = await fetch(`${base}/cli-gateway/actor-credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grantHandle: approved.handle,
        audience: CLI_GATEWAY_ACTOR_AUDIENCE,
        actor: { type: 'cli', id: 'relay-cli-regression' },
        capabilities: ['session:read'],
        scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
        ttlMs: 60_000,
      }),
    });
    const issued = await expectJsonStatus<{ token: string }>(
      minted,
      201,
      'grant-backed actor credential mint'
    );

    const actorNodes = await fetch(`${base}/nodes`, {
      headers: {
        authorization: `Bearer ${issued.token}`,
        'x-relay-cli-gateway': 'v1',
        'x-relay-capabilities': 'session:read',
      },
    });
    await expectJsonStatus<{ nodes: unknown[] }>(
      actorNodes,
      200,
      'actor nodes.list'
    );

    const nodeCredentialNodes = await fetch(`${base}/nodes`, {
      headers: {
        authorization: 'Bearer node_fake.secret_fake',
        'x-relay-cli-gateway': 'v1',
        'x-relay-node-id': 'node-fake',
        'x-relay-node-credential': 'node_fake.secret_fake',
      },
    });
    expect(nodeCredentialNodes.status).toBe(401);
  } finally {
    await killAndWait(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scoped actor sessions.create spawns an in-scope controlled worker and rejects an out-of-scope cwd', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-cli-actor-session-create-')
  );
  const outsideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-cli-actor-session-outside-')
  );
  const configPath = path.join(tmpDir, 'config.json');
  const binDir = path.join(tmpDir, 'bin');
  const codexStub = path.join(binDir, 'codex');
  const authorizedDir = path.join(tmpDir, 'authorized');
  const authorizedLink = path.join(tmpDir, 'authorized-link');
  const topicOutsideDir = path.join(tmpDir, 'topic-outside');
  const pin = '246810';
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(authorizedDir);
  fs.mkdirSync(topicOutsideDir);
  fs.symlinkSync(authorizedDir, authorizedLink, 'dir');
  fs.writeFileSync(
    codexStub,
    '#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n'
  );
  fs.chmodSync(codexStub, 0o755);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      port: 0,
      host: '127.0.0.1',
      repos: [tmpDir],
      pinHash: await hashPin(pin),
      cookieTTL: '1h',
    })
  );

  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      HOME: tmpDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });

  try {
    const port = await waitForListeningPort(child);
    const base = `http://127.0.0.1:${port}`;
    const canonicalRepoPath = fs.realpathSync(tmpDir);
    const canonicalAuthorizedPath = fs.realpathSync(authorizedDir);
    const orchestratorSessionId = 'orchestrator-session-1257';

    const login = await fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    await expectJsonStatus<{ ok: true }>(login, 200, 'PIN login');
    const cookie = cookieFromSetCookie(login.headers);

    const grantRequest = await fetch(`${base}/hub/operator-handshake-grants`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: {
          type: 'agent',
          id: 'orchestrator-1257',
          displayName: 'Issue 1257 orchestrator',
        },
        issuer: { id: 'browser-operator-test' },
        audience: CLI_GATEWAY_ACTOR_AUDIENCE,
        capabilities: ['session:create:agent'],
        scope: {
          sessionIds: [orchestratorSessionId],
          pathPrefixes: [canonicalAuthorizedPath],
        },
        ttlMs: 60_000,
      }),
    });
    const requested = await expectJsonStatus<{ grant: { id: string } }>(
      grantRequest,
      201,
      'operator session-create grant request'
    );

    const grantApproval = await fetch(
      `${base}/hub/operator-handshake-grants/${encodeURIComponent(requested.grant.id)}/approve`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ approvedBy: { id: 'browser-operator-test' } }),
      }
    );
    const approved = await expectJsonStatus<{ handle: string }>(
      grantApproval,
      200,
      'operator session-create grant approval'
    );

    const minted = await fetch(`${base}/cli-gateway/actor-credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grantHandle: approved.handle,
        audience: CLI_GATEWAY_ACTOR_AUDIENCE,
        actor: {
          type: 'agent',
          id: 'orchestrator-1257',
          displayName: 'Issue 1257 orchestrator',
        },
        capabilities: ['session:create:agent'],
        scope: {
          sessionIds: [orchestratorSessionId],
          pathPrefixes: [canonicalAuthorizedPath],
        },
        ttlMs: 60_000,
      }),
    });
    const issued = await expectJsonStatus<{ token: string }>(
      minted,
      201,
      'grant-backed session-create actor credential mint'
    );
    const actorHeaders = {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
      'x-relay-cli-gateway': 'v1',
      'x-relay-cli-command': 'sessions.create',
    };

    const inScopeCreate = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: actorHeaders,
      body: JSON.stringify({
        cwd: authorizedLink,
        type: 'agent',
        agent: 'codex',
        displayName: 'Scoped worker',
        spawnedBySessionId: orchestratorSessionId,
      }),
    });
    const created = await expectJsonStatus<{
      id: string;
      cwd: string;
      spawnedBySessionId?: string;
      activeActors?: Array<{
        kind: string;
        id?: string;
        sessionId?: string;
      }>;
      activeWorker?: { id?: string };
    }>(inScopeCreate, 201, 'in-scope actor sessions.create');
    expect(created.cwd).toBe(canonicalAuthorizedPath);
    expect(created.spawnedBySessionId).toBe(orchestratorSessionId);
    expect(created.activeWorker?.id).toBe(created.id);
    expect(created.activeActors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'agent', id: created.id }),
        expect.objectContaining({
          kind: 'agent',
          id: 'agent:orchestrator-1257',
          sessionId: orchestratorSessionId,
        }),
      ])
    );

    const topicCreate = await fetch(`${base}/workspace-topics`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-relay-capabilities': 'context:write',
      },
      body: JSON.stringify({
        id: 'topic:actor-scope-bypass-1257',
        workspaceId: 'ws-actor-scope-1257',
        title: 'Actor scope bypass regression',
        routingDefaults: {
          repoPath: canonicalRepoPath,
          worktreePath: fs.realpathSync(topicOutsideDir),
        },
      }),
    });
    await expectJsonStatus<{ topic: { id: string } }>(
      topicCreate,
      201,
      'workspace topic bypass fixture'
    );

    const topicBypassCreate = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: actorHeaders,
      body: JSON.stringify({
        cwd: authorizedLink,
        workspaceTopicId: 'topic:actor-scope-bypass-1257',
        type: 'agent',
        agent: 'codex',
        spawnedBySessionId: orchestratorSessionId,
      }),
    });
    await expectJsonStatus<{
      error: { code: string; reasonCode: string };
    }>(topicBypassCreate, 403, 'topic-expanded out-of-scope actor create').then(
      (body) => {
        expect(body.error).toMatchObject({
          code: 'FORBIDDEN',
          reasonCode: 'CLI_ACTOR_WRONG_PATH_SCOPE',
        });
      }
    );

    const outOfScopeCreate = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: actorHeaders,
      body: JSON.stringify({
        cwd: fs.realpathSync(outsideDir),
        type: 'agent',
        agent: 'codex',
      }),
    });
    await expectJsonStatus<{
      error: { code: string; reasonCode: string };
    }>(outOfScopeCreate, 403, 'out-of-scope actor sessions.create').then(
      (body) => {
        expect(body.error).toMatchObject({
          code: 'FORBIDDEN',
          reasonCode: 'CLI_ACTOR_WRONG_PATH_SCOPE',
        });
      }
    );
  } finally {
    await killAndWait(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
