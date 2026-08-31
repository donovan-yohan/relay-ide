import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { commandSpec } from '../../shared/cli-gateway-contract.js';

/**
 * #1473: `relay-ide v1 agent-profiles ...` dispatch, run through the real built
 * CLI so the assertions cover the shipped argv parsing rather than a
 * re-implementation of it.
 *
 * The load-bearing assertion is negative: the write-only Hermes gateway key
 * must never be readable from argv, and the CLI must refuse rather than accept
 * it — argv is visible in the process table and in shell history.
 */

const RELAY_BIN = path.resolve('dist/bin/relay-ide.js');
const FETCH_PRELOAD = pathToFileURL(
  path.resolve('test/fixtures/cli-gateway/mock-fetch.mjs')
).href;

const BASE_ENV = {
  RELAY_IDE_PORT: '4571',
  RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.test-actor.[REDACTED]',
  RELAY_IDE_BROWSER_TOKEN: '',
};

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<{
  envelope: Record<string, unknown>;
  request: Record<string, unknown>;
}> {
  const captureDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-profiles-'));
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
          ...env,
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

function runCliFailure(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<Record<string, unknown>> {
  const captureDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-profiles-'));
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
          ...env,
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

describe('agent-profiles CLI gateway verbs', () => {
  it('declares the four stable verbs with their CLI projections', () => {
    expect(commandSpec('agent-profiles.list').cli).toEqual([
      'relay-ide',
      'v1',
      'agent-profiles',
      'list',
      '--json',
    ]);
    expect(commandSpec('agent-profiles.get').cli).toContain('--id');
    expect(commandSpec('agent-profiles.create').cli).toContain('--provider');
    expect(commandSpec('agent-profiles.update').cli).toContain('--id');
  });

  it('lists profiles on the actor lane', async () => {
    const { envelope, request } = await runCli([
      'v1',
      'agent-profiles',
      'list',
      '--json',
    ]);

    expect(envelope).toMatchObject({
      ok: true,
      command: 'agent-profiles.list',
    });
    expect(request).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:4571/agent-profiles',
    });
    const headers = (request as { headers: Record<string, string> }).headers;
    expect(headers['x-relay-cli-command']).toBe('agent-profiles.list');
    expect(headers['x-relay-capabilities']).toBe('context:read');
  });

  it('gets one profile by id', async () => {
    const { envelope, request } = await runCli([
      'v1',
      'agent-profiles',
      'get',
      '--id',
      'agent-profile:hermes:0001',
      '--json',
    ]);

    expect(envelope).toMatchObject({ ok: true, command: 'agent-profiles.get' });
    expect(request).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:4571/agent-profiles/agent-profile%3Ahermes%3A0001',
    });
  });

  it('creates a hermes-bound profile with the key read from an env var', async () => {
    const { envelope, request } = await runCli(
      [
        'v1',
        'agent-profiles',
        'create',
        '--provider',
        'hermes',
        '--name',
        'Tako Planner',
        '--hermes-profile',
        'tako-planner',
        '--hermes-api-key-env',
        'RELAY_TEST_HERMES_KEY',
        '--json',
      ],
      { RELAY_TEST_HERMES_KEY: 'secret-from-env' }
    );

    expect(envelope).toMatchObject({
      ok: true,
      command: 'agent-profiles.create',
    });
    expect(request).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:4571/agent-profiles',
      body: {
        providerId: 'hermes',
        displayName: 'Tako Planner',
        hermesProfile: 'tako-planner',
        hermesApiKey: 'secret-from-env',
      },
    });
    const headers = (request as { headers: Record<string, string> }).headers;
    expect(headers['x-relay-capabilities']).toBe('context:write');
    expect(headers['x-relay-cli-command']).toBe('agent-profiles.create');
    // The response envelope is a read: it can never carry the key back.
    expect(JSON.stringify(envelope)).not.toContain('secret-from-env');
  });

  it('reads the key from a file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'relay-key-'));
    const keyPath = path.join(dir, 'key.txt');
    try {
      execFileSync('sh', ['-c', `printf 'secret-from-file\\n' > "${keyPath}"`]);
      const { request } = await runCli([
        'v1',
        'agent-profiles',
        'update',
        '--id',
        'agent-profile:hermes:0001',
        '--hermes-api-key-file',
        keyPath,
        '--json',
      ]);
      expect(request).toMatchObject({
        method: 'PATCH',
        url: 'http://127.0.0.1:4571/agent-profiles/agent-profile%3Ahermes%3A0001',
        body: { hermesApiKey: 'secret-from-file' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the hermes binding and the stored key', async () => {
    const { request } = await runCli([
      'v1',
      'agent-profiles',
      'update',
      '--id',
      'agent-profile:hermes:0001',
      '--clear-hermes-profile',
      '--clear-hermes-api-key',
      '--json',
    ]);

    expect(request).toMatchObject({
      method: 'PATCH',
      body: { hermesProfile: null, hermesApiKey: null },
    });
  });

  it('refuses a gateway key passed as a bare argv value', async () => {
    const envelope = await runCliFailure([
      'v1',
      'agent-profiles',
      'create',
      '--provider',
      'hermes',
      '--name',
      'Leaky',
      '--hermes-api-key',
      'plaintext-secret',
      '--json',
    ]);

    expect(envelope).toMatchObject({
      ok: false,
      command: 'agent-profiles.create',
      error: {
        code: 'INVALID_ARGUMENT',
        details: { field: 'hermesApiKey', reason: 'secret_in_argv' },
      },
    });
    const message = (envelope as { error: { message: string } }).error.message;
    expect(message).toContain('--hermes-api-key-env');
    expect(JSON.stringify(envelope)).not.toContain('plaintext-secret');
  });

  it('refuses a gateway key smuggled through --input-json', async () => {
    const envelope = await runCliFailure([
      'v1',
      'agent-profiles',
      'update',
      '--id',
      'agent-profile:hermes:0001',
      '--input-json',
      JSON.stringify({ hermesApiKey: 'plaintext-secret' }),
      '--json',
    ]);

    expect(envelope).toMatchObject({
      ok: false,
      error: { details: { reason: 'secret_in_input_body' } },
    });
    expect(JSON.stringify(envelope)).not.toContain('plaintext-secret');
  });

  it('fails loudly when the named key env var is unset', async () => {
    const envelope = await runCliFailure(
      [
        'v1',
        'agent-profiles',
        'create',
        '--provider',
        'hermes',
        '--name',
        'No Key',
        '--hermes-api-key-env',
        'RELAY_TEST_MISSING_KEY',
        '--json',
      ],
      { RELAY_TEST_MISSING_KEY: '' }
    );

    expect(envelope).toMatchObject({
      ok: false,
      error: { details: { envVar: 'RELAY_TEST_MISSING_KEY' } },
    });
  });

  it('refuses two key sources at once', async () => {
    const envelope = await runCliFailure([
      'v1',
      'agent-profiles',
      'update',
      '--id',
      'agent-profile:hermes:0001',
      '--hermes-api-key-env',
      'RELAY_TEST_HERMES_KEY',
      '--clear-hermes-api-key',
      '--json',
    ]);

    expect(envelope).toMatchObject({
      ok: false,
      error: { details: { field: 'hermesApiKey' } },
    });
  });

  it('requires --provider and --name on create, and --id on update', async () => {
    const noProvider = await runCliFailure([
      'v1',
      'agent-profiles',
      'create',
      '--name',
      'Nameless',
      '--json',
    ]);
    expect(noProvider).toMatchObject({
      error: { details: { field: 'providerId' } },
    });

    const noName = await runCliFailure([
      'v1',
      'agent-profiles',
      'create',
      '--provider',
      'hermes',
      '--json',
    ]);
    expect(noName).toMatchObject({
      error: { details: { field: 'displayName' } },
    });

    const noId = await runCliFailure([
      'v1',
      'agent-profiles',
      'update',
      '--name',
      'Renamed',
      '--json',
    ]);
    expect(noId).toMatchObject({ error: { details: { field: 'id' } } });
  });

  it('refuses an unknown flag and an empty patch instead of silently dropping it', async () => {
    const unknown = await runCliFailure([
      'v1',
      'agent-profiles',
      'list',
      '--provider',
      'hermes',
      '--json',
    ]);
    expect(unknown).toMatchObject({
      ok: false,
      command: 'agent-profiles.list',
    });

    const empty = await runCliFailure([
      'v1',
      'agent-profiles',
      'update',
      '--id',
      'agent-profile:hermes:0001',
      '--json',
    ]);
    expect(empty).toMatchObject({ error: { details: { field: 'patch' } } });
  });

  it('never echoes a stray positional back into the error envelope', async () => {
    // The realistic leak: a mistyped key flag that leaves the secret loose in
    // argv. The refusal must name the position, never the value.
    const envelope = await runCliFailure([
      'v1',
      'agent-profiles',
      'create',
      '--provider',
      'hermes',
      '--name',
      'Oops',
      'plaintext-secret',
      '--json',
    ]);

    expect(envelope).toMatchObject({
      ok: false,
      error: { details: { reason: 'unexpected_positional' } },
    });
    expect(JSON.stringify(envelope)).not.toContain('plaintext-secret');
  });

  it('refuses combining --input-json with the ergonomic body flags', async () => {
    const envelope = await runCliFailure([
      'v1',
      'agent-profiles',
      'create',
      '--provider',
      'hermes',
      '--input-json',
      JSON.stringify({ providerId: 'hermes', displayName: 'Both' }),
      '--json',
    ]);

    expect(envelope).toMatchObject({ ok: false });
    const message = (envelope as { error: { message: string } }).error.message;
    expect(message).toContain('--input-json/--input-file');
  });
});
