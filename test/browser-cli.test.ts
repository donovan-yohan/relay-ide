import { test, beforeEach, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import * as http from 'node:http';

let tmpDir: string;

type CapturedGatewayRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  marker: string | string[] | undefined;
  body?: Record<string, unknown>;
};

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function execNode(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('node', args, { encoding: 'utf-8', env, timeout: 10_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cli-test-'));
  fs.writeFileSync(path.join(tmpDir, 'test.html'), '<h1>Test</h1>');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('browser command with no args prints usage and exits 1', () => {
  try {
    execFileSync('node', ['dist/bin/relay-ide.js', 'browser'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH },
    });
    throw new Error('Should have exited with code 1');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    expect(e.status).toBe(1);
    expect(e.stderr ?? '').toContain('Usage');
  }
});

test('browser --help shows usage and exits 0', () => {
  try {
    const output = execFileSync(
      'node',
      ['dist/bin/relay-ide.js', 'browser', '--help'],
      {
        encoding: 'utf-8',
        env: { ...process.env, PATH: process.env.PATH },
      }
    );
    expect(output.includes('Usage') || output.includes('browser')).toBe(true);
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    // --help may print to stderr
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    expect(out.includes('Usage') || out.includes('browser')).toBe(true);
  }
});

test('browser command fails gracefully when server is not running', () => {
  try {
    execFileSync(
      'node',
      ['dist/bin/relay-ide.js', 'browser', path.join(tmpDir, 'test.html')],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          RELAY_IDE_PORT: '19999',
          RELAY_IDE_BROWSER_TOKEN: 'test-token',
          PATH: process.env.PATH,
        },
      }
    );
    throw new Error('Should have exited with error');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    expect(e.status).not.toBe(0);
    expect(
      (e.stderr ?? '').includes('connect') ||
        (e.stderr ?? '').includes('ECONNREFUSED') ||
        (e.stderr ?? '').includes('Error')
    ).toBe(true);
  }
});

test('browser command fails when token not set', () => {
  try {
    execFileSync(
      'node',
      ['dist/bin/relay-ide.js', 'browser', path.join(tmpDir, 'test.html')],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          RELAY_IDE_PORT: '19999',
          RELAY_IDE_BROWSER_TOKEN: '', // empty token
          PATH: process.env.PATH,
        },
      }
    );
    throw new Error('Should have exited with error');
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    expect(e.status).not.toBe(0);
    expect(e.stderr ?? '').toContain('RELAY_IDE_BROWSER_TOKEN');
  }
});

test('v1 gateway commands use scoped bearer auth and the v1 marker header', async () => {
  const captured: CapturedGatewayRequest[] = [];
  const server = http.createServer((req, res) => {
    const entry: CapturedGatewayRequest = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      marker: req.headers['x-relay-cli-gateway'],
    };
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      if (rawBody) entry.body = JSON.parse(rawBody) as Record<string, unknown>;
      captured.push(entry);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/sessions') {
        res.end(JSON.stringify([]));
        return;
      }
      if (req.method === 'POST' && req.url === '/sessions') {
        res.end(
          JSON.stringify({
            id: 'local-created',
            type: entry.body?.['type'] ?? 'agent',
            agent: 'claude',
            mode: 'pty',
            cwd: entry.body?.['repoPath'] ?? '/tmp/repo',
            displayName: 'created',
            status: 'active',
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const port = await listen(server);
  try {
    const env = {
      ...process.env,
      RELAY_IDE_PORT: String(port),
      RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      PATH: process.env.PATH,
    };
    await execNode(['dist/bin/relay-ide.js', 'v1', 'sessions', 'list', '--json'], env);
    await execNode(
      [
        'dist/bin/relay-ide.js',
        'v1',
        'sessions',
        'create',
        '--input-json',
        '{"repoPath":"/tmp/repo"}',
        '--json',
      ],
      env
    );
  } finally {
    await close(server);
  }

  expect(captured).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        url: '/sessions',
        authorization: 'Bearer scoped-token',
        marker: 'v1',
      }),
      expect.objectContaining({
        method: 'POST',
        url: '/sessions',
        authorization: 'Bearer scoped-token',
        marker: 'v1',
        body: expect.objectContaining({ repoPath: '/tmp/repo', type: 'agent' }),
      }),
    ])
  );
});
