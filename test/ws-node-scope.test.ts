import { EventEmitter, once } from 'node:events';
import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createLocalRelayNode } from '../server/local-node.js';
import { setupWebSocket } from '../server/ws.js';
import type { WorktreeWatcher } from '../server/watcher.js';
import {
  testBrowserAuthTokens,
  testBrowserWsHeaders,
} from './helpers/ws-auth.js';

const cleanupFns: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupFns.splice(0)) cleanup();
});

describe('node-scoped websocket broadcasts', () => {
  it('adds local authority to no-payload worktrees-changed events', async () => {
    const server = http.createServer();
    const watcher = new EventEmitter();
    const { wss } = setupWebSocket(
      server,
      testBrowserAuthTokens(),
      watcher as unknown as WorktreeWatcher,
      undefined,
      true,
      createLocalRelayNode({ nodeId: 'node-a', environmentId: 'env-a' })
    );

    cleanupFns.push(() => wss.close());
    cleanupFns.push(() => server.close());

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server did not listen on a tcp port');
    }

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/events`, {
      headers: testBrowserWsHeaders(),
    });
    cleanupFns.push(() => client.close());
    await once(client, 'open');

    const messagePromise = once(client, 'message');
    watcher.emit('worktrees-changed');
    const [raw] = await messagePromise;
    const payload = JSON.parse(raw.toString()) as Record<string, unknown>;

    expect(payload).toMatchObject({
      type: 'worktrees-changed',
      nodeId: 'node-a',
      environmentId: 'env-a',
      authority: 'local-node',
    });
  });
});
