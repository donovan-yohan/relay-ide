import fs from 'node:fs';
import path from 'node:path';

/**
 * Self-update install detection.
 *
 * `POST /update` used to always shell out to `npm install -g relay-ide`, which
 * silently no-ops when the running server was installed with `bun add -g`: npm
 * writes into npm's own global prefix while the running install root stays on
 * the old version. Detect the package manager that owns the running install
 * root so the update lands where the server actually runs from, and verify the
 * root afterwards so an install into some other prefix cannot report success.
 */

export type InstallKind = 'bun' | 'npm' | 'unknown';

export interface InstallDetection {
  kind: InstallKind;
  /**
   * Directory the running server was installed into. Non-null whenever the
   * running path has a `node_modules/relay-ide` ancestor — including `unknown`
   * kinds (pnpm/yarn/deno globals), so callers can still verify that an update
   * landed here. Null only for dev checkouts and worktrees.
   */
  installRoot: string | null;
}

export interface SelfUpdateDeps {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  fsRealpathSync?: (p: string) => string;
  fsReadFileSync?: (p: string, encoding: BufferEncoding) => string;
  fsExistsSync?: (p: string) => boolean;
}

/** Matches the deepest `<prefix>/node_modules/relay-ide` in a path. */
const INSTALL_ROOT_RE = /^(.*)[\\/]node_modules[\\/]relay-ide(?=[\\/]|$)/;

const BUN_GLOBAL_SUFFIX = '/install/global';

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

/** `<prefix>/bin/node` → `<prefix>`, matching npm's global prefix layout. */
function nodePrefixOf(execPath: string): string {
  const normalized = normalizePath(execPath);
  return normalizePath(path.dirname(path.dirname(normalized)));
}

function isBunPrefix(prefix: string, env: NodeJS.ProcessEnv): boolean {
  if (prefix.endsWith(`/.bun${BUN_GLOBAL_SUFFIX}`)) return true;
  if (prefix === `.bun${BUN_GLOBAL_SUFFIX}`) return true;
  const bunInstall = env.BUN_INSTALL ? normalizePath(env.BUN_INSTALL) : null;
  if (bunInstall !== null && prefix === `${bunInstall}${BUN_GLOBAL_SUFFIX}`) {
    return true;
  }
  const bunGlobalDir = env.BUN_INSTALL_GLOBAL_DIR
    ? normalizePath(env.BUN_INSTALL_GLOBAL_DIR)
    : null;
  return bunGlobalDir !== null && prefix === bunGlobalDir;
}

function isNpmPrefix(
  prefix: string,
  env: NodeJS.ProcessEnv,
  execPath: string
): boolean {
  const segments = prefix.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? '';
  // Unix global installs live under `<prefix>/lib/node_modules`; the Windows
  // npm prefix is `%AppData%\npm` with no `lib` level.
  if (lastSegment !== 'lib' && lastSegment !== 'npm') return false;
  // Shape alone is ambiguous — any `/srv/lib/node_modules/relay-ide` matches —
  // so require a real npm prefix to corroborate it.
  const configured = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  const candidates = [nodePrefixOf(execPath)];
  if (configured) candidates.push(normalizePath(configured));
  return candidates.some(
    (candidate) =>
      candidate.length > 0 &&
      (prefix === candidate || prefix === `${candidate}/lib`)
  );
}

/**
 * Classify the install root the running server was launched from.
 * Dev checkouts and worktrees have no `node_modules/relay-ide` ancestor and
 * come back as `unknown` with a null root; other unrecognized package managers
 * come back as `unknown` with a usable root so update verification still runs.
 */
export function detectInstallKind(
  entryPath: string,
  deps: SelfUpdateDeps = {}
): InstallDetection {
  if (!entryPath) return { kind: 'unknown', installRoot: null };
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const resolved = resolveEntry(entryPath, deps);
  const match = INSTALL_ROOT_RE.exec(resolved);
  if (!match) return { kind: 'unknown', installRoot: null };

  const installRoot = match[0];
  const prefix = normalizePath(match[1] ?? '');

  if (isBunPrefix(prefix, env)) return { kind: 'bun', installRoot };
  if (isNpmPrefix(prefix, env, execPath)) return { kind: 'npm', installRoot };
  return { kind: 'unknown', installRoot };
}

/**
 * Classify the running install from candidate entry paths (argv[1] first, then
 * the module path). A classified hit wins; otherwise the first candidate that
 * still yields an install root is kept so verification can run.
 */
export function detectRunningInstall(
  candidates: Array<string | undefined>,
  deps: SelfUpdateDeps = {}
): InstallDetection {
  let fallback: InstallDetection = { kind: 'unknown', installRoot: null };
  for (const candidate of candidates) {
    if (!candidate) continue;
    const detection = detectInstallKind(candidate, deps);
    if (detection.kind !== 'unknown') return detection;
    if (detection.installRoot && !fallback.installRoot) fallback = detection;
  }
  return fallback;
}

/**
 * Resolve the bun binary that owns an install root. Service units frequently
 * run with a PATH that lacks `~/.bun/bin`, so prefer the absolute path.
 */
export function resolveBunBinary(
  installRoot: string | null,
  deps: SelfUpdateDeps = {}
): string {
  if (!installRoot) return 'bun';
  const exists = deps.fsExistsSync ?? fs.existsSync;
  const normalized = normalizePath(installRoot);
  const suffix = `${BUN_GLOBAL_SUFFIX}/node_modules/relay-ide`;
  if (!normalized.endsWith(suffix)) return 'bun';
  const bunHome = normalized.slice(0, normalized.length - suffix.length);
  if (!bunHome) return 'bun';
  const binary = `${bunHome}/bin/bun`;
  return exists(binary) ? binary : 'bun';
}

/** Build the global-install command for the detected package manager. */
export function buildUpdateCommand(
  kind: InstallKind,
  tag: string,
  installRoot: string | null = null,
  deps: SelfUpdateDeps = {}
): [command: string, args: string[]] {
  if (kind === 'bun') {
    return [
      resolveBunBinary(installRoot, deps),
      ['add', '-g', `relay-ide@${tag}`],
    ];
  }
  return ['npm', ['install', '-g', `relay-ide@${tag}`]];
}

/** Operator-facing command that installs into a specific install root. */
export function buildRemedyCommand(
  kind: InstallKind,
  installRoot: string | null,
  tag: string
): string {
  if (kind === 'bun') return `bun add -g relay-ide@${tag}`;
  if (kind === 'npm' && installRoot) {
    const prefix = normalizePath(installRoot)
      .replace(/\/node_modules\/relay-ide$/, '')
      .replace(/\/lib$/, '');
    return `npm install -g --prefix ${prefix} relay-ide@${tag}`;
  }
  if (installRoot) {
    return `reinstall relay-ide@${tag} into ${installRoot} with the package manager that owns it`;
  }
  return `npm install -g relay-ide@${tag}`;
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

export type UpdateVerification =
  | 'updated'
  | 'already-latest'
  | 'unchanged-stale'
  | 'no-change-detected'
  | 'unverifiable';

/**
 * Decide whether an install actually landed in the running install root.
 * `unverifiable` means the root's version could not be read on one side, so the
 * caller has no evidence either way and should keep its legacy behavior.
 */
export function verifyUpdateLanded(input: {
  versionBefore: string | null;
  versionAfter: string | null;
  latest: string | null;
}): UpdateVerification {
  const { versionBefore, versionAfter, latest } = input;
  if (versionBefore === null || versionAfter === null) return 'unverifiable';
  // Any change counts as landed, including an intentional downgrade.
  if (versionAfter !== versionBefore) return 'updated';
  if (latest !== null && versionAfter === latest) return 'already-latest';
  if (latest !== null) return 'unchanged-stale';
  return 'no-change-detected';
}
