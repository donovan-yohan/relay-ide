import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HermesProtocolAdapter } from '../server/protocol-adapters/hermes-adapter.js';
import type { AdapterConfig } from '../server/protocol-adapter.js';
import type { ChatEvent } from '../shared/chat-events.js';

/**
 * Integration coverage for durable Hermes resume (#1087). Drives a real
 * HermesProtocolAdapter against an in-process gateway that speaks just enough of
 * the Responses SSE protocol to (a) pass the reachability probe, (b) stream a
 * completed response with a known id, and (c) record every `/v1/responses`
 * request body so we can assert `previous_response_id` chaining after a resume.
 */

interface InlineGateway {
  server: http.Server;
  endpoint: string;
  requests: Array<Record<string, unknown>>;
}

function startInlineGateway(responseId: string): Promise<InlineGateway> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'inline-stub' }] }));
        return;
      }
      if (req.url === '/v1/responses') {
        try {
          requests.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          requests.push({});
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        const send = (obj: unknown): void => {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        };
        send({ type: 'response.created', response: { id: responseId } });
        send({ type: 'response.output_text.delta', delta: 'ok' });
        send({
          type: 'response.completed',
          response: {
            id: responseId,
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'done' }],
              },
            ],
          },
        });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, endpoint: `http://127.0.0.1:${port}`, requests });
    });
  });
}

function configFor(endpoint: string, sessionId: string): AdapterConfig {
  return {
    cwd: process.cwd(),
    port: 0,
    sessionId,
    hookToken: 'test-hook',
    configDir: process.cwd(),
    extra: { endpoint, apiToken: 'inline-key' },
  };
}

describe('Hermes durable resume', () => {
  let gateway: InlineGateway | undefined;
  let adapter: HermesProtocolAdapter | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.disconnect().catch(() => {});
      adapter = undefined;
    }
    if (gateway) {
      await new Promise<void>((resolve) =>
        gateway!.server.close(() => resolve())
      );
      gateway = undefined;
    }
  });

  it('emits a provider-session event carrying the completed response id', async () => {
    gateway = await startInlineGateway('resp_emit_1');
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-emit-1'));
    await adapter.sendMessage('turn-1', 'remember 42');

    const providerSession = events.find(
      (event) => event.type === 'chat:provider-session'
    );
    expect(providerSession).toBeDefined();
    if (providerSession?.type !== 'chat:provider-session') {
      throw new Error('expected a provider-session event');
    }
    expect(providerSession.sessionId).toBe('sess-emit-1');
    expect(providerSession.providerSession).toEqual({
      hermesResponseId: 'resp_emit_1',
    });
  });

  it('chains the next turn from a restored response id after resumeSession', async () => {
    gateway = await startInlineGateway('resp_after_resume');
    adapter = new HermesProtocolAdapter();

    // Simulate a cold-restart resume: connect (resets chaining), then restore
    // the stored response id via resumeSession before the next turn.
    await adapter.connect(configFor(gateway.endpoint, 'sess-resume-1'));
    await adapter.resumeSession('resp_previous_turn');
    await adapter.sendMessage('turn-1', 'continue');

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.['previous_response_id']).toBe(
      'resp_previous_turn'
    );
    expect(gateway.requests[0]?.['session_id']).toBe('sess-resume-1');
  });

  it('does not chain when resume was never called (fresh session)', async () => {
    gateway = await startInlineGateway('resp_fresh');
    adapter = new HermesProtocolAdapter();

    await adapter.connect(configFor(gateway.endpoint, 'sess-fresh-1'));
    await adapter.sendMessage('turn-1', 'hello');

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.['previous_response_id']).toBeUndefined();
  });

  it('injects the Relay cwd through instructions without a custom cwd request field', async () => {
    gateway = await startInlineGateway('resp_cwd');
    adapter = new HermesProtocolAdapter();

    await adapter.connect(configFor(gateway.endpoint, 'sess-cwd-1'));
    await adapter.sendMessage('turn-1', 'where am I?');

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.['session_id']).toBe('sess-cwd-1');
    expect(gateway.requests[0]?.['cwd']).toBeUndefined();
    expect(gateway.requests[0]?.['instructions']).toContain(
      'Relay session context:'
    );
    expect(gateway.requests[0]?.['instructions']).toContain(
      `- cwd: ${process.cwd()}`
    );
  });
});
