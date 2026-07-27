import fs from 'node:fs';
import path from 'node:path';

/**
 * Self-update install detection.
 *
 * `POST /update` used to always shell out to `npm install -g relay-ide`, which
 * silently no-ops when the running server was installed with `bun add -g`: npm
 * writes into npm's own global prefix while the running install root stays on
 * the old version. Detect the package manager that owns the running install
 * root so the update lands where the server actually runs from.
 */

export type InstallKind = 'bun' | 'npm' | 'unknown';

export interface InstallDetection {
  kind: InstallKind;
  /** Directory the running server was installed into, or null when unknown. */
  installRoot: string | null;
}

export interface SelfUpdateDeps {
  env?: NodeJS.ProcessEnv;
  fsRealpathSync?: (p: string) => string;
  fsReadFileSync?: (p: string, encoding: BufferEncoding) => string;
}

/** Matches the deepest `<prefix>/node_modules/relay-ide` in a path. */
const INSTALL_ROOT_RE = /^(.*)[\\/]node_modules[\\/]relay-ide(?=[\\/]|$)/;

function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

function resolveEntry(entryPath: string, deps: SelfUpdateDeps): string {
  const realpath = deps.fsRealpathSync ?? fs.realpathSync;
  try {
    // Global bin entries are symlinks (e.g. ~/.bun/bin/relay-ide), so the
    // install root only shows up after resolving them.
    return realpath(entryPath);
  } catch (_) {
    return entryPath;
  }
}

/**
 * Classify the install root the running server was launched from.
 * Dev checkouts and worktrees have no `node_modules/relay-ide` ancestor and
 * come back as `unknown` with a null root, which keeps callers on the legacy
 * npm behavior instead of guessing.
 */
export function detectInstallKind(
  entryPath: string,
  deps: SelfUpdateDeps = {}
): InstallDetection {
  if (!entryPath) return { kind: 'unknown', installRoot: null };
  const env = deps.env ?? process.env;
  const resolved = resolveEntry(entryPath, deps);
  const match = INSTALL_ROOT_RE.exec(resolved);
  if (!match) return { kind: 'unknown', installRoot: null };

  const installRoot = match[0];
  const prefix = normalizePath(match[1] ?? '');

  const bunInstall = env.BUN_INSTALL ? normalizePath(env.BUN_INSTALL) : null;
  const bunGlobalDir = env.BUN_INSTALL_GLOBAL_DIR
    ? normalizePath(env.BUN_INSTALL_GLOBAL_DIR)
    : null;
  const isBun =
    prefix.endsWith('/.bun/install/global') ||
    prefix === '.bun/install/global' ||
    (bunInstall !== null && prefix === `${bunInstall}/install/global`) ||
    (bunGlobalDir !== null && prefix === bunGlobalDir);
  if (isBun) return { kind: 'bun', installRoot };

  const npmPrefix = env.npm_config_prefix
    ? normalizePath(env.npm_config_prefix)
    : null;
  const prefixSegments = prefix.split('/').filter(Boolean);
  const lastSegment = prefixSegments[prefixSegments.length - 1] ?? '';
  // Unix global installs live under `<prefix>/lib/node_modules`; the Windows
  // npm prefix is `%AppData%\npm` with no `lib` level.
  const isNpm =
    lastSegment === 'lib' ||
    lastSegment === 'npm' ||
    (npmPrefix !== null && prefix === npmPrefix);
  if (isNpm) return { kind: 'npm', installRoot };

  return { kind: 'unknown', installRoot: null };
}

/** Build the global-install command for the detected package manager. */
export function buildUpdateCommand(
  kind: InstallKind,
  tag: string
): [command: string, args: string[]] {
  if (kind === 'bun') return ['bun', ['add', '-g', `relay-ide@${tag}`]];
  return ['npm', ['install', '-g', `relay-ide@${tag}`]];
}

/** Read the version currently on disk in an install root. */
export function readInstalledVersion(
  installRoot: string,
  deps: SelfUpdateDeps = {}
): string | null {
  const readFile = deps.fsReadFileSync ?? fs.readFileSync;
  try {
    const raw = readFile(path.join(installRoot, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch (_) {
    return null;
  }
}
