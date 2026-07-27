import { test, expect } from 'vitest';
import {
  buildUpdateCommand,
  detectInstallKind,
  readInstalledVersion,
} from '../server/self-update.js';

const BUN_ROOT = '/home/relay/.bun/install/global/node_modules/relay-ide';
const NPM_ROOT = '/usr/local/lib/node_modules/relay-ide';

function fakeReadFile(files: Record<string, string>) {
  return (p: string) => {
    const content = files[p];
    if (content === undefined) throw new Error(`ENOENT: ${p}`);
    return content;
  };
}

test('detectInstallKind classifies a bun global install root', () => {
  const detection = detectInstallKind(`${BUN_ROOT}/dist/server/index.js`, {
    env: {},
    fsRealpathSync: (p) => p,
  });
  expect(detection).toEqual({ kind: 'bun', installRoot: BUN_ROOT });
});

test('detectInstallKind classifies a bun install rooted at $BUN_INSTALL', () => {
  const root = '/opt/bun-home/install/global/node_modules/relay-ide';
  const detection = detectInstallKind(`${root}/dist/bin/relay-ide.js`, {
    env: { BUN_INSTALL: '/opt/bun-home' },
    fsRealpathSync: (p) => p,
  });
  expect(detection).toEqual({ kind: 'bun', installRoot: root });
});

test('detectInstallKind classifies an npm lib/node_modules install root', () => {
  const detection = detectInstallKind(`${NPM_ROOT}/dist/server/index.js`, {
    env: {},
    fsRealpathSync: (p) => p,
  });
  expect(detection).toEqual({ kind: 'npm', installRoot: NPM_ROOT });
});

test('detectInstallKind classifies a Windows npm prefix install root', () => {
  const root =
    'C:\\Users\\relay\\AppData\\Roaming\\npm\\node_modules\\relay-ide';
  const detection = detectInstallKind(`${root}\\dist\\server\\index.js`, {
    env: {},
    fsRealpathSync: (p) => p,
  });
  expect(detection).toEqual({ kind: 'npm', installRoot: root });
});

test('detectInstallKind returns unknown for a worktree/dev checkout', () => {
  const detection = detectInstallKind(
    '/home/relay/Documents/relay-ide/.worktrees/1284-fix/dist/server/index.js',
    { env: {}, fsRealpathSync: (p) => p }
  );
  expect(detection).toEqual({ kind: 'unknown', installRoot: null });
});

test('detectInstallKind resolves a symlinked bin entry into the bun root', () => {
  const detection = detectInstallKind('/home/relay/.bun/bin/relay-ide', {
    env: {},
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
    fsRealpathSync: () => {
      throw new Error('ENOENT');
    },
  });
  expect(detection.kind).toBe('npm');
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
