import { describe, expect, it } from 'vitest';

import { InMemoryTransport } from '@modelcontextprotocol/server';

import { RELAY_CLI_GATEWAY_CONTRACT } from '../shared/cli-gateway-contract.js';
import {
  createRelayChannelClient,
  RelayChannelClientError,
  RelayChannelSubscriptionOverflowError,
  type RelayChannelClient,
} from '../shared/channel-client.js';
import {
  createRelayMcpServer,
  executeRelayMcpTool,
  RELAY_MCP_CHANNEL_COMMANDS,
  RELAY_MCP_SUBSCRIBE_MAX_EVENTS,
  RELAY_MCP_SUBSCRIBE_MAX_IDLE_TIMEOUT_MS,
  relayMcpToolDefinitions,
} from '../shared/relay-mcp.js';

const PRIVATE_VALUES = [
  'runtime-private',
  'turn-private',
  'item-private',
  'detail-private',
  'provider-runtime-private',
  'provider-item-private',
  'source-runtime-private',
] as const;

const encoder = new TextEncoder();

function ndjson(lines: unknown[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines)
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

const privateMessage = {
  schemaVersion: 1,
  id: 'chm:one',
  channelId: 'topic:one',
  seq: 1,
  kind: 'message',
  status: 'complete',
  sender: { kind: 'agent', id: 'agent:relay' },
  body: { text: 'safe body', format: 'text' },
  threadId: null,
  parentMessageId: null,
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
  source: {
    runtimeId: PRIVATE_VALUES[0],
    turnId: PRIVATE_VALUES[1],
    itemId: PRIVATE_VALUES[2],
  },
  agentDetail: { itemId: PRIVATE_VALUES[3], card: { title: 'public card' } },
  providerRuntimeId: PRIVATE_VALUES[4],
  nested: {
    provider_item_id: PRIVATE_VALUES[5],
    source_runtime_id: PRIVATE_VALUES[6],
    api_key: 'must-never-leak',
  },
};

function fakeClient(
  overrides: Partial<RelayChannelClient> = {}
): RelayChannelClient {
  return {
    list: async () => ({ channels: [] }),
    get: async () => ({ channel: {} }),
    run: { get: async () => ({ run: { id: 'chrun:one' } }) },
    history: async () => ({ messages: [privateMessage] }),
    threads: { history: async () => ({ messages: [privateMessage] }) },
    roster: async () => ({ roster: [] }),
    post: async () => ({ message: privateMessage as never }),
    subscribe: async function* () {} as RelayChannelClient['subscribe'],
    collect: async () => ({
      durableSeq: 1,
      stopReason: 'stream-closed',
      frames: [
        {
          schemaVersion: 1,
          frame: 'event',
          channelId: 'topic:one',
          sequence: 1,
          occurredAt: '2026-08-12T00:00:00.000Z',
          durableSeq: 1,
          payload: {
            type: 'channel-snapshot-v1',
            stateReplacements: [{ message: privateMessage }],
          },
        },
      ],
      state: {
        channelId: 'topic:one',
        messages: [privateMessage],
        byId: { 'chm:one': privateMessage },
      },
    }),
    ...overrides,
  } as unknown as RelayChannelClient;
}

type JsonRpcResponse = {
  id: number;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    ('result' in value || 'error' in value)
  );
}

/** Exercise the actual registered MCP handlers, not only the facade helper. */
async function openMcp(client: RelayChannelClient): Promise<{
  request: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<JsonRpcResponse>;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createRelayMcpServer(client);
  const pending = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (reason: Error) => void;
    }
  >();
  let nextId = 1;
  const rejectPending = () => {
    const error = new Error('MCP test transport closed before response');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  clientTransport.onmessage = (message) => {
    if (!isJsonRpcResponse(message)) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    request.resolve(message);
  };
  clientTransport.onclose = rejectPending;
  serverTransport.onclose = rejectPending;
  const request = async (
    method: string,
    params?: Record<string, unknown>
  ): Promise<JsonRpcResponse> => {
    const id = nextId++;
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    try {
      await clientTransport.send({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    } catch (error) {
      pending.delete(id);
      throw error;
    }
    return response;
  };

  await server.connect(serverTransport);
  await clientTransport.start();
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'relay-mcp-test', version: '0.0.0' },
  });
  if (initialized.error)
    throw new Error(
      `MCP initialize failed: ${JSON.stringify(initialized.error)}`
    );
  await clientTransport.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  return {
    request,
    close: async () => {
      rejectPending();
      await Promise.all([clientTransport.close(), serverTransport.close()]);
    },
  };
}

describe('relay-mcp', () => {
  it('derives the closed eight-tool set from the gateway contract and command manifest', () => {
    const tools = relayMcpToolDefinitions();
    expect(tools.map((tool) => tool.command)).toEqual(
      RELAY_MCP_CHANNEL_COMMANDS
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      'relay_channels_list',
      'relay_channels_get',
      'relay_channels_run_get',
      'relay_channels_history',
      'relay_channels_subscribe',
      'relay_channels_threads_history',
      'relay_channels_roster',
      'relay_channels_post',
    ]);
    for (const tool of tools) {
      const spec = RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.find(
        (entry) => entry.name === tool.command
      );
      expect(spec).toBeDefined();
      expect(tool.outputSchema.oneOf?.[0]?.title).toBe(
        tool.command === 'channels.subscribe'
          ? 'ChannelsSubscribeCollectionOutput'
          : spec?.outputSchema.title
      );
      if (tool.command !== 'channels.subscribe') {
        expect(tool.inputSchema).toEqual(spec?.inputSchema);
      }
    }
  });

  it('fails closed for commands and tool inputs outside the allowlist', async () => {
    expect(RELAY_MCP_CHANNEL_COMMANDS).not.toContain('sessions.input');
    expect(RELAY_MCP_CHANNEL_COMMANDS).not.toContain('files.read');
    const result = await executeRelayMcpTool(
      'channels.get',
      { channelId: 'topic:one', token: 'never-accepted' },
      fakeClient()
    );
    expect(result).toMatchObject({
      ok: false,
      command: 'channels.get',
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(JSON.stringify(result)).not.toContain('never-accepted');
    const forbidden = await executeRelayMcpTool(
      'sessions.input' as never,
      { id: 'session:one', data: 'never-run' },
      fakeClient({
        list: async () => {
          throw new Error('unexpected client call');
        },
      })
    );
    expect(forbidden).toMatchObject({
      ok: false,
      command: 'channels.list',
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(JSON.stringify(forbidden)).not.toContain('sessions.input');
  });

  it('requires bounded subscribe count and time before opening a stream', async () => {
    let calls = 0;
    const client = fakeClient({
      collect: async (input) => {
        calls += 1;
        expect(input.maxEvents).toBe(2);
        expect(input.idleTimeoutMs).toBe(500);
        return {
          frames: [],
          state: {} as never,
          durableSeq: 0,
          stopReason: 'stream-closed',
        };
      },
    });
    const missing = await executeRelayMcpTool(
      'channels.subscribe',
      { channelId: 'topic:one' },
      client
    );
    const unbounded = await executeRelayMcpTool(
      'channels.subscribe',
      {
        channelId: 'topic:one',
        maxEvents: RELAY_MCP_SUBSCRIBE_MAX_EVENTS + 1,
        idleTimeoutMs: 500,
      },
      client
    );
    const timeout = await executeRelayMcpTool(
      'channels.subscribe',
      {
        channelId: 'topic:one',
        maxEvents: 2,
        idleTimeoutMs: RELAY_MCP_SUBSCRIBE_MAX_IDLE_TIMEOUT_MS + 1,
      },
      client
    );
    const accepted = await executeRelayMcpTool(
      'channels.subscribe',
      { channelId: 'topic:one', maxEvents: 2, idleTimeoutMs: 500 },
      client
    );
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(unbounded).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(timeout).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(accepted).toMatchObject({ ok: true, command: 'channels.subscribe' });
    expect(calls).toBe(1);
    const subscribe = relayMcpToolDefinitions().find(
      (tool) => tool.command === 'channels.subscribe'
    );
    expect(subscribe?.inputSchema.required).toEqual(
      expect.arrayContaining(['channelId', 'maxEvents', 'idleTimeoutMs'])
    );
    const collection = subscribe?.outputSchema.oneOf?.[0]?.properties?.['data'];
    expect(collection).toMatchObject({
      title: 'ChannelsSubscribeCollectionData',
      type: 'object',
      required: ['frames', 'state', 'durableSeq', 'stopReason'],
    });
    expect(collection?.properties?.['frames']?.items).toEqual(
      RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.find(
        (spec) => spec.name === 'channels.subscribe'
      )?.outputSchema.properties?.['data']
    );
  });

  it('forwards only validated subscribe predicates before authoritative bounds and identity', async () => {
    let received: Record<string, unknown> | undefined;
    const client = fakeClient({
      collect: async (input) => {
        received = input as unknown as Record<string, unknown>;
        return {
          frames: [],
          state: {} as never,
          durableSeq: 7,
          stopReason: 'max-events',
        };
      },
    });
    const malformed = await executeRelayMcpTool(
      'channels.subscribe',
      {
        channelId: 'topic:one',
        maxEvents: 2,
        idleTimeoutMs: 100,
        filter: { runId: 'chrun:one', channelId: 'topic:other' },
      },
      client
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(received).toBeUndefined();

    await expect(
      executeRelayMcpTool(
        'channels.subscribe',
        {
          channelId: 'topic:one',
          afterSeq: 4,
          maxEvents: 2,
          idleTimeoutMs: 100,
          filter: { runId: 'chrun:one', terminalOnly: true },
        },
        client
      )
    ).resolves.toMatchObject({ ok: true });
    expect(received).toEqual({
      runId: 'chrun:one',
      terminalOnly: true,
      channelId: 'topic:one',
      afterSeq: 4,
      maxEvents: 2,
      idleTimeoutMs: 100,
    });
  });

  it('maps local overflow before generic client errors and derives generic retryability', async () => {
    const overflow = await executeRelayMcpTool(
      'channels.subscribe',
      { channelId: 'topic:one', maxEvents: 1, idleTimeoutMs: 100 },
      fakeClient({
        collect: async () => {
          throw new RelayChannelSubscriptionOverflowError('line-bytes', 8, 9);
        },
      })
    );
    expect(overflow).toMatchObject({
      ok: false,
      error: {
        code: 'UPSTREAM_ERROR',
        retryable: false,
        details: { limit: 'line-bytes', maximum: 8, observed: 9 },
      },
    });
    const client4xx = await executeRelayMcpTool(
      'channels.get',
      { channelId: 'topic:one' },
      fakeClient({
        get: async () => {
          throw new RelayChannelClientError(404, { code: 'NOT_FOUND' });
        },
      })
    );
    const client5xx = await executeRelayMcpTool(
      'channels.get',
      { channelId: 'topic:one' },
      fakeClient({
        get: async () => {
          throw new RelayChannelClientError(502, { code: 'UPSTREAM_ERROR' });
        },
      })
    );
    expect(client4xx).toMatchObject({ error: { retryable: false } });
    expect(client5xx).toMatchObject({ error: { retryable: true } });
  });

  it('registers valid bounded collection schemas and results through MCP tools/list and tools/call', async () => {
    let collections = 0;
    const mcp = await openMcp(
      fakeClient({
        collect: async ({ maxEvents, idleTimeoutMs }) => {
          collections += 1;
          expect(maxEvents).toBe(2);
          expect(idleTimeoutMs).toBe(250);
          return {
            frames: [],
            state: { channelId: 'topic:one' } as never,
            durableSeq: 4,
            stopReason: 'max-events',
          };
        },
      })
    );
    try {
      const listed = await mcp.request('tools/list');
      expect(listed.error).toBeUndefined();
      const tools = listed.result?.['tools'] as
        | Array<Record<string, unknown>>
        | undefined;
      const subscribe = tools?.find(
        (tool) => tool['name'] === 'relay_channels_subscribe'
      );
      expect(tools).toHaveLength(8);
      expect(subscribe).toMatchObject({
        inputSchema: {
          required: expect.arrayContaining([
            'channelId',
            'maxEvents',
            'idleTimeoutMs',
          ]),
        },
      });

      const accepted = await mcp.request('tools/call', {
        name: 'relay_channels_subscribe',
        arguments: {
          channelId: 'topic:one',
          maxEvents: 2,
          idleTimeoutMs: 250,
        },
      });
      expect(accepted.error).toBeUndefined();
      expect(accepted.result).toMatchObject({
        structuredContent: {
          ok: true,
          command: 'channels.subscribe',
          data: {
            frames: [],
            state: { channelId: 'topic:one' },
            durableSeq: 4,
            stopReason: 'max-events',
          },
        },
      });

      const overBound = await mcp.request('tools/call', {
        name: 'relay_channels_subscribe',
        arguments: {
          channelId: 'topic:one',
          maxEvents: RELAY_MCP_SUBSCRIBE_MAX_EVENTS + 1,
          idleTimeoutMs: 250,
        },
      });
      expect(overBound.error).toBeUndefined();
      expect(overBound.result).toMatchObject({ isError: true });
      expect(collections).toBe(1);
    } finally {
      await mcp.close();
    }
  });

  it('keeps the actual client-to-MCP post projection public while retaining Relay correlation ids', async () => {
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async () =>
        Response.json({
          message: {
            ...privateMessage,
            // A real upstream can echo a provider locator inside otherwise
            // public diagnostic prose. The client must discover the private
            // leaf before dropping its keyed source and the MCP facade must
            // never reintroduce that value.
            meta: { diagnostic: `upstream echoed ${PRIVATE_VALUES[0]}` },
          },
          run: {
            id: 'chrun:public',
            channelId: 'topic:one',
            threadId: null,
            requestMessageId: 'chm:one',
            requesterId: 'human:operator',
            state: 'submitted',
            targets: [
              {
                targetId: 'target:public',
                state: 'queued',
                updatedAt: '2026-08-12T00:00:00.000Z',
              },
            ],
            createdAt: '2026-08-12T00:00:00.000Z',
            updatedAt: '2026-08-12T00:00:00.000Z',
            runtimeId: PRIVATE_VALUES[0],
            providerTurnId: PRIVATE_VALUES[1],
          },
        }),
    });
    const mcp = await openMcp(client);
    try {
      const response = await mcp.request('tools/call', {
        name: 'relay_channels_post',
        arguments: { channelId: 'topic:one', text: 'hello' },
      });
      expect(response.error).toBeUndefined();
      const structured = response.result?.['structuredContent'];
      expect(structured, JSON.stringify(response)).toBeDefined();
      const serialized = JSON.stringify(structured);
      for (const privateValue of PRIVATE_VALUES)
        expect(serialized).not.toContain(privateValue);
      expect(serialized).not.toMatch(
        /"(?:source|runtimeId|turnId|itemId|providerRuntimeId|providerTurnId|provider_item_id|source_runtime_id)"/
      );
      expect(structured).toMatchObject({
        ok: true,
        command: 'channels.post',
        data: {
          message: { sender: { id: 'agent:relay' } },
          run: {
            id: 'chrun:public',
            targets: [{ targetId: 'target:public' }],
          },
        },
      });
    } finally {
      await mcp.close();
    }
  });

  it('turns malformed upstream subscription frames into canonical UPSTREAM_ERROR MCP output', async () => {
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async () =>
        ndjson([
          {
            schemaVersion: 1,
            frame: 'event',
            channelId: 'topic:one',
            sequence: 1,
            occurredAt: '2026-08-12T00:00:01.000Z',
            durableSeq: 1,
            payload: {
              type: 'channel-message-created-v1',
              channelId: 'topic:other',
            },
          },
        ]),
    });
    const mcp = await openMcp(client);
    try {
      const response = await mcp.request('tools/call', {
        name: 'relay_channels_subscribe',
        arguments: {
          channelId: 'topic:one',
          maxEvents: 1,
          idleTimeoutMs: 100,
        },
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          command: 'channels.subscribe',
          error: { code: 'UPSTREAM_ERROR', retryable: true },
        },
      });
      expect(response.result?.['content']).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('"code":"UPSTREAM_ERROR"'),
        }),
      ]);
    } finally {
      await mcp.close();
    }
  });

  it('preserves exact sibling scope failures and concurrent Relay post/run correlation', async () => {
    const posts: Array<{ channelId: string; clientMessageId?: string }> = [];
    const client = fakeClient({
      get: async ({ channelId }) => {
        if (channelId === 'topic:forbidden')
          throw new RelayChannelClientError(403, {
            code: 'FORBIDDEN',
            message: 'not scoped to sibling channel',
            retryable: false,
          });
        return { channel: { id: channelId } } as never;
      },
      post: async ({ channelId, clientMessageId }) => {
        posts.push({ channelId, clientMessageId });
        return {
          message: { channelId, clientMessageId },
          run: {
            id: `chrun:${clientMessageId}`,
            channelId,
            targets: [{ targetId: `target:${clientMessageId}` }],
          },
        } as never;
      },
      run: {
        get: async ({ channelId, runId }) =>
          ({ run: { id: runId, channelId } }) as never,
      },
    });
    const [first, second] = await Promise.all([
      executeRelayMcpTool(
        'channels.post',
        {
          channelId: 'topic:one',
          text: 'first',
          clientMessageId: 'request-one',
        },
        client
      ),
      executeRelayMcpTool(
        'channels.post',
        {
          channelId: 'topic:two',
          text: 'second',
          clientMessageId: 'request-two',
        },
        client
      ),
    ]);
    expect(posts).toEqual([
      { channelId: 'topic:one', clientMessageId: 'request-one' },
      { channelId: 'topic:two', clientMessageId: 'request-two' },
    ]);
    expect(first).toMatchObject({
      ok: true,
      data: {
        run: {
          id: 'chrun:request-one',
          targets: [{ targetId: 'target:request-one' }],
        },
      },
    });
    expect(second).toMatchObject({
      ok: true,
      data: {
        run: {
          id: 'chrun:request-two',
          targets: [{ targetId: 'target:request-two' }],
        },
      },
    });
    await expect(
      executeRelayMcpTool(
        'channels.get',
        { channelId: 'topic:forbidden' },
        client
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
  });

  it('projects provider diagnostics out of history, streamed replacements, and typed errors', async () => {
    const history = await executeRelayMcpTool(
      'channels.history',
      { channelId: 'topic:one' },
      fakeClient()
    );
    const subscribe = await executeRelayMcpTool(
      'channels.subscribe',
      { channelId: 'topic:one', maxEvents: 1, idleTimeoutMs: 100 },
      fakeClient()
    );
    const error = await executeRelayMcpTool(
      'channels.history',
      { channelId: 'topic:one' },
      fakeClient({
        history: async () => {
          throw new RelayChannelClientError(502, {
            code: 'UPSTREAM_ERROR',
            message: `upstream ${PRIVATE_VALUES[0]} failed`,
            retryable: true,
            details: {
              source: {
                runtimeId: PRIVATE_VALUES[0],
                turnId: PRIVATE_VALUES[1],
              },
            },
          });
        },
      })
    );

    for (const envelope of [history, subscribe, error]) {
      const serialized = JSON.stringify(envelope);
      expect(serialized).not.toMatch(
        /"(?:source|runtimeId|turnId|itemId|providerRuntimeId|provider_item_id|source_runtime_id|api_key)"/
      );
      for (const privateValue of PRIVATE_VALUES)
        expect(serialized).not.toContain(privateValue);
      expect(serialized).not.toContain('must-never-leak');
      expect(serialized).not.toContain('RELAY_IDE_ACTOR_TOKEN');
    }
    expect(history).toMatchObject({
      ok: true,
      data: { messages: [{ sender: { id: 'agent:relay' } }] },
    });
    expect(subscribe).toMatchObject({
      ok: true,
      data: {
        frames: [
          {
            payload: {
              stateReplacements: [{ message: { body: { text: 'safe body' } } }],
            },
          },
        ],
      },
    });
    expect(error).toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_ERROR', message: 'upstream [redacted] failed' },
    });
  });
});
