import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapterV2 } from '../../../server/protocol-adapters/index.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../server/protocol-adapters/legacy-v2-bridge.js';
import {
  buildRelayHermesSessionInstructions,
  HermesProtocolAdapter,
  resolveHermesGatewaySettings,
} from '../../../server/protocol-adapters/hermes-adapter.js';
import type { AdapterConfig } from '../../../server/protocol-adapter.js';
import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  type AgentPatchV2,
} from '../../../shared/agent-chat-protocol-v2.js';
import type { ChatEvent } from '../../../shared/chat-events.js';
import hermesDetailFixture from '../../fixtures/agent-detail/hermes.js';

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
const HERMES_FILE_ENV_KEYS = ENV_KEYS.filter(
  (key) => key !== 'HOME' && key !== 'HERMES_HOME'
);

function hermeticHermesEnv(
  overrides: Partial<Record<(typeof HERMES_FILE_ENV_KEYS)[number], string>> = {}
): string {
  return HERMES_FILE_ENV_KEYS.map(
    (key) => `${key}=${overrides[key] ?? ''}`
  ).join('\n');
}

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
  const hermesRoot = path.join(dir, '.hermes');
  fs.mkdirSync(hermesRoot, { recursive: true });
  fs.writeFileSync(path.join(hermesRoot, '.env'), hermeticHermesEnv());
  process.env.HOME = dir;
  process.env.HERMES_HOME = hermesRoot;
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
      basePath: '',
      hermesProfile: null,
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
      basePath: '',
      hermesProfile: null,
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
    fs.writeFileSync(
      path.join(hermesHome, '.env'),
      hermeticHermesEnv({ API_SERVER_PORT: '1111' })
    );
    fs.writeFileSync(path.join(hermesHome, 'active_profile'), 'ebi\n');
    fs.writeFileSync(
      path.join(profileHome, '.env'),
      'API_SERVER_PORT=2222\nAPI_SERVER_KEY=profile-secret\n'
    );

    expect(resolveHermesGatewaySettings(undefined)).toEqual({
      basePath: '',
      hermesProfile: null,
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
    fs.writeFileSync(
      path.join(customRoot, '.env'),
      hermeticHermesEnv({ API_SERVER_PORT: '1111' })
    );
    fs.writeFileSync(path.join(customRoot, 'active_profile'), 'ebi\n');
    fs.writeFileSync(
      path.join(profileHome, '.env'),
      'API_SERVER_PORT=2222\nAPI_SERVER_KEY=custom-profile-secret\n'
    );

    expect(resolveHermesGatewaySettings(undefined)).toEqual({
      basePath: '',
      hermesProfile: null,
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

  async function runCompletedTool(input: {
    toolName: string;
    arguments: Record<string, unknown>;
    output: string;
  }): Promise<ChatEvent[]> {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_tool_fixture' } });
      send({
        type: 'response.output_item.added',
        item: {
          id: 'item_tool_fixture',
          type: 'function_call',
          call_id: 'call_tool_fixture',
          name: input.toolName,
          arguments: JSON.stringify(input.arguments),
        },
      });
      send({
        type: 'response.output_item.done',
        item: {
          id: 'item_tool_fixture',
          type: 'function_call',
          call_id: 'call_tool_fixture',
          name: input.toolName,
          arguments: JSON.stringify(input.arguments),
          status: 'completed',
          output: input.output,
        },
      });
      send({
        type: 'response.completed',
        response: { id: 'resp_tool_fixture', status: 'completed' },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));
    await adapter.connect(configFor(gateway.endpoint, 'sess-tool-fixture'));
    await adapter.sendMessage('turn-1', 'synthetic tool fixture');
    return events;
  }

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

  it.each([
    {
      label: 'added',
      diff: '--- /dev/null\n+++ b/src/created.ts\n@@ -0,0 +1 @@\n+export const created = true;\n',
      path: 'src/created.ts',
      kind: 'added',
      additions: 1,
      deletions: 0,
    },
    {
      label: 'deleted',
      diff: '--- a/src/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const removed = true;\n',
      path: 'src/deleted.ts',
      kind: 'deleted',
      additions: 0,
      deletions: 1,
    },
  ])(
    'derives $label file path and kind from unified-diff headers when args have only patch input',
    async ({ diff, path, kind, additions, deletions }) => {
      const events = await runCompletedTool({
        toolName: 'apply_patch',
        arguments: { input: diff },
        output: diff,
      });

      expect(
        events.filter((event) => event.type === 'chat:file-change')
      ).toEqual([
        expect.objectContaining({
          path,
          kind,
          additions,
          deletions,
          diff,
        }),
      ]);
    }
  );

  it('keeps plain file-tool output as a tool result instead of promoting it to a diff', async () => {
    const events = await runCompletedTool({
      toolName: 'write_file',
      arguments: { path: '/workspace/example/src/plain.ts' },
      output: 'wrote 500 synthetic lines',
    });

    expect(events.some((event) => event.type === 'chat:file-change')).toBe(
      false
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'chat:tool-result',
          toolName: 'write_file',
          output: 'wrote 500 synthetic lines',
        }),
      ])
    );
  });

  it('keeps diff-shaped non-edit tool output as a tool result', async () => {
    const diff =
      '--- a/src/read-only.ts\n+++ b/src/read-only.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const events = await runCompletedTool({
      toolName: 'run_command',
      arguments: { command: 'git diff -- src/read-only.ts' },
      output: diff,
    });

    expect(events.some((event) => event.type === 'chat:file-change')).toBe(
      false
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'chat:tool-result',
          toolName: 'run_command',
          output: diff,
        }),
      ])
    );
  });

  it('replays the sanitized Hermes detail fixture into normalized cards', async () => {
    gateway = await startInlineGateway((send, res) => {
      for (const event of hermesDetailFixture.nativeEvents) send(event);
      send({
        type: 'response.completed',
        response: { id: 'resp_synthetic_hermes', status: 'completed' },
      });
      res.end();
    });

    const v2 = createAdapterV2('hermes');
    const patches: AgentPatchV2[] = [];
    v2.onPatch((patch) => patches.push(patch));
    try {
      await v2.connect(configFor(gateway.endpoint, 'sess-diff'));
      await v2.sendMessage({ turnId: 'turn-1', content: 'patch demo.ts' });
    } finally {
      await v2.disconnect();
    }

    let session = emptyAgentSessionV2({
      id: 'sess-diff',
      provider: 'hermes',
      cwd: '/workspace/example',
    });
    for (const patch of patches) session = applyAgentPatchV2(session, patch);
    const items = session.turns.flatMap((turn) => turn.items);
    expect(
      items.filter((item) => item.id === 'tool-call_synthetic_hermes_patch')
    ).toHaveLength(1);
    const diffItem = items.find(
      (item) => item.id === 'tool-call_synthetic_hermes_patch'
    );
    expect(diffItem).not.toHaveProperty('applyStatus');
    const fixtureDiffItem = hermesDetailFixture.session.turns
      .flatMap((turn) => turn.items)
      .find((item) => item.type === 'fileChange');
    expect(fixtureDiffItem).not.toHaveProperty('applyStatus');
    const cards = items.flatMap((item) =>
      item.card && item.card.kind !== 'message' ? [item.card] : []
    );
    const expectedCards = hermesDetailFixture.session.turns
      .flatMap((turn) => turn.items)
      .flatMap((item) =>
        item.card && item.card.kind !== 'message' ? [item.card] : []
      );
    expect(cards).toEqual(expectedCards);
    expect(hermesDetailFixture.sanitization.containsLiveTranscriptBytes).toBe(
      false
    );
  });

  it('echoes the submitted user message when the turn starts', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_user_echo' } });
      send({
        type: 'response.completed',
        response: { id: 'resp_user_echo', status: 'completed' },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-user-echo'));
    await adapter.sendMessage('turn-1', 'hi from enter');

    const turnStartedIndex = events.findIndex(
      (event) => event.type === 'chat:turn-started'
    );
    const userEchoIndex = events.findIndex(
      (event) => event.type === 'chat:message-complete' && event.role === 'user'
    );
    expect(turnStartedIndex).toBeGreaterThanOrEqual(0);
    expect(userEchoIndex).toBeGreaterThan(turnStartedIndex);
    expect(events[userEchoIndex]).toMatchObject({
      type: 'chat:message-complete',
      turnId: 'turn-1',
      messageId: 'user-turn-1',
      role: 'user',
      content: 'hi from enter',
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
      (event) =>
        event.type === 'chat:message-complete' && event.role === 'assistant'
    );
    expect(complete).toMatchObject({ role: 'assistant', content: 'Hello' });
  });

  it('keeps streamed reasoning when Hermes completes with an empty done text', async () => {
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
        // Sanitized real gateway shape: Hermes may send an empty authoritative
        // done field after non-empty deltas. The emitter must not blank the row.
        text: '',
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

// #1181 defect 1: hermes replies must always finalize to exactly one assistant
// `chat:message-complete`, whichever wire shape the reply arrives in.
describe('Hermes assistant reply finalization (#1181)', () => {
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

  function assistantCompletes(events: ChatEvent[]): ChatEvent[] {
    return events.filter(
      (event) =>
        event.type === 'chat:message-complete' && event.role === 'assistant'
    );
  }

  it('maps a v0.18.2 message output-item to exactly one assistant message-complete', async () => {
    // v0.18.2 delivers the reply as a `message` output-item via
    // output_item.done, with NO streamed output_text.done.
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_v0182' } });
      send({
        type: 'response.output_item.done',
        item: {
          id: 'msg_out_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ok', annotations: [] }],
        },
      });
      send({
        type: 'response.completed',
        response: { id: 'resp_v0182', status: 'completed' },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-v0182'));
    await adapter.sendMessage('turn-1', 'say ok');

    const completes = assistantCompletes(events);
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({
      role: 'assistant',
      content: 'ok',
      turnId: 'turn-1',
    });
  });

  it('emits exactly one assistant message-complete on the streamed output_text.done shape', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_stream' } });
      send({ type: 'response.output_text.delta', delta: 'o' });
      send({ type: 'response.output_text.delta', delta: 'k' });
      send({ type: 'response.output_text.done', text: 'ok' });
      send({
        type: 'response.completed',
        response: {
          id: 'resp_stream',
          status: 'completed',
          output: [
            {
              id: 'msg_stream_1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
        },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-stream'));
    await adapter.sendMessage('turn-1', 'say ok');

    const completes = assistantCompletes(events);
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ content: 'ok' });
  });

  it('does not double-emit when BOTH output_text.done and the message output-item arrive', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_both' } });
      send({ type: 'response.output_text.delta', delta: 'ok' });
      send({ type: 'response.output_text.done', text: 'ok' });
      send({
        type: 'response.output_item.done',
        item: {
          id: 'msg_both_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      });
      send({
        type: 'response.completed',
        response: {
          id: 'resp_both',
          status: 'completed',
          output: [
            {
              id: 'msg_both_1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
        },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-both'));
    await adapter.sendMessage('turn-1', 'say ok');

    expect(assistantCompletes(events)).toHaveLength(1);
  });

  it('recovers the reply from response.completed output[] when no item.done/text.done arrives', async () => {
    gateway = await startInlineGateway((send, res) => {
      send({ type: 'response.created', response: { id: 'resp_fallback' } });
      send({
        type: 'response.completed',
        response: {
          id: 'resp_fallback',
          status: 'completed',
          output: [
            {
              id: 'msg_fallback_1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ],
        },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-fallback'));
    await adapter.sendMessage('turn-1', 'say ok');

    const completes = assistantCompletes(events);
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ content: 'ok' });
  });
});

/**
 * #1409 (1): Hermes has no separate system-prompt slot — the Responses API's
 * `instructions` field IS the system region — so `config.systemPromptAppendix`
 * (the profile prompt + Relay's collaboration contract, assembled in
 * `server/channel-agent-runtime.ts`) must be folded into the instructions block
 * the adapter already sends per `/v1/responses` call. Before this it was
 * silently dropped and hermes profiles ran with no profile prompt at all.
 *
 * The second assertion in each case is the prefix-cache invariant: the system
 * region must be byte-identical across every turn of one runtime, which is why
 * the adapter composes it once at connect instead of per turn.
 */
describe('Hermes systemPromptAppendix delivery (#1409)', () => {
  const APPENDIX =
    'You are the ebi profile.\n\nRelay collaboration contract: report back in the channel.';

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

  async function startCompletingGateway(): Promise<InlineGateway> {
    let turn = 0;
    return startInlineGateway((send, res) => {
      const id = `resp_appendix_${++turn}`;
      send({ type: 'response.created', response: { id } });
      send({ type: 'response.output_text.done', text: 'ok' });
      send({
        type: 'response.completed',
        response: { id, status: 'completed' },
      });
      res.end();
    });
  }

  it('folds the appendix into instructions after the channel prompt, byte-identically on every turn', async () => {
    gateway = await startCompletingGateway();
    adapter = new HermesProtocolAdapter();

    await adapter.connect({
      ...configFor(gateway.endpoint, 'sess-appendix-1'),
      systemPromptAppendix: APPENDIX,
      extra: {
        endpoint: gateway.endpoint,
        apiToken: 'inline-key',
        instructions: 'Prefer terse answers.',
      },
    });
    await adapter.sendMessage('turn-1', 'hello');
    await adapter.sendMessage('turn-2', 'again');

    const relayContext = buildRelayHermesSessionInstructions({
      sessionId: 'sess-appendix-1',
      cwd: process.cwd(),
    });
    expect(gateway.requests).toHaveLength(2);
    // Relay session context, then channel promptDefaults, then the Relay
    // appendix LAST so channel-authored text cannot redefine the boundary.
    expect(gateway.requests[0]?.['instructions']).toBe(
      `${relayContext}\n\nPrefer terse answers.\n\n${APPENDIX}`
    );
    expect(gateway.requests[1]?.['instructions']).toBe(
      gateway.requests[0]?.['instructions']
    );
  });

  it('delivers the appendix when the channel has no promptDefaults of its own', async () => {
    gateway = await startCompletingGateway();
    adapter = new HermesProtocolAdapter();

    await adapter.connect({
      ...configFor(gateway.endpoint, 'sess-appendix-2'),
      systemPromptAppendix: APPENDIX,
    });
    await adapter.sendMessage('turn-1', 'hello');

    const relayContext = buildRelayHermesSessionInstructions({
      sessionId: 'sess-appendix-2',
      cwd: process.cwd(),
    });
    expect(gateway.requests[0]?.['instructions']).toBe(
      `${relayContext}\n\n${APPENDIX}`
    );
  });

  it('keeps the one-shot ticket kickoff after the appendix and drops it on later turns', async () => {
    gateway = await startCompletingGateway();
    adapter = new HermesProtocolAdapter();

    await adapter.connect({
      ...configFor(gateway.endpoint, 'sess-appendix-3'),
      systemPromptAppendix: APPENDIX,
      extra: {
        endpoint: gateway.endpoint,
        apiToken: 'inline-key',
        initialInstructions: 'You are working on ticket GH-42.',
      },
    });
    await adapter.sendMessage('turn-1', 'hello');
    await adapter.sendMessage('turn-2', 'again');

    const relayContext = buildRelayHermesSessionInstructions({
      sessionId: 'sess-appendix-3',
      cwd: process.cwd(),
    });
    expect(gateway.requests[0]?.['instructions']).toBe(
      `${relayContext}\n\n${APPENDIX}\n\nYou are working on ticket GH-42.`
    );
    // The persistent region stays byte-stable; only the one-shot kickoff drops.
    expect(gateway.requests[1]?.['instructions']).toBe(
      `${relayContext}\n\n${APPENDIX}`
    );
  });

  it('ignores a whitespace-only appendix instead of padding the system region', async () => {
    gateway = await startCompletingGateway();
    adapter = new HermesProtocolAdapter();

    await adapter.connect({
      ...configFor(gateway.endpoint, 'sess-appendix-4'),
      systemPromptAppendix: '   \n  ',
    });
    await adapter.sendMessage('turn-1', 'hello');

    expect(gateway.requests[0]?.['instructions']).toBe(
      buildRelayHermesSessionInstructions({
        sessionId: 'sess-appendix-4',
        cwd: process.cwd(),
      })
    );
  });
});

/**
 * #1409 (2): a user interrupt used to null `_lastResponseId`, so the turn after
 * ANY interrupt posted without `previous_response_id` and Hermes started a
 * fresh, context-free conversation. The next turn must re-anchor to the last
 * response the gateway actually finished — and must never resurrect the
 * in-flight id of the response that was aborted.
 */
describe('Hermes interrupt chain re-anchor (#1409)', () => {
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

  async function waitFor(
    predicate: () => boolean,
    what: string
  ): Promise<void> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('chains the turn after an interrupt from the last completed response, not the aborted one', async () => {
    let turn = 0;
    gateway = await startInlineGateway((send, res) => {
      turn += 1;
      if (turn === 2) {
        // The interrupted turn: the response is created and starts thinking,
        // then the stream stays open until the client aborts it. Its id is
        // never finished upstream, so it must not become the next anchor.
        send({
          type: 'response.created',
          response: { id: 'resp_interrupted_2' },
        });
        send({
          type: 'response.reasoning_summary_text.delta',
          delta: 'thinking...',
        });
        return;
      }
      const id = `resp_completed_${turn}`;
      send({ type: 'response.created', response: { id } });
      send({ type: 'response.output_text.done', text: 'ok' });
      send({
        type: 'response.completed',
        response: { id, status: 'completed' },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-interrupt-1'));
    await adapter.sendMessage('turn-1', 'remember 42');

    const interrupted = adapter.sendMessage('turn-2', 'and then?');
    // Wait until the adapter has really consumed `response.created` for the
    // in-flight response, so this test proves the re-anchor rather than an
    // anchor that was never advanced.
    await waitFor(
      () => events.some((event) => event.type === 'chat:reasoning'),
      'the interrupted turn to start streaming'
    );
    await adapter.interrupt('turn-2');
    await interrupted;

    const completed = events.filter(
      (event) => event.type === 'chat:turn-completed'
    );
    expect(completed.at(-1)).toMatchObject({
      turnId: 'turn-2',
      reason: 'interrupted',
    });

    await adapter.sendMessage('turn-3', 'continue');
    expect(gateway.requests).toHaveLength(3);
    expect(gateway.requests[2]?.['previous_response_id']).toBe(
      'resp_completed_1'
    );
  });

  it('re-anchors to the resumed response id when the first turn after resume is interrupted', async () => {
    let turn = 0;
    gateway = await startInlineGateway((send, res) => {
      turn += 1;
      if (turn === 1) {
        send({
          type: 'response.created',
          response: { id: 'resp_interrupted_1' },
        });
        send({
          type: 'response.reasoning_summary_text.delta',
          delta: 'thinking...',
        });
        return;
      }
      send({ type: 'response.created', response: { id: 'resp_after' } });
      send({
        type: 'response.completed',
        response: { id: 'resp_after', status: 'completed' },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));

    await adapter.connect(configFor(gateway.endpoint, 'sess-interrupt-2'));
    await adapter.resumeSession('resp_restored_from_disk');

    const interrupted = adapter.sendMessage('turn-1', 'continue');
    await waitFor(
      () => events.some((event) => event.type === 'chat:reasoning'),
      'the interrupted turn to start streaming'
    );
    await adapter.interrupt('turn-1');
    await interrupted;

    await adapter.sendMessage('turn-2', 'again');
    expect(gateway.requests[1]?.['previous_response_id']).toBe(
      'resp_restored_from_disk'
    );
  });

  it('re-anchors after a failed response instead of dropping the chain', async () => {
    let turn = 0;
    gateway = await startInlineGateway((send, res) => {
      turn += 1;
      if (turn === 2) {
        send({ type: 'response.created', response: { id: 'resp_failed_2' } });
        send({ type: 'response.error', message: 'gateway blew up' });
        res.end();
        return;
      }
      const id = `resp_completed_${turn}`;
      send({ type: 'response.created', response: { id } });
      send({
        type: 'response.completed',
        response: { id, status: 'completed' },
      });
      res.end();
    });
    adapter = new HermesProtocolAdapter();

    await adapter.connect(configFor(gateway.endpoint, 'sess-interrupt-3'));
    await adapter.sendMessage('turn-1', 'remember 42');
    await adapter.sendMessage('turn-2', 'boom');
    await adapter.sendMessage('turn-3', 'continue');

    expect(gateway.requests).toHaveLength(3);
    expect(gateway.requests[2]?.['previous_response_id']).toBe(
      'resp_completed_1'
    );
  });
});

/**
 * Hermes multiplex profile binding (#1453 slice 1, PR 1).
 *
 * The invariants this block exists to hold:
 *  - an UNBOUND runtime is byte-identical to pre-#1453 Relay on every call site
 *    (health, models, responses, abort, approvals);
 *  - a BOUND runtime prefixes all five with `/p/<profile>`;
 *  - two runtimes bound to different profiles never cross paths or bearer
 *    tokens, even with turns in flight at the same time;
 *  - the gateway's 404 (unknown/unallowlisted profile) and 401 (profile has no
 *    usable API_SERVER_KEY) reach the channel row as distinguishable, typed,
 *    non-retryable errors instead of a bare `HTTP 404`.
 */

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
}

interface RecordingGateway {
  server: http.Server;
  endpoint: string;
  recorded: RecordedRequest[];
}

/**
 * Inline gateway that records the exact path and Authorization header of every
 * request and answers ANY path shape (bare or `/p/<profile>`-prefixed), so the
 * assertions are about what the adapter sent, not about what the stub allows.
 */
function startRecordingGateway(
  options: {
    /** Status for `…/v1/responses`; non-2xx skips the SSE body. */
    responsesStatus?: number;
    /** Paths whose prefix the gateway refuses (simulates an unserved profile). */
    unservedPrefix?: string;
    unservedStatus?: number;
    /** Park responses calls until this many are in flight. */
    parkResponses?: number;
  } = {}
): Promise<RecordingGateway> {
  const recorded: RecordedRequest[] = [];
  const parked: Array<() => void> = [];
  const parkTarget = options.parkResponses ?? 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      recorded.push({
        method: req.method ?? 'GET',
        url,
        authorization: req.headers['authorization'] as string | undefined,
      });

      if (options.unservedPrefix && url.startsWith(options.unservedPrefix)) {
        res.writeHead(options.unservedStatus ?? 404, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'Unknown or unconfigured profile' }));
        return;
      }

      if (url.endsWith('/health')) {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      if (url.endsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'inline-stub' }] }));
        return;
      }
      if (url.endsWith('/v1/responses')) {
        const status = options.responsesStatus ?? 200;
        if (status !== 200) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown or unconfigured profile' }));
          return;
        }
        const respond = (): void => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          const responseId = `resp_${recorded.length}`;
          res.write(
            `data: ${JSON.stringify({ type: 'response.created', response: { id: responseId } })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, status: 'completed' } })}\n\n`
          );
          res.end();
        };
        if (parkTarget > 0) {
          parked.push(respond);
          if (parked.length >= parkTarget) {
            for (const release of parked.splice(0)) release();
          }
          return;
        }
        respond();
        return;
      }
      // abort / permission and anything else the adapter may call.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, endpoint: `http://127.0.0.1:${port}`, recorded });
    });
  });
}

function boundConfig(
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
    extra: { endpoint, ...extra },
  };
}

describe('Hermes multiplex profile binding (#1453)', () => {
  const gateways: RecordingGateway[] = [];
  const adapters: HermesProtocolAdapter[] = [];

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      await adapter.disconnect().catch(() => {});
    }
    for (const gateway of gateways.splice(0)) {
      await new Promise<void>((resolve) =>
        gateway.server.close(() => resolve())
      );
    }
  });

  async function gateway(
    options?: Parameters<typeof startRecordingGateway>[0]
  ): Promise<RecordingGateway> {
    const created = await startRecordingGateway(options);
    gateways.push(created);
    return created;
  }

  function adapterFor(): HermesProtocolAdapter {
    const adapter = new HermesProtocolAdapter();
    adapters.push(adapter);
    return adapter;
  }

  /** Drive every call site the adapter owns, in order. */
  async function exerciseAllCallSites(
    adapter: HermesProtocolAdapter
  ): Promise<void> {
    await adapter.sendMessage('turn-1', 'hi');
    await adapter.interrupt('turn-1');
    await adapter.respondToApproval('req-1', 'allow');
  }

  it('resolves an empty base path when no profile is bound', () => {
    makeTempHome();
    expect(resolveHermesGatewaySettings({ endpoint: 'http://h:1' })).toEqual({
      basePath: '',
      hermesProfile: null,
      endpoint: 'http://h:1',
      apiKey: null,
      source: 'adapter config',
    });
  });

  it('resolves /p/<profile> for a bound profile', () => {
    makeTempHome();
    expect(
      resolveHermesGatewaySettings({
        endpoint: 'http://h:1',
        hermesProfile: 'koi-product',
      })
    ).toMatchObject({
      basePath: '/p/koi-product',
      hermesProfile: 'koi-product',
    });
    // An empty binding is "unbound", never `/p/`.
    expect(
      resolveHermesGatewaySettings({
        endpoint: 'http://h:1',
        hermesProfile: '',
      })
    ).toMatchObject({ basePath: '' });
  });

  it.each([
    ['../other', 'traversal via separator'],
    ['a/b', 'nested path'],
    ['..', 'relative parent'],
    ['.', 'relative self'],
    ['has space', 'whitespace'],
    ['%2e%2e', 'percent-encoded traversal'],
    ['x'.repeat(65), 'over-length'],
  ])(
    'refuses to build a base path from %j (%s) instead of silently using the default profile',
    (value) => {
      makeTempHome();
      expect(() =>
        resolveHermesGatewaySettings({
          endpoint: 'http://h:1',
          hermesProfile: value,
        })
      ).toThrow(/not a valid profile id/);
    }
  );

  it('keeps every unbound call site on the bare gateway paths', async () => {
    makeTempHome();
    const gw = await gateway();
    const adapter = adapterFor();
    await adapter.connect(
      boundConfig(gw.endpoint, 'sess-unbound', { apiToken: 'inline-key' })
    );
    await exerciseAllCallSites(adapter);

    expect(gw.recorded.map((entry) => entry.url)).toEqual([
      '/health',
      '/v1/models',
      '/v1/responses',
      '/session/sess-unbound/abort',
      '/permission/req-1/allow',
    ]);
    expect(
      gw.recorded.every((entry) => entry.authorization === 'Bearer inline-key')
    ).toBe(true);
    expect(gw.recorded.some((entry) => entry.url.includes('/p/'))).toBe(false);
  });

  it('prefixes every bound call site with /p/<profile>', async () => {
    makeTempHome();
    const gw = await gateway();
    const adapter = adapterFor();
    await adapter.connect(
      boundConfig(gw.endpoint, 'sess-bound', {
        apiToken: 'inline-key',
        hermesProfile: 'koi-product',
      })
    );
    await exerciseAllCallSites(adapter);

    expect(gw.recorded.map((entry) => entry.url)).toEqual([
      '/p/koi-product/health',
      '/p/koi-product/v1/models',
      '/p/koi-product/v1/responses',
      '/p/koi-product/session/sess-bound/abort',
      '/p/koi-product/permission/req-1/allow',
    ]);
  });

  it('never crosses paths or bearer tokens between two concurrently bound profiles', async () => {
    makeTempHome();
    // Both turns are parked until BOTH have arrived, so the two runtimes are
    // genuinely in flight together when the assertion is made.
    const gw = await gateway({ parkResponses: 2 });
    const first = adapterFor();
    const second = adapterFor();
    await first.connect(
      boundConfig(gw.endpoint, 'sess-a', {
        apiToken: 'key-a',
        hermesProfile: 'koi-product',
      })
    );
    await second.connect(
      boundConfig(gw.endpoint, 'sess-b', {
        apiToken: 'key-b',
        hermesProfile: 'ika-frontend',
      })
    );

    await Promise.all([
      first.sendMessage('turn-a', 'from a'),
      second.sendMessage('turn-b', 'from b'),
    ]);
    await Promise.all([first.interrupt('turn-a'), second.interrupt('turn-b')]);

    const forProfile = (profile: string): RecordedRequest[] =>
      gw.recorded.filter((entry) => entry.url.startsWith(`/p/${profile}/`));
    expect(forProfile('koi-product').length).toBeGreaterThanOrEqual(4);
    expect(forProfile('ika-frontend').length).toBeGreaterThanOrEqual(4);
    // Every koi-product request carries koi-product's key and vice versa.
    expect(
      forProfile('koi-product').every(
        (entry) => entry.authorization === 'Bearer key-a'
      )
    ).toBe(true);
    expect(
      forProfile('ika-frontend').every(
        (entry) => entry.authorization === 'Bearer key-b'
      )
    ).toBe(true);
    // No request escaped its prefix, and no session id landed under the other
    // profile's path.
    expect(
      gw.recorded.every(
        (entry) =>
          entry.url.startsWith('/p/koi-product/') ||
          entry.url.startsWith('/p/ika-frontend/')
      )
    ).toBe(true);
    expect(
      forProfile('koi-product').some((entry) => entry.url.includes('sess-b'))
    ).toBe(false);
    expect(
      forProfile('ika-frontend').some((entry) => entry.url.includes('sess-a'))
    ).toBe(false);
  });

  it('surfaces an unknown bound profile (404) as a typed, non-retryable channel error', async () => {
    makeTempHome();
    // Health/models answer under the prefix so connect succeeds; only the turn
    // hits the gateway's unknown-profile response.
    const gw = await gateway({ responsesStatus: 404 });
    const adapter = adapterFor();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));
    await adapter.connect(
      boundConfig(gw.endpoint, 'sess-ghost', {
        apiToken: 'inline-key',
        hermesProfile: 'ghost-profile',
      })
    );
    await expect(adapter.sendMessage('turn-1', 'hi')).rejects.toThrow(
      /ghost-profile/
    );

    const error = events.find((event) => event.type === 'chat:error');
    expect(error).toMatchObject({
      type: 'chat:error',
      kind: 'protocol',
      retryable: false,
      turnId: 'turn-1',
    });
    expect((error as { message: string }).message).toMatch(
      /ghost-profile.*multiplex_profile_allowlist/s
    );
  });

  it('surfaces an unauthorized bound profile (401) as a typed auth error', async () => {
    makeTempHome();
    const gw = await gateway({ responsesStatus: 401 });
    const adapter = adapterFor();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));
    await adapter.connect(
      boundConfig(gw.endpoint, 'sess-401', {
        apiToken: 'inline-key',
        hermesProfile: 'ika-frontend',
      })
    );
    await expect(adapter.sendMessage('turn-1', 'hi')).rejects.toThrow(
      /ika-frontend/
    );

    const error = events.find((event) => event.type === 'chat:error');
    expect(error).toMatchObject({
      type: 'chat:error',
      kind: 'auth',
      retryable: false,
    });
    expect((error as { message: string }).message).toMatch(/API_SERVER_KEY/);
  });

  it('leaves an UNBOUND runtime error mapping untouched (still retryable protocol)', async () => {
    makeTempHome();
    const gw = await gateway({ responsesStatus: 404 });
    const adapter = adapterFor();
    const events: ChatEvent[] = [];
    adapter.on((event) => events.push(event));
    await adapter.connect(
      boundConfig(gw.endpoint, 'sess-plain', { apiToken: 'inline-key' })
    );
    await expect(adapter.sendMessage('turn-1', 'hi')).rejects.toThrow(
      /Hermes sendMessage failed: 404/
    );

    expect(events.find((event) => event.type === 'chat:error')).toMatchObject({
      kind: 'protocol',
      retryable: true,
      message: 'Hermes sendMessage failed: 404',
    });
  });

  it('fails connect with the profile-specific reason when the gateway does not serve the prefix', async () => {
    makeTempHome();
    const gw = await gateway({ unservedPrefix: '/p/ghost-profile' });
    const adapter = adapterFor();
    await expect(
      adapter.connect(
        boundConfig(gw.endpoint, 'sess-unserved', {
          apiToken: 'inline-key',
          hermesProfile: 'ghost-profile',
        })
      )
    ).rejects.toThrow(/ghost-profile.*multiplex_profiles/s);
  });

  // ── per-profile gateway key (#1453) ───────────────────────────────────────
  // Hermes multiplex gives each named profile its own `API_SERVER_KEY`, so the
  // binding and the credential have to travel together or `/p/<profile>/`
  // answers 401.

  it('sends the bound profile OWN key on every call site, not the default key', async () => {
    makeTempHome();
    process.env.HERMES_API_TOKEN = 'gateway-default-key';
    const gw = await gateway();
    const adapter = adapterFor();
    await adapter.connect(
      boundConfig(gw.endpoint, 'sess-keyed', {
        hermesProfile: 'koi-product',
        hermesApiKey: 'koi-only-key',
      })
    );
    await exerciseAllCallSites(adapter);

    expect(gw.recorded.map((entry) => entry.url)).toEqual([
      '/p/koi-product/health',
      '/p/koi-product/v1/models',
      '/p/koi-product/v1/responses',
      '/p/koi-product/session/sess-keyed/abort',
      '/p/koi-product/permission/req-1/allow',
    ]);
    // Every single request, not just the turn: an abort or an approval sent
    // with the default key is the same 401 the operator would have to debug.
    expect(new Set(gw.recorded.map((entry) => entry.authorization))).toEqual(
      new Set(['Bearer koi-only-key'])
    );
  });

  it('keeps the DEFAULT key for an unbound runtime even when a profile key is supplied', async () => {
    makeTempHome();
    const gw = await gateway();
    const adapter = adapterFor();
    await adapter.connect(
      boundConfig(gw.endpoint, 'sess-unbound-key', {
        apiToken: 'gateway-default-key',
        hermesApiKey: 'koi-only-key',
      })
    );
    await exerciseAllCallSites(adapter);

    expect(gw.recorded.some((entry) => entry.url.includes('/p/'))).toBe(false);
    // An unbound runtime talks to the gateway's DEFAULT profile. A named
    // profile's key cannot work there, so it must not displace the default.
    expect(new Set(gw.recorded.map((entry) => entry.authorization))).toEqual(
      new Set(['Bearer gateway-default-key'])
    );
  });

  it('falls back to the default key when a bound profile has no key of its own', async () => {
    makeTempHome();
    const gw = await gateway();
    const adapter = adapterFor();
    await adapter.connect(
      boundConfig(gw.endpoint, 'sess-keyless', {
        apiToken: 'gateway-default-key',
        hermesProfile: 'ika-frontend',
      })
    );
    await exerciseAllCallSites(adapter);

    expect(new Set(gw.recorded.map((entry) => entry.authorization))).toEqual(
      new Set(['Bearer gateway-default-key'])
    );
  });

  it('gives two bound runtimes their own bearer, with neither key crossing prefixes', async () => {
    makeTempHome();
    const gw = await gateway({ parkResponses: 2 });
    const koi = adapterFor();
    const ika = adapterFor();
    await koi.connect(
      boundConfig(gw.endpoint, 'sess-koi', {
        hermesProfile: 'koi-product',
        hermesApiKey: 'koi-only-key',
      })
    );
    await ika.connect(
      boundConfig(gw.endpoint, 'sess-ika', {
        hermesProfile: 'ika-frontend',
        hermesApiKey: 'ika-only-key',
      })
    );
    await Promise.all([
      koi.sendMessage('turn-koi', 'hi'),
      ika.sendMessage('turn-ika', 'hi'),
    ]);

    const koiRequests = gw.recorded.filter((entry) =>
      entry.url.startsWith('/p/koi-product/')
    );
    const ikaRequests = gw.recorded.filter((entry) =>
      entry.url.startsWith('/p/ika-frontend/')
    );
    expect(koiRequests.length).toBeGreaterThan(0);
    expect(ikaRequests.length).toBeGreaterThan(0);
    expect(koiRequests.length + ikaRequests.length).toBe(gw.recorded.length);
    expect(new Set(koiRequests.map((entry) => entry.authorization))).toEqual(
      new Set(['Bearer koi-only-key'])
    );
    expect(new Set(ikaRequests.map((entry) => entry.authorization))).toEqual(
      new Set(['Bearer ika-only-key'])
    );
  });

  it.each([
    ['has space', 'whitespace'],
    ['line\nbreak', 'header injection via LF'],
    ['line\r\nX-Injected: 1', 'header injection via CRLF'],
    ['', 'empty'],
  ])(
    'refuses a malformed profile key %j (%s) rather than silently using the default credential',
    (value, label) => {
      makeTempHome();
      process.env.HERMES_API_TOKEN = 'gateway-default-key';
      const resolve = (): unknown =>
        resolveHermesGatewaySettings({
          endpoint: 'http://h:1',
          hermesProfile: 'koi-product',
          hermesApiKey: value,
        });
      if (label === 'empty') {
        // An empty key is "no key", which is the documented fall-back.
        expect(resolve()).toMatchObject({ apiKey: 'gateway-default-key' });
        return;
      }
      expect(resolve).toThrow(/not usable/);
      // The rejection must never echo the secret it rejected.
      try {
        resolve();
      } catch (err) {
        expect((err as Error).message).not.toContain(value);
      }
    }
  );
});
