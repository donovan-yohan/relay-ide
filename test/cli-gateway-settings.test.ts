import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type RequestHandler } from 'express';
import { describe, expect, it } from 'vitest';

import {
  createCliGatewaySettingsRouter,
  safeSettingsFromConfig,
  updateSafeSetting,
} from '../server/cli-gateway-settings.js';
import { saveConfig } from '../server/config.js';
import type { Config } from '../server/types.js';
import { createTestServer } from './helpers/test-server.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 3456,
    host: '127.0.0.1',
    ...overrides,
  } as Config;
}

const browserOnlyAuth: RequestHandler = (req, res, next) => {
  if (req.header('cookie') === 'token=browser') {
    next();
    return;
  }
  res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      reasonCode: 'BROWSER_SESSION_REQUIRED',
      message: 'browser operator session required',
      retryable: false,
    },
  });
};

async function startSettingsServer(configPath: string) {
  const app = express();
  app.use(express.json());
  app.use(
    '/cli-gateway',
    createCliGatewaySettingsRouter({
      configPath,
      requireAuth: browserOnlyAuth,
    })
  );
  return createTestServer(app);
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

describe('CLI gateway settings/webhook route auth', () => {
  it('does not let CLI bearer auth self-assert settings:write through x-relay-capabilities', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-gateway-settings-'));
    const configPath = path.join(tmpDir, 'config.json');
    saveConfig(configPath, config({ defaultFramework: 'claude' }));
    const { url, close } = await startSettingsServer(configPath);
    try {
      const res = await fetch(`${url}/cli-gateway/settings`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer scoped-token-without-settings-grant',
          'Content-Type': 'application/json',
          'x-relay-cli-gateway': 'v1',
          'x-relay-capabilities': 'settings:write',
        },
        body: JSON.stringify({ key: 'defaultAgent', value: 'codex' }),
      });

      expect(res.status).toBe(401);
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Config;
      expect(persisted.defaultFramework).toBe('claude');
    } finally {
      await close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['GET', '/cli-gateway/settings', 'settings:read'],
    ['GET', '/cli-gateway/webhooks/status', 'integration:webhook:read'],
    ['POST', '/cli-gateway/webhooks/ping', 'integration:webhook:test'],
  ])(
    'keeps %s %s browser-operator-only even when x-relay-capabilities=%s is spoofed',
    async (method, pathName, capability) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-gateway-settings-'));
      const configPath = path.join(tmpDir, 'config.json');
      saveConfig(configPath, config({ defaultFramework: 'claude' }));
      const { url, close } = await startSettingsServer(configPath);
      try {
        const denied = await fetch(`${url}${pathName}`, {
          method,
          headers: {
            Authorization: 'Bearer scoped-token-without-route-grant',
            'x-relay-cli-gateway': 'v1',
            'x-relay-capabilities': capability,
          },
        });
        expect(denied.status).toBe(401);

        const allowed = await fetch(`${url}${pathName}`, {
          method,
          headers: { cookie: 'token=browser' },
        });
        expect(allowed.status).toBe(200);
      } finally {
        await close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  );
});
