import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapterV2 } from '../../../server/protocol-adapters/index.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../server/protocol-adapters/legacy-v2-bridge.js';
import {
  HermesProtocolAdapter,
  resolveHermesGatewaySettings,
} from '../../../server/protocol-adapters/hermes-adapter.js';
import type { AdapterConfig } from '../../../server/protocol-adapter.js';
import type { ChatEvent } from '../../../shared/chat-events.js';

const ENV_KEYS = [
  'HOME',
  'HERMES_HOME',
  'HERMES_API_ENDPOINT',
  'HERMES_API_BASE_URL',
  'HERMES_API_URL',
  'HERMES_API_TOKEN',
  'HERMES_API_KEY',
  'HERMES_GATEWAY_API_KEY',
  'API_SERVER_KEY',
  'API_SERVER_HOST',
  'API_SERVER_PORT',
];

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);
const tempDirs: string[] = [];

function resetHermesEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hermes-home-'));
  tempDirs.push(dir);
  process.env.HOME = dir;
  delete process.env.HERMES_HOME;
  for (const key of ENV_KEYS) {
    if (key !== 'HOME' && key !== 'HERMES_HOME') delete process.env[key];
  }
  return dir;
}

afterEach(resetHermesEnv);

describe('Hermes V2 web adapter registration', () => {
  it('registers hermes as a ProtocolAdapterV2 bridge while native gateway mapping is ported', () => {
    const adapter = createAdapterV2('hermes');

    expect(adapter).toBeInstanceOf(LegacyProtocolAdapterV2Bridge);
    expect(adapter.agentType).toBe('hermes');
    expect(adapter.capabilities).toMatchObject({
      text: true,
      commandExecution: true,
      fileChanges: true,
      approvals: true,
      interrupt: true,
      resume: true,
      // chat:telemetry isn't mapped by mapChatEventToAgentPatchV2 yet, so the
      // bridge can't deliver it to the V2 stream/UI (see index.ts comment).
      telemetry: false,
    });
  });

  it('delegates resumeSession to the wrapped Hermes adapter when resume is enabled', async () => {
    const adapter = createAdapterV2('hermes');
    // Hermes resumeSession only restores in-memory chaining state (no network),
    // so it resolves without a connected gateway.
    await expect(adapter.resumeSession('resp_stored')).resolves.toBeUndefined();
  });

  it('keeps resumeSession throwing for a legacy adapter without resume capability', async () => {
    const opencode = createAdapterV2('opencode');
    expect(opencode.capabilities.resume).toBe(false);
    await expect(opencode.resumeSession('anything')).rejects.toThrow(
      /does not support resume/
    );
  });
});

describe('Hermes gateway settings resolution', () => {
  it('reads the API server endpoint and key from Hermes config.yaml', () => {
    const home = makeTempHome();
    const hermesHome = path.join(home, '.hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(
      path.join(hermesHome, 'config.yaml'),
      [
        'platforms:',
        '  api_server:',
        '    enabled: true',
        '    extra:',
        '      host: 127.0.0.1',
        '      port: 9876',
        '      key: cfg#secret # keep hash in scalar, drop comment',
        '',
      ].join('\n')
    );

    expect(resolveHermesGatewaySettings(undefined)).toEqual({
      endpoint: 'http://127.0.0.1:9876',
      apiKey: 'cfg#secret',
      source: 'Hermes config',
    });
  });

  it('ignores disabled config.yaml API server endpoints', () => {
    const home = makeTempHome();
    const hermesHome = path.join(home, '.hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(
      path.join(hermesHome, 'config.yaml'),
      [
        'platforms:',
        '  api_server:',
        '    enabled: false',
        '    extra:',
        '      host: 127.0.0.1',
        '      port: 9876',
        '      key: disabled-secret',
        '',
      ].join('\n')
    );

    expect(resolveHermesGatewaySettings(undefined)).toEqual({
      endpoint: 'http://127.0.0.1:8642',
      apiKey: null,
      source: 'default',
    });
  });

  it('lets active Hermes profile env override root env defaults', () => {
    const home = makeTempHome();
    const hermesHome = path.join(home, '.hermes');
    const profileHome = path.join(hermesHome, 'profiles', 'ebi');
    fs.mkdirSync(profileHome, { recursive: true });
    fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_PORT=1111\n');
    fs.writeFileSync(path.join(hermesHome, 'active_profile'), 'ebi\n');
    fs.writeFileSync(
      path.join(profileHome, '.env'),
      'API_SERVER_PORT=2222\nAPI_SERVER_KEY=profile-secret\n'
    );

    expect(resolveHermesGatewaySettings(undefined)).toEqual({
      endpoint: 'http://127.0.0.1:2222',
      apiKey: 'profile-secret',
      source: 'environment',
    });
  });

  it('uses the active profile under a custom HERMES_HOME root', () => {
    makeTempHome();
    const customRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-hermes-custom-')
    );
    tempDirs.push(customRoot);
    process.env.HERMES_HOME = customRoot;

    const profileHome = path.join(customRoot, 'profiles', 'ebi');
    fs.mkdirSync(profileHome, { recursive: true });
    fs.writeFileSync(path.join(customRoot, '.env'), 'API_SERVER_PORT=1111\n');
    fs.writeFileSync(path.join(customRoot, 'active_profile'), 'ebi\n');
    fs.writeFileSync(
      path.join(profileHome, '.env'),
      'API_SERVER_PORT=2222\nAPI_SERVER_KEY=custom-profile-secret\n'
    );

    expect(resolveHermesGatewaySettings(undefined)).toEqual({
      endpoint: 'http://127.0.0.1:2222',
      apiKey: 'custom-profile-secret',
      source: 'environment',
    });
  });
});

/**
 * SSE hardening coverage (#1062). Drives a real `HermesProtocolAdapter`
 * against an in-process gateway that streams a caller-scripted sequence of
 * Responses API SSE events, so we can assert the adapter never leaves a turn
 * hanging and correctly maps tool-call/reasoning/telemetry events.
 */

interface InlineGateway {
  server: http.Server;
  endpoint: string;
  requests: Array<Record<string, unknown>>;
}

function startInlineGateway(
  writeEvents: (send: (obj: unknown) => void, res: http.ServerResponse) => void
): Promise<InlineGateway> {
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
        writeEvents(send, res);
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

describe('Hermes Responses SSE hardening', () => {
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

  it('maps response.error to a chat:error and fails the turn instead of hanging', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_err' } });
      send({ type: 'response.error', message: 'gateway blew up' });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-error'));
    await adapter.sendMessage('turn-1', 'hi');

    const errorEvent = events.find((event) => event.type === 'chat:error');
    expect(errorEvent).toMatchObject({
      type: 'chat:error',
      message: 'gateway blew up',
      turnId: 'turn-1',
    });
    const completed = events.find(
      (event) => event.type === 'chat:turn-completed'
    );
    expect(completed).toMatchObject({
      type: 'chat:turn-completed',
      turnId: 'turn-1',
      reason: 'failed',
    });
    const lastStatus = events
      .filter((event) => event.type === 'chat:session-status')
      .pop();
    expect(lastStatus).toMatchObject({ status: 'error' });
  });

  it('fails the turn when response.failed carries an error message', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_failed' } });
      send({
        type: 'response.failed',
        response: { id: 'resp_failed', error: { message: 'model overloaded' } },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-failed'));
    await adapter.sendMessage('turn-1', 'hi');

    const errorEvent = events.find((event) => event.type === 'chat:error');
    expect(errorEvent).toMatchObject({ message: 'model overloaded' });
    const completed = events.find(
      (event) => event.type === 'chat:turn-completed'
    );
    expect(completed).toMatchObject({ reason: 'failed' });
  });

  it('fails the turn but keeps a chainable response id on response.incomplete', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_incomplete' } });
      send({
        type: 'response.incomplete',
        response: {
          id: 'resp_incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-incomplete'));
    await adapter.sendMessage('turn-1', 'hi');

    const errorEvent = events.find((event) => event.type === 'chat:error');
    expect(errorEvent?.message).toMatch(/incomplete/i);
    const completed = events.find(
      (event) => event.type === 'chat:turn-completed'
    );
    expect(completed).toMatchObject({ reason: 'error' });

    // The response id is still chainable — the next turn should carry it.
    await adapter.sendMessage('turn-2', 'continue');
    expect(gateway.requests[1]?.['previous_response_id']).toBe(
      'resp_incomplete'
    );
  });

  it('fails the turn when the stream closes without a terminal event', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_hang' } });
      send({ type: 'response.output_text.delta', delta: 'partial answer' });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-hang'));
    await adapter.sendMessage('turn-1', 'hi');

    const errorEvent = events.find((event) => event.type === 'chat:error');
    expect(errorEvent?.message).toMatch(/terminal/i);
    const completed = events.find(
      (event) => event.type === 'chat:turn-completed'
    );
    expect(completed).toMatchObject({ reason: 'error' });
    const lastStatus = events
      .filter((event) => event.type === 'chat:session-status')
      .pop();
    expect(lastStatus).toMatchObject({ status: 'error' });
  });

  it('accumulates function_call_arguments deltas and emits a completed tool call + result', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_tool' } });
      send({
        type: 'response.output_item.added',
        item: {
          id: 'item_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '',
        },
      });
      send({
        type: 'response.function_call_arguments.delta',
        item_id: 'item_1',
        delta: '{"path":',
      });
      send({
        type: 'response.function_call_arguments.delta',
        item_id: 'item_1',
        delta: '"a.txt"}',
      });
      send({
        type: 'response.function_call_arguments.done',
        item_id: 'item_1',
        arguments: '{"path":"a.txt"}',
      });
      send({
        type: 'response.output_item.done',
        item: {
          id: 'item_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"a.txt"}',
          status: 'completed',
          output: 'file contents',
        },
      });
      send({
        type: 'response.completed',
        response: { id: 'resp_tool', status: 'completed' },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-tool'));
    await adapter.sendMessage('turn-1', 'read a.txt');

    const toolCalls = events.filter((event) => event.type === 'chat:tool-call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      status: 'running',
      toolCallId: 'call_1',
      toolName: 'read_file',
      input: {},
    });
    expect(toolCalls[1]).toMatchObject({
      status: 'completed',
      toolCallId: 'call_1',
      toolName: 'read_file',
      input: { path: 'a.txt' },
    });

    const toolResult = events.find(
      (event) => event.type === 'chat:tool-result'
    );
    expect(toolResult).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'read_file',
      status: 'completed',
      output: 'file contents',
    });
  });

  it('completes the assistant message on response.output_text.done', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_msg' } });
      send({ type: 'response.output_text.delta', delta: 'Hel' });
      send({ type: 'response.output_text.delta', delta: 'lo' });
      send({ type: 'response.output_text.done', text: 'Hello' });
      send({
        type: 'response.completed',
        response: { id: 'resp_msg', status: 'completed' },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-msg'));
    await adapter.sendMessage('turn-1', 'hi');

    const complete = events.find(
      (event) => event.type === 'chat:message-complete'
    );
    expect(complete).toMatchObject({ role: 'assistant', content: 'Hello' });
  });

  it('streams reasoning summary deltas and completes on done', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_reason' } });
      send({
        type: 'response.reasoning_summary_text.delta',
        delta: 'Thinking',
      });
      send({
        type: 'response.reasoning_summary_text.delta',
        delta: ' it through',
      });
      send({
        type: 'response.reasoning_summary_text.done',
        text: 'Thinking it through',
      });
      send({
        type: 'response.completed',
        response: { id: 'resp_reason', status: 'completed' },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-reason'));
    await adapter.sendMessage('turn-1', 'hi');

    const reasoningEvents = events.filter(
      (event) => event.type === 'chat:reasoning'
    );
    expect(reasoningEvents.length).toBeGreaterThanOrEqual(3);
    expect(reasoningEvents[reasoningEvents.length - 1]).toMatchObject({
      isDelta: false,
      content: 'Thinking it through',
    });
  });

  it('emits chat:telemetry from response.completed usage', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_usage' } });
      send({
        type: 'response.completed',
        response: {
          id: 'resp_usage',
          status: 'completed',
          model: 'gpt-test',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            input_tokens_details: { cached_tokens: 5 },
          },
        },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-usage'));
    await adapter.sendMessage('turn-1', 'hi');

    const telemetry = events.find((event) => event.type === 'chat:telemetry');
    expect(telemetry).toMatchObject({
      model: 'gpt-test',
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 5,
    });
  });
});
