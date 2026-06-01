import { test, beforeAll, afterAll, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULTS,
  loadConfig,
  saveConfig,
  ensureMetaDir,
  readMeta,
  writeMeta,
  deleteMeta,
  resolveSessionSettings,
  deleteRepoSettingKeys,
} from '../server/config.js';
import type { Config } from '../server/types.js';

let tmpDir!: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-config-test-'));
});

afterEach(() => {
  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    const fullPath = path.join(tmpDir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true });
    } else {
      fs.unlinkSync(fullPath);
    }
  }
});

afterAll(() => {
  fs.rmdirSync(tmpDir);
});

test('loadConfig loads a JSON config file', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const data = { port: 4000, host: '127.0.0.1' };
  fs.writeFileSync(configPath, JSON.stringify(data), 'utf8');

  const config = loadConfig(configPath);
  expect(config.port).toBe(4000);
  expect(config.host).toBe('127.0.0.1');
});

test('loadConfig merges with defaults for missing fields', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 9000 }), 'utf8');

  const config = loadConfig(configPath);
  expect(config.port).toBe(9000);
  expect(config.host).toBe(DEFAULTS.host);
  expect(config.cookieTTL).toBe(DEFAULTS.cookieTTL);
  expect(config.repos).toEqual(DEFAULTS.repos);
  expect(config.claudeArgs).toEqual(DEFAULTS.claudeArgs);
  expect(config.defaultFramework).toBe(DEFAULTS.defaultFramework);
});

test('loadConfig throws if config file not found', () => {
  const configPath = path.join(tmpDir, 'nonexistent.json');
  expect(() => loadConfig(configPath)).toThrow(/Config file not found/);
});

test('saveConfig writes JSON with 2-space indent', () => {
  const configPath = path.join(tmpDir, 'output.json');
  const config = { port: 3456, host: '0.0.0.0' };

  saveConfig(configPath, config as Parameters<typeof saveConfig>[1]);

  const raw = fs.readFileSync(configPath, 'utf8');
  expect(raw).toBe(JSON.stringify(config, null, 2));
});

test('DEFAULTS has expected keys and values', () => {
  expect(DEFAULTS.host).toBe('0.0.0.0');
  expect(DEFAULTS.port).toBe(3456);
  expect(DEFAULTS.cookieTTL).toBe('24h');
  expect(DEFAULTS.repos).toEqual([]);
  expect(DEFAULTS.claudeArgs).toEqual([]);
  expect(DEFAULTS.defaultFramework).toBe('claude');
  expect(DEFAULTS.defaultContinue).toBe(true);
  expect(DEFAULTS.defaultYolo).toBe(false);
  expect(DEFAULTS.launchInTmux).toBe(false);
  expect(DEFAULTS.terminalBackend).toBe('relay-pty');
});

test('loadConfig returns correct defaults for defaultContinue, defaultYolo, and launchInTmux', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 3456 }), 'utf8');

  const config = loadConfig(configPath);
  expect(config.defaultContinue).toBe(true);
  expect(config.defaultYolo).toBe(false);
  expect(config.launchInTmux).toBe(false);
  expect(config.terminalBackend).toBe('relay-pty');
});

test('loadConfig migrates legacy launchInTmux=true to tmux-compat when terminalBackend is absent', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ launchInTmux: true }), 'utf8');

  const config = loadConfig(configPath);
  expect(config.terminalBackend).toBe('tmux-compat');
  expect(config.launchInTmux).toBe(true);
});

test('loadConfig keeps relay-pty default for absent or false legacy launchInTmux', () => {
  const missingLegacyPath = path.join(tmpDir, 'missing-legacy.json');
  fs.writeFileSync(missingLegacyPath, JSON.stringify({}), 'utf8');
  const missingLegacyConfig = loadConfig(missingLegacyPath);
  expect(missingLegacyConfig.terminalBackend).toBe('relay-pty');
  expect(missingLegacyConfig.launchInTmux).toBe(false);

  const falseLegacyPath = path.join(tmpDir, 'false-legacy.json');
  fs.writeFileSync(
    falseLegacyPath,
    JSON.stringify({ launchInTmux: false }),
    'utf8'
  );
  const falseLegacyConfig = loadConfig(falseLegacyPath);
  expect(falseLegacyConfig.terminalBackend).toBe('relay-pty');
  expect(falseLegacyConfig.launchInTmux).toBe(false);
});

test('loadConfig lets explicit terminalBackend take precedence over legacy launchInTmux', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ terminalBackend: 'relay-pty', launchInTmux: true }),
    'utf8'
  );

  const config = loadConfig(configPath);
  expect(config.terminalBackend).toBe('relay-pty');
  expect(config.launchInTmux).toBe(false);
});

test('ensureMetaDir creates worktree-meta directory', () => {
  const configPath = path.join(tmpDir, 'config.json');
  ensureMetaDir(configPath);
  const metaPath = path.join(tmpDir, 'worktree-meta');
  expect(fs.existsSync(metaPath)).toBeTruthy();
});

test('writeMeta creates and readMeta reads metadata file', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const meta = {
    worktreePath: '/tmp/test-worktree',
    displayName: 'My Feature',
    lastActivity: '2026-02-22T00:00:00.000Z',
  };
  writeMeta(configPath, meta);
  const read = readMeta(configPath, '/tmp/test-worktree');
  expect(read).toEqual(meta);
});

test('readMeta returns null for non-existent metadata', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const result = readMeta(configPath, '/no/such/worktree');
  expect(result).toBe(null);
});

test('writeMeta overwrites existing metadata', () => {
  const configPath = path.join(tmpDir, 'config.json');
  writeMeta(configPath, {
    worktreePath: '/tmp/wt',
    displayName: 'Old Name',
    lastActivity: '2026-01-01T00:00:00.000Z',
  });
  writeMeta(configPath, {
    worktreePath: '/tmp/wt',
    displayName: 'New Name',
    lastActivity: '2026-02-22T00:00:00.000Z',
  });
  const read = readMeta(configPath, '/tmp/wt');
  expect(read!.displayName).toBe('New Name');
  expect(read!.lastActivity).toBe('2026-02-22T00:00:00.000Z');
});

test('deleteMeta removes metadata file', () => {
  const configPath = path.join(tmpDir, 'config.json');
  writeMeta(configPath, {
    worktreePath: '/tmp/del-test',
    displayName: 'To Delete',
    lastActivity: '2026-02-22T00:00:00.000Z',
  });
  expect(readMeta(configPath, '/tmp/del-test')).toBeTruthy();
  deleteMeta(configPath, '/tmp/del-test');
  expect(readMeta(configPath, '/tmp/del-test')).toBe(null);
});

test('deleteMeta is a no-op for non-existent metadata', () => {
  const configPath = path.join(tmpDir, 'config.json');
  expect(() => deleteMeta(configPath, '/no/such/path')).not.toThrow();
});

test('resolveSessionSettings returns global defaults when no workspace or overrides', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultContinue: true,
      defaultYolo: false,
      launchInTmux: false,
      claudeArgs: [],
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/some/repo', {});
  expect(result.agent).toBe('claude');
  expect(result.yolo).toBe(false);
  expect(result.continuePolicy).toBe('always');
  expect(result.terminalBackend).toBe('relay-pty');
  expect(result.useTmux).toBe(false);
  expect(result.claudeArgs).toEqual([]);
});

test('resolveSessionSettings applies workspace overrides over globals', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultYolo: false,
      defaultContinue: true,
      launchInTmux: false,
      claudeArgs: [],
      repoSettings: {
        '/my/repo': { defaultYolo: true, defaultFramework: 'codex' },
      },
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', {});
  expect(result.agent).toBe('codex');
  expect(result.yolo).toBe(true);
  expect(result.continuePolicy).toBe('always');
});

test('resolveSessionSettings can opt into relay-pty through legacy useTmux:false', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const wsId = 'ws-tmux-required';
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultYolo: false,
      defaultContinue: true,
      launchInTmux: false,
      claudeArgs: [],
      repos: ['/my/repo'],
      workspaces: [
        {
          id: wsId,
          name: 'My Workspace',
          repos: ['/my/repo'],
          order: 0,
          settings: { launchInTmux: false },
        },
      ],
      repoSettings: {
        '/my/repo': { launchInTmux: false },
      },
    }),
    'utf8'
  );

  const config = loadConfig(configPath);
  const result = resolveSessionSettings(
    config,
    '/my/repo',
    { useTmux: false },
    wsId
  );

  expect(result.terminalBackend).toBe('relay-pty');
  expect(result.useTmux).toBe(false);
});

test('resolveSessionSettings can opt into relay-pty through terminalBackend', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultYolo: false,
      defaultContinue: true,
      terminalBackend: 'relay-pty',
      claudeArgs: [],
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/some/repo', {});
  expect(result.terminalBackend).toBe('relay-pty');
  expect(result.useTmux).toBe(false);
});

test('resolveSessionSettings lets repo terminalBackend override env global default', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const previousBackend = process.env.RELAY_IDE_TERMINAL_BACKEND;
  process.env.RELAY_IDE_TERMINAL_BACKEND = 'relay-pty';
  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultFramework: 'claude',
        defaultYolo: false,
        defaultContinue: true,
        terminalBackend: 'relay-pty',
        claudeArgs: [],
        repoSettings: {
          '/my/repo': { terminalBackend: 'tmux-compat' },
        },
      }),
      'utf8'
    );
    const config = loadConfig(configPath);
    const result = resolveSessionSettings(config, '/my/repo', {});
    expect(result.terminalBackend).toBe('tmux-compat');
    expect(result.useTmux).toBe(true);
  } finally {
    if (previousBackend === undefined) {
      delete process.env.RELAY_IDE_TERMINAL_BACKEND;
    } else {
      process.env.RELAY_IDE_TERMINAL_BACKEND = previousBackend;
    }
  }
});

test('resolveSessionSettings explicit overrides beat workspace settings', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultYolo: true,
      defaultContinue: true,
      launchInTmux: false,
      claudeArgs: [],
      repoSettings: {
        '/my/repo': { defaultYolo: true },
      },
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', { yolo: false });
  expect(result.yolo).toBe(false);
});

test('resolveSessionSettings uses override claudeArgs, not global', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultYolo: false,
      defaultContinue: true,
      launchInTmux: false,
      claudeArgs: ['--global-arg'],
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/some/repo', {
    claudeArgs: ['--custom'],
  });
  expect(result.claudeArgs).toEqual(['--custom']);
});

test('resolveSessionSettings falls through to globals when no workspace exists', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'codex',
      defaultYolo: true,
      defaultContinue: false,
      launchInTmux: true,
      claudeArgs: ['--verbose'],
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/nonexistent/repo', {});
  expect(result.agent).toBe('codex');
  expect(result.yolo).toBe(true);
  expect(result.continuePolicy).toBe('never');
  expect(result.terminalBackend).toBe('tmux-compat');
  expect(result.useTmux).toBe(true);
  expect(result.claudeArgs).toEqual(['--verbose']);
});

test('deleteRepoSettingKeys removes specified keys', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const config = {
    ...DEFAULTS,
    repoSettings: {
      '/my/repo': {
        defaultYolo: true,
        defaultFramework: 'codex',
        branchPrefix: 'dy/',
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  deleteRepoSettingKeys(configPath, config, '/my/repo', [
    'defaultYolo',
    'defaultFramework',
  ]);
  expect(config.repoSettings!['/my/repo']!.defaultYolo).toBe(undefined);
  expect(config.repoSettings!['/my/repo']!.defaultFramework).toBe(undefined);
  expect(config.repoSettings!['/my/repo']!.branchPrefix).toBe('dy/');
});

test('deleteRepoSettingKeys removes entire workspace entry when empty', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const config = {
    ...DEFAULTS,
    repoSettings: {
      '/my/repo': { defaultYolo: true },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  deleteRepoSettingKeys(configPath, config, '/my/repo', ['defaultYolo']);
  expect(config.repoSettings!['/my/repo']).toBe(undefined);
});

test('deleteRepoSettingKeys is no-op for nonexistent workspace', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const config = { ...DEFAULTS };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  expect(() =>
    deleteRepoSettingKeys(configPath, config, '/no/such/repo', ['defaultYolo'])
  ).not.toThrow();
});

// ── resolveSessionSettings workspace cascade ──

test('resolveSessionSettings with workspaceId applies workspace settings between global and repo', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const wsId = 'ws-cascade-1';
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultYolo: false,
      defaultContinue: true,
      launchInTmux: false,
      claudeArgs: [],
      repos: ['/my/repo'],
      workspaces: [
        {
          id: wsId,
          name: 'My Workspace',
          repos: ['/my/repo'],
          order: 0,
          settings: {
            defaultYolo: true,
            defaultFramework: 'codex',
            launchInTmux: true,
          },
        },
      ],
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', {}, wsId);
  // Workspace settings should override global; legacy launchInTmux no longer changes the backend.
  expect(result.yolo).toBe(true);
  expect(result.agent).toBe('codex');
  expect(result.useTmux).toBe(false);
});

test('resolveSessionSettings: repo settings override workspace settings', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const wsId = 'ws-cascade-2';
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultYolo: false,
      defaultContinue: true,
      launchInTmux: false,
      claudeArgs: [],
      repos: ['/my/repo'],
      workspaces: [
        {
          id: wsId,
          name: 'My Workspace',
          repos: ['/my/repo'],
          order: 0,
          settings: { defaultYolo: true, defaultFramework: 'codex' },
        },
      ],
      repoSettings: {
        '/my/repo': { defaultYolo: false, defaultFramework: 'claude' },
      },
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', {}, wsId);
  // Repo settings beat workspace settings
  expect(result.yolo).toBe(false);
  expect(result.agent).toBe('claude');
});

test('resolveSessionSettings: overrides beat workspace and repo settings', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const wsId = 'ws-cascade-3';
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultYolo: false,
      defaultContinue: true,
      launchInTmux: false,
      claudeArgs: [],
      repos: ['/my/repo'],
      workspaces: [
        {
          id: wsId,
          name: 'My Workspace',
          repos: ['/my/repo'],
          order: 0,
          settings: { defaultYolo: true },
        },
      ],
      repoSettings: {
        '/my/repo': { defaultYolo: true },
      },
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(
    config,
    '/my/repo',
    { yolo: false },
    wsId
  );
  expect(result.yolo).toBe(false);
});

test('resolveSessionSettings without workspaceId skips workspace cascade', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultYolo: false,
      defaultContinue: true,
      launchInTmux: false,
      claudeArgs: [],
      repos: ['/my/repo'],
      workspaces: [
        {
          id: 'ws-x',
          name: 'My Workspace',
          repos: ['/my/repo'],
          order: 0,
          settings: { defaultYolo: true, defaultFramework: 'codex' },
        },
      ],
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  // No workspaceId passed — workspace settings should NOT apply
  const result = resolveSessionSettings(config, '/my/repo', {});
  expect(result.yolo).toBe(false);
  expect(result.agent).toBe('claude');
});

test('resolveSessionSettings with unknown workspaceId falls through to global', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      defaultYolo: false,
      defaultContinue: true,
      launchInTmux: false,
      claudeArgs: [],
      repos: ['/my/repo'],
      workspaces: [],
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(
    config,
    '/my/repo',
    {},
    'no-such-workspace'
  );
  expect(result.yolo).toBe(false);
  expect(result.agent).toBe('claude');
});

test('resolveSessionSettings maps defaultContinue:true to continuePolicy:always', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ defaultContinue: true }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', {});
  expect(resolved.continuePolicy).toBe('always');
});

test('resolveSessionSettings maps defaultContinue:false to continuePolicy:never', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ defaultContinue: false }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', {});
  expect(resolved.continuePolicy).toBe('never');
});

test('resolveSessionSettings respects explicit continuePolicy override', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ defaultContinue: true }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', {
    continuePolicy: 'never',
  });
  expect(resolved.continuePolicy).toBe('never');
});

test('resolveSessionSettings defaults continuePolicy to always when defaultContinue is missing', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', {});
  // defaultContinue defaults to true via DEFAULTS, so maps to 'always'
  expect(resolved.continuePolicy).toBe('always');
});

test('cascades workspace settings when workspaceId is provided', () => {
  const config = {
    ...DEFAULTS,
    repos: ['/tmp/test-repo'],
    workspaces: [
      {
        id: 'ws-1',
        name: 'test workspace',
        repos: ['/tmp/test-repo'],
        order: 0,
        settings: {
          defaultYolo: true,
          defaultFramework: 'claude',
        },
      },
    ],
    repoSettings: {},
  } as Config;

  const result = resolveSessionSettings(config, '/tmp/test-repo', {}, 'ws-1');
  expect(result.yolo).toBe(true);
  expect(result.agent).toBe('claude');
});

test('repo settings override workspace settings', () => {
  const config = {
    ...DEFAULTS,
    repos: ['/tmp/test-repo'],
    workspaces: [
      {
        id: 'ws-1',
        name: 'test workspace',
        repos: ['/tmp/test-repo'],
        order: 0,
        settings: {
          defaultYolo: true,
        },
      },
    ],
    repoSettings: {
      '/tmp/test-repo': { defaultYolo: false },
    },
  } as Config;

  const result = resolveSessionSettings(config, '/tmp/test-repo', {}, 'ws-1');
  expect(result.yolo).toBe(false);
});

test('resolveSessionSettings: repoSettings defaultFramework overrides global', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultFramework: 'claude',
      repos: ['/my/repo'],
      repoSettings: {
        '/my/repo': { defaultFramework: 'opencode' },
      },
    }),
    'utf8'
  );
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', {});
  expect(result.agent).toBe('opencode');
});
