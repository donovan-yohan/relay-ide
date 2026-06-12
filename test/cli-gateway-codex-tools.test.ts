import { expect, test } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  CLI_GATEWAY_CODEX_SMOKE_COMMANDS,
  RelayCodexGatewayToolRunner,
  generateRelayCodexGatewayFunctionDescriptors,
  generateRelayCodexGatewayMcpDescriptors,
  generateRelayCodexGatewayOpenAiToolDescriptors,
  generateRelayCodexGatewayTools,
} from '../shared/cli-gateway-codex-tools.js';
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

test('generates Codex tool, MCP, and function descriptors from the v1 contract', () => {
  const tools = generateRelayCodexGatewayTools(RELAY_CLI_GATEWAY_CONTRACT);
  expect(tools.map((tool) => tool.relay.command)).toEqual([...CLI_GATEWAY_CODEX_SMOKE_COMMANDS]);
  expect(tools.map((tool) => tool.name)).toEqual([
    'relay_codex_gateway_nodes_list',
    'relay_codex_gateway_sessions_create',
    'relay_codex_gateway_files_read',
    'relay_codex_gateway_sessions_stream',
    'relay_codex_gateway_sessions_wait',
    'relay_codex_gateway_sessions_input',
    'relay_codex_gateway_sessions_detach',
  ]);

  const readTool = tools.find((tool) => tool.relay.command === 'files.read');
  expect(readTool?.parameters).toBe(commandSpec('files.read').inputSchema);
  expect(readTool?.mcp.inputSchema).toBe(commandSpec('files.read').inputSchema);
  expect(readTool?.function.function.parameters).toBe(commandSpec('files.read').inputSchema);
  expect(readTool?.openai).toEqual({
    type: 'function',
    name: 'relay_codex_gateway_files_read',
    description: commandSpec('files.read').summary,
    parameters: commandSpec('files.read').inputSchema,
  });
  expect(readTool?.relay).toMatchObject({
    contract: 'v1',
    contractVersion: '1.0',
    command: 'files.read',
    requiresAuth: true,
  });

  const mcpDescriptors = generateRelayCodexGatewayMcpDescriptors(RELAY_CLI_GATEWAY_CONTRACT);
  const functionDescriptors = generateRelayCodexGatewayFunctionDescriptors(RELAY_CLI_GATEWAY_CONTRACT);
  const openaiToolDescriptors = generateRelayCodexGatewayOpenAiToolDescriptors(
    RELAY_CLI_GATEWAY_CONTRACT
  );
  expect(mcpDescriptors.map((descriptor) => descriptor.inputSchema)).toEqual(
    tools.map((tool) => tool.parameters)
  );
  expect(functionDescriptors).toEqual(tools.map((tool) => tool.function));
  expect(openaiToolDescriptors).toEqual(tools.map((tool) => tool.openai));
});

test('generated Codex CLI gateway tools run the fake hub/node adapter smoke over public v1 commands', async () => {
  const tools = generateRelayCodexGatewayTools(RELAY_CLI_GATEWAY_CONTRACT);
  const captured: CapturedGatewayRequest[] = [];
  const upgrades: Array<{ url?: string; cookie?: string; marker?: string | string[] }> = [];
  const inputs: string[] = [];
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
            content: 'hello codex gateway\n',
            bytesRead: 20,
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
    const runner = new RelayCodexGatewayToolRunner(tools, {
      command: process.execPath,
      commandArgsPrefix: ['dist/bin/relay-ide.js'],
      env: {
        ...process.env,
        RELAY_IDE_PORT: String(port),
        RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      },
    });

    const nodes = await runner.callTool('relay_codex_gateway_nodes_list');
    expect(nodes).toMatchObject({ ok: true, command: 'nodes.list' });
    if (Array.isArray(nodes) || !nodes.ok) throw new Error('expected nodes.list to succeed');
    expect((nodes.data as { nodes: unknown[] }).nodes).toHaveLength(1);

    const created = await runner.callTool('relay_codex_gateway_sessions_create', {
      nodeId: 'node-a',
      cwd: '/fixture',
      type: 'terminal',
    });
    expect(created).toMatchObject({ ok: true, command: 'sessions.create' });
    if (Array.isArray(created) || !created.ok) throw new Error('expected sessions.create to succeed');
    expect(created.data).toMatchObject({ id: 'remote-session-1', nodeId: 'node-a' });

    const read = await runner.callTool('relay_codex_gateway_files_read', {
      sessionId: 'remote-session-1',
      path: 'hello.txt',
      maxBytes: 64,
      maxLines: 2,
    });
    expect(read).toMatchObject({ ok: true, command: 'files.read' });
    if (Array.isArray(read) || !read.ok) throw new Error('expected files.read to succeed');
    expect(read.data).toMatchObject({ content: 'hello codex gateway\n', maxBytes: 64, maxLines: 2 });

    const defaultPathRead = await runner.callTool('relay_codex_gateway_files_read', {
      sessionId: 'remote-session-1',
    });
    expect(defaultPathRead).toMatchObject({ ok: true, command: 'files.read' });
    if (Array.isArray(defaultPathRead) || !defaultPathRead.ok) {
      throw new Error('expected files.read with omitted path to succeed');
    }
    expect(defaultPathRead.data).toMatchObject({ content: 'hello codex gateway\n' });

    const stream = await runner.callTool('relay_codex_gateway_sessions_stream', {
      id: 'remote-session-1',
      maxEvents: 1,
    });
    if (!Array.isArray(stream)) throw new Error('expected sessions.stream to return NDJSON envelopes');
    expect(stream[0]).toMatchObject({
      ok: true,
      command: 'sessions.stream',
      data: { event: 'data', data: 'stream-marker\n', nodeId: 'node-a' },
    });
    expect(stream.at(-1)).toMatchObject({
      ok: true,
      command: 'sessions.stream',
      data: { event: 'closed', frames: 1, truncated: false },
    });

    const defaultBoundedStream = await runner.callTool('relay_codex_gateway_sessions_stream', {
      id: 'remote-session-1',
    });
    if (!Array.isArray(defaultBoundedStream)) {
      throw new Error('expected default sessions.stream to return NDJSON envelopes');
    }
    expect(defaultBoundedStream.at(-1)).toMatchObject({
      ok: true,
      command: 'sessions.stream',
      data: {
        event: 'closed',
        frames: 1,
        truncated: false,
        maxBytes: 65536,
      },
    });

    const wait = await runner.callTool('relay_codex_gateway_sessions_wait', {
      id: 'remote-session-1',
      outputText: 'stream-marker',
      timeoutMs: 500,
    });
    expect(wait).toMatchObject({
      ok: true,
      command: 'sessions.wait',
      data: {
        model: 'raw-output',
        status: 'matched',
        predicate: { kind: 'output-text', value: 'stream-marker' },
        nodeId: 'node-a',
      },
    });

    const input = await runner.callTool('relay_codex_gateway_sessions_input', {
      id: 'remote-session-1',
      data: 'marker-input\n',
      waitFor: 'echo:marker-input',
    });
    expect(input).toMatchObject({
      ok: true,
      command: 'sessions.input',
      data: { matched: true, nodeId: 'node-a' },
    });
    if (Array.isArray(input) || !input.ok) throw new Error('expected sessions.input to succeed');
    expect((input.data as { output: string }).output).toContain('echo:marker-input\n');

    const detached = await runner.callTool('relay_codex_gateway_sessions_detach', {
      id: 'remote-session-1',
    });
    expect(detached).toMatchObject({ ok: true, command: 'sessions.detach' });
    if (Array.isArray(detached) || !detached.ok) throw new Error('expected sessions.detach to succeed');
    expect(detached.data).toMatchObject({ detached: true, killed: false });
  } finally {
    wss.close();
    await close(server);
  }

  expect(sessionAlive).toBe(true);
  expect(captured.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
    'GET /nodes',
    'POST /hub/nodes/node-a/sessions',
    'GET /sessions/remote-session-1',
    'POST /hub/nodes/node-a/sessions/remote-session-1/files/read',
    'GET /sessions/remote-session-1',
    'POST /hub/nodes/node-a/sessions/remote-session-1/files/read',
    'GET /sessions/remote-session-1',
    'GET /sessions/remote-session-1',
    'GET /sessions/remote-session-1',
    'GET /sessions/remote-session-1',
    'GET /sessions/remote-session-1',
  ]);
  expect(captured.some((entry) => entry.method === 'DELETE')).toBe(false);
  expect(captured.find((entry) => entry.url === '/nodes')).toMatchObject({
    authorization: 'Bearer scoped-token',
    marker: 'v1',
    capabilities: 'session:read',
  });
  const readBodies = captured
    .filter((entry) => entry.url?.endsWith('/files/read'))
    .map((entry) => entry.body);
  expect(readBodies[0]).toMatchObject({
    path: 'hello.txt',
    maxBytes: 64,
    maxLines: 2,
  });
  expect(readBodies[1]).toMatchObject({
    path: '.',
  });
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

test('generated Codex session rename tool forwards displayName to the PATCH body', async () => {
  const tools = generateRelayCodexGatewayTools(RELAY_CLI_GATEWAY_CONTRACT, [
    'sessions.rename',
  ]);
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
      capabilities: req.headers['x-relay-capabilities'],
    };
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      if (rawBody) entry.body = JSON.parse(rawBody) as Record<string, unknown>;
      captured.push(entry);
      res.setHeader('content-type', 'application/json');

      if (req.method === 'GET' && req.url === '/sessions/remote-session-1') {
        res.end(JSON.stringify(session));
        return;
      }
      if (
        req.method === 'PATCH' &&
        req.url === '/hub/nodes/node-a/sessions/remote-session-1'
      ) {
        res.end(
          JSON.stringify({
            ...session,
            displayName: entry.body?.['displayName'],
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
    const runner = new RelayCodexGatewayToolRunner(tools, {
      command: process.execPath,
      commandArgsPrefix: ['dist/bin/relay-ide.js'],
      env: {
        ...process.env,
        RELAY_IDE_PORT: String(port),
        RELAY_IDE_BROWSER_TOKEN: 'scoped-token',
      },
    });

    const renamed = await runner.callTool('relay_codex_gateway_sessions_rename', {
      id: 'remote-session-1',
      displayName: 'wanted name',
    });
    expect(renamed).toMatchObject({
      ok: true,
      command: 'sessions.rename',
      data: { renamed: true, displayName: 'wanted name' },
    });
  } finally {
    await close(server);
  }

  expect(captured.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
    'GET /sessions/remote-session-1',
    'PATCH /hub/nodes/node-a/sessions/remote-session-1',
  ]);
  expect(captured[1]).toMatchObject({
    capabilities: 'session:read,session:control:rename',
    body: { displayName: 'wanted name' },
  });
});

test('Codex sessions.stream runner has stdout buffer headroom for schema-valid maxBytes', async () => {
  const tools = generateRelayCodexGatewayTools(RELAY_CLI_GATEWAY_CONTRACT);
  const largePayload = 'x'.repeat(1024 * 1024);
  const dataEnvelope = {
    ok: true,
    contract: 'v1',
    contractVersion: '1.0',
    command: 'sessions.stream',
    data: {
      event: 'data',
      sessionId: 'large-session-1',
      encoding: 'utf8',
      data: largePayload,
      bytes: largePayload.length,
      sequence: 0,
    },
  };
  const closedEnvelope = {
    ok: true,
    contract: 'v1',
    contractVersion: '1.0',
    command: 'sessions.stream',
    data: {
      event: 'closed',
      sessionId: 'large-session-1',
      frames: 1,
      bytesReceived: largePayload.length,
      truncated: false,
      maxBytes: largePayload.length,
      backpressureClosed: false,
    },
  };
  const tempDir = mkdtempSync(join(tmpdir(), 'relay-codex-buffer-'));
  const scriptPath = join(tempDir, 'large-stdout.mjs');
  writeFileSync(
    scriptPath,
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(dataEnvelope)}\n${JSON.stringify(closedEnvelope)}\n`)});\n`
  );

  try {
    const runner = new RelayCodexGatewayToolRunner(tools, {
      command: process.execPath,
      commandArgsPrefix: [scriptPath],
    });

    const stream = await runner.callTool('relay_codex_gateway_sessions_stream', {
      id: 'large-session-1',
      maxBytes: 1024 * 1024,
    });
    if (!Array.isArray(stream)) throw new Error('expected sessions.stream to return NDJSON envelopes');
    expect(stream[0]).toMatchObject({
      ok: true,
      command: 'sessions.stream',
      data: { event: 'data', bytes: largePayload.length },
    });
    expect(stream.at(-1)).toMatchObject({
      ok: true,
      command: 'sessions.stream',
      data: {
        event: 'closed',
        frames: 1,
        bytesReceived: largePayload.length,
        maxBytes: largePayload.length,
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

