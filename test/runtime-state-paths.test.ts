import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  pathHash,
  relayAppDataDir,
  resolveSourceLaunchConfigPath,
  safePathSlug,
} from '../server/runtime-state-paths.js';

let tmpDir: string | null = null;

function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-state-test-'));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('relayAppDataDir', () => {
  it('prefers XDG_CONFIG_HOME when set', () => {
    expect(
      relayAppDataDir({ XDG_CONFIG_HOME: '/xdg/cfg' }, '/home/user')
    ).toBe(path.join('/xdg/cfg', 'relay-ide'));
  });

  it('falls back to ~/.config when XDG is unset or blank', () => {
    expect(relayAppDataDir({}, '/home/user')).toBe(
      path.join('/home/user', '.config', 'relay-ide')
    );
    expect(relayAppDataDir({ XDG_CONFIG_HOME: '   ' }, '/home/user')).toBe(
      path.join('/home/user', '.config', 'relay-ide')
    );
  });

  it('ignores a relative XDG_CONFIG_HOME (XDG spec; would resolve into cwd) and stays absolute', () => {
    // A relative value must not anchor runtime DBs to process.cwd() (= the
    // checkout for a from-source launch). Mirrors session-attachment.ts (#472).
    const dir = relayAppDataDir({ XDG_CONFIG_HOME: 'relaydata' }, '/home/user');
    expect(dir).toBe(path.join('/home/user', '.config', 'relay-ide'));
    expect(path.isAbsolute(dir)).toBe(true);
    expect(
      relayAppDataDir({ XDG_CONFIG_HOME: '.config' }, '/home/user')
    ).toBe(path.join('/home/user', '.config', 'relay-ide'));
  });
});

describe('safePathSlug / pathHash', () => {
  it('produces a filesystem-safe slug from the basename', () => {
    expect(safePathSlug('/repo/.worktrees/Feat Branch!')).toBe('feat-branch');
    expect(safePathSlug('/')).toBe('workspace');
  });

  it('hashes the absolute path stably to 12 hex chars', () => {
    const a = pathHash('/repo/.worktrees/feature-a');
    expect(a).toMatch(/^[a-f0-9]{12}$/);
    expect(pathHash('/repo/.worktrees/feature-a')).toBe(a);
    expect(pathHash('/repo/.worktrees/feature-b')).not.toBe(a);
  });
});

describe('resolveSourceLaunchConfigPath', () => {
  it('places the config under app-data, never inside the checkout', () => {
    const home = makeTmpDir();
    const xdg = path.join(home, '.config');
    const checkout = path.join(home, 'src', 'relay-ide');
    fs.mkdirSync(checkout, { recursive: true });

    const { configPath, legacyConfigPath } = resolveSourceLaunchConfigPath(
      checkout,
      { fileName: 'config.dev.json', namespace: 'dev', env: { XDG_CONFIG_HOME: xdg }, homedir: home }
    );

    expect(configPath.startsWith(path.join(xdg, 'relay-ide', 'dev'))).toBe(true);
    expect(configPath.endsWith('config.dev.json')).toBe(true);
    expect(configPath.startsWith(checkout)).toBe(false);
    // No legacy file present → nothing to migrate.
    expect(legacyConfigPath).toBeNull();
  });

  it('gives each checkout a stable, distinct app-data directory', () => {
    const home = makeTmpDir();
    const env = { XDG_CONFIG_HOME: path.join(home, '.config') };
    const wtA = path.join(home, 'repo', '.worktrees', 'feature-a');
    const wtB = path.join(home, 'repo', '.worktrees', 'feature-b');

    const a1 = resolveSourceLaunchConfigPath(wtA, { fileName: 'config.dev.json', namespace: 'dev', env, homedir: home });
    const a2 = resolveSourceLaunchConfigPath(wtA, { fileName: 'config.dev.json', namespace: 'dev', env, homedir: home });
    const b = resolveSourceLaunchConfigPath(wtB, { fileName: 'config.dev.json', namespace: 'dev', env, homedir: home });

    expect(a1.configPath).toBe(a2.configPath); // stable per checkout
    expect(a1.configPath).not.toBe(b.configPath); // distinct per checkout
  });

  it('surfaces an existing in-repo config as legacy without honoring it', () => {
    const home = makeTmpDir();
    const xdg = path.join(home, '.config');
    const checkout = path.join(home, 'src', 'relay-ide');
    fs.mkdirSync(checkout, { recursive: true });
    const legacy = path.join(checkout, 'config.dev.json');
    fs.writeFileSync(legacy, '{}', 'utf8');

    const { configPath, legacyConfigPath } = resolveSourceLaunchConfigPath(
      checkout,
      { fileName: 'config.dev.json', namespace: 'dev', env: { XDG_CONFIG_HOME: xdg }, homedir: home }
    );

    // Default still moves out of the checkout; legacy file is reported, not used.
    expect(configPath.startsWith(checkout)).toBe(false);
    expect(legacyConfigPath).toBe(legacy);
  });

  it('namespaces launch modes (dev vs source) into separate subtrees', () => {
    const home = makeTmpDir();
    const env = { XDG_CONFIG_HOME: path.join(home, '.config') };
    const checkout = path.join(home, 'src', 'relay-ide');

    const dev = resolveSourceLaunchConfigPath(checkout, { fileName: 'config.dev.json', namespace: 'dev', env, homedir: home });
    const source = resolveSourceLaunchConfigPath(checkout, { fileName: 'config.json', namespace: 'source', env, homedir: home });

    expect(dev.configPath).toContain(path.join('relay-ide', 'dev'));
    expect(source.configPath).toContain(path.join('relay-ide', 'source'));
    expect(dev.configPath).not.toBe(source.configPath);
  });
});
