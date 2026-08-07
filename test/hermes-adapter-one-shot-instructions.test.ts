import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRelayHermesSessionInstructions,
  HermesProtocolAdapter,
} from '../server/protocol-adapters/hermes-adapter.js';
import type { AdapterConfig } from '../server/protocol-adapter.js';

/**
 * #1062 review follow-up: the ticket-launch kickoff prompt
 * (`extra.initialInstructions`) must be delivered once (mirroring the PTY
 * path's one-shot typed initial prompt, server/sessions.ts), not resent as
 * persistent system framing on every turn the way channel `promptDefaults`
 * (`extra.instructions`, #1090) intentionally are. Drives a real
 * HermesProtocolAdapter across two turns against an in-process stub gateway
 * and asserts the `instructions` field sent with each `/v1/responses` call.
 */

interface InlineGateway {
  server: http.Server;
  endpoint: string;
  requests: Array<Record<string, unknown>>;
}

function startInlineGateway(): Promise<InlineGateway> {
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
        const id = `resp_${requests.length}`;
        send({ type: 'response.created', response: { id } });
        send({ type: 'response.output_text.delta', delta: 'ok' });
        send({
          type: 'response.completed',
          response: {
            id,
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

function configFor(
  endpoint: string,
  sessionId: string,
  extra: Record<string, unknown>
): AdapterConfig {
  return {
    cwd: process.cwd(),
    port: 0,
    sessionId,
    hookToken: 'test-hook',
    configDir: process.cwd(),
    extra: { endpoint, apiToken: 'inline-key', ...extra },
  };
}

describe('HermesProtocolAdapter one-shot initialInstructions (#1062 review follow-up)', () => {
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

  it('sends the ticket kickoff only on the first turn, dropping it from later turns', async () => {
    gateway = await startInlineGateway();
    adapter = new HermesProtocolAdapter();

    await adapter.connect(
      configFor(gateway.endpoint, 'sess-ticket-1', {
        instructions: 'Prefer terse answers.',
        initialInstructions: 'You are working on ticket GH-42.',
      })
    );
    await adapter.sendMessage('turn-1', 'hello');
    await adapter.sendMessage('turn-2', 'continue');

    const relayContext = buildRelayHermesSessionInstructions({
      sessionId: 'sess-ticket-1',
      cwd: process.cwd(),
    });
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]?.['instructions']).toBe(
      `${relayContext}\n\nPrefer terse answers.\n\nYou are working on ticket GH-42.`
    );
    expect(gateway.requests[1]?.['instructions']).toBe(
      `${relayContext}\n\nPrefer terse answers.`
    );
  });

  it('keeps only Relay context once the one-shot kickoff is consumed and there is no persistent channel instructions', async () => {
    gateway = await startInlineGateway();
    adapter = new HermesProtocolAdapter();

    await adapter.connect(
      configFor(gateway.endpoint, 'sess-ticket-2', {
        initialInstructions: 'You are working on ticket GH-42.',
      })
    );
    await adapter.sendMessage('turn-1', 'hello');
    await adapter.sendMessage('turn-2', 'continue');

    const relayContext = buildRelayHermesSessionInstructions({
      sessionId: 'sess-ticket-2',
      cwd: process.cwd(),
    });
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]?.['instructions']).toBe(
      `${relayContext}\n\nYou are working on ticket GH-42.`
    );
    expect(gateway.requests[1]?.['instructions']).toBe(relayContext);
  });

  it('resets the one-shot flag on reconnect so a fresh conversation gets the kickoff again', async () => {
    gateway = await startInlineGateway();
    adapter = new HermesProtocolAdapter();

    const config = configFor(gateway.endpoint, 'sess-ticket-3', {
      initialInstructions: 'You are working on ticket GH-42.',
    });
    await adapter.connect(config);
    await adapter.sendMessage('turn-1', 'hello');
    await adapter.reconnect();
    await adapter.sendMessage('turn-2', 'hello again');

    const relayContext = buildRelayHermesSessionInstructions({
      sessionId: 'sess-ticket-3',
      cwd: process.cwd(),
    });
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]?.['instructions']).toBe(
      `${relayContext}\n\nYou are working on ticket GH-42.`
    );
    expect(gateway.requests[1]?.['instructions']).toBe(
      `${relayContext}\n\nYou are working on ticket GH-42.`
    );
  });
});
