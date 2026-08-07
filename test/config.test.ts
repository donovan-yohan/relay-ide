import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';

import {
  DEFAULTS,
  deleteMeta,
  deleteRepoSettingKeys,
  ensureMetaDir,
  loadConfig,
  readMeta,
  resolveSessionSettings,
  saveConfig,
  writeMeta,
} from '../server/config.js';

const LEGACY_TMUX_LAUNCH_KEY = 'launchInTmux';
const RETIRED_AGENT_KEYS = [
  'defaultContinue',
  'defaultContinuePolicy',
  'defaultYolo',
  'claudeFullscreen',
  'claudeArgs',
  'promptCreatePr',
  'promptBranchRename',
  'promptGeneral',
  'promptStartWork',
] as const;

let tmpDir!: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-config-test-'));
});

afterEach(() => {
  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    fs.rmSync(path.join(tmpDir, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadConfig merges supported defaults', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ port: 9000, host: '127.0.0.1' }),
    'utf8'
  );

  const config = loadConfig(configPath);
  expect(config).toMatchObject({
    port: 9000,
    host: '127.0.0.1',
    cookieTTL: DEFAULTS.cookieTTL,
    repos: [],
    defaultFramework: 'claude',
    terminalBackend: 'relay-pty',
  });
  for (const key of RETIRED_AGENT_KEYS) {
    expect(config).not.toHaveProperty(key);
    expect(DEFAULTS).not.toHaveProperty(key);
  }
});

test('loadConfig strips retired public-agent settings at every config layer', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const retired = Object.fromEntries(
    RETIRED_AGENT_KEYS.map((key) => [
      key,
      key === 'claudeArgs' ? ['--x'] : true,
    ])
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...retired,
      defaultFramework: 'codex',
      repoSettings: {
        '/repo': {
          ...retired,
          defaultFramework: 'claude',
          promptFixConflicts: 'resolve this conflict',
        },
      },
      workspaces: [
        {
          id: 'ws',
          name: 'Workspace',
          repos: ['/repo'],
          order: 0,
          settings: {
            ...retired,
            defaultFramework: 'hermes',
            promptFixConflicts: 'workspace conflict prompt',
          },
        },
      ],
    }),
    'utf8'
  );

  const config = loadConfig(configPath);
  for (const key of RETIRED_AGENT_KEYS) {
    expect(config).not.toHaveProperty(key);
    expect(config.repoSettings?.['/repo']).not.toHaveProperty(key);
    expect(config.workspaces?.[0]?.settings).not.toHaveProperty(key);
  }
  expect(config.defaultFramework).toBe('codex');
  expect(config.repoSettings?.['/repo']).toMatchObject({
    defaultFramework: 'claude',
    promptFixConflicts: 'resolve this conflict',
  });
});

test('loadConfig strips the retired tmux launch flag and preserves relay-pty', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      [LEGACY_TMUX_LAUNCH_KEY]: true,
      terminalBackend: 'relay-pty',
    }),
    'utf8'
  );

  const config = loadConfig(configPath);
  expect(config.terminalBackend).toBe('relay-pty');
  expect(config).not.toHaveProperty(LEGACY_TMUX_LAUNCH_KEY);
});

test('loadConfig exposes only supported automation settings', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      automations: {
        autoCheckoutReviewRequests: true,
        pollIntervalMs: 120_000,
        lastPollTimestamp: '2026-07-26T00:00:00.000Z',
        unsupportedSetting: true,
      },
    }),
    'utf8'
  );

  expect(loadConfig(configPath).automations).toEqual({
    autoCheckoutReviewRequests: true,
    pollIntervalMs: 120_000,
    lastPollTimestamp: '2026-07-26T00:00:00.000Z',
  });
});

test('loadConfig throws for a missing file and saveConfig writes formatted JSON', () => {
  expect(() => loadConfig(path.join(tmpDir, 'missing.json'))).toThrow(
    /Config file not found/
  );
  const configPath = path.join(tmpDir, 'saved.json');
  const config = { ...DEFAULTS };
  saveConfig(configPath, config);
  expect(fs.readFileSync(configPath, 'utf8')).toBe(
    JSON.stringify(config, null, 2)
  );
});

test('worktree metadata round-trips and deletes', () => {
  const configPath = path.join(tmpDir, 'config.json');
  ensureMetaDir(configPath);
  const metadata = {
    worktreePath: '/tmp/worktree',
    displayName: 'feature',
    lastActivity: '2026-07-27T00:00:00.000Z',
    branchName: 'feature/runtime',
  };
  writeMeta(configPath, metadata);
  expect(readMeta(configPath, metadata.worktreePath)).toEqual(metadata);
  deleteMeta(configPath, metadata.worktreePath);
  expect(readMeta(configPath, metadata.worktreePath)).toBeNull();
  expect(() => deleteMeta(configPath, '/missing')).not.toThrow();
});

test('resolveSessionSettings resolves only terminal runtime settings', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      terminalBackend: 'relay-pty',
      sessionDurability: { scrollbackBytes: 333_000 },
      defaultFramework: 'codex',
    }),
    'utf8'
  );
  expect(resolveSessionSettings(loadConfig(configPath), '/repo', {})).toEqual({
    terminalBackend: 'relay-pty',
    scrollbackBytes: 333_000,
  });
});

test('repo terminal settings override workspace settings and invalid backends fall through', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      terminalBackend: 'relay-pty',
      workspaces: [
        {
          id: 'ws',
          name: 'Workspace',
          repos: ['/repo'],
          order: 0,
          settings: {
            terminalBackend: 'relay-pty',
            sessionDurability: { scrollbackBytes: 200_000 },
          },
        },
      ],
      repoSettings: {
        '/repo': {
          terminalBackend: 'tmux-compat',
          sessionDurability: { scrollbackBytes: 250_000 },
        },
      },
    }),
    'utf8'
  );
  expect(
    resolveSessionSettings(loadConfig(configPath), '/repo', {}, 'ws')
  ).toEqual({
    terminalBackend: 'relay-pty',
    scrollbackBytes: 250_000,
  });
});

test('deleteRepoSettingKeys preserves remaining repo configuration', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const config = {
    ...DEFAULTS,
    repoSettings: {
      '/repo': { defaultFramework: 'codex', branchPrefix: 'dy/' },
    },
  };
  deleteRepoSettingKeys(configPath, config, '/repo', ['defaultFramework']);
  expect(config.repoSettings?.['/repo']).toEqual({ branchPrefix: 'dy/' });
  deleteRepoSettingKeys(configPath, config, '/repo', ['branchPrefix']);
  expect(config.repoSettings?.['/repo']).toBeUndefined();
});
