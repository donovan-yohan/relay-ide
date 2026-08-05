import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONFIG_PATH_ENV_VAR,
  E2E_FIXTURE_ENV_VAR,
  findFixtureConfigIsolationViolation,
  relayAppDataDir,
  sharedConfigRoots,
} from '../server/runtime-state-paths.js';
import {
  createIsolatedE2eConfigPath,
  e2eWebServerEnv,
  resolveE2eConfigPath,
} from './e2e/isolated-config.js';

/**
 * #1214: the Playwright fixture web-server booted with no `RELAY_IDE_CONFIG`,
 * so it resolved the *shared* config root a deployed hub owns on the same host.
 * The deploy's PIN then failed every smoke test, and the fixture run wrote its
 * sessions and SQLite back over the hub's state. The rule these tests hold: in
 * fixture mode there is no default — an explicit run-scoped path outside every
 * shared root, or no boot.
 */

const SERVER_SCRIPT = path.resolve(
  import.meta.dirname,
  '..',
  'dist',
  'server',
  'index.js'
);

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-isolation-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('findFixtureConfigIsolationViolation (#1214)', () => {
  const home = '/home/operator';

  it('refuses fixture mode with no explicit config instead of defaulting', () => {
    const violation = findFixtureConfigIsolationViolation({
      explicitConfigPath: undefined,
      env: {},
      homedir: home,
    });
    expect(violation).toContain(CONFIG_PATH_ENV_VAR);
    expect(violation).toContain(path.join(home, '.config', 'relay-ide'));
    expect(violation).toContain('#1214');
  });

  it('treats a blank config value as unset', () => {
    expect(
      findFixtureConfigIsolationViolation({
        explicitConfigPath: '   ',
        env: {},
        homedir: home,
      })
    ).toContain('requires an explicit isolated');
  });

  it('refuses the deployed hub config file itself', () => {
    expect(
      findFixtureConfigIsolationViolation({
        explicitConfigPath: path.join(home, '.config', 'relay-ide', 'config.json'),
        env: {},
        homedir: home,
      })
    ).toContain('inside the shared Relay config root');
  });

  it('refuses per-checkout subtrees under the shared root, not just its config file', () => {
    // `npm run start` from a checkout resolves here (#961). It is still shared
    // state: a previous fixture run's PIN lives in it just as a deploy's does.
    expect(
      findFixtureConfigIsolationViolation({
        explicitConfigPath: path.join(
          home,
          '.config',
          'relay-ide',
          'source',
          'relay-ide-abc123',
          'config.json'
        ),
        env: {},
        homedir: home,
      })
    ).toContain('inside the shared Relay config root');
  });

  it('refuses the XDG root and the hardcoded ~/.config root, since the two disagree', () => {
    // relayAppDataDir honors XDG; server/service.ts hardcodes ~/.config. With
    // XDG set, checking only one root leaves the installed hub reachable.
    const env = { XDG_CONFIG_HOME: '/xdg' };
    expect(sharedConfigRoots(env, home)).toEqual([
      path.join('/xdg', 'relay-ide'),
      path.join(home, '.config', 'relay-ide'),
    ]);
    expect(
      findFixtureConfigIsolationViolation({
        explicitConfigPath: path.join('/xdg', 'relay-ide', 'config.json'),
        env,
        homedir: home,
      })
    ).toContain(path.join('/xdg', 'relay-ide'));
    expect(
      findFixtureConfigIsolationViolation({
        explicitConfigPath: path.join(home, '.config', 'relay-ide', 'config.json'),
        env,
        homedir: home,
      })
    ).toContain(path.join(home, '.config', 'relay-ide'));
  });

  it('refuses a relative path, which would resolve against the launching cwd', () => {
    expect(
      findFixtureConfigIsolationViolation({
        explicitConfigPath: 'config.json',
        env: {},
        homedir: home,
      })
    ).toContain('absolute');
  });

  it('accepts a run-scoped path outside every shared root', () => {
    expect(
      findFixtureConfigIsolationViolation({
        explicitConfigPath: '/tmp/relay-ide-e2e-xyz/config.json',
        env: {},
        homedir: home,
      })
    ).toBeNull();
  });

  it('is not fooled by a sibling directory that shares a name prefix', () => {
    expect(
      findFixtureConfigIsolationViolation({
        explicitConfigPath: path.join(home, '.config', 'relay-ide-e2e', 'config.json'),
        env: {},
        homedir: home,
      })
    ).toBeNull();
  });
});

describe('e2e harness config resolution (#1214)', () => {
  it('mints a fresh temp config dir per run', () => {
    const tmpRoot = makeTmpDir();
    const first = createIsolatedE2eConfigPath({}, tmpRoot);
    const second = createIsolatedE2eConfigPath({}, tmpRoot);

    expect(path.dirname(first)).not.toBe(path.dirname(second));
    for (const configPath of [first, second]) {
      expect(fs.existsSync(path.dirname(configPath))).toBe(true);
      expect(path.basename(configPath)).toBe('config.json');
      expect(configPath.startsWith(tmpRoot)).toBe(true);
      expect(
        configPath.startsWith(relayAppDataDir(process.env, os.homedir()))
      ).toBe(false);
    }
  });

  it('resolves to an isolated path when nothing is inherited', () => {
    const tmpRoot = makeTmpDir();
    const resolved = resolveE2eConfigPath({}, tmpRoot);
    expect(resolved.startsWith(tmpRoot)).toBe(true);
    expect(
      findFixtureConfigIsolationViolation({ explicitConfigPath: resolved })
    ).toBeNull();
  });

  it('hard-fails on an inherited RELAY_IDE_CONFIG pointing at the shared root', () => {
    const shared = path.join(
      relayAppDataDir(process.env, os.homedir()),
      'config.json'
    );
    expect(() =>
      resolveE2eConfigPath({ [CONFIG_PATH_ENV_VAR]: shared })
    ).toThrow(/shared Relay config root/);
  });

  it('honors an inherited RELAY_IDE_CONFIG that is already isolated', () => {
    const tmpRoot = makeTmpDir();
    const configPath = path.join(tmpRoot, 'config.json');
    expect(resolveE2eConfigPath({ [CONFIG_PATH_ENV_VAR]: configPath })).toBe(
      configPath
    );
  });

  it('builds a web-server env that pins fixture mode, port, and the isolated config', () => {
    const tmpRoot = makeTmpDir();
    const configPath = path.join(tmpRoot, 'config.json');
    expect(e2eWebServerEnv({ port: 3466, configPath, env: {} })).toEqual({
      [E2E_FIXTURE_ENV_VAR]: '1',
      RELAY_IDE_PORT: '3466',
      [CONFIG_PATH_ENV_VAR]: configPath,
    });
  });

  it('refuses to build a web-server env around a shared config path', () => {
    const shared = path.join(
      relayAppDataDir(process.env, os.homedir()),
      'source',
      'checkout-abc',
      'config.json'
    );
    expect(() => e2eWebServerEnv({ port: 3466, configPath: shared })).toThrow(
      /#1214/
    );
  });
});

// The unit tests above prove the rule; these prove the built server actually
// enforces it, which is the only thing that stops a hand-rolled fixture boot
// (or a future harness change) from reaching the deployed hub's config.
describe('fixture-mode server boot (#1214)', () => {
  if (!fs.existsSync(SERVER_SCRIPT)) {
    throw new Error('dist/server/index.js missing — run npm run build first');
  }

  const children: ChildProcess[] = [];

  afterEach(async () => {
    while (children.length > 0) {
      const child = children.pop();
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        continue;
      }
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 10_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  });

  function startFixtureServer(
    overrides: Record<string, string>,
    home: string
  ): ChildProcess {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      RELAY_IDE_PORT: '0',
      [E2E_FIXTURE_ENV_VAR]: '1',
    };
    // The suite's own shell may export these; the fixture boot must be judged
    // on what the harness passes, not on the developer's environment.
    delete env[CONFIG_PATH_ENV_VAR];
    delete env['XDG_CONFIG_HOME'];
    Object.assign(env, overrides);
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    return child;
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
          new Error(
            `fixture server did not exit within ${timeoutMs}ms; output: ${output}`
          )
        );
      }, timeoutMs);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        resolve({ code, output });
      });
    });
  }

  async function waitForListening(
    child: ChildProcess,
    timeoutMs = 30_000
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        reject(
          new Error(`fixture server never listened; output: ${output}`)
        );
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/listening on [\w.]+:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(
          new Error(`fixture server exited with ${code}; output: ${output}`)
        );
      });
    });
  }

  it('refuses to boot with no explicit config rather than using the shared one', async () => {
    const home = makeTmpDir();
    const child = startFixtureServer({}, home);
    const { code, output } = await collectExit(child);

    expect(code).toBe(1);
    expect(output).toContain(CONFIG_PATH_ENV_VAR);
    expect(output).toContain('#1214');
    // Refused before touching disk: no config dir, no runtime SQLite.
    expect(fs.existsSync(path.join(home, '.config', 'relay-ide'))).toBe(false);
  });

  it('refuses to boot against a config inside the shared root', async () => {
    const home = makeTmpDir();
    const shared = path.join(home, '.config', 'relay-ide');
    fs.mkdirSync(shared, { recursive: true });
    const sharedConfig = path.join(shared, 'config.json');
    fs.writeFileSync(sharedConfig, JSON.stringify({ port: 3456 }), 'utf8');

    const child = startFixtureServer(
      { [CONFIG_PATH_ENV_VAR]: sharedConfig },
      home
    );
    const { code, output } = await collectExit(child);

    expect(code).toBe(1);
    expect(output).toContain('shared Relay config root');
    // The deployed hub's file is untouched — not read into, not written over.
    expect(fs.readFileSync(sharedConfig, 'utf8')).toBe(
      JSON.stringify({ port: 3456 })
    );
    expect(fs.readdirSync(shared)).toEqual(['config.json']);
  });

  it('boots with an isolated config and keeps its runtime state there', async () => {
    const home = makeTmpDir();
    const runDir = path.join(makeTmpDir(), 'relay-ide-e2e-run');
    fs.mkdirSync(runDir, { recursive: true });
    const configPath = path.join(runDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ port: 0, host: '127.0.0.1' }),
      'utf8'
    );

    const child = startFixtureServer(
      { [CONFIG_PATH_ENV_VAR]: configPath },
      home
    );
    await waitForListening(child);

    expect(fs.existsSync(configPath)).toBe(true);
    // Runtime SQLite lives beside the config, so this is where it must land.
    expect(fs.readdirSync(runDir).some((name) => name.endsWith('.db'))).toBe(
      true
    );
    // ...and nowhere near the shared root the harness is refusing to use.
    expect(fs.existsSync(path.join(home, '.config', 'relay-ide'))).toBe(false);
  }, 45_000);
});
