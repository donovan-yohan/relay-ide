import { test, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
    const timeout = setTimeout(() => {
      reject(new Error('Server did not exit within 3s of SIGTERM'));
    }, 3000);
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

test('server starts without PIN in non-TTY mode and serves /auth/status', async () => {
  // Create a temporary config with no pinHash
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-test-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 0, host: '127.0.0.1' }));

  const child = startServer({
    env: {
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      NO_PIN: '1',
    },
  });

  try {
    const port = await waitForListeningPort(child);

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

test('protected hub accepts grant-backed CLI actor credential for nodes.list without browser-cookie fallback', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-actor-protected-'));
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
    await expectJsonStatus<{ nodes: unknown[] }>(actorNodes, 200, 'actor nodes.list');

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
