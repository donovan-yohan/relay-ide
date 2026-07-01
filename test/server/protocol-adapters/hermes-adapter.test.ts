import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapterV2 } from '../../../server/protocol-adapters/index.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../server/protocol-adapters/legacy-v2-bridge.js';
import { resolveHermesGatewaySettings } from '../../../server/protocol-adapters/hermes-adapter.js';

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
