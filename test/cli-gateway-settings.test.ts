import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { describe, expect, it } from 'vitest';

import {
  createCliGatewaySettingsRouter,
  safeSettingsFromConfig,
  updateSafeSetting,
} from '../server/cli-gateway-settings.js';
import type { Config } from '../server/types.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 3456,
    host: '127.0.0.1',
    ...overrides,
  } as Config;
}

async function withSettingsRouter(
  grantedCapabilities: readonly RelayCapabilityBit[],
  callback: (input: {
    baseUrl: string;
    configPath: string;
  }) => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-settings-router-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(config({ defaultYolo: false, defaultNotifications: false })),
    'utf8'
  );
  const granted = new Set<RelayCapabilityBit>(grantedCapabilities);
  const app = express();
  app.use(express.json());
  app.use(
    '/cli-gateway',
    createCliGatewaySettingsRouter({
      configPath,
      requireAuth: (_req, _res, next) => next(),
      authorizeCapability: (_req, capability) => granted.has(capability),
    })
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await callback({
      baseUrl: `http://127.0.0.1:${address.port}`,
      configPath,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('CLI gateway safe settings helpers', () => {
  it('returns only the allowlisted settings subset with defaults', () => {
    const settings = safeSettingsFromConfig(
      config({
        defaultFramework: 'codex',
        defaultContinue: false,
        defaultYolo: false,
        defaultNotifications: true,
        claudeFullscreen: false,
        renamerTool: 'none',
        updateChannel: 'nightly',
        github: {
          webhookSecret: '[REDACTED]',
          smeeUrl: '[REDACTED]',
        },
      })
    );

    expect(settings).toEqual({
      defaultAgent: 'codex',
      defaultContinue: false,
      defaultYolo: false,
      defaultNotifications: true,
      claudeFullscreen: false,
      renamerTool: 'none',
      updateChannel: 'nightly',
    });
    expect(JSON.stringify(settings)).not.toContain('webhookSecret');
    expect(JSON.stringify(settings)).not.toContain('smeeUrl');
  });

  it('mutates only allowlisted keys and reports redaction metadata', () => {
    const mutable = config({ defaultFramework: 'claude' });
    const result = updateSafeSetting(mutable, {
      key: 'defaultAgent',
      value: 'codex',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({
        key: 'defaultAgent',
        value: 'codex',
        previousValue: 'claude',
        changed: true,
        redaction: {
          rawConfigReturned: false,
          secretsReturned: false,
          tokenMaterialReturned: false,
        },
      });
    }
    expect(mutable.defaultFramework).toBe('codex');
  });

  it('rejects invalid values before saving', () => {
    const mutable = config({ renamerTool: 'claude' });
    const result = updateSafeSetting(mutable, {
      key: 'renamerTool',
      value: 'curl' as never,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: {
        code: 'INVALID_ARGUMENT',
        field: 'renamerTool',
      },
    });
    expect(mutable.renamerTool).toBe('claude');
  });

  it('requires explicit confirmation for risky setting transitions', () => {
    const mutable = config({ defaultYolo: false });
    const denied = updateSafeSetting(mutable, {
      key: 'defaultYolo',
      value: true,
    });

    expect(denied).toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: 'CONFIRMATION_REQUIRED',
        reasonCode: 'RISKY_SETTING_WRITE_CONFIRMATION_REQUIRED',
      },
    });
    expect(mutable.defaultYolo).toBe(false);

    const confirmed = updateSafeSetting(mutable, {
      key: 'defaultYolo',
      value: true,
      confirmRiskyWrite: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(mutable.defaultYolo).toBe(true);
  });
});

describe('CLI gateway settings router capability authorization', () => {
  it('rejects caller-asserted settings:write without a server-side grant', async () => {
    await withSettingsRouter([], async ({ baseUrl, configPath }) => {
      const res = await fetch(`${baseUrl}/cli-gateway/settings`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-relay-cli-gateway': 'v1',
          'x-relay-capabilities': 'settings:write',
        },
        body: JSON.stringify({
          key: 'defaultYolo',
          value: true,
          confirmRiskyWrite: true,
        }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { deniedBits: string[] } };
      expect(body.error.deniedBits).toEqual(['settings:write']);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
        defaultYolo: false,
      });
    });
  });

  it('allows settings updates from server-side settings:write grants without trusting headers', async () => {
    await withSettingsRouter(['settings:write'], async ({ baseUrl, configPath }) => {
      const res = await fetch(`${baseUrl}/cli-gateway/settings`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-relay-cli-gateway': 'v1',
        },
        body: JSON.stringify({ key: 'defaultNotifications', value: true }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        key: 'defaultNotifications',
        value: true,
        changed: true,
      });
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
        defaultNotifications: true,
      });
    });
  });
});
