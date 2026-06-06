import { describe, expect, it } from 'vitest';

import {
  safeSettingsFromConfig,
  updateSafeSetting,
} from '../server/cli-gateway-settings.js';
import type { Config } from '../server/types.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 3456,
    host: '127.0.0.1',
    ...overrides,
  } as Config;
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
