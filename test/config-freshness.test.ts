import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, DEFAULTS } from '../server/config.js';
import type { Config } from '../server/types.js';

describe('config freshness', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-config-test-'));
    configPath = path.join(tmpDir, 'config.json');
    const initial: Config = { ...DEFAULTS } as Config;
    initial.repos = ['/existing/workspace'];
    fs.writeFileSync(configPath, JSON.stringify(initial, null, 2));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadConfig sees repos added to disk after initial load', () => {
    // Simulate: server starts, loads config
    const initial = loadConfig(configPath);
    expect(initial.repos).toEqual(['/existing/workspace']);

    // Simulate: workspace router adds a repo and saves to disk
    const updated = loadConfig(configPath);
    updated.repos = [...(updated.repos ?? []), '/new/workspace'];
    saveConfig(configPath, updated);

    // Simulate: session handler reads config (fresh)
    const fresh = loadConfig(configPath);
    expect(fresh.repos).toContain('/new/workspace');
    expect(fresh.repos).toContain('/existing/workspace');
  });

  it('loadConfig sees repos removed from disk after initial load', () => {
    const initial = loadConfig(configPath);
    expect(initial.repos).toEqual(['/existing/workspace']);

    // Simulate: workspace router removes the repo
    const updated = loadConfig(configPath);
    updated.repos = [];
    saveConfig(configPath, updated);

    // Fresh read should see empty list
    const fresh = loadConfig(configPath);
    expect(fresh.repos).toEqual([]);
  });

  it('loadConfig sees workspace settings changes', () => {
    // Add repo settings to disk
    const config = loadConfig(configPath);
    config.repoSettings = {
      '/existing/workspace': { defaultFramework: 'codex' },
    };
    saveConfig(configPath, config);

    // Fresh read should see settings
    const fresh = loadConfig(configPath);
    expect(fresh.repoSettings?.['/existing/workspace']?.defaultFramework).toBe(
      'codex'
    );
  });

  it('loadConfig throws when config file is missing', () => {
    fs.unlinkSync(configPath);
    expect(() => loadConfig(configPath)).toThrow(/Config file not found/);
  });

  it('loadConfig throws on corrupted JSON', () => {
    fs.writeFileSync(configPath, '{bad json');
    expect(() => loadConfig(configPath)).toThrow();
  });
});
