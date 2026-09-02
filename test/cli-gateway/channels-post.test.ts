import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { commandSpec } from '../../shared/cli-gateway-contract.js';

const RELAY_BIN = path.resolve('dist/bin/relay-ide.js');
const FETCH_PRELOAD = pathToFileURL(
  path.resolve('test/fixtures/cli-gateway/mock-fetch.mjs')
).href;

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{
  envelope: Record<string, unknown>;
  request: Record<string, unknown>;
}> {
  const captureDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-fetch-'));
  const capturePath = path.join(captureDir, 'request.json');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RELAY_BIN, ...args],
      {
        encoding: 'utf8',
        env: {
          ...env,
          NODE_OPTIONS: `--import=${FETCH_PRELOAD}`,
          RELAY_TEST_FETCH_CAPTURE: capturePath,
        },
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        try {
          if (error) {
            reject(
              new Error(
                `CLI failed (${String(error.code)}): ${stderr || stdout}`
              )
            );
            return;
          }
          resolve({
            envelope: JSON.parse(stdout) as Record<string, unknown>,
            request: JSON.parse(readFileSync(capturePath, 'utf8')) as Record<
              string,
              unknown
            >,
          });
        } finally {
          rmSync(captureDir, { recursive: true, force: true });
        }
      }
    );
  });
}

function runCliFailure(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<Record<string, unknown>> {
  const captureDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-fetch-'));
  const capturePath = path.join(captureDir, 'request.json');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RELAY_BIN, ...args],
      {
        encoding: 'utf8',
        env: {
          ...env,
          NODE_OPTIONS: `--import=${FETCH_PRELOAD}`,
          RELAY_TEST_FETCH_CAPTURE: capturePath,
        },
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        try {
          if (!error) {
            reject(new Error(`CLI unexpectedly succeeded: ${stdout}`));
            return;
          }
          if (existsSync(capturePath)) {
            reject(new Error(`CLI sent HTTP for invalid input: ${stdout}`));
            return;
          }
          resolve(JSON.parse(stdout) as Record<string, unknown>);
        } catch {
          reject(new Error(`CLI did not emit a gateway envelope: ${stderr}`));
        } finally {
          rmSync(captureDir, { recursive: true, force: true });
        }
      }
    );
  });
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build:server'], {
    cwd: path.resolve('.'),
    env: process.env,
    stdio: 'inherit',
  });
}, 60_000);

describe('channels.post CLI gateway command', () => {
  it('declares the typed channel message input and context write capability', () => {
    const spec = commandSpec('channels.post');

    expect(spec.cli).toEqual([
      'relay-ide',
      'v1',
      'channels',
      'post',
      '--channel-id',
      '<id>',
      '--text',
      '<text>',
      '[--format <text|markdown>]',
      '[--thread-id <id|null>]',
      '[--parent-message-id <id>]',
      '[--client-message-id <id>]',
      '--json',
      '| channels post --input-json <json> --json',
    ]);
    expect(spec.capabilityHints).toEqual(['context:write']);
    expect(spec.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['channelId', 'text'],
      properties: {
        channelId: { type: 'string' },
        text: { type: 'string' },
        format: { enum: ['markdown', 'text'] },
        parentMessageId: { type: 'string' },
        threadId: { type: ['string', 'null'] },
        clientMessageId: { type: 'string' },
      },
    });
    expect(spec.inputSchema.properties).not.toHaveProperty('parts');
    expect(spec.inputSchema.properties).not.toHaveProperty('sender');
    expect(spec.inputSchema.properties).not.toHaveProperty('source');
  });

  it('uses the actor token lane and forwards the route body exactly', async () => {
    const input = {
      channelId: 'product/main',
      text: 'Worker one is ready.',
      format: 'markdown',
      parentMessageId: 'chm:root',
      threadId: 'chm:root',
      clientMessageId: 'orchestrator-update-1',
    };

    const { envelope, request } = await runCli(
      [
        'v1',
        'channels',
        'post',
        '--input-json',
        JSON.stringify(input),
        '--json',
      ],
      {
        ...process.env,
        RELAY_IDE_PORT: '4567',
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test-actor.[REDACTED]',
        RELAY_IDE_BROWSER_TOKEN: '',
      }
    );

    expect(envelope).toMatchObject({
      ok: true,
      command: 'channels.post',
      data: {
        message: { id: 'chm:test' },
        run: {
          id: 'chrun:test',
          requestMessageId: 'chm:test',
          state: 'submitted',
        },
      },
    });
    expect(request).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:4567/channels/product%2Fmain/messages',
      body: {
        text: input.text,
        format: input.format,
        parentMessageId: input.parentMessageId,
        threadId: input.threadId,
        clientMessageId: input.clientMessageId,
      },
      headers: {
        Authorization: 'Bearer relay-sac-v1.test-actor.[REDACTED]',
        'Content-Type': 'application/json',
        'x-relay-cli-gateway': 'v1',
        'x-relay-cli-actor-token': 'v1',
        'x-relay-cli-command': 'channels.post',
        'x-relay-capabilities': 'context:write',
      },
    });
    expect(request.body).not.toHaveProperty('channelId');
  });

  it('posts with the ergonomic flag form and forwards the route body exactly', async () => {
    const { envelope, request } = await runCli(
      [
        'v1',
        'channels',
        'post',
        '--channel-id',
        'product/main',
        '--text',
        'Worker one is ready.',
        '--format',
        'markdown',
        '--parent-message-id',
        'chm:root',
        '--thread-id',
        'chm:root',
        '--client-message-id',
        'orchestrator-update-1',
        '--json',
      ],
      {
        ...process.env,
        RELAY_IDE_PORT: '4567',
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test-actor.[REDACTED]',
        RELAY_IDE_BROWSER_TOKEN: '',
      }
    );

    expect(envelope).toMatchObject({
      ok: true,
      command: 'channels.post',
      data: {
        message: { id: 'chm:test' },
        run: {
          id: 'chrun:test',
          requestMessageId: 'chm:test',
          state: 'submitted',
        },
      },
    });
    expect(request).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:4567/channels/product%2Fmain/messages',
      body: {
        text: 'Worker one is ready.',
        format: 'markdown',
        parentMessageId: 'chm:root',
        threadId: 'chm:root',
        clientMessageId: 'orchestrator-update-1',
      },
      headers: {
        Authorization: 'Bearer relay-sac-v1.test-actor.[REDACTED]',
        'Content-Type': 'application/json',
        'x-relay-cli-gateway': 'v1',
        'x-relay-cli-actor-token': 'v1',
        'x-relay-cli-command': 'channels.post',
        'x-relay-capabilities': 'context:write',
      },
    });
    expect(request.body).not.toHaveProperty('channelId');
  });

  it('keeps --input-json unchanged and rejects mixing it with the flag form', async () => {
    const { envelope, request } = await runCli(
      [
        'v1',
        'channels',
        'post',
        '--input-json',
        JSON.stringify({ channelId: 'product/main', text: 'hello' }),
        '--json',
      ],
      {
        ...process.env,
        RELAY_IDE_PORT: '4567',
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test-actor.[REDACTED]',
        RELAY_IDE_BROWSER_TOKEN: '',
      }
    );

    expect(envelope).toMatchObject({ ok: true, command: 'channels.post' });
    expect(request).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:4567/channels/product%2Fmain/messages',
      body: { text: 'hello' },
    });

    const mixed = await runCliFailure(
      [
        'v1',
        'channels',
        'post',
        '--input-json',
        JSON.stringify({ channelId: 'topic:one', text: 'ok' }),
        '--channel-id',
        'topic:one',
        '--json',
      ],
      {
        ...process.env,
        RELAY_IDE_PORT: '4567',
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test-actor.[REDACTED]',
        RELAY_IDE_BROWSER_TOKEN: '',
      }
    );

    expect(mixed).toMatchObject({
      ok: false,
      command: 'channels.post',
      error: {
        code: 'INVALID_ARGUMENT',
        details: { field: 'inputJson' },
      },
    });
  });

  it('gets one opaque run through the context-read actor lane', async () => {
    const { envelope, request } = await runCli(
      [
        'v1',
        'channels',
        'run',
        'get',
        '--channel-id',
        'product/main',
        '--run-id',
        'chrun:test',
        '--thread-id',
        'chm:root',
        '--json',
      ],
      {
        ...process.env,
        RELAY_IDE_PORT: '4567',
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test-actor.[REDACTED]',
        RELAY_IDE_BROWSER_TOKEN: '',
      }
    );

    expect(envelope).toMatchObject({
      ok: true,
      command: 'channels.run.get',
      data: { run: { id: 'chrun:test' } },
    });
    expect(request).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:4567/channels/product%2Fmain/runs/chrun%3Atest?threadId=chm%3Aroot',
      headers: expect.objectContaining({
        'x-relay-cli-command': 'channels.run.get',
        'x-relay-capabilities': 'context:read',
      }),
    });
  });

  it.each([
    [['post', '--json']],
    [['post', '--input-json', '{}', '--input-json', '{}', '--json']],
    [
      [
        'post',
        '--input-json',
        JSON.stringify({
          channelId: 'topic:one',
          text: 'ok',
          clientMessageId: 7,
        }),
        '--json',
      ],
    ],
    [
      [
        'post',
        '--input-json',
        JSON.stringify({
          channelId: 'topic:one',
          text: 'ok',
          unexpected: true,
        }),
        '--json',
      ],
    ],
    [
      [
        'post',
        '--input-json',
        JSON.stringify({
          channelId: 'topic:one',
          text: 'ok',
          parts: [
            {
              type: 'image',
              id: 'cha:diagram',
              mime: 'image/png',
              w: 640,
              h: 480,
              bytes: 1024,
            },
          ],
        }),
        '--json',
      ],
    ],
    // Flag form: --text is required alongside --channel-id.
    [['post', '--channel-id', 'topic:one', '--json']],
    // Flag form: unknown flags stay fail-closed.
    [
      [
        'post',
        '--channel-id',
        'topic:one',
        '--text',
        'ok',
        '--bogus',
        'x',
        '--json',
      ],
    ],
  ] as const)(
    'rejects malformed post argv or input before HTTP %j',
    async (channelArgs) => {
      const envelope = await runCliFailure(['v1', 'channels', ...channelArgs], {
        ...process.env,
        RELAY_IDE_PORT: '4567',
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test-actor.[REDACTED]',
        RELAY_IDE_BROWSER_TOKEN: '',
      });
      expect(envelope).toMatchObject({
        ok: false,
        command: 'channels.post',
        error: { code: 'INVALID_ARGUMENT' },
      });
    }
  );

  it('allows the actor token lane to create terminal sessions', async () => {
    const input = {
      cwd: '/repo',
      type: 'terminal',
      mode: 'pty',
    };

    const { envelope, request } = await runCli(
      [
        'v1',
        'sessions',
        'create',
        '--input-json',
        JSON.stringify(input),
        '--json',
      ],
      {
        ...process.env,
        RELAY_IDE_PORT: '4567',
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test-actor.[REDACTED]',
        RELAY_IDE_BROWSER_TOKEN: '',
      }
    );

    expect(envelope).toMatchObject({
      ok: true,
      command: 'sessions.create',
      data: { id: 'worker-session' },
    });
    expect(request).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:4567/sessions',
      body: input,
      headers: {
        Authorization: 'Bearer relay-sac-v1.test-actor.[REDACTED]',
        'Content-Type': 'application/json',
        'x-relay-cli-gateway': 'v1',
        'x-relay-cli-actor-token': 'v1',
        'x-relay-cli-command': 'sessions.create',
        'x-relay-capabilities': 'session:create:terminal',
      },
    });
  });
});
