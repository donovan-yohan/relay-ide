import { test, expect } from 'vitest';
import type { execSync } from 'node:child_process';
import * as service from '../server/service.js';

function execSucceedsFor(commands: string[]): typeof execSync {
  return ((command: string) => {
    if (commands.includes(command)) return '';
    throw new Error(`unexpected command: ${command}`);
  }) as unknown as typeof execSync;
}

test('getPlatform returns macos or linux', () => {
  const platform = service.getPlatform();
  expect(platform === 'macos' || platform === 'linux').toBeTruthy();
});

test('getServicePaths returns expected keys', () => {
  const paths = service.getServicePaths();
  expect(paths.servicePath).toBeTruthy();
  expect(typeof paths.label).toBe('string');
  expect('logDir' in paths).toBeTruthy();
});

test('generateServiceFile for macos contains plist XML', () => {
  const content = service.generateServiceFile('macos', {
    nodePath: '/usr/local/bin/node',
    scriptPath: '/usr/local/lib/node_modules/relay-ide/bin/relay-ide.js',
    configPath: '/Users/test/.config/relay-ide/config.json',
    port: '3456',
    host: '0.0.0.0',
    logDir: '/Users/test/.config/relay-ide/logs',
  });
  expect(content).toMatch(/<!DOCTYPE plist/);
  expect(content).toMatch(/com\.relay-ide/);
  expect(content).toMatch(/RunAtLoad/);
  expect(content).toMatch(/KeepAlive/);
  expect(content).toMatch(/3456/);
});

test('generateServiceFile for linux contains systemd unit', () => {
  const content = service.generateServiceFile('linux', {
    nodePath: '/usr/bin/node',
    scriptPath: '/usr/lib/node_modules/relay-ide/bin/relay-ide.js',
    configPath: '/home/test/.config/relay-ide/config.json',
    port: '3456',
    host: '0.0.0.0',
    logDir: null,
  });
  expect(content).toMatch(/\[Unit\]/);
  expect(content).toMatch(/\[Service\]/);
  expect(content).toMatch(/\[Install\]/);
  expect(content).toMatch(/Restart=on-failure/);
  expect(content).toMatch(/3456/);
});

test('generateServiceFile is a pure formatter that interpolates any scriptPath', () => {
  const worktreePath =
    '/Users/test/project/.worktrees/etna/dist/bin/relay-ide.js';
  const content = service.generateServiceFile('macos', {
    nodePath: '/usr/local/bin/node',
    scriptPath: worktreePath,
    configPath: '/Users/test/.config/relay-ide/config.json',
    port: '3456',
    host: '0.0.0.0',
    logDir: '/Users/test/.config/relay-ide/logs',
  });
  // generateServiceFile is a pure formatter — the guard is in install()
  expect(content).toContain(worktreePath);
});

test('resolveGlobalScriptPath returns a path under global node_modules or null', () => {
  const result = service.resolveGlobalScriptPath();
  if (result !== null) {
    // If a global install exists, it should point to the relay-ide dist binary
    expect(result).toContain('relay-ide');
    expect(result).toMatch(/relay-ide\.js$/);
    // Must never resolve to a worktree path
    expect(result).not.toMatch(/\.worktrees/);
    expect(result).not.toMatch(/\.claude\/worktrees/);
  }
  // null is acceptable — means no global install found
});

test('isGlobalInstall returns false when running from repo checkout', () => {
  // In the test environment we're running from the local repo, not a global install
  expect(service.isGlobalInstall()).toBe(false);
});

test('detectServiceManager models macOS launchd explicitly', () => {
  expect(
    service.detectServiceManager({ platform: 'darwin', home: '/Users/test' })
  ).toMatchObject({
    kind: 'launchd',
    supported: true,
    installable: true,
    servicePath: '/Users/test/Library/LaunchAgents/com.relay-ide.plist',
  });
});

test('detectServiceManager reports systemd-user with linger caveat', () => {
  const manager = service.detectServiceManager({
    platform: 'linux',
    home: '/home/test',
    wsl: { detected: false, version: null, systemd: false },
    execSync: execSucceedsFor([
      'command -v systemctl',
      'systemctl --user show-environment',
    ]),
  });

  expect(manager).toMatchObject({
    kind: 'systemd-user',
    supported: true,
    installable: true,
    servicePath: '/home/test/.config/systemd/user/relay-ide.service',
  });
  expect(manager.installHint).toContain('loginctl enable-linger');
});

test('detectServiceManager does not claim normal systemd-user inside WSL without systemd', () => {
  expect(
    service.detectServiceManager({
      platform: 'linux',
      wsl: { detected: true, version: 2, systemd: false },
      execSync: execSucceedsFor(['command -v systemctl']),
    })
  ).toMatchObject({
    kind: 'wsl-manual',
    supported: false,
    installable: false,
  });
});

test('detectServiceManager distinguishes system systemd without a user manager', () => {
  expect(
    service.detectServiceManager({
      platform: 'linux',
      wsl: { detected: false, version: null, systemd: false },
      execSync: execSucceedsFor([
        'command -v systemctl',
        'systemctl is-system-running --quiet',
      ]),
    })
  ).toMatchObject({
    kind: 'systemd-system',
    supported: false,
    installable: false,
  });
});

test('detectWslInfo recognizes WSL2 and systemd availability', () => {
  const wsl = service.detectWslInfo({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/123_interop' },
    fsExistsSync: (p) => p === '/run/systemd/system',
    fsReadFileSync: (p) =>
      p === '/proc/sys/kernel/osrelease' ? '5.15.90.1-microsoft-standard-WSL2' : '',
  });

  expect(wsl).toMatchObject({
    detected: true,
    version: 2,
    distroName: 'Ubuntu',
    systemd: true,
  });
});
