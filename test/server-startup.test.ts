import { test, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
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
