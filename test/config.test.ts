import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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

before(() => {
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

after(() => {
  fs.rmdirSync(tmpDir);
});

test('loadConfig loads a JSON config file', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const data = { port: 4000, host: '127.0.0.1' };
  fs.writeFileSync(configPath, JSON.stringify(data), 'utf8');

  const config = loadConfig(configPath);
  assert.equal(config.port, 4000);
  assert.equal(config.host, '127.0.0.1');
});

test('loadConfig merges with defaults for missing fields', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 9000 }), 'utf8');

  const config = loadConfig(configPath);
  assert.equal(config.port, 9000);
  assert.equal(config.host, DEFAULTS.host);
  assert.equal(config.cookieTTL, DEFAULTS.cookieTTL);
  assert.deepEqual(config.repos, DEFAULTS.repos);
  assert.deepEqual(config.claudeArgs, DEFAULTS.claudeArgs);
  assert.equal(config.defaultFramework, DEFAULTS.defaultFramework);
});

test('loadConfig throws if config file not found', () => {
  const configPath = path.join(tmpDir, 'nonexistent.json');
  assert.throws(() => loadConfig(configPath), /Config file not found/);
});

test('saveConfig writes JSON with 2-space indent', () => {
  const configPath = path.join(tmpDir, 'output.json');
  const config = { port: 3456, host: '0.0.0.0' };

  saveConfig(configPath, config as Parameters<typeof saveConfig>[1]);

  const raw = fs.readFileSync(configPath, 'utf8');
  assert.equal(raw, JSON.stringify(config, null, 2));
});

test('DEFAULTS has expected keys and values', () => {
  assert.equal(DEFAULTS.host, '0.0.0.0');
  assert.equal(DEFAULTS.port, 3456);
  assert.equal(DEFAULTS.cookieTTL, '24h');
  assert.deepEqual(DEFAULTS.repos, []);
  assert.deepEqual(DEFAULTS.claudeArgs, []);
  assert.equal(DEFAULTS.defaultFramework, 'claude');
  assert.equal(DEFAULTS.defaultContinue, true);
  assert.equal(DEFAULTS.defaultYolo, false);
  assert.equal(DEFAULTS.launchInTmux, false);
});

test('loadConfig returns correct defaults for defaultContinue, defaultYolo, and launchInTmux', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 3456 }), 'utf8');

  const config = loadConfig(configPath);
  assert.equal(config.defaultContinue, true);
  assert.equal(config.defaultYolo, false);
  assert.equal(config.launchInTmux, false);
});

test('ensureMetaDir creates worktree-meta directory', () => {
  const configPath = path.join(tmpDir, 'config.json');
  ensureMetaDir(configPath);
  const metaPath = path.join(tmpDir, 'worktree-meta');
  assert.ok(fs.existsSync(metaPath));
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
  assert.deepEqual(read, meta);
});

test('readMeta returns null for non-existent metadata', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const result = readMeta(configPath, '/no/such/worktree');
  assert.equal(result, null);
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
  assert.equal(read!.displayName, 'New Name');
  assert.equal(read!.lastActivity, '2026-02-22T00:00:00.000Z');
});

test('deleteMeta removes metadata file', () => {
  const configPath = path.join(tmpDir, 'config.json');
  writeMeta(configPath, {
    worktreePath: '/tmp/del-test',
    displayName: 'To Delete',
    lastActivity: '2026-02-22T00:00:00.000Z',
  });
  assert.ok(readMeta(configPath, '/tmp/del-test'));
  deleteMeta(configPath, '/tmp/del-test');
  assert.equal(readMeta(configPath, '/tmp/del-test'), null);
});

test('deleteMeta is a no-op for non-existent metadata', () => {
  const configPath = path.join(tmpDir, 'config.json');
  assert.doesNotThrow(() => deleteMeta(configPath, '/no/such/path'));
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
  assert.equal(result.agent, 'claude');
  assert.equal(result.yolo, false);
  assert.equal(result.continuePolicy, 'always');
  assert.equal(result.useTmux, false);
  assert.deepEqual(result.claudeArgs, []);
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
  assert.equal(result.agent, 'codex');
  assert.equal(result.yolo, true);
  assert.equal(result.continuePolicy, 'always');
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
  assert.equal(result.yolo, false);
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
  assert.deepEqual(result.claudeArgs, ['--custom']);
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
  assert.equal(result.agent, 'codex');
  assert.equal(result.yolo, true);
  assert.equal(result.continuePolicy, 'never');
  assert.equal(result.useTmux, true);
  assert.deepEqual(result.claudeArgs, ['--verbose']);
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
  assert.equal(config.repoSettings!['/my/repo']!.defaultYolo, undefined);
  assert.equal(config.repoSettings!['/my/repo']!.defaultFramework, undefined);
  assert.equal(config.repoSettings!['/my/repo']!.branchPrefix, 'dy/');
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
  assert.equal(config.repoSettings!['/my/repo'], undefined);
});

test('deleteRepoSettingKeys is no-op for nonexistent workspace', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const config = { ...DEFAULTS };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  assert.doesNotThrow(() =>
    deleteRepoSettingKeys(configPath, config, '/no/such/repo', ['defaultYolo'])
  );
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
  // Workspace settings should override global
  assert.equal(result.yolo, true);
  assert.equal(result.agent, 'codex');
  assert.equal(result.useTmux, true);
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
  assert.equal(result.yolo, false);
  assert.equal(result.agent, 'claude');
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
  assert.equal(result.yolo, false);
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
  assert.equal(result.yolo, false);
  assert.equal(result.agent, 'claude');
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
  assert.equal(result.yolo, false);
  assert.equal(result.agent, 'claude');
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
  assert.equal(resolved.continuePolicy, 'always');
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
  assert.equal(resolved.continuePolicy, 'never');
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
  assert.equal(resolved.continuePolicy, 'never');
});

test('resolveSessionSettings defaults continuePolicy to always when defaultContinue is missing', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', {});
  // defaultContinue defaults to true via DEFAULTS, so maps to 'always'
  assert.equal(resolved.continuePolicy, 'always');
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
  assert.strictEqual(
    result.yolo,
    true,
    'workspace settings should cascade yolo'
  );
  assert.strictEqual(result.agent, 'claude');
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
  assert.strictEqual(
    result.yolo,
    false,
    'repo settings should override workspace'
  );
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
  assert.equal(result.agent, 'opencode');
});
