import { EventEmitter, once } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { setupWebSocket } from '../server/ws.js';
import { createLocalRelayNode } from '../server/local-node.js';
import { createChannelMessageStore } from '../server/channel-message-store.js';
import { createChannelHub } from '../server/channel-hub.js';
import type { WorktreeWatcher } from '../server/watcher.js';

// Exercises the REAL ws.ts upgrade handler for /ws/channels/:channelId — the
// auth-before-upgrade gate, the 4404 close for unknown channels, and the
// snapshot-on-connect happy path — rather than driving the hub with fake sockets.

const cleanupFns: Array<() => void> = [];
const KNOWN_CHANNEL = 'topic:known';
const TOKEN = 'valid-cookie-token';

afterEach(() => {
  for (const cleanup of cleanupFns.splice(0)) cleanup();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server did not listen on a tcp port');
  }
  return address.port;
}

function makeServer(): { server: http.Server } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ws-channels-'));
  cleanupFns.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
  cleanupFns.push(() => store.close());
  const hub = createChannelHub({
    store,
    channelExists: (id) => id === KNOWN_CHANNEL,
  });
  cleanupFns.push(() => hub.close());

  const server = http.createServer();
  const watcher = new EventEmitter();
  const { wss } = setupWebSocket(
    server,
    new Set<string>([TOKEN]),
    watcher as unknown as WorktreeWatcher,
    undefined,
    true,
    createLocalRelayNode({ nodeId: 'node-a', environmentId: 'env-a' }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    hub
  );
  cleanupFns.push(() => wss.close());
  cleanupFns.push(() => server.close());
  return { server };
}

function connect(port: number, channelId: string, cookie?: string): WebSocket {
  const client = new WebSocket(
    `ws://127.0.0.1:${port}/ws/channels/${encodeURIComponent(channelId)}`,
    cookie ? { headers: { Cookie: cookie } } : {}
  );
  client.on('error', () => {});
  cleanupFns.push(() => client.close());
  return client;
}

describe('/ws/channels upgrade auth', () => {
  it('rejects an unauthenticated upgrade with 401 (no upgrade)', async () => {
    const { server } = makeServer();
    const port = await listen(server);
    const client = connect(port, KNOWN_CHANNEL, 'token=not-the-token');
    const [, res] = (await once(client, 'unexpected-response')) as [
      http.ClientRequest,
      http.IncomingMessage,
    ];
    expect(res.statusCode).toBe(401);
  });

  it('closes an authenticated upgrade to an unknown channel with app code 4404', async () => {
    const { server } = makeServer();
    const port = await listen(server);
    const client = connect(port, 'topic:ghost', `token=${TOKEN}`);
    const [code] = (await once(client, 'close')) as [number];
    expect(code).toBe(4404);
  });

  it('delivers a snapshot on an authenticated upgrade to a valid channel', async () => {
    const { server } = makeServer();
    const port = await listen(server);
    const client = connect(port, KNOWN_CHANNEL, `token=${TOKEN}`);
    const [raw] = (await once(client, 'message')) as [Buffer];
    const event = JSON.parse(raw.toString()) as { type: string };
    expect(event.type).toBe('channel-snapshot-v1');
  });
});
