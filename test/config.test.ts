import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULTS, loadConfig, saveConfig, ensureMetaDir, readMeta, writeMeta, deleteMeta, resolveSessionSettings, deleteWorkspaceSettingKeys } from '../server/config.js';

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
    workspaceSettings: {
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
    workspaceSettings: {
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

test('deleteWorkspaceSettingKeys removes specified keys', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const config = {
    ...DEFAULTS,
    workspaceSettings: {
      '/my/repo': { defaultYolo: true, defaultAgent: 'codex' as const, branchPrefix: 'dy/' },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  deleteWorkspaceSettingKeys(configPath, config, '/my/repo', ['defaultYolo', 'defaultAgent']);
  assert.equal(config.workspaceSettings!['/my/repo']!.defaultYolo, undefined);
  assert.equal(config.workspaceSettings!['/my/repo']!.defaultAgent, undefined);
  assert.equal(config.workspaceSettings!['/my/repo']!.branchPrefix, 'dy/');
});

test('deleteWorkspaceSettingKeys removes entire workspace entry when empty', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const config = {
    ...DEFAULTS,
    workspaceSettings: {
      '/my/repo': { defaultYolo: true },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  deleteWorkspaceSettingKeys(configPath, config, '/my/repo', ['defaultYolo']);
  assert.equal(config.workspaceSettings!['/my/repo'], undefined);
});

test('deleteWorkspaceSettingKeys is no-op for nonexistent workspace', () => {
  const configPath = path.join(tmpDir, 'config.json');
  const config = { ...DEFAULTS };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  assert.doesNotThrow(() => deleteWorkspaceSettingKeys(configPath, config, '/no/such/repo', ['defaultYolo']));
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
  assert.deepEqual(config.workspaceGroups!['Group A'], ['/a/repo']);
  assert.deepEqual(config.workspaceGroups!['Group B'], ['/b/repo']);
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
  assert.deepEqual(config.workspaceGroups!['My Group'], ['/valid/repo']);
});

test('workspaceGroups with duplicate path keeps first-group winner', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaces: ['/shared/repo'],
    workspaceGroups: {
      'First': ['/shared/repo'],
      'Second': ['/shared/repo'],
    },
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.deepEqual(config.workspaceGroups!['First'], ['/shared/repo']);
  assert.equal(config.workspaceGroups!['Second'], undefined);
});

test('workspaceGroups undefined produces no errors', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaces: ['/some/repo'],
  }), 'utf8');
  const config = loadConfig(configPath);
  assert.equal(config.workspaceGroups, undefined);
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
  assert.equal(config.workspaceGroups!['Ghost Group'], undefined);
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
