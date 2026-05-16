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

async function execNode(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      'node',
      args,
      { encoding: 'utf-8', env, timeout: 10_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

function parseEnvelope<T = unknown>(stdout: string): {
  ok: boolean;
  command: string;
  data: T;
} {
  return JSON.parse(stdout) as { ok: boolean; command: string; data: T };
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


test('v1 gateway smoke lists node, creates/attaches, reads files, and detaches without kill', async () => {
  const captured: CapturedGatewayRequest[] = [];
  const session = {
    id: 'remote-session-1',
    globalSessionId: 'node-a:remote-session-1',
    nodeId: 'node-a',
    type: 'terminal',
    agent: 'shell',
    mode: 'pty',
    cwd: '/fixture',
    displayName: 'fixture terminal',
    status: 'active',
  };
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

      if (req.method === 'GET' && req.url === '/nodes') {
        res.end(
          JSON.stringify({
            nodes: [
              {
                nodeId: 'node-a',
                status: 'online',
                availability: 'available',
                cwd: '/fixture',
              },
            ],
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/hub/nodes/node-a/sessions') {
        res.statusCode = 201;
        res.end(JSON.stringify(session));
        return;
      }
      if (req.method === 'GET' && req.url === '/sessions/remote-session-1') {
        res.end(JSON.stringify(session));
        return;
      }
      if (
        req.method === 'POST' &&
        req.url === '/hub/nodes/node-a/sessions/remote-session-1/files/list'
      ) {
        res.end(
          JSON.stringify({
            operation: 'list',
            root: '/fixture',
            cwd: '/fixture',
            path: '/fixture',
            entries: [
              {
                path: '/fixture/hello.txt',
                name: 'hello.txt',
                type: 'file',
                size: 12,
                mtimeMs: 1,
                mode: 0o100644,
              },
            ],
            truncated: false,
            maxEntries: entry.body?.['maxEntries'] ?? 100,
          })
        );
        return;
      }
      if (
        req.method === 'POST' &&
        req.url === '/hub/nodes/node-a/sessions/remote-session-1/files/read'
      ) {
        res.end(
          JSON.stringify({
            operation: 'read',
            root: '/fixture',
            cwd: '/fixture',
            path: '/fixture/hello.txt',
            encoding: 'utf8',
            content: 'hello gateway\n',
            bytesRead: 14,
            truncatedBytes: false,
            truncatedLines: false,
            maxBytes: entry.body?.['maxBytes'] ?? 32768,
            maxLines: entry.body?.['maxLines'],
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
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
    const nodes = parseEnvelope<{ nodes: unknown[] }>(
      await execNode(['dist/bin/relay-ide.js', 'v1', 'nodes', 'list', '--json'], env)
    );
    expect(nodes).toMatchObject({ ok: true, command: 'nodes.list' });
    expect(nodes.data.nodes).toHaveLength(1);

    const created = parseEnvelope<typeof session>(
      await execNode(
        [
          'dist/bin/relay-ide.js',
          'v1',
          'sessions',
          'create',
          '--input-json',
          '{"nodeId":"node-a","cwd":"/fixture","type":"terminal"}',
          '--json',
        ],
        env
      )
    );
    expect(created).toMatchObject({ ok: true, command: 'sessions.create' });
    expect(created.data).toMatchObject({ id: 'remote-session-1', nodeId: 'node-a' });

    const attached = parseEnvelope<{ attach: { streaming: boolean }; session: typeof session }>(
      await execNode(
        ['dist/bin/relay-ide.js', 'v1', 'sessions', 'attach', '--id', 'remote-session-1', '--json'],
        env
      )
    );
    expect(attached.data.attach.streaming).toBe(false);

    const listed = parseEnvelope<{ entries: Array<{ name: string }> }>(
      await execNode(
        [
          'dist/bin/relay-ide.js',
          'v1',
          'files',
          'list',
          '--session-id',
          'remote-session-1',
          '--path',
          '.',
          '--max-entries',
          '5',
          '--json',
        ],
        env
      )
    );
    expect(listed.data.entries[0]?.name).toBe('hello.txt');

    const read = parseEnvelope<{ content: string; maxBytes: number; maxLines: number }>(
      await execNode(
        [
          'dist/bin/relay-ide.js',
          'v1',
          'files',
          'read',
          '--session-id',
          'remote-session-1',
          '--path',
          'hello.txt',
          '--max-bytes',
          '64',
          '--max-lines',
          '2',
          '--json',
        ],
        env
      )
    );
    expect(read.data).toMatchObject({ content: 'hello gateway\n', maxBytes: 64, maxLines: 2 });

    const detached = parseEnvelope<{ detached: boolean; killed: boolean; session: typeof session }>(
      await execNode(
        ['dist/bin/relay-ide.js', 'v1', 'sessions', 'detach', '--id', 'remote-session-1', '--json'],
        env
      )
    );
    expect(detached.data).toMatchObject({ detached: true, killed: false });

    const stillThere = parseEnvelope<typeof session>(
      await execNode(
        ['dist/bin/relay-ide.js', 'v1', 'sessions', 'get', '--id', 'remote-session-1', '--json'],
        env
      )
    );
    expect(stillThere.data).toMatchObject({ id: 'remote-session-1', status: 'active' });
  } finally {
    await close(server);
  }

  expect(captured.map((entry) => `${entry.method} ${entry.url}`)).toEqual(
    expect.arrayContaining([
      'GET /nodes',
      'POST /hub/nodes/node-a/sessions',
      'POST /hub/nodes/node-a/sessions/remote-session-1/files/list',
      'POST /hub/nodes/node-a/sessions/remote-session-1/files/read',
      'GET /sessions/remote-session-1',
    ])
  );
  expect(captured.some((entry) => entry.method === 'DELETE')).toBe(false);
  expect(
    captured.find((entry) => entry.url?.endsWith('/files/read'))?.body
  ).toMatchObject({ path: 'hello.txt', maxBytes: 64, maxLines: 2 });
});
