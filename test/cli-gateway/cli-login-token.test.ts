import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const RELAY_BIN = path.resolve('dist/bin/relay-ide.js');

interface Capture {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

/**
 * Scripted hub: each fetch is answered in FIFO order and every request is
 * captured, so tests can assert precedence (env > file) and the auto-renew
 * call pattern without a live hub.
 */
function makeScriptedFetch(
  script: Array<{
    status: number;
    body: unknown;
  }>,
  callsPath?: string
): string {
  const preload = `
const script = ${JSON.stringify(script)};
const calls = [];
const fs = await import('node:fs');
globalThis.fetch = async (url, init = {}) => {
  const headers = {};
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    headers[String(key).toLowerCase()] = String(value);
  }
  const step = script[calls.length] ?? script[script.length - 1];
  if (!step && script.length === 0) {
    throw new Error('unexpected fetch during test: ' + String(url));
  }
  calls.push({ url: String(url), method: init.method, headers });${callsPath ? `\n  fs.writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));` : ''}
  return new Response(JSON.stringify(step.body), {
    status: step.status,
    headers: { 'content-type': 'application/json' },
  });
};
`;
  const captureDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-scripted-'));
  const preloadPath = path.join(captureDir, 'scripted-fetch.mjs');
  writeFileSync(preloadPath, preload);
  return pathToFileURL(preloadPath).href;
}

function runCli(
  args: string[],
  env: Record<string, string>
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [RELAY_BIN, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error
            ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1)
            : 0,
          stdout,
          stderr,
        });
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

describe('CLI stored actor token (#1435)', () => {
  it('precedence: explicit --actor-token beats a stored file credential', async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-precedence-'));
    writeFileSync(
      path.join(configDir, 'actor-token.json'),
      JSON.stringify({
        version: 1,
        token: 'relay-sac-v1.file-cred.filesecret',
        credentialId: 'file-cred',
        hubUrl: 'http://127.0.0.1:4567',
        issuedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2027-08-01T00:00:00.000Z',
        actorId: 'relay-cli@box',
        capabilities: ['session:read'],
      })
    );
    chmodSync(path.join(configDir, 'actor-token.json'), 0o600);

    // HOME points at the dir that holds .config/relay-ide/actor-token.json.
    const homeDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-home-'));
    const relayConfigDir = path.join(homeDir, '.config', 'relay-ide');
    const { mkdirSync, copyFileSync } = await import('node:fs');
    mkdirSync(relayConfigDir, { recursive: true });
    copyFileSync(
      path.join(configDir, 'actor-token.json'),
      path.join(relayConfigDir, 'actor-token.json')
    );
    chmodSync(path.join(relayConfigDir, 'actor-token.json'), 0o600);
    rmSync(configDir, { recursive: true, force: true });

    const callsPath = path.join(relayConfigDir, '..', '..', 'calls.json');
    const preload = makeScriptedFetch(
      [{ status: 201, body: { ok: true } }],
      callsPath
    );
    const result = await runCli(
      [
        'v1',
        'nodes',
        'list',
        '--json',
        '--actor-token',
        'relay-sac-v1.flag-cred.flagsecret',
      ],
      {
        HOME: homeDir,
        NODE_OPTIONS: `--import=${preload}`,
        RELAY_IDE_PORT: '4567',
        RELAY_IDE_ACTOR_TOKEN: '',
        RELAY_IDE_BROWSER_TOKEN: '',
      }
    );

    const calls: Capture[] = JSON.parse(readFileSync(callsPath, 'utf8'));
    const gatewayCall = calls.find((call) => call.url.endsWith('/nodes'));
    expect(gatewayCall).toBeTruthy();
    expect(gatewayCall!.headers?.['authorization']).toBe(
      'Bearer relay-sac-v1.flag-cred.flagsecret'
    );
    void result;
    rmSync(homeDir, { recursive: true, force: true });
  }, 30_000);

  it('file fallback: with no flag/env, the stored credential authenticates the call', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-home-'));
    const relayConfigDir = path.join(homeDir, '.config', 'relay-ide');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(relayConfigDir, { recursive: true });
    writeFileSync(
      path.join(relayConfigDir, 'actor-token.json'),
      JSON.stringify({
        version: 1,
        token: 'relay-sac-v1.file-cred.filesecret',
        credentialId: 'file-cred',
        hubUrl: 'http://127.0.0.1:4567',
        issuedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2027-08-01T00:00:00.000Z',
        actorId: 'relay-cli@box',
        capabilities: ['session:read'],
      })
    );
    chmodSync(path.join(relayConfigDir, 'actor-token.json'), 0o600);

    const callsPath = path.join(homeDir, 'calls.json');
    const preload = makeScriptedFetch(
      [{ status: 200, body: { nodes: [] } }],
      callsPath
    );
    await runCli(['v1', 'nodes', 'list', '--json'], {
      HOME: homeDir,
      NODE_OPTIONS: `--import=${preload}`,
      RELAY_IDE_PORT: '4567',
      RELAY_IDE_ACTOR_TOKEN: '',
      RELAY_IDE_BROWSER_TOKEN: '',
    });

    const calls: Capture[] = JSON.parse(readFileSync(callsPath, 'utf8'));
    const gatewayCall = calls.find((call) => call.url.endsWith('/nodes'));
    expect(gatewayCall).toBeTruthy();
    expect(gatewayCall!.headers?.['authorization']).toBe(
      'Bearer relay-sac-v1.file-cred.filesecret'
    );
    expect(gatewayCall!.headers?.['x-relay-cli-actor-token']).toBe('v1');
    rmSync(homeDir, { recursive: true, force: true });
  }, 30_000);

  it('expired login file + valid local token => command succeeds via local token (#1484)', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-home-'));
    const relayConfigDir = path.join(homeDir, '.config', 'relay-ide');
    const { mkdirSync, existsSync } = await import('node:fs');
    mkdirSync(relayConfigDir, { recursive: true });

    // Expired login credential file
    const loginFilePath = path.join(relayConfigDir, 'actor-token.json');
    writeFileSync(
      loginFilePath,
      JSON.stringify({
        version: 1,
        token: 'relay-sac-v1.old-cred.oldsecret',
        credentialId: 'old-cred',
        hubUrl: 'http://127.0.0.1:4567',
        issuedAt: '2025-08-01T00:00:00.000Z',
        expiresAt: '2025-09-01T00:00:00.000Z',
        actorId: 'relay-cli@box',
        capabilities: ['session:read'],
      })
    );
    chmodSync(loginFilePath, 0o600);

    // Valid local hub token file for port 4567
    const localTokenPath = path.join(
      relayConfigDir,
      'local-actor-token-4567.json'
    );
    writeFileSync(
      localTokenPath,
      JSON.stringify({
        version: 1,
        source: 'hub-local',
        port: 4567,
        pid: 12345,
        token: 'relay-sac-v1.local-cred.localsecret',
        credentialId: 'local-cred',
        hubUrl: 'http://127.0.0.1:4567',
        issuedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2027-08-01T00:00:00.000Z',
        actorId: 'relay-hub@local',
        capabilities: ['session:read'],
      })
    );
    chmodSync(localTokenPath, 0o600);

    const callsPath = path.join(homeDir, 'calls.json');
    const preload = makeScriptedFetch(
      [{ status: 200, body: { nodes: [] } }],
      callsPath
    );
    const result = await runCli(['v1', 'nodes', 'list', '--json'], {
      HOME: homeDir,
      NODE_OPTIONS: `--import=${preload}`,
      RELAY_IDE_PORT: '4567',
      RELAY_IDE_ACTOR_TOKEN: '',
      RELAY_IDE_BROWSER_TOKEN: '',
    });

    expect(result.code).toBe(0);
    const calls: Capture[] = JSON.parse(readFileSync(callsPath, 'utf8'));
    const gatewayCall = calls.find((call) => call.url.endsWith('/nodes'));
    expect(gatewayCall).toBeTruthy();
    expect(gatewayCall!.headers?.['authorization']).toBe(
      'Bearer relay-sac-v1.local-cred.localsecret'
    );
    // The stale expired login file was removed so it stops shadowing
    expect(existsSync(loginFilePath)).toBe(false);

    rmSync(homeDir, { recursive: true, force: true });
  }, 30_000);

  it('valid login file still wins over local hub token (#1484)', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-home-'));
    const relayConfigDir = path.join(homeDir, '.config', 'relay-ide');
    const { mkdirSync, existsSync } = await import('node:fs');
    mkdirSync(relayConfigDir, { recursive: true });

    // Valid login credential file
    const loginFilePath = path.join(relayConfigDir, 'actor-token.json');
    writeFileSync(
      loginFilePath,
      JSON.stringify({
        version: 1,
        token: 'relay-sac-v1.valid-login.loginsecret',
        credentialId: 'valid-login',
        hubUrl: 'http://127.0.0.1:4567',
        issuedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2027-08-01T00:00:00.000Z',
        actorId: 'relay-cli@box',
        capabilities: ['session:read'],
      })
    );
    chmodSync(loginFilePath, 0o600);

    // Valid local hub token file for port 4567
    const localTokenPath = path.join(
      relayConfigDir,
      'local-actor-token-4567.json'
    );
    writeFileSync(
      localTokenPath,
      JSON.stringify({
        version: 1,
        source: 'hub-local',
        port: 4567,
        pid: 12345,
        token: 'relay-sac-v1.local-cred.localsecret',
        credentialId: 'local-cred',
        hubUrl: 'http://127.0.0.1:4567',
        issuedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2027-08-01T00:00:00.000Z',
        actorId: 'relay-hub@local',
        capabilities: ['session:read'],
      })
    );
    chmodSync(localTokenPath, 0o600);

    const callsPath = path.join(homeDir, 'calls.json');
    const preload = makeScriptedFetch(
      [{ status: 200, body: { nodes: [] } }],
      callsPath
    );
    const result = await runCli(['v1', 'nodes', 'list', '--json'], {
      HOME: homeDir,
      NODE_OPTIONS: `--import=${preload}`,
      RELAY_IDE_PORT: '4567',
      RELAY_IDE_ACTOR_TOKEN: '',
      RELAY_IDE_BROWSER_TOKEN: '',
    });

    expect(result.code).toBe(0);
    const calls: Capture[] = JSON.parse(readFileSync(callsPath, 'utf8'));
    const gatewayCall = calls.find((call) => call.url.endsWith('/nodes'));
    expect(gatewayCall).toBeTruthy();
    expect(gatewayCall!.headers?.['authorization']).toBe(
      'Bearer relay-sac-v1.valid-login.loginsecret'
    );
    expect(existsSync(loginFilePath)).toBe(true);

    rmSync(homeDir, { recursive: true, force: true });
  }, 30_000);

  it('expired stored credential fails with actionable guidance when no local token exists (#1484)', async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-expired-'));
    writeFileSync(
      path.join(configDir, 'actor-token.json'),
      JSON.stringify({
        version: 1,
        token: 'relay-sac-v1.old-cred.oldsecret',
        credentialId: 'old-cred',
        hubUrl: 'http://127.0.0.1:4567',
        issuedAt: '2025-08-01T00:00:00.000Z',
        expiresAt: '2025-09-01T00:00:00.000Z',
        actorId: 'relay-cli@box',
        capabilities: ['session:read'],
      })
    );
    chmodSync(path.join(configDir, 'actor-token.json'), 0o600);

    const preload = makeScriptedFetch([]);
    // The CLI resolves its own config dir from $HOME/.config/relay-ide; point
    // HOME at a dir containing .config/relay-ide/actor-token.json.
    const homeDir = mkdtempSync(path.join(tmpdir(), 'relay-cli-home-'));
    const relayConfigDir = path.join(homeDir, '.config', 'relay-ide');
    const { mkdirSync, copyFileSync, existsSync } = await import('node:fs');
    mkdirSync(relayConfigDir, { recursive: true });
    const targetLoginFile = path.join(relayConfigDir, 'actor-token.json');
    copyFileSync(path.join(configDir, 'actor-token.json'), targetLoginFile);
    chmodSync(targetLoginFile, 0o600);

    const result = await runCli(['v1', 'sessions', 'list', '--json'], {
      HOME: homeDir,
      NODE_OPTIONS: `--import=${preload}`,
      RELAY_IDE_PORT: '4567',
      RELAY_IDE_ACTOR_TOKEN: '',
      RELAY_IDE_BROWSER_TOKEN: '',
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('relay-ide login');
    expect(result.stdout).not.toContain('relay-sac-v1.');
    expect(existsSync(targetLoginFile)).toBe(false);

    rmSync(homeDir, { recursive: true, force: true });
  }, 30_000);
});
