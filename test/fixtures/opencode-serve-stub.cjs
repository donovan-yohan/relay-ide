#!/usr/bin/env node
/**
 * Lightweight HTTP server that mimics the OpenCode serve API used by
 * server/protocol-adapters/opencode-adapter.ts.
 *
 * Usage: node opencode-serve-stub.cjs --port <port>
 */

const http = require('http');
const url = require('url');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = parseInt(
  process.env.OPENCODE_PORT || (portIdx !== -1 ? args[portIdx + 1] : ''),
  10
);

if (!port || isNaN(port)) {
  console.error('Usage: node opencode-serve-stub.cjs --port <port>');
  process.exit(1);
}

/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

const sessionId = 'ses_stub';

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/global/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ healthy: true, version: 'stub' }));
    return;
  }

  if (parsed.pathname === '/global/event') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    sseClients.add(res);
    sendEvent(res, {
      type: 'server.connected',
      properties: {},
    });
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (parsed.pathname === '/session' && req.method === 'POST') {
    drain(req, () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: sessionId, title: 'Relay test' }));
    });
    return;
  }

  if (
    parsed.pathname === `/session/${sessionId}/prompt_async` &&
    req.method === 'POST'
  ) {
    drain(req, (body) => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      if (
        !payload ||
        typeof payload !== 'object' ||
        !Array.isArray(payload.parts)
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'parts is required' }));
        return;
      }

      res.writeHead(204);
      res.end();
      emitTurn();
    });
    return;
  }

  if (
    parsed.pathname === `/session/${sessionId}/abort` &&
    req.method === 'POST'
  ) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(true));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function drain(req, done) {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => done(body));
}

function sendEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event) {
  for (const client of sseClients) {
    sendEvent(client, event);
  }
}

function emitTurn() {
  const part = {
    id: 'part_1',
    sessionID: sessionId,
    messageID: 'msg_1',
    type: 'text',
  };

  broadcast({
    type: 'session.status',
    properties: { sessionID: sessionId, status: 'active' },
  });

  ['hello ', 'from ', 'opencode'].forEach((delta, index) => {
    setTimeout(() => {
      broadcast({
        type: 'message.part.updated',
        properties: { part, delta },
      });
    }, index * 25);
  });

  setTimeout(() => {
    broadcast({
      type: 'session.status',
      properties: { sessionID: sessionId, status: 'idle' },
    });
  }, 100);
}

server.listen(port, '127.0.0.1', () => {
  console.log(`OpenCode serve stub listening on ${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
