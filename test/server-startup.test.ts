import { expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { hashPin } from '../server/auth.js';
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

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 10_000
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
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
    await expect(health.json()).resolves.toEqual({
      status: 'ok',
      lagMs: expect.any(Number),
      rss: expect.any(Number),
      // Per-process identity a restart-waiting client compares against (#1285).
      bootId: expect.any(String),
      ready: expect.any(Boolean),
      resume: {
        inProgress: expect.any(Boolean),
        complete: expect.any(Boolean),
        restored: expect.any(Number),
        failed: expect.any(Boolean),
      },
    });

    // Hit GET /auth/status — should work without auth
    const res = await fetch(`http://127.0.0.1:${port}/auth/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasPIN: boolean };
    expect(body).toEqual({ hasPIN: false });
  } finally {
    await killAndWait(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fatal persistence failure exits before listening without degraded opt-in', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-persistence-fatal-')
  );
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 0, host: '127.0.0.1' }));
  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      NODE_ENV: 'test',
      RELAY_IDE_TEST_FAIL_PERSISTENCE_STORES: 'channel-messages',
    },
  });

  try {
    await expect(waitForChildExit(child, 1_000)).resolves.toBe(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await killAndWait(child);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('allow-degraded boot reports disabled persistence through health and auth', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-persistence-degraded-')
  );
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 0, host: '127.0.0.1' }));
  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      NODE_ENV: 'test',
      RELAY_IDE_ALLOW_DEGRADED: '1',
      RELAY_IDE_TEST_FAIL_PERSISTENCE_STORES: 'channel-messages,analytics',
    },
  });

  try {
    const port = await waitForListeningPort(child);
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const [health, authStatus] = await Promise.all([
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/auth/status`),
    ]);

    expect(health.status).toBe(503);
    await expect(health.json()).resolves.toMatchObject({
      status: 'degraded',
      disabledStores: ['channel-messages', 'analytics'],
    });
    expect(authStatus.status).toBe(200);
    await expect(authStatus.json()).resolves.toEqual({
      hasPIN: false,
      status: 'degraded',
      disabledStores: ['channel-messages', 'analytics'],
    });
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
    const issued = await expectJsonStatus<{
      token: string;
      credential: { id: string };
    }>(minted, 201, 'grant-backed actor credential mint');

    const actorNodes = await fetch(`${base}/nodes`, {
      headers: {
        authorization: `Bearer ${issued.token}`,
        'x-relay-cli-gateway': 'v1',
        'x-relay-cli-command': 'nodes.list',
        'x-relay-capabilities': 'session:read',
      },
    });
    await expectJsonStatus<{ nodes: unknown[] }>(
      actorNodes,
      200,
      'actor nodes.list'
    );

    for (const command of [undefined, 'sessions.list']) {
      const denied = await fetch(`${base}/nodes`, {
        headers: {
          authorization: `Bearer ${issued.token}`,
          'x-relay-cli-gateway': 'v1',
          ...(command ? { 'x-relay-cli-command': command } : {}),
          'x-relay-capabilities': 'session:read',
        },
      });
      expect(denied.status).toBe(401);
    }

    const browserNodes = await fetch(`${base}/nodes`, { headers: { cookie } });
    expect(browserNodes.status).toBe(200);

    const revoked = await fetch(
      `${base}/cli-gateway/actor-credentials/${encodeURIComponent(issued.credential.id)}`,
      { method: 'DELETE', headers: { cookie } }
    );
    expect(revoked.status).toBe(200);
    const revokedActorNodes = await fetch(`${base}/nodes`, {
      headers: {
        authorization: `Bearer ${issued.token}`,
        'x-relay-cli-gateway': 'v1',
        'x-relay-cli-command': 'nodes.list',
        'x-relay-capabilities': 'session:read',
      },
    });
    expect(revokedActorNodes.status).toBe(401);

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

test('real channel middleware enforces registry-issued channel leases and preserves browser access', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-channel-lease-'));
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
    env: { RELAY_IDE_CONFIG: configPath, RELAY_IDE_PORT: '0', HOME: tmpDir },
  });
  try {
    const port = await waitForListeningPort(child);
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    await expectJsonStatus<{ ok: true }>(login, 200, 'PIN login');
    const cookie = cookieFromSetCookie(login.headers);
    const createTopic = async (title: string) =>
      expectJsonStatus<{ topic: { id: string } }>(
        await fetch(`${base}/workspace-topics`, {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/json',
            'x-relay-capabilities': 'context:write',
          },
          body: JSON.stringify({ workspaceId: 'workspace:local', title }),
        }),
        201,
        `create ${title}`
      );
    const channelA = (await createTopic('Lease A')).topic.id;
    const channelB = (await createTopic('Lease B')).topic.id;

    const requested = await expectJsonStatus<{ grant: { id: string } }>(
      await fetch(`${base}/hub/operator-handshake-grants`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: { type: 'cli', id: 'channel-lease-peer' },
          issuer: { id: 'browser-operator-test' },
          audience: CLI_GATEWAY_ACTOR_AUDIENCE,
          capabilities: ['context:read', 'context:write'],
          scope: { channelIds: [channelA] },
          ttlMs: 60_000,
        }),
      }),
      201,
      'channel grant request'
    );
    const approved = await expectJsonStatus<{ handle: string }>(
      await fetch(
        `${base}/hub/operator-handshake-grants/${encodeURIComponent(requested.grant.id)}/approve`,
        {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ approvedBy: { id: 'browser-operator-test' } }),
        }
      ),
      200,
      'channel grant approval'
    );
    const issued = await expectJsonStatus<{ token: string }>(
      await fetch(`${base}/cli-gateway/actor-credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grantHandle: approved.handle,
          audience: CLI_GATEWAY_ACTOR_AUDIENCE,
          actor: { type: 'cli', id: 'channel-lease-peer' },
          capabilities: ['context:read', 'context:write'],
          scope: { channelIds: [channelA] },
          ttlMs: 60_000,
        }),
      }),
      201,
      'channel actor credential mint'
    );
    const actorHeaders = (command: string) => ({
      authorization: `Bearer ${issued.token}`,
      'x-relay-cli-gateway': 'v1',
      'x-relay-cli-command': command,
      'x-relay-capabilities':
        command === 'channels.post' ? 'context:write' : 'context:read',
    });
    expect(
      (
        await fetch(`${base}/channels/${encodeURIComponent(channelA)}`, {
          headers: actorHeaders('channels.get'),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/channels/${encodeURIComponent(channelB)}`, {
          headers: actorHeaders('channels.get'),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/channels/${encodeURIComponent(channelA)}`, {
          headers: { cookie, 'x-relay-capabilities': 'context:read' },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/channels/${encodeURIComponent(channelA)}`, {
          headers: {
            ...actorHeaders('channels.get'),
            'x-relay-cli-command': 'channels.history',
          },
        })
      ).status
    ).toBe(401);
  } finally {
    await killAndWait(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scoped actor sessions.create launches only in-scope terminals and rejects an out-of-scope cwd', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-cli-actor-session-create-')
  );
  const outsideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-cli-actor-session-outside-')
  );
  const configPath = path.join(tmpDir, 'config.json');
  const binDir = path.join(tmpDir, 'bin');
  const codexStub = path.join(binDir, 'codex');
  const claudeStub = path.join(binDir, 'claude');
  const hermesStub = path.join(binDir, 'hermes');
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
  for (const stub of [claudeStub, hermesStub]) {
    fs.copyFileSync(codexStub, stub);
    fs.chmodSync(stub, 0o755);
  }
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

  const hermesGateway = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) =>
    hermesGateway.listen(0, '127.0.0.1', resolve)
  );
  const hermesAddress = hermesGateway.address();
  if (!hermesAddress || typeof hermesAddress === 'string') {
    throw new Error('Hermes test gateway did not bind');
  }

  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      HOME: tmpDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      HERMES_API_ENDPOINT: `http://127.0.0.1:${hermesAddress.port}`,
    },
  });

  try {
    const port = await waitForListeningPort(child);
    const base = `http://127.0.0.1:${port}`;
    const canonicalRepoPath = fs.realpathSync(tmpDir);
    const canonicalAuthorizedPath = fs.realpathSync(authorizedDir);
    const forgedParentSessionId = 'forged-public-session-1257';

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
          id: 'agent-profile:claude:orchestrator-1257',
          displayName: 'Issue 1257 orchestrator',
        },
        issuer: { id: 'browser-operator-test' },
        audience: CLI_GATEWAY_ACTOR_AUDIENCE,
        capabilities: ['session:create:terminal'],
        scope: {
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
          id: 'agent-profile:claude:orchestrator-1257',
          displayName: 'Issue 1257 orchestrator',
        },
        capabilities: ['session:create:terminal'],
        scope: {
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

    const credentialsBeforeHermes = await fetch(
      `${base}/cli-gateway/actor-credentials`,
      { headers: { cookie } }
    ).then((response) =>
      expectJsonStatus<{
        credentials: Array<{ metadata?: { reason?: string } }>;
      }>(response, 200, 'credential list before actor Hermes create')
    );
    const actorHermesCreate = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: actorHeaders,
      body: JSON.stringify({
        cwd: authorizedLink,
        type: 'terminal',
      }),
    });
    const actorHermes = await expectJsonStatus<{
      id: string;
      type: string;
      activityState: string;
    }>(actorHermesCreate, 201, 'actor terminal create');
    expect(actorHermes.type).toBe('terminal');
    expect(actorHermes).not.toHaveProperty('role');
    expect(actorHermes).not.toHaveProperty('spawnedBySessionId');
    const credentialsAfterHermes = await fetch(
      `${base}/cli-gateway/actor-credentials`,
      { headers: { cookie } }
    ).then((response) =>
      expectJsonStatus<{
        credentials: Array<{ metadata?: { reason?: string } }>;
      }>(response, 200, 'credential list after actor Hermes create')
    );
    expect(credentialsAfterHermes.credentials).toHaveLength(
      credentialsBeforeHermes.credentials.length
    );
    expect(
      credentialsAfterHermes.credentials.filter(
        (credential) =>
          credential.metadata?.reason === 'persistent-orchestrator'
      )
    ).toHaveLength(0);

    const actorClaudeCreate = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: actorHeaders,
      body: JSON.stringify({
        cwd: authorizedLink,
        type: 'terminal',
      }),
    });
    const actorClaude = await expectJsonStatus<{
      type: string;
      activityState: string;
    }>(actorClaudeCreate, 201, 'second actor terminal create');
    expect(actorClaude).toMatchObject({ type: 'terminal' });
    expect(actorClaude).not.toHaveProperty('role');
    expect(actorClaude).not.toHaveProperty('spawnedBySessionId');

    const inScopeCreate = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: actorHeaders,
      body: JSON.stringify({
        cwd: authorizedLink,
        type: 'terminal',
        displayName: 'Scoped terminal',
      }),
    });
    const created = await expectJsonStatus<{
      id: string;
      cwd: string;
      spawnedBySessionId?: string;
      role?: string;
    }>(inScopeCreate, 201, 'in-scope actor terminal create');
    expect(created.cwd).toBe(canonicalAuthorizedPath);
    expect(created.spawnedBySessionId).toBeUndefined();
    expect(created.role).toBeUndefined();

    const forgedLineageCreate = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: actorHeaders,
      body: JSON.stringify({
        cwd: authorizedLink,
        type: 'terminal',
        spawnedBySessionId: forgedParentSessionId,
      }),
    });
    await expectJsonStatus<{
      error: { code: string; reasonCode: string };
    }>(forgedLineageCreate, 403, 'forged actor terminal lineage').then(
      (body) => {
        expect(body.error.code).toBe('FORBIDDEN');
      }
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
        type: 'terminal',
        spawnedBySessionId: forgedParentSessionId,
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
        type: 'terminal',
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
    await new Promise<void>((resolve, reject) =>
      hermesGateway.close((error) => (error ? reject(error) : resolve()))
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
