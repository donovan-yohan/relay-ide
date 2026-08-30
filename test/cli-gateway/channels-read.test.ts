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

function runCliFailure(args: string[]): Promise<{
  envelope: Record<string, unknown>;
  requested: boolean;
}> {
  const captureDir = mkdtempSync(
    path.join(tmpdir(), 'relay-cli-fetch-failure-')
  );
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
          if (!error) {
            reject(new Error(`CLI unexpectedly succeeded: ${stdout}`));
            return;
          }
          resolve({
            envelope: JSON.parse(stdout) as Record<string, unknown>,
            requested: (() => {
              try {
                readFileSync(capturePath, 'utf8');
                return true;
              } catch {
                return false;
              }
            })(),
          });
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
        '--after-seq',
        '10',
      ],
      'channels.history',
      '/channels/product%2Fmain/messages?limit=25&afterSeq=10',
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
        '--after-seq',
        '10',
      ],
      'channels.threads.history',
      '/channels/product%2Fmain/threads/chm%2Froot?limit=12&afterSeq=10',
    ],
    [
      ['roster', '--channel-id', 'product/main'],
      'channels.roster',
      '/channels/product%2Fmain/roster',
    ],
    // #1472: channel ids carry a colon (`topic:general`); the adapter lane
    // percent-encodes it, so the CLI front-end must too.
    [
      ['get', '--channel-id', 'topic:general'],
      'channels.get',
      '/channels/topic%3Ageneral',
    ],
    [
      ['history', '--channel-id', 'topic:general', '--limit', '3'],
      'channels.history',
      '/channels/topic%3Ageneral/messages?limit=3',
    ],
    [
      ['history', '--channel-id', 'topic:general', '--before-seq', '42'],
      'channels.history',
      '/channels/topic%3Ageneral/messages?beforeSeq=42',
    ],
    [
      ['search', '--query', 'needle'],
      'channels.search',
      '/channels/search?q=needle',
    ],
    [
      [
        'search',
        '--query',
        'needle in haystack',
        '--channel-id',
        'product/main',
        '--include-archived',
        'true',
        '--limit',
        '10',
      ],
      'channels.search',
      '/channels/search?q=needle+in+haystack&channelId=product%2Fmain&includeArchived=true&limit=10',
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

  it.each([
    [['list', '--undeclared', '--json'], 'channels.list'],
    [['get', '--json'], 'channels.get'],
    [
      ['history', '--channel-id', 'one', '--channel-id', 'two', '--json'],
      'channels.history',
    ],
    [
      [
        'history',
        '--channel-id',
        'one',
        '--before-seq',
        '1',
        '--after-seq',
        '0',
        '--json',
      ],
      'channels.history',
    ],
    [
      ['history', '--channel-id', 'one', '--after-seq', '   ', '--json'],
      'channels.history',
    ],
    [
      [
        'threads',
        'history',
        '--channel-id',
        'one',
        '--thread-id',
        'root',
        '--limit',
        '1.5',
        '--json',
      ],
      'channels.threads.history',
    ],
    [
      ['roster', '--channel-id', 'one', '--channel-id', 'two', '--json'],
      'channels.roster',
    ],
    [['search', '--json'], 'channels.search'],
    [['search', '--query', '   ', '--json'], 'channels.search'],
    [
      ['search', '--query', 'needle', '--limit', '0', '--json'],
      'channels.search',
    ],
    [
      ['search', '--query', 'needle', '--limit', '51', '--json'],
      'channels.search',
    ],
    [
      ['search', '--query', 'needle', '--include-archived', 'yes', '--json'],
      'channels.search',
    ],
    [
      ['search', '--query', 'needle', '--after-seq', '3', '--json'],
      'channels.search',
    ],
    [['create', '--json'], 'workspace-topics.create'],
    [['create', '--workspace-id', 'ws:1', '--json'], 'workspace-topics.create'],
    [
      ['create', '--title', 'Demo', '--undeclared', 'x', '--json'],
      'workspace-topics.create',
    ],
    [
      [
        'create',
        '--title',
        'Demo',
        '--input-json',
        '{"workspaceId":"ws:1","title":"Demo"}',
        '--json',
      ],
      'workspace-topics.create',
    ],
  ] as const)(
    'rejects malformed stable command argv %j',
    async (channelArgs, command) => {
      const { envelope, requested } = await runCliFailure([
        'v1',
        'channels',
        ...channelArgs,
      ]);
      expect(envelope).toMatchObject({
        ok: false,
        command,
        error: { code: 'INVALID_ARGUMENT' },
      });
      expect(requested).toBe(false);
    }
  );
});

// #1472: `channels create` is the ergonomic alias for the existing
// `workspace-topics.create` gateway verb. No new verb is minted, so the
// envelope's command stays `workspace-topics.create`.
describe('channels create CLI alias for workspace-topics.create', () => {
  it('posts a workspace topic from ergonomic flags', async () => {
    const { envelope, request } = await runCli([
      'v1',
      'channels',
      'create',
      '--title',
      'Nightly triage',
      '--json',
    ]);

    expect(envelope).toMatchObject({
      ok: true,
      command: 'workspace-topics.create',
    });
    expect(request).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:4567/workspace-topics',
      headers: {
        'x-relay-cli-command': 'workspace-topics.create',
        'x-relay-capabilities': 'context:write',
      },
      body: { workspaceId: 'workspace:local', title: 'Nightly triage' },
    });
  });

  it('carries workspace, description, and an explicit channel id', async () => {
    const { request } = await runCli([
      'v1',
      'channels',
      'create',
      '--title',
      'Nightly triage',
      '--workspace-id',
      'ws:local-1',
      '--description',
      'Triage lane',
      '--channel-id',
      'topic:nightly-triage',
      '--json',
    ]);

    expect(request).toMatchObject({
      method: 'POST',
      body: {
        workspaceId: 'ws:local-1',
        title: 'Nightly triage',
        description: 'Triage lane',
        id: 'topic:nightly-triage',
      },
    });
  });

  it('passes --input-json straight through to workspace-topics create', async () => {
    const { envelope, request } = await runCli([
      'v1',
      'channels',
      'create',
      '--input-json',
      JSON.stringify({ workspaceId: 'ws:local-1', title: 'Raw JSON lane' }),
      '--json',
    ]);

    expect(envelope).toMatchObject({
      ok: true,
      command: 'workspace-topics.create',
    });
    expect(request).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:4567/workspace-topics',
      body: { workspaceId: 'ws:local-1', title: 'Raw JSON lane' },
    });
  });
});
