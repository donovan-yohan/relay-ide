import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const __dirname = import.meta.dirname;

interface StartedServer {
  child: ChildProcess;
  port: number;
  tmpDir: string;
}

function writeAgentStub(tmpDir: string, agent: string, body: string): void {
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, agent), body, { mode: 0o755 });
}

function writeWorkingHermesStub(tmpDir: string): void {
  const stubPath = path.resolve(__dirname, 'fixtures', 'hermes-gateway-stub.cjs');

  // The adapter calls: hermes gateway run --port <port>
  // Our stub expects: node stub.js <port>
  writeAgentStub(
    tmpDir,
    'hermes',
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx !== -1 ? args[portIdx + 1] : process.argv[2];
process.argv = [process.argv[0], process.argv[1], port];
require('${stubPath.replace(/\\/g, '\\\\')}');
`
  );
}

async function startRelayServer(tmpDir: string): Promise<StartedServer> {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ port: 0, host: '127.0.0.1', repos: [tmpDir] })
  );

  const serverScript = path.resolve(__dirname, '..', 'dist', 'server', 'index.js');
  const envPath = path.join(tmpDir, 'bin') + ':' + (process.env.PATH ?? '');
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      RELAY_IDE_CONFIG: configPath,
      RELAY_IDE_PORT: '0',
      NO_PIN: '1',
      PATH: envPath,
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

  return { child, port, tmpDir };
}

async function stopRelayServer(server: StartedServer): Promise<void> {
  server.child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    server.child.on('exit', () => resolve());
    setTimeout(resolve, 3000);
  });
  fs.rmSync(server.tmpDir, { recursive: true, force: true });
}

/**
 * End-to-end API test for creating a Hermes web session.
 *
 * Spins up the compiled relay-ide server with a mock `hermes` binary in PATH,
 * calls POST /sessions with agent=hermes, and verifies the response
 * contains a web session with the correct agent type.
 */
test(
  'POST /sessions creates a hermes web session visible in the session list',
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hermes-api-e2e-'));
    writeWorkingHermesStub(tmpDir);
    const server = await startRelayServer(tmpDir);

    try {
      // 1) Create a hermes session via the public API
      const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        sessionType?: string;
      };

      expect(session.agent).toBe('hermes');
      expect(session.mode).toBe('web');
      expect(session.status).toBe('active');

      // 2) Verify it appears in GET /sessions
      const listRes = await fetch(`http://127.0.0.1:${server.port}/sessions`);
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
    }
  },
  20_000
);

test(
  'POST /sessions honors web mode for claude protocol adapter sessions',
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-claude-api-e2e-'));
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: tmpDir,
          type: 'agent',
          agent: 'claude',
          mode: 'web',
        }),
      });

      expect(createRes.status).toBe(201);
      const session = (await createRes.json()) as {
        agent: string;
        mode: string;
        adapterType?: string;
      };
      expect(session.agent).toBe('claude');
      expect(session.mode).toBe('web');
      expect(session.adapterType).toBe('claude');
    } finally {
      await stopRelayServer(server);
    }
  },
  20_000
);

test(
  'POST /sessions returns structured json when hermes gateway startup fails',
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hermes-api-e2e-'));
    writeAgentStub(
      tmpDir,
      'hermes',
      `#!/usr/bin/env node
process.stderr.write('mock hermes gateway failed to start\\n');
process.exit(2);
`
    );
    const server = await startRelayServer(tmpDir);

    try {
      const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: tmpDir,
          type: 'agent',
          agent: 'hermes',
          mode: 'web',
        }),
      });

      expect(createRes.status).toBe(500);
      expect(createRes.headers.get('content-type')).toContain('application/json');
      await expect(createRes.json()).resolves.toMatchObject({
        error: 'session_create_failed',
        message: 'Failed to create session.',
      });
    } finally {
      await stopRelayServer(server);
    }
  },
  20_000
);
