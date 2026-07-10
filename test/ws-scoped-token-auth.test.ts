import { EventEmitter, once } from 'node:events';
import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createLocalRelayNode } from '../server/local-node.js';
import { setupWebSocket } from '../server/ws.js';
import { generateScopedToken } from '../server/browser-content.js';
import type { WorktreeWatcher } from '../server/watcher.js';

const cleanupFns: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupFns.splice(0)) cleanup();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server did not listen on a tcp port');
  }
  return address.port;
}

describe('websocket scoped-token auth', () => {
  it('accepts the hub browser scoped token as a cookie token', async () => {
    const scopedToken = generateScopedToken();
    const server = http.createServer();
    const watcher = new EventEmitter();
    const { wss } = setupWebSocket(
      server,
      new Set<string>(),
      watcher as unknown as WorktreeWatcher,
      undefined,
      true,
      createLocalRelayNode({ nodeId: 'node-a', environmentId: 'env-a' })
    );
    cleanupFns.push(() => wss.close());
    cleanupFns.push(() => server.close());

    const port = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
      headers: { Cookie: `token=${encodeURIComponent(scopedToken)}` },
    });
    client.on('error', () => {});
    cleanupFns.push(() => client.close());
    await once(client, 'open');
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('still rejects unknown cookie tokens', async () => {
    generateScopedToken();
    const server = http.createServer();
    const watcher = new EventEmitter();
    const { wss } = setupWebSocket(
      server,
      new Set<string>(),
      watcher as unknown as WorktreeWatcher,
      undefined,
      true,
      createLocalRelayNode({ nodeId: 'node-a', environmentId: 'env-a' })
    );
    cleanupFns.push(() => wss.close());
    cleanupFns.push(() => server.close());

    const port = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
      headers: { Cookie: 'token=not-the-scoped-token' },
    });
    client.on('error', () => {});
    cleanupFns.push(() => client.close());
    const [, res] = (await once(client, 'unexpected-response')) as [
      http.ClientRequest,
      http.IncomingMessage,
    ];
    expect(res.statusCode).toBe(401);
  });
});
