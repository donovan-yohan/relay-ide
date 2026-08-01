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

/**
 * Script path a platform service should point at, for install roots npm prefix
 * probing cannot find (a `bun add -g` install has no npm-global copy). Only
 * classified global installs qualify — never a dev checkout, and never an
 * unclassified root such as an npx cache directory.
 */
export function resolveDetectedScriptPath(
  detection: InstallDetection,
  deps: SelfUpdateDeps = {}
): string | undefined {
  if (detection.kind === 'unknown' || !detection.installRoot) return undefined;
  const exists = deps.fsExistsSync ?? fs.existsSync;
  const script = path.join(
    detection.installRoot,
    'dist',
    'bin',
    'relay-ide.js'
  );
  return exists(script) ? script : undefined;
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
  const normalized = installRoot ? normalizePath(installRoot) : '';
  // An npm-shaped root deserves the precise command even when classification
  // fell back to `unknown` (e.g. a node prefix this process is not running).
  if (
    installRoot &&
    (kind === 'npm' || normalized.endsWith('/lib/node_modules/relay-ide'))
  ) {
    const prefix = normalized
      .replace(/\/node_modules\/relay-ide$/, '')
      .replace(/\/lib$/, '');
    return `npm install -g --prefix "${prefix}" relay-ide@${tag}`;
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

/**
 * How the running process is supervised, i.e. who would start it again if it
 * exited right now.
 *
 * - `stock-service` — the unit/plist `relay-ide service install` writes. Its
 *   restart semantics are proven, so it always wins.
 * - `systemd` — some other systemd unit owns this process (a hand-written
 *   `relay-stable-hub.service`, a distro package, a container unit).
 * - `none` — nothing would bring the process back; the operator restarts it.
 */
export type SupervisionKind = 'stock-service' | 'systemd' | 'none';

export interface SupervisionDetection {
  supervised: boolean;
  kind: SupervisionKind;
}

export interface SupervisionDeps {
  /**
   * The stock service check (`server/service.ts` `isInstalled`). Required —
   * a default would silently downgrade the proven path to a guess.
   */
  serviceIsInstalled: () => boolean;
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.stdout.isTTY`; see the interactive-shell note below. */
  stdoutIsTty?: () => boolean;
}

/**
 * Decide whether an exit would be followed by a restart.
 *
 * The stock service check comes first: it identifies the exact unit Relay
 * installs, whose restart policy is known. Everything else falls back to
 * `INVOCATION_ID`, which systemd sets per service invocation (systemd >= 232,
 * system and user managers alike) and no ordinary shell sets.
 *
 * `INVOCATION_ID` is inherited by children, so a hub launched by hand from a
 * terminal that itself descends from a unit would look supervised. An
 * interactive stdout (a TTY) rules that case out: systemd services get the
 * journal, a file, or null — never a terminal — so a TTY means a human started
 * this process and nothing will restart it.
 */
export function detectSupervision(deps: SupervisionDeps): SupervisionDetection {
  let stockInstalled: boolean;
  try {
    stockInstalled = deps.serviceIsInstalled();
  } catch (_) {
    // A failed probe (permissions, exotic platform) is not evidence of a unit.
    stockInstalled = false;
  }
  if (stockInstalled) return { supervised: true, kind: 'stock-service' };

  const env = deps.env ?? process.env;
  const invocationId = env.INVOCATION_ID;
  if (typeof invocationId !== 'string' || invocationId.trim() === '') {
    return { supervised: false, kind: 'none' };
  }
  const isTty = deps.stdoutIsTty ?? (() => process.stdout.isTTY === true);
  if (isTty()) return { supervised: false, kind: 'none' };
  return { supervised: true, kind: 'systemd' };
}

/**
 * Exit code that makes a supervisor restart this process.
 *
 * The stock unit/plist restarts on any exit, and a clean exit keeps the
 * journal honest. A foreign systemd unit is the opposite bet: the common
 * hand-written policy is `Restart=on-failure`, which restarts *unclean* exits
 * only — a `process.exit(0)` there would leave the hub down until an operator
 * noticed. Exiting nonzero restarts under `on-failure`, `on-abnormal`, and
 * `always` alike; only the rare `Restart=on-success` misses it.
 */
export function restartExitCode(kind: SupervisionKind): number {
  return kind === 'systemd' ? 1 : 0;
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
