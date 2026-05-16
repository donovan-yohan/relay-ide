import { expect, test } from 'vitest';
import * as http from 'node:http';
import {
  CLI_GATEWAY_CLAUDE_SMOKE_COMMANDS,
  RelayClaudeGatewayToolRunner,
  generateRelayClaudeGatewayTools,
} from '../shared/cli-gateway-claude-tools.js';
import { RELAY_CLI_GATEWAY_CONTRACT, commandSpec } from '../shared/cli-gateway-contract.js';

type CapturedGatewayRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  marker: string | string[] | undefined;
  capabilities: string | string[] | undefined;
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

test('generated Claude-style CLI gateway tools run the first adapter smoke path', async () => {
  const tools = generateRelayClaudeGatewayTools(RELAY_CLI_GATEWAY_CONTRACT);
  expect(tools.map((tool) => tool.relay.command)).toEqual([...CLI_GATEWAY_CLAUDE_SMOKE_COMMANDS]);
  expect(tools.map((tool) => tool.name)).toEqual([
    'relay_nodes_list',
    'relay_sessions_create',
    'relay_files_read',
    'relay_sessions_detach',
  ]);
  expect(tools.find((tool) => tool.relay.command === 'files.read')?.input_schema).toBe(
    commandSpec('files.read').inputSchema
  );

  const captured: CapturedGatewayRequest[] = [];
  let sessionAlive = false;
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
      capabilities: req.headers['x-relay-capabilities'],
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
            nodes: [{ nodeId: 'node-a', status: 'online', availability: 'available' }],
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/hub/nodes/node-a/sessions') {
        sessionAlive = true;
        res.statusCode = 201;
        res.end(JSON.stringify(session));
        return;
      }
      if (req.method === 'GET' && req.url === '/sessions/remote-session-1' && sessionAlive) {
        res.end(JSON.stringify(session));
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
      if (req.method === 'DELETE') sessionAlive = false;
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
    });
  });

  const port = await listen(server);
  try {
    const runner = new RelayClaudeGatewayToolRunner(tools, {
      command: process.execPath,
      commandArgsPrefix: ['dist/bin/relay-ide.js'],
      env: {
        ...process.env,
        RELAY_IDE_PORT: String(port),
        RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      },
    });

    const nodes = await runner.callTool('relay_nodes_list');
    expect(nodes).toMatchObject({ ok: true, command: 'nodes.list' });
    if (!nodes.ok) throw new Error('expected nodes.list to succeed');
    expect((nodes.data as { nodes: unknown[] }).nodes).toHaveLength(1);

    const created = await runner.callTool('relay_sessions_create', {
      nodeId: 'node-a',
      cwd: '/fixture',
      type: 'terminal',
    });
    expect(created).toMatchObject({ ok: true, command: 'sessions.create' });
    if (!created.ok) throw new Error('expected sessions.create to succeed');
    expect(created.data).toMatchObject({ id: 'remote-session-1', nodeId: 'node-a' });

    const read = await runner.callTool('relay_files_read', {
      sessionId: 'remote-session-1',
      path: 'hello.txt',
      maxBytes: 64,
      maxLines: 2,
    });
    expect(read).toMatchObject({ ok: true, command: 'files.read' });
    if (!read.ok) throw new Error('expected files.read to succeed');
    expect(read.data).toMatchObject({ content: 'hello gateway\n', maxBytes: 64, maxLines: 2 });

    const detached = await runner.callTool('relay_sessions_detach', { id: 'remote-session-1' });
    expect(detached).toMatchObject({ ok: true, command: 'sessions.detach' });
    if (!detached.ok) throw new Error('expected sessions.detach to succeed');
    expect(detached.data).toMatchObject({ detached: true, killed: false });
  } finally {
    await close(server);
  }

  expect(sessionAlive).toBe(true);
  expect(captured.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
    'GET /nodes',
    'POST /hub/nodes/node-a/sessions',
    'GET /sessions/remote-session-1',
    'POST /hub/nodes/node-a/sessions/remote-session-1/files/read',
    'GET /sessions/remote-session-1',
  ]);
  expect(captured.some((entry) => entry.method === 'DELETE')).toBe(false);
  expect(captured.find((entry) => entry.url === '/nodes')).toMatchObject({
    authorization: 'Bearer scoped-token',
    marker: 'v1',
    capabilities: 'session:read',
  });
  expect(captured.find((entry) => entry.url?.endsWith('/files/read'))?.body).toMatchObject({
    path: 'hello.txt',
    maxBytes: 64,
    maxLines: 2,
  });
});
