import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../server/config.js';
import {
  createDiagnosticsBundle,
  redactJson,
  redactText,
} from '../server/diagnostics-bundle.js';
import type { Config } from '../server/types.js';
import type { NodeManifest } from '../shared/node-manifest.js';

const cleanup: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-diag-bundle-'));
  cleanup.push(dir);
  return dir;
}

function makeManifest(): NodeManifest {
  return {
    schemaVersion: 1,
    platform: 'darwin',
    arch: 'arm64',
    hostname: 'test-host',
    homeDir: '/Users/tester',
    relayVersion: '0.1.0',
    generatedAt: '2026-01-02T03:04:05.000Z',
    wsl: { detected: false, version: null, systemd: false },
    serviceManager: {
      kind: 'launchd',
      label: 'launchd',
      supported: true,
      installable: true,
      message: 'launchd available',
      installHint: 'install hint',
      uninstallHint: 'uninstall hint',
      caveats: [],
    },
    capabilities: {
      tmux: { id: 'tmux', label: 'tmux', status: 'available', message: 'ok' },
      git: { id: 'git', label: 'Git', status: 'available', message: 'ok' },
      clipboard: {
        id: 'clipboard',
        label: 'Clipboard',
        status: 'available',
        message: 'ok',
      },
      browserAutomation: {
        id: 'browserAutomation',
        label: 'Browser automation',
        status: 'degraded',
        message: 'missing',
      },
      githubCli: {
        id: 'githubCli',
        label: 'GitHub CLI',
        status: 'available',
        message: 'ok',
      },
      tailscale: {
        id: 'tailscale',
        label: 'Tailscale CLI',
        status: 'unavailable',
        message: 'missing',
      },
      ssh: { id: 'ssh', label: 'SSH client', status: 'available', message: 'ok' },
      sessionResume: 'tmux',
      agents: {},
    },
  };
}

function makeConfig(): Config {
  return {
    ...DEFAULTS,
    repos: ['/repo/one'],
    pinHash: 'pin-hash-secret',
    vapidPublicKey: 'public-key',
    vapidPrivateKey: 'private-vapid-secret',
    github: {
      accessToken: 'ghp_123456789012345678901234567890123456',
      username: 'tester',
      webhookSecret: 'webhook-secret',
      smeeUrl: 'https://smee.io/secret-channel',
    },
  };
}

function readBundleFile(bundleDir: string, relativePath: string): string {
  return fs.readFileSync(path.join(bundleDir, relativePath), 'utf8');
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('diagnostics bundle', () => {
  it('redacts sensitive json keys and token-shaped text', () => {
    const json = redactJson({
      accessToken: 'ghp_123456789012345678901234567890123456',
      nested: { pinHash: 'pin-secret', safe: 'hello' },
    });
    expect(json.value).toEqual({
      accessToken: '[REDACTED]',
      nested: { pinHash: '[REDACTED]', safe: 'hello' },
    });
    expect(json.counts['sensitive-json-key']).toBe(2);

    const text = redactText(
      'Authorization: Bearer abc.def Cookie: sid=secret token=abc https://u:p@example.test'
    );
    expect(text.value).not.toContain('abc.def');
    expect(text.value).not.toContain('sid=secret');
    expect(text.value).not.toContain('https://u:p@');
    expect(text.value).toContain('[REDACTED]');
  });

  it('writes a timestamped local bundle with redacted config, logs, manifest, and skipped sources', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const logDir = path.join(dir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(), null, 2));
    fs.writeFileSync(
      path.join(logDir, 'relay-ide.log'),
      'startup ok\nAuthorization: Bearer local-secret-token\nCookie: sid=local-cookie\n'
    );
    fs.writeFileSync(
      path.join(dir, 'hub-node-registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        pairTokens: [{ tokenHash: 'hash-secret' }],
        nodes: [{ nodeId: 'node-1', credentialHash: 'credential-secret' }],
      })
    );

    const result = await createDiagnosticsBundle({
      configPath,
      outputRoot: path.join(dir, 'out'),
      now: new Date('2026-01-02T03:04:05.000Z'),
      lines: 10,
      manifest: makeManifest(),
      servicePaths: {
        servicePath: path.join(dir, 'service.plist'),
        logDir: null,
        label: 'relay-ide',
      },
      serviceStatus: { installed: false, running: false },
      versionInfo: {
        relayVersion: '0.1.0',
        nodeVersion: 'v24.0.0',
        platform: 'darwin',
        arch: 'arm64',
      },
      env: {
        RELAY_IDE_PORT: '3456',
        GITHUB_TOKEN: 'ghp_123456789012345678901234567890123456',
      },
      cwd: dir,
    });

    expect(path.basename(result.bundleDir)).toBe(
      'relay-diagnostics-2026-01-02T03-04-05-000Z'
    );
    const config = readBundleFile(result.bundleDir, 'config-redacted.json');
    expect(config).not.toContain('pin-hash-secret');
    expect(config).not.toContain('private-vapid-secret');
    expect(config).not.toContain('ghp_123456789012345678901234567890123456');
    expect(config).toContain('[REDACTED]');

    const log = readBundleFile(result.bundleDir, 'logs/hub.log');
    expect(log).toContain('startup ok');
    expect(log).not.toContain('local-secret-token');
    expect(log).not.toContain('local-cookie');

    const registry = readBundleFile(result.bundleDir, 'hub-node-registry-redacted.json');
    expect(registry).not.toContain('hash-secret');
    expect(registry).not.toContain('credential-secret');

    const manifest = JSON.parse(
      readBundleFile(result.bundleDir, 'manifest.json')
    ) as { entries: Array<{ path: string; status: string }>; redactionSummary: object };
    expect(manifest.entries.some((entry) => entry.path === 'node-manifest.json')).toBe(
      true
    );
    expect(manifest.entries.some((entry) => entry.status === 'skipped')).toBe(true);
    expect(Object.keys(manifest.redactionSummary).length).toBeGreaterThan(0);
  });
});
