import { afterEach, expect, test } from 'vitest';

import {
  createContextPacket,
  fetchInboxMessages,
  sendInboxMessage,
  updateInboxMessageState,
} from '../frontend/src/lib/api.js';

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

const requests: CapturedRequest[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  requests.length = 0;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(responses: unknown[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const body = responses.shift();
    if (body === undefined) throw new Error('unexpected fetch');
    return jsonResponse(body, init?.method === 'POST' ? 201 : 200);
  }) as typeof globalThis.fetch;
}

test('context feedback api creates a file anchor and sends it through inbox verbs', async () => {
  installFetch([
    {
      contextPacket: {
        id: 'cp:web-1',
        kind: 'file-anchor',
        createdAt: '2026-05-28T00:00:00.000Z',
        createdBy: 'relay-web',
      },
    },
    {
      message: {
        id: 'im:web-1',
        targetSessionId: 'local:session-1',
        contextPacketIds: ['cp:web-1'],
        state: 'queued',
        createdAt: '2026-05-28T00:00:01.000Z',
        createdBy: 'relay-web',
      },
    },
  ]);

  const packet = await createContextPacket({
    kind: 'file-anchor',
    anchor: {
      ref: {
        nodeId: 'local',
        path: '/repo/README.md',
        capturedAt: '2026-05-28T00:00:00.000Z',
        intent: 'read',
      },
      lineRange: { startLine: 1, endLine: 3 },
      quote: '# relay',
    },
    binding: { nodeId: 'local' },
    createdBy: 'relay-web',
  });
  const message = await sendInboxMessage({
    targetSessionId: 'local:session-1',
    contextPacketIds: [packet.id],
    text: 'please review this markdown range',
    createdBy: 'relay-web',
  });

  expect(packet.id).toBe('cp:web-1');
  expect(message.contextPacketIds).toEqual(['cp:web-1']);
  expect(requests.map((request) => request.url)).toEqual([
    '/context',
    '/inbox',
  ]);
  expect(requests[0]?.init?.headers).toMatchObject({
    'Content-Type': 'application/json',
    'x-relay-capabilities': 'context:read,context:write,inbox:read,inbox:write',
  });
  expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
    targetSessionId: 'local:session-1',
    contextPacketIds: ['cp:web-1'],
  });
});

test('context feedback api lists inbox feedback and drives review state transitions', async () => {
  installFetch([
    {
      messages: [
        {
          id: 'im:web-1',
          targetSessionId: 'local:session-1',
          contextPacketIds: ['cp:web-1'],
          state: 'delivered',
          text: 'please review this range',
          contextPackets: [
            { id: 'cp:web-1', kind: 'file-anchor', anchorState: 'unchanged' },
          ],
        },
      ],
    },
    {
      message: {
        id: 'im:web-1',
        targetSessionId: 'local:session-1',
        contextPacketIds: ['cp:web-1'],
        state: 'resolved',
      },
    },
  ]);

  const messages = await fetchInboxMessages('local:session-1', 8);
  const resolved = await updateInboxMessageState('im:web-1', 'resolve');

  expect(messages[0]?.contextPackets?.[0]?.anchorState).toBe('unchanged');
  expect(resolved.state).toBe('resolved');
  expect(requests[0]?.url).toBe(
    '/inbox?targetSessionId=local%3Asession-1&limit=8'
  );
  expect(requests[1]?.url).toBe('/inbox/im%3Aweb-1/resolve');
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
    actorId: 'relay-web',
  });
});
