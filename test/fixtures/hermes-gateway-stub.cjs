#!/usr/bin/env node
/* eslint-disable */
/**
 * Mock Hermes Gateway Stub
 *
 * Lightweight HTTP server that mimics the Hermes gateway protocol
 * expected by server/protocol-adapters/hermes-adapter.ts.
 *
 * Usage: node hermes-gateway-stub.js <port>
 */

const http = require('http');
const url = require('url');

const port = parseInt(process.argv[2], 10);
if (!port || isNaN(port)) {
  console.error('Usage: node hermes-gateway-stub.js <port>');
  process.exit(1);
}

/** @type {http.ServerResponse | null} */
let sseClient = null;

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // SSE events stream
  if (parsed.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    sseClient = res;
    return;
  }

  // Send a prompt
  if (parsed.pathname.match(/^\/session\/[^/]+\/prompt$/)) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const data = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));

      // Emit mock SSE events after a short delay
      setTimeout(() => emitTurn(data.text), 50);
    });
    return;
  }

  // Abort
  if (parsed.pathname.match(/^\/session\/[^/]+\/abort$/)) {
    res.writeHead(200);
    res.end();
    return;
  }

  // Approval response
  if (parsed.pathname.match(/^\/permission\/[^/]+\/(allow|deny)$/)) {
    res.writeHead(200);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function sendEvent(event) {
  if (!sseClient) return;
  sseClient.write(`data: ${JSON.stringify(event)}\n\n`);
}

function emitTurn(userText) {
  const turnId = `turn-${Date.now()}`;

  // Stream a few tokens
  const words = ['hello', 'from', 'hermes', 'stub'];
  words.forEach((word, i) => {
    setTimeout(() => {
      sendEvent({ type: 'token', data: { token: word + ' ' } });
    }, i * 30);
  });

  // Done event
  setTimeout(() => {
    sendEvent({ type: 'done', data: {} });
  }, words.length * 30 + 50);
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Hermes gateway stub listening on ${port}`);
});
