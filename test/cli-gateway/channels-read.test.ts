import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const RELAY_BIN = path.resolve('dist/bin/relay-ide.js');
const FETCH_PRELOAD = pathToFileURL(
  path.resolve('test/fixtures/cli-gateway/mock-fetch.mjs')
).href;

function runCli(args: string[]): Promise<{
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
          ...process.env,
          NODE_OPTIONS: `--import=${FETCH_PRELOAD}`,
          RELAY_TEST_FETCH_CAPTURE: capturePath,
          RELAY_IDE_PORT: '4567',
          RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test-actor.[REDACTED]',
          RELAY_IDE_BROWSER_TOKEN: '',
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

beforeAll(() => {
  execFileSync('npm', ['run', 'build:server'], {
    cwd: path.resolve('.'),
    env: process.env,
    stdio: 'inherit',
  });
}, 60_000);

describe('channel read CLI gateway runtime wiring', () => {
  it.each([
    [['list'], 'channels.list', '/channels'],
    [
      ['get', '--channel-id', 'product/main'],
      'channels.get',
      '/channels/product%2Fmain',
    ],
    [
      [
        'history',
        '--channel-id',
        'product/main',
        '--limit',
        '25',
        '--before-seq',
        '90',
        '--after-seq',
        '10',
      ],
      'channels.history',
      '/channels/product%2Fmain/messages?limit=25&beforeSeq=90&afterSeq=10',
    ],
    [
      [
        'threads',
        'history',
        '--channel-id',
        'product/main',
        '--thread-id',
        'chm/root',
        '--limit',
        '12',
      ],
      'channels.threads.history',
      '/channels/product%2Fmain/threads/chm%2Froot?limit=12',
    ],
    [
      ['roster', '--channel-id', 'product/main'],
      'channels.roster',
      '/channels/product%2Fmain/roster',
    ],
  ] as const)(
    'maps %j to %s and its declared REST route',
    async (channelArgs, command, route) => {
      const { envelope, request } = await runCli([
        'v1',
        'channels',
        ...channelArgs,
        '--json',
      ]);

      expect(envelope).toMatchObject({ ok: true, command });
      expect(request).toMatchObject({
        method: 'GET',
        url: `http://127.0.0.1:4567${route}`,
        headers: {
          Authorization: 'Bearer relay-sac-v1.test-actor.[REDACTED]',
          'x-relay-cli-gateway': 'v1',
          'x-relay-cli-actor-token': 'v1',
          'x-relay-cli-command': command,
          'x-relay-capabilities': 'context:read',
        },
      });
    }
  );
});
