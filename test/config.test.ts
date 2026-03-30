import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULTS, loadConfig, saveConfig, ensureMetaDir, readMeta, writeMeta, deleteMeta, resolveSessionSettings, deleteRepoSettingKeys } from '../server/config.js';

let tmpDir!: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-cli-config-test-'));
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
  assert.equal(config.claudeCommand, DEFAULTS.claudeCommand);
  assert.deepEqual(config.claudeArgs, DEFAULTS.claudeArgs);
  assert.equal(config.defaultAgent, DEFAULTS.defaultAgent);
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
  assert.equal(DEFAULTS.claudeCommand, 'claude');
  assert.deepEqual(DEFAULTS.claudeArgs, []);
  assert.equal(DEFAULTS.defaultAgent, 'claude');
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
  const meta = { worktreePath: '/tmp/test-worktree', displayName: 'My Feature', lastActivity: '2026-02-22T00:00:00.000Z' };
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
  writeMeta(configPath, { worktreePath: '/tmp/wt', displayName: 'Old Name', lastActivity: '2026-01-01T00:00:00.000Z' });
  writeMeta(configPath, { worktreePath: '/tmp/wt', displayName: 'New Name', lastActivity: '2026-02-22T00:00:00.000Z' });
  const read = readMeta(configPath, '/tmp/wt');
  assert.equal(read!.displayName, 'New Name');
  assert.equal(read!.lastActivity, '2026-02-22T00:00:00.000Z');
});

test('deleteMeta removes metadata file', () => {
  const configPath = path.join(tmpDir, 'config.json');
  writeMeta(configPath, { worktreePath: '/tmp/del-test', displayName: 'To Delete', lastActivity: '2026-02-22T00:00:00.000Z' });
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
  fs.writeFileSync(configPath, JSON.stringify({
    defaultAgent: 'claude',
    defaultContinue: true,
    defaultYolo: false,
    launchInTmux: false,
    claudeArgs: [],
  }), 'utf8');
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
  fs.writeFileSync(configPath, JSON.stringify({
    defaultAgent: 'claude',
    defaultYolo: false,
    defaultContinue: true,
    launchInTmux: false,
    claudeArgs: [],
    repoSettings: {
      '/my/repo': { defaultYolo: true, defaultAgent: 'codex' },
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', {});
  assert.equal(result.agent, 'codex');
  assert.equal(result.yolo, true);
  assert.equal(result.continuePolicy, 'always');
});

test('resolveSessionSettings explicit overrides beat workspace settings', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    defaultAgent: 'claude',
    defaultYolo: true,
    defaultContinue: true,
    launchInTmux: false,
    claudeArgs: [],
    repoSettings: {
      '/my/repo': { defaultYolo: true },
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', { yolo: false });
  assert.equal(result.yolo, false);
});

test('resolveSessionSettings uses override claudeArgs, not global', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    defaultAgent: 'claude',
    defaultYolo: false,
    defaultContinue: true,
    launchInTmux: false,
    claudeArgs: ['--global-arg'],
  }), 'utf8');
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/some/repo', { claudeArgs: ['--custom'] });
  assert.deepEqual(result.claudeArgs, ['--custom']);
});

test('resolveSessionSettings falls through to globals when no workspace exists', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    defaultAgent: 'codex',
    defaultYolo: true,
    defaultContinue: false,
    launchInTmux: true,
    claudeArgs: ['--verbose'],
  }), 'utf8');
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
      '/my/repo': { defaultYolo: true, defaultAgent: 'codex' as const, branchPrefix: 'dy/' },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  deleteRepoSettingKeys(configPath, config, '/my/repo', ['defaultYolo', 'defaultAgent']);
  assert.equal(config.repoSettings!['/my/repo']!.defaultYolo, undefined);
  assert.equal(config.repoSettings!['/my/repo']!.defaultAgent, undefined);
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
  assert.doesNotThrow(() => deleteRepoSettingKeys(configPath, config, '/no/such/repo', ['defaultYolo']));
});

test('workspaceGroups with valid paths loads cleanly', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaces: ['/a/repo', '/b/repo'],
    workspaceGroups: {
      'Group A': ['/a/repo'],
      'Group B': ['/b/repo'],
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.workspaceGroups, undefined);
  const workspaces = config.workspaces as any[];
  const groupA = workspaces?.find((w: any) => w.name === 'Group A');
  const groupB = workspaces?.find((w: any) => w.name === 'Group B');
  assert.deepEqual(groupA?.repos, ['/a/repo']);
  assert.deepEqual(groupB?.repos, ['/b/repo']);
});

test('workspaceGroups with invalid path filters it out', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaces: ['/valid/repo'],
    workspaceGroups: {
      'My Group': ['/valid/repo', '/not/in/workspaces'],
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.workspaceGroups, undefined);
  const myGroup = (config.workspaces as any[])?.find((w: any) => w.name === 'My Group');
  assert.deepEqual(myGroup?.repos, ['/valid/repo']);
});

test('workspaceGroups with duplicate path allows many-to-many', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaces: ['/shared/repo'],
    workspaceGroups: {
      'First': ['/shared/repo'],
      'Second': ['/shared/repo'],
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.workspaceGroups, undefined);
  const workspaces = config.workspaces as any[];
  const first = workspaces?.find((w: any) => w.name === 'First');
  const second = workspaces?.find((w: any) => w.name === 'Second');
  // Many-to-many: both groups can contain the same repo
  assert.deepEqual(first?.repos, ['/shared/repo']);
  assert.deepEqual(second?.repos, ['/shared/repo']);
});

test('workspaceGroups undefined produces no errors', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaces: ['/some/repo'],
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.workspaceGroups, undefined);
  assert.deepEqual(config.workspaces as any[], []);
});

test('workspaceGroups with all-invalid paths removes empty group', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaces: ['/valid/repo'],
    workspaceGroups: {
      'Ghost Group': ['/not/here', '/also/not/here'],
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.workspaceGroups, undefined);
  const workspaces = config.workspaces as any[];
  assert.ok(!workspaces?.find((w: any) => w.name === 'Ghost Group'));
});

// ── Config v4 migration ──

test('migrateToV4: sets configVersion to 4', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ repos: ['/a'] }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.configVersion, 4);
});

test('migrateToV4: already v4 config is unchanged', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const v4Config = {
    configVersion: 4,
    repos: ['/a', '/b'],
    repoSettings: { '/a': { defaultYolo: true } },
    workspaces: [{ id: 'ws-1', name: 'My App', repos: ['/a', '/b'], order: 0 }],
  };
  fs.writeFileSync(configPath, JSON.stringify(v4Config), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.configVersion, 4);
  assert.deepEqual(config.repos, ['/a', '/b']);
  assert.ok(config.repoSettings?.['/a']?.defaultYolo);
  assert.equal((config.workspaces as any[])?.length, 1);
  assert.equal((config.workspaces as any[])?.[0]?.name, 'My App');
});

test('migrateToV4: reconciles legacy workspaces string[] into repos', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaces: ['/old/repo1', '/old/repo2'],
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.configVersion, 4);
  assert.ok(config.repos.includes('/old/repo1'));
  assert.ok(config.repos.includes('/old/repo2'));
});

test('migrateToV4: merges workspaces and repos arrays with dedup', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: ['/a', '/b'],
    workspaces: ['/b', '/c'],
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.deepEqual(config.repos, ['/a', '/b', '/c']);
});

test('migrateToV4: renames workspaceSettings to repoSettings', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: ['/my/repo'],
    workspaceSettings: { '/my/repo': { defaultYolo: true, branchPrefix: 'dy/' } },
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.ok(config.repoSettings?.['/my/repo']?.defaultYolo);
  assert.equal(config.repoSettings?.['/my/repo']?.branchPrefix, 'dy/');
  assert.equal(config.workspaceSettings, undefined);
});

test('migrateToV4: promotes workspaceGroups to Workspace entities', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: ['/frontend', '/backend', '/shared'],
    workspaceGroups: {
      'My App': ['/frontend', '/backend'],
      'Infra': ['/shared'],
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  const workspaces = config.workspaces as any[];
  assert.equal(workspaces?.length, 2);
  const myApp = workspaces?.find((w: any) => w.name === 'My App');
  assert.ok(myApp);
  assert.ok(myApp.id);
  assert.deepEqual(myApp.repos, ['/frontend', '/backend']);
  assert.equal(myApp.order, 0);
  const infra = workspaces?.find((w: any) => w.name === 'Infra');
  assert.ok(infra);
  assert.deepEqual(infra.repos, ['/shared']);
  assert.equal(infra.order, 1);
  assert.equal(config.workspaceGroups, undefined);
});

test('migrateToV4: workspaceGroups promotion validates against repos[]', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: ['/valid'],
    workspaceGroups: {
      'Mixed': ['/valid', '/not-in-repos'],
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  const mixed = (config.workspaces as any[])?.find((w: any) => w.name === 'Mixed');
  assert.ok(mixed);
  assert.deepEqual(mixed.repos, ['/valid']);
});

// ── resolveSessionSettings workspace cascade ──

test('resolveSessionSettings with workspaceId applies workspace settings between global and repo', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const wsId = 'ws-cascade-1';
  fs.writeFileSync(configPath, JSON.stringify({
    configVersion: 4,
    defaultAgent: 'claude',
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
        settings: { defaultYolo: true, defaultAgent: 'codex', launchInTmux: true },
      },
    ],
  }), 'utf8');
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
  fs.writeFileSync(configPath, JSON.stringify({
    configVersion: 4,
    defaultAgent: 'claude',
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
        settings: { defaultYolo: true, defaultAgent: 'codex' },
      },
    ],
    repoSettings: {
      '/my/repo': { defaultYolo: false, defaultAgent: 'claude' },
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', {}, wsId);
  // Repo settings beat workspace settings
  assert.equal(result.yolo, false);
  assert.equal(result.agent, 'claude');
});

test('resolveSessionSettings: overrides beat workspace and repo settings', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const wsId = 'ws-cascade-3';
  fs.writeFileSync(configPath, JSON.stringify({
    configVersion: 4,
    defaultAgent: 'claude',
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
  }), 'utf8');
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', { yolo: false }, wsId);
  assert.equal(result.yolo, false);
});

test('resolveSessionSettings without workspaceId skips workspace cascade', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    configVersion: 4,
    defaultAgent: 'claude',
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
        settings: { defaultYolo: true, defaultAgent: 'codex' },
      },
    ],
  }), 'utf8');
  const config = loadConfig(configPath);
  // No workspaceId passed — workspace settings should NOT apply
  const result = resolveSessionSettings(config, '/my/repo', {});
  assert.equal(result.yolo, false);
  assert.equal(result.agent, 'claude');
});

test('resolveSessionSettings with unknown workspaceId falls through to global', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    configVersion: 4,
    defaultAgent: 'claude',
    defaultYolo: false,
    defaultContinue: true,
    launchInTmux: false,
    claudeArgs: [],
    repos: ['/my/repo'],
    workspaces: [],
  }), 'utf8');
  const config = loadConfig(configPath);
  const result = resolveSessionSettings(config, '/my/repo', {}, 'no-such-workspace');
  assert.equal(result.yolo, false);
  assert.equal(result.agent, 'claude');
});

test('migrateToV4: empty config gets configVersion 4', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.configVersion, 4);
});

test('migrateToV4: persists migrated config to disk', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: ['/a'],
    workspaceSettings: { '/a': { defaultYolo: true } },
    workspaceGroups: { 'G': ['/a'] },
  }), 'utf8');
  loadConfig(configPath);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(raw.configVersion, 4);
  assert.ok(raw.repoSettings);
  assert.equal(raw.workspaceSettings, undefined);
  assert.equal(raw.workspaceGroups, undefined);
});

test('resolveSessionSettings maps defaultContinue:true to continuePolicy:always', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ defaultContinue: true }), 'utf8');
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', {});
  assert.equal(resolved.continuePolicy, 'always');
});

test('resolveSessionSettings maps defaultContinue:false to continuePolicy:never', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ defaultContinue: false }), 'utf8');
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', {});
  assert.equal(resolved.continuePolicy, 'never');
});

test('resolveSessionSettings respects explicit continuePolicy override', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ defaultContinue: true }), 'utf8');
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', { continuePolicy: 'never' });
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
