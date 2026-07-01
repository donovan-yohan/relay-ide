import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import getPort from 'get-port';
import { hashPin } from '../server/auth.js';

const __dirname = import.meta.dirname;

interface StartedServer {
  child: ChildProcess;
  port: number;
  tmpDir: string;
  authCookie: string;
}

function writeAgentStub(tmpDir: string, agent: string, body: string): void {
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, agent), body, { mode: 0o755 });
}

function writeTmuxStub(tmpDir: string): void {
  writeAgentStub(
    tmpDir,
    'tmux',
    `#!/bin/sh
if [ "$1" = "-V" ]; then
  echo "tmux 3.5"
fi
exit 0
`
  );
}

async function startHermesGatewayStub(tmpDir: string): Promise<{
  child: ChildProcess;
  endpoint: string;
  apiToken: string;
}> {
  const stubPath = path.resolve(
    __dirname,
    'fixtures',
    'hermes-gateway-stub.cjs'
  );
  const port = await getPort();
  const apiToken = 'test-hermes-key';
  const child = spawn(process.execPath, [stubPath, String(port)], {
    env: {
      ...process.env,
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: apiToken,
    },
    cwd: tmpDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Hermes gateway stub did not start within 5s'));
    }, 5000);
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Hermes gateway stub listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`Hermes gateway stub exited with code ${code}: ${stderr}`)
      );
    });
  });

  return { child, endpoint: `http://127.0.0.1:${port}`, apiToken };
}

async function startRelayServer(
  tmpDir: string,
  envOverrides: Record<string, string> = {}
): Promise<StartedServer> {
  const configPath = path.join(tmpDir, 'config.json');
  const pin = '123456';
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      port: 0,
      host: '127.0.0.1',
      repos: [tmpDir],
      pinHash: await hashPin(pin),
    })
  );

  const serverScript = path.resolve(
    __dirname,
    '..',
    'dist',
    'server',
    'index.js'
  );
  const envPath = path.join(tmpDir, 'bin') + ':' + (process.env.PATH ?? '');
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      RELAY_IDE_DEV_INSTANCE: '1',
      PATH: envPath,
      ...envOverrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server did not start within 10s'));
    }, 10_000);
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

  const loginRes = await fetch(`http://127.0.0.1:${port}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (loginRes.status !== 200) {
    throw new Error(`Failed to login test server: ${loginRes.status}`);
  }
  const authCookie = loginRes.headers.get('set-cookie') ?? '';
  if (!authCookie.includes('token=')) {
    throw new Error('Failed to capture test auth cookie');
  }

  return { child, port, tmpDir, authCookie };
}

async function stopRelayServer(server: StartedServer): Promise<void> {
  server.child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    server.child.on('exit', () => resolve());
    setTimeout(resolve, 3000);
  });
  fs.rmSync(server.tmpDir, { recursive: true, force: true });
}

async function stopChild(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    setTimeout(resolve, 3000);
  });
}

/**
 * End-to-end API test for creating a Hermes web session.
 *
 * Spins up the compiled relay-ide server with an already-running mock Hermes
 * gateway, calls POST /sessions with agent=hermes, and verifies the response
 * contains a web session with the correct agent type.
 */
test('POST /sessions creates a hermes web session visible in the session list', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-hermes-api-e2e-')
  );
  writeAgentStub(
    tmpDir,
    'hermes',
    `#!/usr/bin/env node
process.exit(0);
`
  );
  const gateway = await startHermesGatewayStub(tmpDir);
  const server = await startRelayServer(tmpDir, {
    HERMES_API_ENDPOINT: gateway.endpoint,
    HERMES_API_TOKEN: gateway.apiToken,
  });

  try {
    // 1) Create a hermes session via the public API
    const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: server.authCookie,
      },
      body: JSON.stringify({
        repoPath: tmpDir,
        type: 'agent',
        agent: 'hermes',
        mode: 'web',
      }),
    });

    expect(createRes.status).toBe(201);
    const session = (await createRes.json()) as {
      id: string;
      agent: string;
      mode: string;
      status: string;
      runtimeOwnership?: string;
    };

    expect(session.agent).toBe('hermes');
    expect(session.mode).toBe('web');
    expect(session.status).toBe('active');
    expect(session.runtimeOwnership).toBe('attached');

    // 2) Verify it appears in GET /sessions
    const listRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      headers: { Cookie: server.authCookie },
    });
    expect(listRes.status).toBe(200);
    const sessions = (await listRes.json()) as Array<{
      id: string;
      agent: string;
      mode: string;
    }>;

    const found = sessions.find((s) => s.id === session.id);
    expect(found).toBeDefined();
    expect(found!.agent).toBe('hermes');
    expect(found!.mode).toBe('web');
  } finally {
    await stopRelayServer(server);
    await stopChild(gateway.child);
  }
}, 20_000);

// Regression guard for issue #300: Claude web sessions are de-advertised
// pending end-to-end verification of the protocol adapter. A POST /sessions
// request for `claude` in `mode: 'web'` must be rejected with a structured
// `agent_unavailable` error and a message that references the gap.
test('POST /sessions rejects claude web mode (de-advertised, issue #300)', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-claude-api-e2e-')
  );
  writeAgentStub(
    tmpDir,
    'claude',
    `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`
  );
  const server = await startRelayServer(tmpDir);

  try {
    const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: server.authCookie,
      },
      body: JSON.stringify({
        repoPath: tmpDir,
        type: 'agent',
        agent: 'claude',
        mode: 'web',
      }),
    });

    expect(createRes.status).toBe(400);
    expect(createRes.headers.get('content-type')).toContain('application/json');
    const body = (await createRes.json()) as {
      error?: string;
      message?: string;
      agent?: string;
    };
    expect(body.error).toBe('agent_unavailable');
    expect(body.agent).toBe('claude');
    expect(body.message ?? '').toMatch(/300|not yet verified|end-to-end/i);
  } finally {
    await stopRelayServer(server);
  }
}, 20_000);

test('POST /sessions returns structured json when host hermes gateway is unreachable', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-hermes-api-e2e-')
  );
  writeAgentStub(
    tmpDir,
    'hermes',
    `#!/usr/bin/env node
process.exit(0);
`
  );
  const unusedPort = await getPort();
  const server = await startRelayServer(tmpDir, {
    HERMES_API_ENDPOINT: `http://127.0.0.1:${unusedPort}`,
  });

  try {
    const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: server.authCookie,
      },
      body: JSON.stringify({
        repoPath: tmpDir,
        type: 'agent',
        agent: 'hermes',
        mode: 'web',
      }),
    });

    expect(createRes.status).toBe(400);
    expect(createRes.headers.get('content-type')).toContain('application/json');
    await expect(createRes.json()).resolves.toMatchObject({
      error: 'agent_unavailable',
      agent: 'hermes',
      message: expect.stringContaining('Hermes gateway API is not reachable'),
    });
  } finally {
    await stopRelayServer(server);
  }
}, 20_000);

test('POST /sessions rejects hermes when the host CLI is not installed', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-hermes-api-e2e-')
  );
  writeTmuxStub(tmpDir);
  const gateway = await startHermesGatewayStub(tmpDir);
  const server = await startRelayServer(tmpDir, {
    HERMES_API_ENDPOINT: gateway.endpoint,
    HERMES_API_TOKEN: gateway.apiToken,
    PATH: path.join(tmpDir, 'bin'),
  });

  try {
    const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: server.authCookie,
      },
      body: JSON.stringify({
        repoPath: tmpDir,
        type: 'agent',
        agent: 'hermes',
        mode: 'web',
      }),
    });

    expect(createRes.status).toBe(400);
    await expect(createRes.json()).resolves.toMatchObject({
      error: 'agent_unavailable',
      agent: 'hermes',
      message: 'hermes CLI not found on PATH',
    });
  } finally {
    await stopRelayServer(server);
    await stopChild(gateway.child);
  }
}, 20_000);

// Regression guard for #1062: ticketContext validation used to run only on
// the PTY branch of POST /sessions, so a malformed ticketContext launched in
// `mode: 'web'` silently skipped validation entirely (the branch returned
// before that code ran). Validation is now hoisted above the mode branch, so
// both modes must reject the same malformed ticketContext with the same 400
// shape.
test('POST /sessions rejects an invalid ticketContext the same way for pty and web modes (#1062)', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-hermes-ticket-e2e-')
  );
  writeAgentStub(
    tmpDir,
    'hermes',
    `#!/usr/bin/env node
process.exit(0);
`
  );
  const server = await startRelayServer(tmpDir);

  const invalidTicketContext = {
    ticketId: '42', // missing the required GH-<number> shape
    title: 'Fix the thing',
    url: 'https://github.com/donovan-yohan/relay-ide/issues/42',
    source: 'github',
    repoPath: tmpDir,
    repoName: 'relay-ide',
  };

  try {
    const bodies: Array<Record<string, unknown>> = [];
    for (const mode of ['pty', 'web'] as const) {
      const createRes = await fetch(
        `http://127.0.0.1:${server.port}/sessions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: server.authCookie,
          },
          body: JSON.stringify({
            repoPath: tmpDir,
            type: 'agent',
            agent: 'hermes',
            mode,
            ticketContext: invalidTicketContext,
          }),
        }
      );
      expect(createRes.status).toBe(400);
      const body = (await createRes.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        error: 'ticketContext.ticketId for github must match GH-<number>',
      });
      bodies.push(body);
    }
    // Identical error shape regardless of which mode branch validated it.
    expect(bodies[0]).toEqual(bodies[1]);
  } finally {
    await stopRelayServer(server);
  }
}, 20_000);

// Regression guard for #1062: a well-formed ticketContext must be accepted
// on the web-mode branch (previously it was ignored, not validated) and the
// session must still be created normally.
test('POST /sessions creates a hermes web session launched from a valid ticketContext (#1062)', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-hermes-ticket-e2e-')
  );
  writeAgentStub(
    tmpDir,
    'hermes',
    `#!/usr/bin/env node
process.exit(0);
`
  );
  const gateway = await startHermesGatewayStub(tmpDir);
  const server = await startRelayServer(tmpDir, {
    HERMES_API_ENDPOINT: gateway.endpoint,
    HERMES_API_TOKEN: gateway.apiToken,
  });

  try {
    const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: server.authCookie,
      },
      body: JSON.stringify({
        repoPath: tmpDir,
        type: 'agent',
        agent: 'hermes',
        mode: 'web',
        ticketContext: {
          ticketId: 'GH-42',
          title: 'Fix the thing',
          url: 'https://github.com/donovan-yohan/relay-ide/issues/42',
          source: 'github',
          repoPath: tmpDir,
          repoName: 'relay-ide',
        },
      }),
    });

    expect(createRes.status).toBe(201);
    const session = (await createRes.json()) as {
      agent: string;
      mode: string;
    };
    expect(session.agent).toBe('hermes');
    expect(session.mode).toBe('web');
  } finally {
    await stopRelayServer(server);
    await stopChild(gateway.child);
  }
}, 20_000);
