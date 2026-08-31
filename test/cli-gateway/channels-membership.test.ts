import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { commandSpec } from '../../shared/cli-gateway-contract.js';

/**
 * #1455 slice 2: `relay-ide v1 channels members|invite|remove-member`, driven
 * through the real built CLI so the assertions cover shipped argv parsing.
 *
 * The load-bearing negative assertion is that there is no way to name the
 * inviter or the remover from the command line: attribution is server-derived
 * from the credential, and a flag for it could only ever be a lie.
 */

const RELAY_BIN = path.resolve('dist/bin/relay-ide.js');
const FETCH_PRELOAD = pathToFileURL(
  path.resolve('test/fixtures/cli-gateway/mock-fetch.mjs')
).href;

const BASE_ENV = {
  RELAY_IDE_PORT: '4573',
  RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test-actor.[REDACTED]',
  RELAY_IDE_BROWSER_TOKEN: '',
};

function runCli(args: string[]): Promise<{
  envelope: Record<string, unknown>;
  request: Record<string, unknown>;
}> {
  const captureDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-members-'));
  const capturePath = path.join(captureDir, 'request.json');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RELAY_BIN, ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...BASE_ENV,
          NODE_OPTIONS: `--import=${FETCH_PRELOAD}`,
          RELAY_TEST_FETCH_CAPTURE: capturePath,
        },
        timeout: 15_000,
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

function runCliFailure(args: string[]): Promise<Record<string, unknown>> {
  const captureDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-members-bad-'));
  const capturePath = path.join(captureDir, 'request.json');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RELAY_BIN, ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...BASE_ENV,
          NODE_OPTIONS: `--import=${FETCH_PRELOAD}`,
          RELAY_TEST_FETCH_CAPTURE: capturePath,
        },
        timeout: 15_000,
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
}, 120_000);

describe('channel membership CLI gateway verbs (#1455 slice 2)', () => {
  it('declares the three stable verbs with their CLI projections', () => {
    expect(commandSpec('channels.members').cli).toEqual([
      'relay-ide',
      'v1',
      'channels',
      'members',
      '--channel-id',
      '<id>',
      '--json',
    ]);
    expect(commandSpec('channels.invite').cli).toContain('--member-id');
    expect(commandSpec('channels.remove-member').cli).toContain('--member-id');
    // Attribution is never an input: no CLI projection and no input property
    // names the inviter or the remover.
    for (const name of ['channels.invite', 'channels.remove-member'] as const) {
      const spec = commandSpec(name);
      expect(spec.cli).not.toContain('--invited-by');
      expect(spec.cli).not.toContain('--removed-by');
      const properties = (
        spec.inputSchema as { properties?: Record<string, unknown> }
      ).properties;
      expect(Object.keys(properties ?? {}).sort()).toEqual([
        'channelId',
        'id',
        'kind',
      ]);
    }
  });

  it('reads the membership list on the read lane', async () => {
    const { envelope, request } = await runCli([
      'v1',
      'channels',
      'members',
      '--channel-id',
      'topic:general',
      '--json',
    ]);
    expect(envelope).toMatchObject({ ok: true, command: 'channels.members' });
    expect(request).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:4573/channels/topic%3Ageneral/members',
      headers: {
        'x-relay-cli-command': 'channels.members',
        'x-relay-capabilities': 'context:read',
      },
    });
  });

  it.each([
    ['invite', 'channels.invite', '/channels/topic%3Ageneral/members'],
    [
      'remove-member',
      'channels.remove-member',
      '/channels/topic%3Ageneral/members/remove',
    ],
  ] as const)('posts %s on the write lane', async (sub, command, route) => {
    const { envelope, request } = await runCli([
      'v1',
      'channels',
      sub,
      '--channel-id',
      'topic:general',
      '--member-id',
      'agent-profile:codex:default',
      '--json',
    ]);
    expect(envelope).toMatchObject({ ok: true, command });
    expect(request).toMatchObject({
      method: 'POST',
      url: `http://127.0.0.1:4573${route}`,
      headers: {
        'x-relay-cli-command': command,
        'x-relay-capabilities': 'context:write',
      },
      // No inviter/remover in the body: the hub derives it.
      body: { id: 'agent-profile:codex:default' },
    });
  });

  it('passes an explicit --kind through and refuses anything else', async () => {
    const { request } = await runCli([
      'v1',
      'channels',
      'invite',
      '--channel-id',
      'topic:general',
      '--member-id',
      'human:sam',
      '--kind',
      'human',
      '--json',
    ]);
    expect(request).toMatchObject({
      body: { id: 'human:sam', kind: 'human' },
    });
    const refused = await runCliFailure([
      'v1',
      'channels',
      'invite',
      '--channel-id',
      'topic:general',
      '--member-id',
      'human:sam',
      '--kind',
      'robot',
      '--json',
    ]);
    expect(refused).toMatchObject({
      ok: false,
      command: 'channels.invite',
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it.each([
    [['members', '--json'], 'channels.members'],
    [['invite', '--channel-id', 'topic:general', '--json'], 'channels.invite'],
    [['invite', '--member-id', 'agent:codex', '--json'], 'channels.invite'],
    [
      [
        'invite',
        '--channel-id',
        'topic:general',
        '--member-id',
        'agent:codex',
        '--invited-by',
        'human:operator',
        '--json',
      ],
      'channels.invite',
    ],
    [
      ['remove-member', '--channel-id', 'topic:general', '--json'],
      'channels.remove-member',
    ],
    [
      [
        'remove-member',
        '--channel-id',
        'topic:general',
        '--member-id',
        'a',
        '--member-id',
        'b',
        '--json',
      ],
      'channels.remove-member',
    ],
  ] as const)(
    'refuses %j before any HTTP is sent',
    async (channelArgs, command) => {
      const envelope = await runCliFailure(['v1', 'channels', ...channelArgs]);
      expect(envelope).toMatchObject({
        ok: false,
        command,
        error: { code: 'INVALID_ARGUMENT' },
      });
    }
  );
});
