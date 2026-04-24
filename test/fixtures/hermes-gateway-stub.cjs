#!/usr/bin/env node
/* eslint-disable */
/**
 * Mock Hermes Gateway Stub
 *
 * Lightweight HTTP server that mimics the Hermes API server protocol
 * expected by server/protocol-adapters/hermes-adapter.ts.
 *
 * Usage: API_SERVER_PORT=1234 node hermes-gateway-stub.js
 */

const http = require('http');
const url = require('url');

const port = parseInt(process.env.API_SERVER_PORT || process.argv[2], 10);
if (!port || isNaN(port)) {
  console.error('Usage: node hermes-gateway-stub.js <port>');
  process.exit(1);
}

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

  // OpenAI-compatible Responses streaming endpoint
  if (parsed.pathname === '/v1/responses') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const data = JSON.parse(body);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      emitTurn(res, data.input);
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

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

function emitTurn(res, userText) {
  const responseId = `resp_${Date.now()}`;
  sendEvent(res, 'response.created', {
    response: { id: responseId, status: 'in_progress', output: [] },
  });

  // Stream a few tokens
  const words = ['hello', 'from', 'hermes', 'stub'];
  words.forEach((word, i) => {
    setTimeout(() => {
      sendEvent(res, 'response.output_text.delta', { delta: word + ' ' });
    }, i * 30);
  });

  setTimeout(
    () => {
      sendEvent(res, 'response.completed', {
        response: {
          id: responseId,
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: `echo: ${userText}` }],
            },
          ],
        },
      });
      res.end();
    },
    words.length * 30 + 50
  );
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Hermes gateway stub listening on ${port}`);
});
