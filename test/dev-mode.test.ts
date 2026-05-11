import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveDevModeOptions,
  resolveSelfHostConfigPath,
  SELF_HOST_PORT_VARIABLES,
} from '../scripts/dev-mode.js';
import {
  parseEnvBlock,
  resolvePortAssignmentsPath,
} from '../server/port-allocator.js';

let tmpDir: string | null = null;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dev-mode-test-'));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
});

describe('dev mode option resolution', () => {
  it('keeps ordinary dev mode on fixed dev defaults with repo-local dev config', async () => {
    const packageRoot = makeTmpDir();

    const options = await resolveDevModeOptions({
      argv: ['dev'],
      env: {},
      packageRoot,
      homedir: packageRoot,
    });

    expect(options.selfHost).toBe(false);
    expect(options.backendPort).toBe('3457');
    expect(options.frontendPort).toBe('5173');
    expect(options.configPath).toBe(path.join(packageRoot, 'config.dev.json'));
    expect(options.tmuxPrefix).toBe('relay-dev-');
    expect(options.portMapping).toBeNull();
  });

  it('resolves self-host config outside the repo and gives each worktree a stable identity', () => {
    const home = makeTmpDir();
    const packageRoot = path.join(home, 'src', 'relay-ide', '.worktrees', 'feature-a');
    fs.mkdirSync(packageRoot, { recursive: true });

    const configPath = resolveSelfHostConfigPath(packageRoot, {
      env: { XDG_CONFIG_HOME: path.join(home, '.config') },
      homedir: home,
    });

    expect(
      configPath.startsWith(path.join(home, '.config', 'relay-ide', 'self-host'))
    ).toBe(true);
    expect(configPath).toMatch(/feature-a-[a-f0-9]{12}\/config\.json$/);
    expect(configPath.startsWith(packageRoot)).toBe(false);
  });

  it('self-host mode allocates backend/frontend ports, writes only the managed .env block, and uses an isolated tmux prefix', async () => {
    const home = makeTmpDir();
    const xdgConfigHome = path.join(home, '.config');
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    const packageRoot = path.join(home, 'repo', '.worktrees', 'self-host');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, '.env'), 'EXISTING=value\n', 'utf8');

    const options = await resolveDevModeOptions({
      argv: ['dev', '--self-host'],
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      packageRoot,
      homedir: home,
    });

    expect(options.selfHost).toBe(true);
    expect(options.tmuxPrefix).toBe('relay-self-');
    expect(options.portMapping).toEqual(
      expect.objectContaining({
        RELAY_IDE_DEV_BACKEND_PORT: expect.any(Number),
        RELAY_IDE_DEV_FRONTEND_PORT: expect.any(Number),
      })
    );
    expect(SELF_HOST_PORT_VARIABLES).toEqual([
      'RELAY_IDE_DEV_BACKEND_PORT',
      'RELAY_IDE_DEV_FRONTEND_PORT',
    ]);
    expect(options.backendPort).toBe(
      String(options.portMapping?.RELAY_IDE_DEV_BACKEND_PORT)
    );
    expect(options.frontendPort).toBe(
      String(options.portMapping?.RELAY_IDE_DEV_FRONTEND_PORT)
    );
    expect(options.configPath.startsWith(packageRoot)).toBe(false);
    const assignmentsPath = resolvePortAssignmentsPath(options.configPath);
    expect(assignmentsPath.startsWith(xdgConfigHome)).toBe(true);
    expect(fs.existsSync(assignmentsPath)).toBe(true);

    const envContent = fs.readFileSync(path.join(packageRoot, '.env'), 'utf8');
    expect(envContent).toContain('EXISTING=value');
    expect(parseEnvBlock(envContent)).toEqual(options.portMapping);
  });

  it('self-host mode ignores inherited production config and port env', async () => {
    const home = makeTmpDir();
    const xdgConfigHome = path.join(home, '.config');
    const packageRoot = path.join(home, 'repo', '.worktrees', 'feature');
    const globalConfigPath = path.join(home, 'global-config.json');
    fs.mkdirSync(packageRoot, { recursive: true });

    const options = await resolveDevModeOptions({
      argv: ['dev', '--self-host'],
      env: {
        XDG_CONFIG_HOME: xdgConfigHome,
        RELAY_IDE_CONFIG: globalConfigPath,
        RELAY_IDE_PORT: '3456',
      },
      packageRoot,
      homedir: home,
    });

    expect(options.selfHost).toBe(true);
    expect(options.configPath).not.toBe(globalConfigPath);
    expect(options.configPath.startsWith(packageRoot)).toBe(false);
    expect(
      options.configPath.startsWith(
        path.join(xdgConfigHome, 'relay-ide', 'self-host')
      )
    ).toBe(true);
    expect(fs.existsSync(globalConfigPath)).toBe(false);
    expect(options.backendPort).not.toBe('3456');
    expect(options.backendPort).toBe(
      String(options.portMapping?.RELAY_IDE_DEV_BACKEND_PORT)
    );

    const envContent = fs.readFileSync(path.join(packageRoot, '.env'), 'utf8');
    expect(parseEnvBlock(envContent)).toEqual(options.portMapping);
    expect(envContent).not.toContain('RELAY_IDE_DEV_BACKEND_PORT=3456');
  });

  it('self-host mode treats invalid port overrides as unset and falls back to allocator ports', async () => {
    const home = makeTmpDir();
    const xdgConfigHome = path.join(home, '.config');
    const packageRoot = path.join(home, 'repo', '.worktrees', 'invalid-ports');
    fs.mkdirSync(packageRoot, { recursive: true });

    const options = await resolveDevModeOptions({
      argv: ['dev', '--self-host'],
      env: {
        XDG_CONFIG_HOME: xdgConfigHome,
        RELAY_IDE_DEV_BACKEND_PORT: 'definitely-not-a-port',
        RELAY_IDE_DEV_FRONTEND_PORT: '70000',
      },
      packageRoot,
      homedir: home,
    });

    expect(options.backendPort).toBe(
      String(options.portMapping?.RELAY_IDE_DEV_BACKEND_PORT)
    );
    expect(options.frontendPort).toBe(
      String(options.portMapping?.RELAY_IDE_DEV_FRONTEND_PORT)
    );
    expect(options.backendPort).not.toBe('3457');
    expect(options.frontendPort).not.toBe('5173');
  });

  it('self-host mode still honors explicit dev overrides', async () => {
    const home = makeTmpDir();
    const xdgConfigHome = path.join(home, '.config');
    const packageRoot = path.join(home, 'repo', '.worktrees', 'explicit');
    const explicitConfigPath = path.join(home, 'explicit-self-host.json');
    fs.mkdirSync(packageRoot, { recursive: true });

    const options = await resolveDevModeOptions({
      argv: [
        'dev',
        '--self-host',
        '--config',
        explicitConfigPath,
        '--port',
        '4567',
      ],
      env: {
        XDG_CONFIG_HOME: xdgConfigHome,
        RELAY_IDE_CONFIG: path.join(home, 'global-config.json'),
        RELAY_IDE_PORT: '3456',
        RELAY_IDE_DEV_FRONTEND_PORT: '5678',
        RELAY_IDE_TMUX_PREFIX: ' Custom Prefix ',
      },
      packageRoot,
      homedir: home,
    });

    expect(options.configPath).toBe(explicitConfigPath);
    expect(options.backendPort).toBe('4567');
    expect(options.frontendPort).toBe('5678');
    expect(options.tmuxPrefix).toBe('custom-prefix-');
    expect(options.portMapping).toEqual({
      RELAY_IDE_DEV_BACKEND_PORT: 4567,
      RELAY_IDE_DEV_FRONTEND_PORT: 5678,
    });
  });
});
