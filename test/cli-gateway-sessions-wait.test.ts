import { afterEach, expect, test } from 'vitest';
import * as http from 'node:http';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { retainOutputPredicateSuffix } from '../shared/cli-gateway-sessions-wait.js';

const RELAY_IDE_BIN = path.resolve('dist/bin/relay-ide.js');
const servers: Array<{ server: http.Server; wss: WebSocketServer }> = [];

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type WaitFixture = {
  port: number;
  close: () => Promise<void>;
};

function runRelay(args: string[], port = '9'): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [RELAY_IDE_BIN, ...args],
      {
        env: {
          ...process.env,
          RELAY_IDE_PORT: port,
          RELAY_IDE_BROWSER_TOKEN: 'browser-token',
        },
        maxBuffer: 1024 * 1024,
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        const rawCode = (error as NodeJS.ErrnoException | null)?.code;
        const code = typeof rawCode === 'number' ? rawCode : error ? 1 : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

function parseEnvelope(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function waitArgs(extra: string[]): string[] {
  return ['v1', 'sessions', 'wait', '--id', 'session-wait-1', ...extra, '--json'];
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return address.port;
}

async function closeFixture({ server, wss }: { server: http.Server; wss: WebSocketServer }): Promise<void> {
  const clientClosePromises = Array.from(wss.clients, (client) =>
    client.readyState === client.CLOSED
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          client.once('close', () => resolve());
          client.close();
          setTimeout(() => {
            if (client.readyState !== client.CLOSED) client.terminate();
            resolve();
          }, 25).unref?.();
        })
  );
  await Promise.all(clientClosePromises);
  await new Promise<void>((resolve, reject) =>
    wss.close((error) => (error ? reject(error) : resolve()))
  );
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createWaitFixture(
  onConnection: (ws: WebSocket) => void,
  options: { missingSession?: boolean } = {}
): Promise<WaitFixture> {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/sessions/session-wait-1') {
      if (options.missingSession) {
        res.statusCode = 404;
        res.end(
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: 'session not found',
              details: { reasonCode: 'SESSION_NOT_FOUND' },
            },
          })
        );
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ id: 'session-wait-1', globalSessionId: 'global-wait-1' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws/session-wait-1') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  wss.on('connection', onConnection);
  const port = await listen(server);
  const fixture = { server, wss };
  servers.push(fixture);
  return {
    port,
    close: async () => {
      const idx = servers.indexOf(fixture);
      if (idx >= 0) servers.splice(idx, 1);
      await closeFixture(fixture);
    },
  };
}

afterEach(async () => {
  for (const fixture of servers.splice(0)) await closeFixture(fixture);
});

test('sessions.wait output-text retention keeps no suffix for single-character predicates', () => {
  let outputWindow = '';

  for (let index = 0; index < 5; index += 1) {
    outputWindow += '0123456789';
    outputWindow = retainOutputPredicateSuffix(outputWindow, 'a');
    expect(outputWindow).toBe('');
  }
});

test('sessions.wait output-text retention keeps only the cross-frame match suffix', () => {
  let outputWindow = '';

  outputWindow += 'xxbooting rea';
  outputWindow = retainOutputPredicateSuffix(outputWindow, 'ready marker');
  expect(outputWindow).toBe('booting rea');

  outputWindow += 'dy marker';
  expect(outputWindow).toContain('ready marker');
});

test('sessions.wait resolves raw output-text matches with stable JSON metadata', async () => {
  const fixture = await createWaitFixture((ws) => {
    ws.send('booting rea');
    setTimeout(() => ws.send('dy marker'), 10).unref?.();
  });
  const result = await runRelay(
    waitArgs(['--output-text', 'ready marker', '--timeout-ms', '500', '--max-bytes', '1024']),
    String(fixture.port)
  );

  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  const envelope = parseEnvelope(result.stdout);
  expect(envelope).toMatchObject({
    ok: true,
    command: 'sessions.wait',
    data: {
      model: 'raw-output',
      status: 'matched',
      sessionId: 'session-wait-1',
      globalSessionId: 'global-wait-1',
      predicate: { kind: 'output-text', value: 'ready marker' },
      truncated: false,
      timeoutMs: 500,
      maxBytes: 1024,
    },
  });
  expect((envelope.data as Record<string, unknown>).bytesObserved).toBeGreaterThan(0);
});

test('sessions.wait resolves idle-ms after the PTY stream goes quiet', async () => {
  const fixture = await createWaitFixture((ws) => {
    ws.send('one frame');
  });
  const result = await runRelay(
    waitArgs(['--idle-ms', '20', '--timeout-ms', '500', '--max-bytes', '1024']),
    String(fixture.port)
  );

  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  const envelope = parseEnvelope(result.stdout);
  expect(envelope).toMatchObject({
    ok: true,
    command: 'sessions.wait',
    data: {
      model: 'raw-output',
      status: 'idle',
      predicate: { kind: 'idle-ms', value: 20 },
      bytesObserved: 9,
      truncated: false,
    },
  });
});

test('sessions.wait returns a typed nonzero timeout envelope', async () => {
  const fixture = await createWaitFixture((ws) => {
    ws.send('not the requested text');
  });
  const result = await runRelay(
    waitArgs(['--output-text', 'never appears', '--timeout-ms', '25', '--max-bytes', '1024']),
    String(fixture.port)
  );

  expect(result.stderr).toBe('');
  expect(result.code).toBe(1);
  expect(parseEnvelope(result.stdout)).toMatchObject({
    ok: false,
    command: 'sessions.wait',
    error: {
      code: 'UPSTREAM_ERROR',
      details: {
        reasonCode: 'WAIT_TIMEOUT',
        status: 'timeout',
        model: 'raw-output',
        predicate: { kind: 'output-text', value: 'never appears' },
      },
    },
  });
});

test('sessions.wait returns a typed nonzero closed-stream envelope', async () => {
  const fixture = await createWaitFixture((ws) => {
    ws.close(1000, 'fixture closed');
  });
  const result = await runRelay(
    waitArgs(['--output-text', 'never appears', '--timeout-ms', '500', '--max-bytes', '1024']),
    String(fixture.port)
  );

  expect(result.stderr).toBe('');
  expect(result.code).toBe(1);
  expect(parseEnvelope(result.stdout)).toMatchObject({
    ok: false,
    command: 'sessions.wait',
    error: {
      code: 'UPSTREAM_ERROR',
      details: {
        reasonCode: 'SESSION_STREAM_CLOSED',
        status: 'closed',
        closeCode: 1000,
        reason: 'fixture closed',
      },
    },
  });
});

test('sessions.wait preserves missing-session errors from the gateway lookup', async () => {
  const fixture = await createWaitFixture(() => undefined, { missingSession: true });
  const result = await runRelay(
    waitArgs(['--output-text', 'never appears', '--timeout-ms', '500']),
    String(fixture.port)
  );

  expect(result.stderr).toBe('');
  expect(result.code).toBe(1);
  expect(parseEnvelope(result.stdout)).toMatchObject({
    ok: false,
    command: 'sessions.wait',
    error: {
      code: 'NOT_FOUND',
      details: { status: 404, upstreamCode: 'NOT_FOUND' },
    },
  });
});

test('sessions.wait returns a typed nonzero max-byte-cap envelope', async () => {
  const fixture = await createWaitFixture((ws) => {
    ws.send('abcdef');
  });
  const result = await runRelay(
    waitArgs(['--output-text', 'zzz', '--timeout-ms', '500', '--max-bytes', '3']),
    String(fixture.port)
  );

  expect(result.stderr).toBe('');
  expect(result.code).toBe(1);
  expect(parseEnvelope(result.stdout)).toMatchObject({
    ok: false,
    command: 'sessions.wait',
    error: {
      code: 'UPSTREAM_ERROR',
      details: {
        reasonCode: 'WAIT_MAX_BYTES_EXCEEDED',
        status: 'max-bytes',
        bytesObserved: 3,
        truncated: true,
        maxBytes: 3,
      },
    },
  });
});

test('sessions.wait rejects mixed predicates before attaching to a session', async () => {
  const result = await runRelay(
    waitArgs(['--output-text', 'ready', '--idle-ms', '50', '--timeout-ms', '500'])
  );

  expect(result.stderr).toBe('');
  expect(result.code).toBe(1);
  expect(parseEnvelope(result.stdout)).toMatchObject({
    ok: false,
    command: 'sessions.wait',
    error: {
      code: 'INVALID_ARGUMENT',
      details: { reasonCode: 'WAIT_PREDICATES_MIXED' },
    },
  });
});

test('sessions.wait exposes screen-text as a typed unsupported rendered-screen predicate', async () => {
  const result = await runRelay(
    waitArgs(['--screen-text', 'visible text', '--timeout-ms', '500'])
  );

  expect(result.stderr).toBe('');
  expect(result.code).toBe(1);
  expect(parseEnvelope(result.stdout)).toMatchObject({
    ok: false,
    command: 'sessions.wait',
    error: {
      code: 'UNSUPPORTED',
      details: {
        reasonCode: 'RENDERED_SCREEN_UNSUPPORTED',
        model: 'rendered-screen',
        supportedModels: ['raw-output'],
        predicate: { kind: 'screen-text', value: 'visible text' },
      },
    },
  });
});
