import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const SERVER_SCRIPT = path.resolve(
  import.meta.dirname,
  '..',
  'dist',
  'server',
  'index.js'
);

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-entrypoint-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function collectExit(
  argv: string[],
  env: Record<string, string>
): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [SERVER_SCRIPT, ...argv], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += String(c)));
  child.stderr.on('data', (c) => (output += String(c)));
  const code = await new Promise<number | null>((resolve) =>
    child.on('exit', resolve)
  );
  return { code, output };
}

describe('dist/server entrypoint flags (#1587)', () => {
  if (!fs.existsSync(SERVER_SCRIPT)) {
    throw new Error('dist/server/index.js missing — run npm run build first');
  }

  it('--help prints and exits 0 without touching config', async () => {
    const home = makeTmpDir();
    const xdg = path.join(home, '.config');
    const configPath = path.join(home, 'relay-test-config', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const { code, output } = await collectExit(['--help'], {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      RELAY_IDE_CONFIG: configPath,
    });
    expect(code).toBe(0);
    expect(output).toContain('Usage:');
    expect(fs.existsSync(path.join(home, '.config', 'relay-ide'))).toBe(false);
  });

  it('--version prints and exits 0', async () => {
    const home = makeTmpDir();
    const xdg = path.join(home, '.config');
    const configPath = path.join(home, 'relay-test-config', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const { code, output } = await collectExit(['--version'], {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      RELAY_IDE_CONFIG: configPath,
    });
    expect(code).toBe(0);
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects unknown flags', async () => {
    const home = makeTmpDir();
    const xdg = path.join(home, '.config');
    const configPath = path.join(home, 'relay-test-config', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const { code, output } = await collectExit(['--nope'], {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      RELAY_IDE_CONFIG: configPath,
    });
    expect(code).toBe(1);
    expect(output).toContain('Unknown flag');
  });

  it('rejects unexpected positional arguments', async () => {
    const home = makeTmpDir();
    const xdg = path.join(home, '.config');
    const configPath = path.join(home, 'relay-test-config', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const { code, output } = await collectExit(['foo'], {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      RELAY_IDE_CONFIG: configPath,
    });
    expect(code).toBe(1);
    expect(output).toContain('Unexpected argument');
  });
});
