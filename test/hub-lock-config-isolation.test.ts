import { spawn, type ChildProcess } from 'node:child_process';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hub-lock-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function startSleeper(): ChildProcess {
  // Keep a PID alive so hub.lock "owner pid" checks are meaningful.
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000_000)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

async function collectExit(
  child: ChildProcess,
  timeoutMs = 20_000
): Promise<{ code: number | null; output: string }> {
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`child did not exit within ${timeoutMs}ms; output: ${output}`)
      );
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}

describe('hub.lock config-dir isolation (#1587)', () => {
  if (!fs.existsSync(SERVER_SCRIPT)) {
    throw new Error('dist/server/index.js missing — run npm run build first');
  }

  it('`--help` prints and exits 0 without touching disk (even if a hub.lock exists)', async () => {
    const home = makeTmpDir();
    const configDir = path.join(home, '.config', 'relay-ide');
    fs.mkdirSync(configDir, { recursive: true });

    const owner = startSleeper();
    try {
      const lockPath = path.join(configDir, 'hub.lock');
      fs.writeFileSync(
        lockPath,
        JSON.stringify(
          {
            pid: owner.pid,
            port: 3456,
            host: '127.0.0.1',
            startedAt: new Date().toISOString(),
            hostname: 'test-host',
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ port: 3456 }), 'utf8');

      const child = spawn(process.execPath, [SERVER_SCRIPT, '--help'], {
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, '.config'),
          RELAY_IDE_CONFIG: configPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const { code, output } = await collectExit(child);

      expect(code).toBe(0);
      expect(output).toContain('Usage:');
      expect(fs.existsSync(path.join(configDir, 'channel-chat.db'))).toBe(
        false
      );
      expect(fs.existsSync(path.join(configDir, 'pending-sessions.json'))).toBe(
        false
      );
      expect(fs.readFileSync(lockPath, 'utf8')).toContain(String(owner.pid));
    } finally {
      if (owner.exitCode === null && owner.signalCode === null)
        owner.kill('SIGKILL');
    }
  });

  it('refuses to boot when another live hub owns the config dir', async () => {
    const home = makeTmpDir();
    const configDir = path.join(home, '.config', 'relay-ide');
    fs.mkdirSync(configDir, { recursive: true });

    const owner = startSleeper();
    try {
      fs.writeFileSync(
        path.join(configDir, 'hub.lock'),
        JSON.stringify(
          {
            pid: owner.pid,
            port: 3456,
            host: '127.0.0.1',
            startedAt: new Date().toISOString(),
            hostname: 'test-host',
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ port: 0, host: '127.0.0.1' }),
        'utf8'
      );

      const child = spawn(
        process.execPath,
        [
          SERVER_SCRIPT,
          '--config',
          configPath,
          '--port',
          '0',
          '--host',
          '127.0.0.1',
        ],
        {
          env: { ...process.env, HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      const { code, output } = await collectExit(child);
      expect(code).toBe(1);
      expect(output).toContain('hub.lock');
      expect(output).toContain('owned by a live hub');
      expect(output).toContain('#1587');
      expect(fs.existsSync(path.join(configDir, 'channel-chat.db'))).toBe(
        false
      );
    } finally {
      if (owner.exitCode === null && owner.signalCode === null)
        owner.kill('SIGKILL');
    }
  });
});
