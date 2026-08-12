import { execFile, execFileSync, spawn } from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { commandSpec } from '../../shared/cli-gateway-contract.js';

const RELAY_BIN = path.resolve('dist/bin/relay-ide.js');

beforeAll(() => {
  execFileSync('npm', ['run', 'build:server'], {
    cwd: path.resolve('.'),
    env: process.env,
    stdio: 'inherit',
  });
}, 60_000);

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RELAY_BIN, ...args],
      { encoding: 'utf8', env, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || stdout));
        else resolve(stdout);
      }
    );
  });
}

function runCliAndCloseStdout(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RELAY_BIN, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let closedStdout = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI did not exit after downstream stdout closed'));
    }, 10_000);
    child.stdout.on('data', () => {
      if (closedStdout) return;
      closedStdout = true;
      child.stdout.destroy();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

describe('channels.subscribe CLI gateway command', () => {
  it('declares the resumable actor-readable streaming command', () => {
    expect(commandSpec('channels.subscribe')).toMatchObject({
      stable: true,
      transport: 'hub-http',
      capabilityHints: ['context:read'],
      cli: [
        'relay-ide',
        'v1',
        'channels',
        'subscribe',
        '--channel-id',
        '<id>',
        '--after-seq',
        '<n>',
        '--json',
      ],
    });
  });

  it('forwards frames incrementally with actor auth and an exclusive cursor', async () => {
    let request: http.IncomingMessage | undefined;
    const server = http.createServer((req, res) => {
      request = req;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({ schemaVersion: 1, frame: 'open', channelId: 'topic:test', sequence: 0, durableSeq: 4 })}\n`
      );
      res.write(
        `${JSON.stringify({ schemaVersion: 1, frame: 'event', channelId: 'topic:test', sequence: 1, occurredAt: '2026-08-11T00:00:01.000Z', durableSeq: 4, payload: { type: 'channel-run-lifecycle-v1', run: { id: 'chrun:test' } } })}\n`
      );
      res.end(
        `${JSON.stringify({ schemaVersion: 1, frame: 'closed', channelId: 'topic:test', sequence: 2, occurredAt: '2026-08-11T00:00:02.000Z', durableSeq: 4, reason: 'normal', retryable: false })}\n`
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing port');
    try {
      const stdout = await runCli(
        [
          'v1',
          'channels',
          'subscribe',
          '--channel-id',
          'topic:test',
          '--after-seq',
          '4',
          '--json',
        ],
        {
          ...process.env,
          RELAY_IDE_PORT: String(address.port),
          RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test.[REDACTED]',
          RELAY_IDE_BROWSER_TOKEN: '',
        }
      );
      const lines = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(lines).toMatchObject([
        {
          ok: true,
          command: 'channels.subscribe',
          data: { frame: 'open', durableSeq: 4 },
        },
        {
          ok: true,
          command: 'channels.subscribe',
          data: {
            frame: 'event',
            durableSeq: 4,
            payload: {
              type: 'channel-run-lifecycle-v1',
              run: { id: 'chrun:test' },
            },
          },
        },
        {
          ok: true,
          command: 'channels.subscribe',
          data: { frame: 'closed', durableSeq: 4 },
        },
      ]);
      expect(request?.url).toBe('/channels/topic%3Atest/subscribe?afterSeq=4');
      expect(request?.headers).toMatchObject({
        'x-relay-cli-gateway': 'v1',
        'x-relay-cli-command': 'channels.subscribe',
        'x-relay-cli-actor-token': 'v1',
        'x-relay-capabilities': 'context:read',
      });
    } finally {
      server.close();
    }
  });

  it('stops parsing a shared chunk and cancels the reader at --max-events', async () => {
    let closeRequest!: () => void;
    const requestClosed = new Promise<void>((resolve) => {
      closeRequest = resolve;
    });
    const server = http.createServer((req, res) => {
      req.once('close', closeRequest);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({ schemaVersion: 1, frame: 'open', channelId: 'topic:test', sequence: 0, occurredAt: '2026-08-11T00:00:00.000Z', durableSeq: 0 })}\n`
      );
      res.write(
        [1, 2, 3]
          .map((sequence) =>
            JSON.stringify({
              schemaVersion: 1,
              frame: 'event',
              channelId: 'topic:test',
              sequence,
              occurredAt: `2026-08-11T00:00:0${sequence}.000Z`,
              durableSeq: sequence,
              payload: { type: 'channel-message-created-v1' },
            })
          )
          .join('\n') + '\n'
      );
      // Deliberately keep the response open: the client must actively cancel
      // rather than merely stop consuming its local buffer.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing port');
    try {
      const stdout = await runCli(
        [
          'v1',
          'channels',
          'subscribe',
          '--channel-id',
          'topic:test',
          '--max-events',
          '1',
          '--json',
        ],
        {
          ...process.env,
          RELAY_IDE_PORT: String(address.port),
          RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test.[REDACTED]',
          RELAY_IDE_BROWSER_TOKEN: '',
        }
      );
      await expect(requestClosed).resolves.toBeUndefined();
      const frames = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).data);
      expect(frames.map((frame) => frame.frame)).toEqual(['open', 'event']);
      expect(frames[1]?.sequence).toBe(1);
    } finally {
      server.close();
    }
  });

  it('treats a downstream EPIPE as clean cancellation instead of dropping into an error', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({ schemaVersion: 1, frame: 'open', channelId: 'topic:test', sequence: 0, occurredAt: '2026-08-11T00:00:00.000Z', durableSeq: 0 })}\n`
      );
      setTimeout(() => {
        res.write(
          `${JSON.stringify({ schemaVersion: 1, frame: 'event', channelId: 'topic:test', sequence: 1, occurredAt: '2026-08-11T00:00:01.000Z', durableSeq: 1, payload: { type: 'channel-message-created-v1' } })}\n`
        );
      }, 25).unref();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing port');
    try {
      const result = await runCliAndCloseStdout(
        ['v1', 'channels', 'subscribe', '--channel-id', 'topic:test', '--json'],
        {
          ...process.env,
          RELAY_IDE_PORT: String(address.port),
          RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test.[REDACTED]',
          RELAY_IDE_BROWSER_TOKEN: '',
        }
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('EPIPE');
    } finally {
      server.close();
    }
  });
});
