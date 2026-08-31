import { describe, expect, it } from 'vitest';
import {
  resolveSessionSettings,
  resolveSessionDurabilityScrollbackBytes,
} from '../server/config.js';
import type { Config } from '../server/types.js';

const base: Config = {
  host: '0.0.0.0',
  port: 3456,
  cookieTTL: '24h',
  repos: [],
  defaultFramework: 'claude',
  maxPtySessions: 64,
  terminalBackend: 'relay-pty',
  defaultNotifications: true,
};

describe('resolveSessionDurabilityScrollbackBytes precedence', () => {
  it('returns undefined when nothing is configured', () => {
    expect(resolveSessionDurabilityScrollbackBytes(base, '/r')).toBeUndefined();
  });

  it('falls back to the legacy top-level cap when nothing else is set', () => {
    const config: Config = { ...base, maxScrollbackPerSessionBytes: 64_000 };
    expect(resolveSessionDurabilityScrollbackBytes(config, '/r')).toBe(64_000);
  });

  it('prefers Config.sessionDurability over the legacy top-level cap', () => {
    const config: Config = {
      ...base,
      maxScrollbackPerSessionBytes: 64_000,
      sessionDurability: { scrollbackBytes: 128_000 },
    };
    expect(resolveSessionDurabilityScrollbackBytes(config, '/r')).toBe(128_000);
  });

  it('prefers the workspace override over the global cap', () => {
    const config: Config = {
      ...base,
      sessionDurability: { scrollbackBytes: 100_000 },
      workspaces: [
        {
          id: 'ws-1',
          name: 'work',
          repos: ['/r'],
          order: 0,
          settings: { sessionDurability: { scrollbackBytes: 200_000 } },
        },
      ],
    };
    expect(resolveSessionDurabilityScrollbackBytes(config, '/r', 'ws-1')).toBe(
      200_000
    );
  });

  it('prefers the per-repo override over workspace and global', () => {
    const config: Config = {
      ...base,
      sessionDurability: { scrollbackBytes: 100_000 },
      workspaces: [
        {
          id: 'ws-1',
          name: 'work',
          repos: ['/r'],
          order: 0,
          settings: { sessionDurability: { scrollbackBytes: 200_000 } },
        },
      ],
      repoSettings: {
        '/r': { sessionDurability: { scrollbackBytes: 300_000 } },
      },
    };
    expect(resolveSessionDurabilityScrollbackBytes(config, '/r', 'ws-1')).toBe(
      300_000
    );
  });

  it('falls through past non-positive values with a warning, not crash', () => {
    const config: Config = {
      ...base,
      sessionDurability: { scrollbackBytes: 500_000 },
      repoSettings: {
        '/r': { sessionDurability: { scrollbackBytes: 0 } },
      },
    };
    // Per-repo zero is rejected; resolution falls through to the global.
    expect(resolveSessionDurabilityScrollbackBytes(config, '/r')).toBe(500_000);

    const negative: Config = {
      ...base,
      sessionDurability: { scrollbackBytes: -1 },
      maxScrollbackPerSessionBytes: 64_000,
    };
    expect(resolveSessionDurabilityScrollbackBytes(negative, '/r')).toBe(
      64_000
    );
  });
});

describe('resolveSessionSettings exposes scrollbackBytes', () => {
  it('does not include scrollbackBytes when nothing is configured', () => {
    const settings = resolveSessionSettings(base, '/r', {});
    expect(settings.scrollbackBytes).toBeUndefined();
  });

  it('returns the resolved per-repo cap', () => {
    const config: Config = {
      ...base,
      repoSettings: {
        '/r': { sessionDurability: { scrollbackBytes: 333_000 } },
      },
    };
    const settings = resolveSessionSettings(config, '/r', {});
    expect(settings.scrollbackBytes).toBe(333_000);
  });
});
