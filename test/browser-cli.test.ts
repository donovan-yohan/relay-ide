import { test, beforeEach, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import * as http from 'node:http';
import { WebSocketServer } from 'ws';

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
  if (!address || typeof address === 'string')
    throw new Error('missing server address');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function execNode(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
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

async function execNodeFailure(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{
  status: number | string | undefined;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    execFile(
      'node',
      args,
      { encoding: 'utf-8', env, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (!error) {
          reject(new Error(`expected command to fail: node ${args.join(' ')}`));
          return;
        }
        const execError = error as { code?: number | string };
        resolve({ status: execError.code, stdout, stderr });
      }
    );
  });
}

function parseEnvelope<T = unknown>(
  stdout: string
): {
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
    await execNode(
      ['dist/bin/relay-ide.js', 'v1', 'sessions', 'list', '--json'],
      env
    );
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
        body: expect.objectContaining({
          repoPath: '/tmp/repo',
          type: 'terminal',
        }),
      }),
    ])
  );
});

test('v1 workspace-topics search preserves array scope and update accepts body id', async () => {
  const captured: CapturedGatewayRequest[] = [];
  const server = http.createServer((req, res) => {
    const entry: CapturedGatewayRequest = {
      method: req.method,
      url: req.url,
      authorization: req.headers['authorization'],
      marker: req.headers['x-relay-cli-gateway'],
    };
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      if (rawBody) entry.body = JSON.parse(rawBody) as Record<string, unknown>;
      captured.push(entry);
      res.setHeader('content-type', 'application/json');
      if (
        req.method === 'GET' &&
        req.url?.startsWith('/workspace-topics/search?')
      ) {
        res.end(
          JSON.stringify({
            query: 'bounded',
            results: [],
            truncated: false,
            derived: false,
          })
        );
        return;
      }
      if (
        req.method === 'PATCH' &&
        req.url === '/workspace-topics/topic-body'
      ) {
        res.end(
          JSON.stringify({
            topic: { id: 'topic-body', display: { title: 'Updated' } },
            mutationPolicy: {},
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
    await execNode(
      [
        'dist/bin/relay-ide.js',
        'v1',
        'workspace-topics',
        'search',
        '--q',
        'bounded',
        '--work-context-id',
        'wc-singular',
        '--work-context-ids',
        'wc-plural,wc-extra',
        '--work-context-ids',
        'wc-second',
        '--json',
      ],
      env
    );
    await execNode(
      [
        'dist/bin/relay-ide.js',
        'v1',
        'workspace-topics',
        'update',
        '--input-json',
        '{"id":"topic-body","title":"Updated"}',
        '--json',
      ],
      env
    );
  } finally {
    await close(server);
  }

  const searchRequest = captured.find((entry) => entry.method === 'GET');
  expect(searchRequest?.url).toBeDefined();
  const searchParams = new URL(searchRequest?.url ?? '/', 'http://127.0.0.1')
    .searchParams;
  expect(searchParams.get('workContextId')).toBe('wc-singular');
  expect(searchParams.getAll('workContextIds')).toEqual([
    'wc-plural',
    'wc-extra',
    'wc-second',
  ]);
  expect(captured).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        method: 'PATCH',
        url: '/workspace-topics/topic-body',
        body: expect.objectContaining({ id: 'topic-body', title: 'Updated' }),
      }),
    ])
  );
});

test('v1 files.read preserves its command envelope when session lookup fails', async () => {
  const captured: CapturedGatewayRequest[] = [];
  const server = http.createServer((req, res) => {
    captured.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      marker: req.headers['x-relay-cli-gateway'],
    });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/sessions/missing') {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'session not found' },
        })
      );
      return;
    }
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: { code: 'INTERNAL', message: 'unexpected route' },
      })
    );
  });
  const port = await listen(server);
  try {
    const env = {
      ...process.env,
      RELAY_IDE_PORT: String(port),
      RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      PATH: process.env.PATH,
    };
    const failure = await execNodeFailure(
      [
        'dist/bin/relay-ide.js',
        'v1',
        'files',
        'read',
        '--session-id',
        'missing',
        '--path',
        'hello.txt',
        '--json',
      ],
      env
    );
    const envelope = JSON.parse(failure.stdout) as {
      ok: boolean;
      command: string;
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };
    expect(failure.status).not.toBe(0);
    expect(envelope).toMatchObject({
      ok: false,
      command: 'files.read',
      error: { code: 'NOT_FOUND' },
    });
    expect(envelope.error.message).toContain('session not found');
  } finally {
    await close(server);
  }

  expect(captured.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
    'GET /sessions/missing',
  ]);
});

test('v1 gateway smoke lists node, creates/attaches, reads files, and detaches without kill', async () => {
  const captured: CapturedGatewayRequest[] = [];
  const session = {
    id: 'remote-session-1',
    globalSessionId: 'node-a:remote-session-1',
    nodeId: 'node-a',
    type: 'terminal',
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
        req.url === '/hub/nodes/node-a/sessions/remote-session-1/files/stat'
      ) {
        res.end(
          JSON.stringify({
            operation: 'stat',
            root: '/fixture',
            cwd: '/fixture',
            path: '/fixture/hello.txt',
            name: 'hello.txt',
            type: 'file',
            size: 14,
            mtimeMs: 1,
            mode: 0o100644,
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
      if (
        req.method === 'POST' &&
        req.url === '/hub/nodes/node-a/sessions/remote-session-1/files/write'
      ) {
        res.end(
          JSON.stringify({
            operation: 'write',
            root: '/fixture',
            cwd: '/fixture',
            path: '/fixture/out.txt',
            mode: entry.body?.['mode'] ?? 'create',
            bytesWritten: 5,
            newHash:
              'aabbccddee112233445566778899001122334455667788990011223344556677',
            newMtime: '2026-01-02T03:04:05.000Z',
            created: true,
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } })
      );
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
      await execNode(
        ['dist/bin/relay-ide.js', 'v1', 'nodes', 'list', '--json'],
        env
      )
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
    expect(created.data).toMatchObject({
      id: 'remote-session-1',
      nodeId: 'node-a',
    });

    const attached = parseEnvelope<{
      attach: { streaming: boolean };
      session: typeof session;
    }>(
      await execNode(
        [
          'dist/bin/relay-ide.js',
          'v1',
          'sessions',
          'attach',
          '--id',
          'remote-session-1',
          '--json',
        ],
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

    const stat = parseEnvelope<{ name: string; type: string; size: number }>(
      await execNode(
        [
          'dist/bin/relay-ide.js',
          'v1',
          'files',
          'stat',
          '--session-id',
          'remote-session-1',
          '--path',
          'hello.txt',
          '--json',
        ],
        env
      )
    );
    expect(stat).toMatchObject({ ok: true, command: 'files.stat' });
    expect(stat.data).toMatchObject({
      name: 'hello.txt',
      type: 'file',
      size: 14,
    });

    const read = parseEnvelope<{
      content: string;
      maxBytes: number;
      maxLines: number;
    }>(
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
    expect(read.data).toMatchObject({
      content: 'hello gateway\n',
      maxBytes: 64,
      maxLines: 2,
    });

    // Write a small file via --input-json to avoid needing a real filesystem file
    const written = parseEnvelope<{
      operation: string;
      bytesWritten: number;
      created: boolean;
    }>(
      await execNode(
        [
          'dist/bin/relay-ide.js',
          'v1',
          'files',
          'write',
          '--session-id',
          'remote-session-1',
          '--node-id',
          'node-a',
          '--input-json',
          JSON.stringify({
            sessionId: 'remote-session-1',
            nodeId: 'node-a',
            path: 'out.txt',
            mode: 'create',
            contentBase64: Buffer.from('hello').toString('base64'),
          }),
          '--json',
        ],
        env
      )
    );
    expect(written).toMatchObject({ ok: true, command: 'files.write' });
    expect(written.data).toMatchObject({
      operation: 'write',
      bytesWritten: 5,
      created: true,
    });

    const detached = parseEnvelope<{
      detached: boolean;
      killed: boolean;
      session: typeof session;
    }>(
      await execNode(
        [
          'dist/bin/relay-ide.js',
          'v1',
          'sessions',
          'detach',
          '--id',
          'remote-session-1',
          '--json',
        ],
        env
      )
    );
    expect(detached.data).toMatchObject({ detached: true, killed: false });

    const stillThere = parseEnvelope<typeof session>(
      await execNode(
        [
          'dist/bin/relay-ide.js',
          'v1',
          'sessions',
          'get',
          '--id',
          'remote-session-1',
          '--json',
        ],
        env
      )
    );
    expect(stillThere.data).toMatchObject({
      id: 'remote-session-1',
      status: 'active',
    });
  } finally {
    await close(server);
  }

  expect(captured.map((entry) => `${entry.method} ${entry.url}`)).toEqual(
    expect.arrayContaining([
      'GET /nodes',
      'POST /hub/nodes/node-a/sessions',
      'POST /hub/nodes/node-a/sessions/remote-session-1/files/list',
      'POST /hub/nodes/node-a/sessions/remote-session-1/files/stat',
      'POST /hub/nodes/node-a/sessions/remote-session-1/files/read',
      'POST /hub/nodes/node-a/sessions/remote-session-1/files/write',
      'GET /sessions/remote-session-1',
    ])
  );
  expect(captured.some((entry) => entry.method === 'DELETE')).toBe(false);
  expect(
    captured.find((entry) => entry.url?.endsWith('/files/read'))?.body
  ).toMatchObject({ path: 'hello.txt', maxBytes: 64, maxLines: 2 });
});

test('v1 gateway sessions input rejects missing and mixed input sources before attach', async () => {
  const env = {
    ...process.env,
    RELAY_IDE_PORT: '19999',
    RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
    PATH: process.env.PATH,
  };

  for (const args of [
    [
      'dist/bin/relay-ide.js',
      'v1',
      'sessions',
      'input',
      '--id',
      'remote-session-1',
      '--json',
    ],
    [
      'dist/bin/relay-ide.js',
      'v1',
      'sessions',
      'input',
      '--id',
      'remote-session-1',
      '--data',
      'marker-input\n',
      '--stdin',
      '--json',
    ],
  ]) {
    const failure = await execNodeFailure(args, env);
    expect(failure.status).toBe(1);
    const envelope = JSON.parse(failure.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(envelope.error.message).toContain(
      'exactly one of --data, --data-base64, or --stdin is required'
    );
  }
});

test('v1 gateway session stream and input use routed PTY websocket', async () => {
  const session = {
    id: 'remote-session-1',
    globalSessionId: 'node-a:remote-session-1',
    nodeId: 'node-a',
    type: 'terminal',
    mode: 'pty',
    cwd: '/fixture',
    displayName: 'fixture terminal',
    status: 'active',
  };
  const upgrades: Array<{
    url?: string;
    cookie?: string;
    marker?: string | string[];
  }> = [];
  const inputs: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/sessions/remote-session-1') {
      res.end(JSON.stringify(session));
      return;
    }
    res.statusCode = 404;
    res.end(
      JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } })
    );
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    upgrades.push({
      url: req.url,
      cookie: req.headers.cookie,
      marker: req.headers['x-relay-cli-gateway'],
    });
    if (req.url !== '/nodes/node-a/ws/sessions/remote-session-1') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send('stream-marker\n');
      ws.on('message', (data) => {
        const text = data.toString();
        inputs.push(text);
        ws.send(`echo:${text}`);
      });
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
    const streamStdout = await execNode(
      [
        'dist/bin/relay-ide.js',
        'v1',
        'sessions',
        'stream',
        '--id',
        'remote-session-1',
        '--max-events',
        '1',
        '--json',
      ],
      env
    );
    const streamLines = streamStdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(streamLines[0]).toMatchObject({
      ok: true,
      command: 'sessions.stream',
      data: { event: 'data', data: 'stream-marker\n', nodeId: 'node-a' },
    });
    expect(streamLines.at(-1)).toMatchObject({
      ok: true,
      command: 'sessions.stream',
      data: { event: 'closed', frames: 1, truncated: false },
    });

    const inputEnvelope = parseEnvelope<{
      output: string;
      matched: boolean;
      bytesSent: number;
      nodeId: string;
    }>(
      await execNode(
        [
          'dist/bin/relay-ide.js',
          'v1',
          'sessions',
          'input',
          '--id',
          'remote-session-1',
          '--data',
          'marker-input\n',
          '--wait-for',
          'echo:marker-input',
          '--json',
        ],
        env
      )
    );
    expect(inputEnvelope).toMatchObject({
      ok: true,
      command: 'sessions.input',
      data: { matched: true, nodeId: 'node-a' },
    });
    expect(inputEnvelope.data.output).toContain('echo:marker-input\n');
  } finally {
    wss.close();
    await close(server);
  }

  expect(upgrades).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: '/nodes/node-a/ws/sessions/remote-session-1',
        cookie: 'token=scoped-token',
        marker: 'v1',
      }),
    ])
  );
  expect(inputs).toContain('marker-input\n');
});

test('v1 files.write argv parsing: --mode and --file produce correct request body', async () => {
  const tmpFile = path.join(tmpDir, 'write-payload.txt');
  fs.writeFileSync(tmpFile, 'hello write');

  const captured: CapturedGatewayRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const entry: CapturedGatewayRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        marker: req.headers['x-relay-cli-gateway'],
      };
      if (rawBody) entry.body = JSON.parse(rawBody) as Record<string, unknown>;
      captured.push(entry);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url?.endsWith('/files/write')) {
        res.end(
          JSON.stringify({
            operation: 'write',
            root: '/fixture',
            cwd: '/fixture',
            path: '/fixture/write-payload.txt',
            mode: 'create',
            bytesWritten: 11,
            newHash:
              '0011223344556677889900112233445566778899001122334455667788990011',
            newMtime: '2026-01-02T03:04:05.000Z',
            created: true,
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } })
      );
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
    const result = parseEnvelope<{ operation: string; bytesWritten: number }>(
      await execNode(
        [
          'dist/bin/relay-ide.js',
          'v1',
          'files',
          'write',
          '--session-id',
          'remote-session-1',
          '--node-id',
          'node-a',
          '--path',
          'write-payload.txt',
          '--mode',
          'create',
          '--file',
          tmpFile,
          '--json',
        ],
        env
      )
    );
    expect(result).toMatchObject({ ok: true, command: 'files.write' });
    expect(result.data).toMatchObject({ operation: 'write', bytesWritten: 11 });
    const writeEntry = captured.find((entry) =>
      entry.url?.endsWith('/files/write')
    );
    expect(writeEntry?.body).toMatchObject({
      path: 'write-payload.txt',
      mode: 'create',
      contentBase64: Buffer.from('hello write').toString('base64'),
    });
  } finally {
    await close(server);
  }
});

test('v1 files.write size cap: oversized file exits non-zero before HTTP', async () => {
  // Write a file larger than FILE_RPC_MAX_WRITE_BYTES (1 MB)
  const oversizedFile = path.join(tmpDir, 'oversized.bin');
  // 1 MB + 1 byte
  fs.writeFileSync(oversizedFile, Buffer.alloc(1024 * 1024 + 1, 0x61));

  const env = {
    ...process.env,
    RELAY_IDE_PORT: '19999',
    RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
    PATH: process.env.PATH,
  };

  const failure = await execNodeFailure(
    [
      'dist/bin/relay-ide.js',
      'v1',
      'files',
      'write',
      '--session-id',
      'remote-session-1',
      '--node-id',
      'node-a',
      '--path',
      'oversized.bin',
      '--mode',
      'create',
      '--file',
      oversizedFile,
      '--json',
    ],
    env
  );
  expect(failure.status).not.toBe(0);
  const envelope = JSON.parse(failure.stdout) as {
    ok: boolean;
    error: { code: string; message: string };
  };
  expect(envelope).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGUMENT' },
  });
  expect(envelope.error.message).toContain('maximum write size');
});
