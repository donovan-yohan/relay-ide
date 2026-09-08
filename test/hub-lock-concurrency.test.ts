import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { execFileSync } from 'node:child_process';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const DIST_HUB_LOCK = path.resolve(
  import.meta.dirname,
  '..',
  'dist',
  'server',
  'hub-lock.js'
);

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hub-lock-conc-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeAll(() => {
  if (fs.existsSync(DIST_HUB_LOCK)) return;
  // This test validates the compiled runtime entrypoint behavior; build it if missing.
  execFileSync('npm', ['run', 'build:server'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: 'inherit',
  });
  if (!fs.existsSync(DIST_HUB_LOCK)) {
    throw new Error('dist/server/hub-lock.js missing — build:server failed');
  }
}, 60_000);

async function collectExit(
  child: ChildProcess,
  timeoutMs = 10_000
): Promise<{ code: number | null; output: string }> {
  let output = '';
  child.stdout?.on('data', (c) => (output += String(c)));
  child.stderr?.on('data', (c) => (output += String(c)));
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`child did not exit within ${timeoutMs}ms; output=${output}`)
      );
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}

describe('hub.lock atomic acquisition (#1587)', () => {
  it('only one concurrent acquire succeeds (wx create)', async () => {
    const configDir = makeTmpDir();
    const moduleUrl = pathToFileURL(DIST_HUB_LOCK).href;

    const code = `
      const configDir = process.env.CONFIG_DIR;
      const moduleUrl = process.env.MODULE_URL;
      const holdMs = Number(process.env.HOLD_MS || '1500');
      const main = async () => {
        const mod = await import(moduleUrl);
        mod.acquireHubLockOrThrow(configDir, { port: 0, host: '127.0.0.1' });
        console.log('acquired');
        setTimeout(() => process.exit(0), holdMs);
      };
      main().catch((err) => {
        console.error(String(err && err.message ? err.message : err));
        process.exit(1);
      });
    `;

    const envBase = {
      ...process.env,
      CONFIG_DIR: configDir,
      MODULE_URL: moduleUrl,
      HOLD_MS: '1500',
    };
    const a = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: envBase,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const b = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: envBase,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const [ra, rb] = await Promise.all([collectExit(a), collectExit(b)]);
    const results = [ra, rb];
    const successes = results.filter((r) => r.code === 0);
    const failures = results.filter((r) => r.code !== 0);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0]!.output).toContain('acquired');
    expect(failures[0]!.output).toContain('hub.lock');
  });

  it('stale-lock clear race: loser refuses naming the live winner', async () => {
    const configDir = makeTmpDir();
    const moduleUrl = pathToFileURL(DIST_HUB_LOCK).href;

    // Plant a stale lock (dead pid) that both racers will try to clear+wx.
    fs.writeFileSync(
      path.join(configDir, 'hub.lock'),
      JSON.stringify(
        {
          pid: 999_999,
          port: 0,
          host: '127.0.0.1',
          startedAt: new Date().toISOString(),
          hostname: os.hostname(),
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const code = `
      const configDir = process.env.CONFIG_DIR;
      const moduleUrl = process.env.MODULE_URL;
      const holdMs = Number(process.env.HOLD_MS || '1500');
      const main = async () => {
        const mod = await import(moduleUrl);
        const owned = mod.acquireHubLockOrThrow(configDir, {
          port: 0,
          host: '127.0.0.1',
        });
        console.log('acquired pid=' + owned.pid);
        setTimeout(() => process.exit(0), holdMs);
      };
      main().catch((err) => {
        console.error(String(err && err.message ? err.message : err));
        process.exit(1);
      });
    `;

    const envBase = {
      ...process.env,
      CONFIG_DIR: configDir,
      MODULE_URL: moduleUrl,
      HOLD_MS: '1500',
    };
    const a = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: envBase,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const b = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: envBase,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const [ra, rb] = await Promise.all([collectExit(a), collectExit(b)]);
    const successes = [ra, rb].filter((r) => r.code === 0);
    const failures = [ra, rb].filter((r) => r.code !== 0);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0]!.output).toMatch(/acquired pid=\d+/);
    const winnerPid = successes[0]!.output.match(/acquired pid=(\d+)/)?.[1];
    expect(winnerPid).toBeTruthy();
    expect(failures[0]!.output).toContain('hub.lock');
    expect(failures[0]!.output).toContain(`pid=${winnerPid}`);
  });
});
