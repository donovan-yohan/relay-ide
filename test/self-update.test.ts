import { test, expect } from 'vitest';
import {
  buildRemedyCommand,
  buildUpdateCommand,
  detectInstallKind,
  detectRunningInstall,
  readInstalledVersion,
  resolveBunBinary,
  verifyUpdateLanded,
} from '../server/self-update.js';

const BUN_ROOT = '/home/relay/.bun/install/global/node_modules/relay-ide';
const NPM_ROOT = '/usr/local/lib/node_modules/relay-ide';
const NPM_EXEC_PATH = '/usr/local/bin/node';

function fakeReadFile(files: Record<string, string>) {
  return (p: string) => {
    const content = files[p];
    if (content === undefined) throw new Error(`ENOENT: ${p}`);
    return content;
  };
}

const identityRealpath = (p: string) => p;

test('detectInstallKind classifies a bun global install root', () => {
  const detection = detectInstallKind(`${BUN_ROOT}/dist/server/index.js`, {
    env: {},
    execPath: NPM_EXEC_PATH,
    fsRealpathSync: identityRealpath,
  });
  expect(detection).toEqual({ kind: 'bun', installRoot: BUN_ROOT });
});

test('detectInstallKind classifies a bun install rooted at $BUN_INSTALL', () => {
  const root = '/opt/bun-home/install/global/node_modules/relay-ide';
  const detection = detectInstallKind(`${root}/dist/bin/relay-ide.js`, {
    env: { BUN_INSTALL: '/opt/bun-home' },
    execPath: NPM_EXEC_PATH,
    fsRealpathSync: identityRealpath,
  });
  expect(detection).toEqual({ kind: 'bun', installRoot: root });
});

test('detectInstallKind classifies an npm install corroborated by execPath', () => {
  const detection = detectInstallKind(`${NPM_ROOT}/dist/server/index.js`, {
    env: {},
    execPath: NPM_EXEC_PATH,
    fsRealpathSync: identityRealpath,
  });
  expect(detection).toEqual({ kind: 'npm', installRoot: NPM_ROOT });
});

test('detectInstallKind accepts an uppercase NPM_CONFIG_PREFIX', () => {
  const root = '/home/relay/.npm-global/lib/node_modules/relay-ide';
  const detection = detectInstallKind(`${root}/dist/server/index.js`, {
    env: { NPM_CONFIG_PREFIX: '/home/relay/.npm-global' },
    execPath: NPM_EXEC_PATH,
    fsRealpathSync: identityRealpath,
  });
  expect(detection).toEqual({ kind: 'npm', installRoot: root });
});

test('detectInstallKind classifies a Windows npm prefix install root', () => {
  const root =
    'C:\\Users\\relay\\AppData\\Roaming\\npm\\node_modules\\relay-ide';
  const detection = detectInstallKind(`${root}\\dist\\server\\index.js`, {
    env: { npm_config_prefix: 'C:\\Users\\relay\\AppData\\Roaming\\npm' },
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    fsRealpathSync: identityRealpath,
  });
  expect(detection).toEqual({ kind: 'npm', installRoot: root });
});

test('detectInstallKind does not call an uncorroborated lib path npm', () => {
  const root = '/srv/lib/node_modules/relay-ide';
  const detection = detectInstallKind(`${root}/dist/server/index.js`, {
    env: {},
    execPath: NPM_EXEC_PATH,
    fsRealpathSync: identityRealpath,
  });
  // Still carries the root so the caller can verify the update landed here.
  expect(detection).toEqual({ kind: 'unknown', installRoot: root });
});

test('detectInstallKind keeps the root for other global package managers', () => {
  const root = '/home/relay/.local/share/pnpm/global/5/node_modules/relay-ide';
  const detection = detectInstallKind(`${root}/dist/server/index.js`, {
    env: {},
    execPath: NPM_EXEC_PATH,
    fsRealpathSync: identityRealpath,
  });
  expect(detection).toEqual({ kind: 'unknown', installRoot: root });
});

test('detectInstallKind returns a null root for a worktree/dev checkout', () => {
  const detection = detectInstallKind(
    '/home/relay/Documents/relay-ide/.worktrees/1284-fix/dist/server/index.js',
    { env: {}, execPath: NPM_EXEC_PATH, fsRealpathSync: identityRealpath }
  );
  expect(detection).toEqual({ kind: 'unknown', installRoot: null });
});

test('detectInstallKind resolves a symlinked bin entry into the bun root', () => {
  const detection = detectInstallKind('/home/relay/.bun/bin/relay-ide', {
    env: {},
    execPath: NPM_EXEC_PATH,
    fsRealpathSync: (p) =>
      p === '/home/relay/.bun/bin/relay-ide'
        ? `${BUN_ROOT}/dist/bin/relay-ide.js`
        : p,
  });
  expect(detection).toEqual({ kind: 'bun', installRoot: BUN_ROOT });
});

test('detectInstallKind falls back to the raw path when realpath fails', () => {
  const detection = detectInstallKind(`${NPM_ROOT}/dist/server/index.js`, {
    env: {},
    execPath: NPM_EXEC_PATH,
    fsRealpathSync: () => {
      throw new Error('ENOENT');
    },
  });
  expect(detection.kind).toBe('npm');
});

test('detectRunningInstall prefers a classified candidate over an unknown root', () => {
  const detection = detectRunningInstall(
    [
      undefined,
      '/srv/lib/node_modules/relay-ide/dist/bin/relay-ide.js',
      `${BUN_ROOT}/dist/server/index.js`,
    ],
    { env: {}, execPath: NPM_EXEC_PATH, fsRealpathSync: identityRealpath }
  );
  expect(detection).toEqual({ kind: 'bun', installRoot: BUN_ROOT });
});

test('detectRunningInstall keeps an unknown root when nothing classifies', () => {
  const detection = detectRunningInstall(
    [
      '/srv/lib/node_modules/relay-ide/dist/bin/relay-ide.js',
      '/home/relay/checkout/dist/server/index.js',
    ],
    { env: {}, execPath: NPM_EXEC_PATH, fsRealpathSync: identityRealpath }
  );
  expect(detection).toEqual({
    kind: 'unknown',
    installRoot: '/srv/lib/node_modules/relay-ide',
  });
});

test('buildUpdateCommand uses bun for bun installs and npm otherwise', () => {
  expect(buildUpdateCommand('bun', 'nightly')).toEqual([
    'bun',
    ['add', '-g', 'relay-ide@nightly'],
  ]);
  expect(buildUpdateCommand('npm', 'latest')).toEqual([
    'npm',
    ['install', '-g', 'relay-ide@latest'],
  ]);
  expect(buildUpdateCommand('unknown', 'latest')).toEqual([
    'npm',
    ['install', '-g', 'relay-ide@latest'],
  ]);
});

test('buildUpdateCommand uses the absolute bun binary when it exists', () => {
  expect(
    buildUpdateCommand('bun', 'nightly', BUN_ROOT, {
      fsExistsSync: (p) => p === '/home/relay/.bun/bin/bun',
    })
  ).toEqual(['/home/relay/.bun/bin/bun', ['add', '-g', 'relay-ide@nightly']]);
});

test('resolveBunBinary falls back to bare bun when the binary is missing', () => {
  expect(resolveBunBinary(BUN_ROOT, { fsExistsSync: () => false })).toBe('bun');
  expect(resolveBunBinary(NPM_ROOT, { fsExistsSync: () => true })).toBe('bun');
  expect(resolveBunBinary(null)).toBe('bun');
});

test('buildRemedyCommand targets the detected prefix', () => {
  expect(buildRemedyCommand('bun', BUN_ROOT, 'nightly')).toBe(
    'bun add -g relay-ide@nightly'
  );
  expect(buildRemedyCommand('npm', NPM_ROOT, 'latest')).toBe(
    'npm install -g --prefix /usr/local relay-ide@latest'
  );
  expect(
    buildRemedyCommand('unknown', '/srv/lib/node_modules/relay-ide', 'latest')
  ).toContain('/srv/lib/node_modules/relay-ide');
  expect(buildRemedyCommand('unknown', null, 'latest')).toBe(
    'npm install -g relay-ide@latest'
  );
});

test('readInstalledVersion sees a changed version after a successful install', () => {
  const pkgPath = `${BUN_ROOT}/package.json`;
  const before = readInstalledVersion(BUN_ROOT, {
    fsReadFileSync: fakeReadFile({ [pkgPath]: '{"version":"1.2.3"}' }),
  });
  const after = readInstalledVersion(BUN_ROOT, {
    fsReadFileSync: fakeReadFile({ [pkgPath]: '{"version":"1.2.4"}' }),
  });
  expect(before).toBe('1.2.3');
  expect(after).toBe('1.2.4');
});

test('readInstalledVersion reports the same version when the root is untouched', () => {
  const pkgPath = `${NPM_ROOT}/package.json`;
  const read = fakeReadFile({ [pkgPath]: '{"version":"1.2.3"}' });
  expect(readInstalledVersion(NPM_ROOT, { fsReadFileSync: read })).toBe(
    '1.2.3'
  );
  expect(readInstalledVersion(NPM_ROOT, { fsReadFileSync: read })).toBe(
    '1.2.3'
  );
});

test('readInstalledVersion returns null for a missing or invalid package.json', () => {
  expect(
    readInstalledVersion(NPM_ROOT, { fsReadFileSync: fakeReadFile({}) })
  ).toBe(null);
  expect(
    readInstalledVersion(NPM_ROOT, {
      fsReadFileSync: fakeReadFile({
        [`${NPM_ROOT}/package.json`]: 'not json',
      }),
    })
  ).toBe(null);
});

test('verifyUpdateLanded flags an unchanged root that is behind latest', () => {
  expect(
    verifyUpdateLanded({
      versionBefore: '1.2.3',
      versionAfter: '1.2.3',
      latest: '1.2.4',
    })
  ).toBe('unchanged-stale');
});

test('verifyUpdateLanded flags an unchanged root when latest is unknown', () => {
  expect(
    verifyUpdateLanded({
      versionBefore: '1.2.3',
      versionAfter: '1.2.3',
      latest: null,
    })
  ).toBe('no-change-detected');
});

test('verifyUpdateLanded accepts an unchanged root that is already at latest', () => {
  expect(
    verifyUpdateLanded({
      versionBefore: '1.2.4',
      versionAfter: '1.2.4',
      latest: '1.2.4',
    })
  ).toBe('already-latest');
});

test('verifyUpdateLanded counts any version change as landed', () => {
  expect(
    verifyUpdateLanded({
      versionBefore: '1.2.3',
      versionAfter: '1.2.4',
      latest: '1.2.4',
    })
  ).toBe('updated');
  // A downgrade still means the install root was rewritten.
  expect(
    verifyUpdateLanded({
      versionBefore: '1.2.4',
      versionAfter: '1.2.3',
      latest: '1.2.4',
    })
  ).toBe('updated');
});

test('verifyUpdateLanded is unverifiable when either version is unreadable', () => {
  expect(
    verifyUpdateLanded({
      versionBefore: null,
      versionAfter: '1.2.4',
      latest: '1.2.4',
    })
  ).toBe('unverifiable');
  expect(
    verifyUpdateLanded({
      versionBefore: '1.2.3',
      versionAfter: null,
      latest: '1.2.4',
    })
  ).toBe('unverifiable');
  expect(
    verifyUpdateLanded({
      versionBefore: null,
      versionAfter: null,
      latest: null,
    })
  ).toBe('unverifiable');
});
