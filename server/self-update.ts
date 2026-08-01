import { spawnSync } from 'node:child_process';
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
 * - `launchd` — the stock `com.relay-ide` plist Relay installs on macOS. It
 *   sets `KeepAlive=true`, which restarts the job on *any* exit.
 * - `systemd` — a systemd unit whose `Restart=` policy was read and confirmed
 *   to restart a nonzero exit (the stock Linux unit and hand-written ones like
 *   `relay-daily-hub.service` alike).
 * - `none` — nothing is known to bring the process back; the operator restarts
 *   it. This is the fail-closed answer whenever the evidence is incomplete:
 *   staying up on stale bytes is recoverable, exiting into nothing is not.
 */
export type SupervisionKind = 'launchd' | 'systemd' | 'none';

export interface SupervisionDetection {
  supervised: boolean;
  kind: SupervisionKind;
  /** Operator-facing explanation; logged and echoed in the `/update` response. */
  reason: string;
}

/** The systemd unit that owns this process, plus its `Restart=` policy. */
export interface SystemdUnitInfo {
  /** Unit name, e.g. `relay-daily-hub.service`. */
  unit: string;
  /** Lowercased `Restart=` value, or `''` when it could not be read. */
  restart: string;
}

export interface SupervisionDeps {
  /**
   * The stock service check (`server/service.ts` `isInstalled`). Required —
   * a default would silently downgrade the proven path to a guess. Consulted
   * on macOS only: launchd exposes no restart policy to read, so the stock
   * plist is the one job whose `KeepAlive` semantics are known. On Linux the
   * unit's own `Restart=` is authoritative, stock or not.
   */
  serviceIsInstalled: () => boolean;
  /** `getPlatform()` from `server/service.ts`; may throw off macOS/Linux. */
  platform?: () => 'macos' | 'linux';
  /** launchd job label the stock plist installs (`com.relay-ide`). */
  serviceLabel?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.stdout.isTTY`; see the interactive-shell note below. */
  stdoutIsTty?: () => boolean;
  /** Owning unit + policy lookup; defaults to cgroup + `systemctl show`. */
  systemdUnit?: () => SystemdUnitInfo | null;
}

/**
 * systemd `Restart=` values that restart a process which exits *nonzero*.
 * `on-abnormal`, `on-abort` and `on-watchdog` react to signals, timeouts and
 * watchdog misses — never to a plain nonzero exit status — and `no` (the
 * default) and `on-success` react to neither. See systemd.service(5).
 */
const RESTART_ON_NONZERO_EXIT = new Set(['always', 'on-failure']);

function noSupervision(reason: string): SupervisionDetection {
  return { supervised: false, kind: 'none', reason };
}

/**
 * Find the systemd unit that owns this process from its cgroup path.
 *
 * cgroup v2 writes one `0::<path>` line; v1 writes several `<id>:<ctrl>:<path>`
 * lines. The deepest `*.service` segment is the owning unit. A `*.scope` closer
 * to the leaf (a login session, a `systemd-run --scope`, a container payload)
 * means no unit owns this process directly, so nothing would restart it —
 * that is a `null`, not a unit. `user@<uid>.service` is the per-user manager
 * itself rather than a restartable unit, so it is skipped.
 */
export function parseSystemdUnitFromCgroup(
  raw: string
): { unit: string; user: boolean } | null {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cgroupPath = trimmed.split(':').slice(2).join(':');
    if (!cgroupPath) continue;
    const segments = cgroupPath.split('/').filter(Boolean);
    const user = /(^|\/)user@\d+\.service(\/|$)/.test(cgroupPath);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i] as string;
      if (segment.endsWith('.scope')) return null;
      if (!segment.endsWith('.service')) continue;
      if (/^user@\d+\.service$/.test(segment)) break;
      return { unit: segment, user };
    }
  }
  return null;
}

const SYSTEMCTL_TIMEOUT_MS = 3000;

/** Default owning-unit probe: read the cgroup, then ask systemd for `Restart=`. */
function readSystemdUnit(): SystemdUnitInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync('/proc/self/cgroup', 'utf-8');
  } catch (_) {
    return null;
  }
  const owning = parseSystemdUnitFromCgroup(raw);
  if (!owning) return null;
  const args = owning.user
    ? ['--user', 'show', '--value', '-p', 'Restart', owning.unit]
    : ['show', '--value', '-p', 'Restart', owning.unit];
  try {
    const result = spawnSync('systemctl', args, {
      encoding: 'utf-8',
      timeout: SYSTEMCTL_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) {
      return { unit: owning.unit, restart: '' };
    }
    return {
      unit: owning.unit,
      restart: (result.stdout ?? '').trim().toLowerCase(),
    };
  } catch (_) {
    return { unit: owning.unit, restart: '' };
  }
}

/**
 * `INVOCATION_ID` is set once per systemd service invocation (systemd >= 232,
 * system and user managers alike) and no ordinary shell sets it — but children
 * inherit it, so a hub started by hand from a terminal that descends from a
 * unit would look supervised. An interactive stdout rules that case out:
 * services get the journal, a file, or null — never a terminal.
 */
function isSystemdManaged(
  env: NodeJS.ProcessEnv,
  isTty: () => boolean
): boolean {
  const invocationId = env.INVOCATION_ID;
  if (typeof invocationId !== 'string' || invocationId.trim() === '') {
    return false;
  }
  return !isTty();
}

/**
 * launchd's equivalent evidence: it exports `XPC_SERVICE_NAME` set to the job
 * label for jobs it started (`0` for everything else). Requiring the stock
 * label means a hub started by hand on a Mac that merely *has* the plist
 * installed is not mistaken for the serviced process.
 */
function isLaunchdManaged(
  env: NodeJS.ProcessEnv,
  isTty: () => boolean,
  label: string | undefined
): boolean {
  if (isTty()) return false;
  const xpcName = (env.XPC_SERVICE_NAME ?? '').trim();
  if (xpcName === '' || xpcName === '0') return false;
  return label ? xpcName.includes(label) : true;
}

/**
 * Decide whether an exit would be followed by a restart.
 *
 * The bet is asymmetric: guessing "supervised" wrong takes the hub down until
 * a human notices, while guessing "not supervised" wrong only leaves it
 * running the old bytes with a "restart manually" toast. So every branch here
 * demands positive evidence, and anything unreadable resolves to `none`.
 *
 * On Linux that evidence is the owning unit's actual `Restart=` policy —
 * `INVOCATION_ID` is set for *every* unit invocation regardless of policy, and
 * `Restart=no` is systemd's default, so the variable alone proves only that
 * systemd started the process, never that it would start it again.
 *
 * `RELAY_UPDATE_RESTART` overrides the whole decision: `never` keeps the
 * process alive no matter what, `systemd` asserts a nonzero-exit-restarting
 * supervisor for hosts where the policy cannot be read (locked-down
 * containers, `systemctl` off PATH).
 */
export function detectSupervision(deps: SupervisionDeps): SupervisionDetection {
  const env = deps.env ?? process.env;
  const override = (env.RELAY_UPDATE_RESTART ?? '').trim().toLowerCase();
  if (override === 'never' || override === 'off' || override === 'manual') {
    return noSupervision('RELAY_UPDATE_RESTART=never');
  }
  if (override === 'systemd' || override === 'always') {
    return {
      supervised: true,
      kind: 'systemd',
      reason: `RELAY_UPDATE_RESTART=${override}`,
    };
  }

  const isTty = deps.stdoutIsTty ?? (() => process.stdout.isTTY === true);

  let platform: 'macos' | 'linux' | null;
  try {
    platform = deps.platform?.() ?? null;
  } catch (_) {
    // Unsupported platform: no supervisor we know how to reason about.
    platform = null;
  }

  if (platform === 'macos') {
    let stockInstalled: boolean;
    try {
      stockInstalled = deps.serviceIsInstalled();
    } catch (_) {
      // A failed probe (permissions, exotic platform) is not evidence.
      stockInstalled = false;
    }
    if (!stockInstalled) {
      return noSupervision('no stock launchd plist installed');
    }
    if (!isLaunchdManaged(env, isTty, deps.serviceLabel)) {
      return noSupervision(
        'stock launchd plist installed but this process was not started by it'
      );
    }
    return {
      supervised: true,
      kind: 'launchd',
      reason: 'stock launchd plist (KeepAlive restarts any exit)',
    };
  }

  if (!isSystemdManaged(env, isTty)) {
    return noSupervision('no systemd invocation owns this process');
  }
  const unitProbe = deps.systemdUnit ?? readSystemdUnit;
  let info: SystemdUnitInfo | null;
  try {
    info = unitProbe();
  } catch (_) {
    info = null;
  }
  if (!info) {
    return noSupervision(
      'systemd invocation without a resolvable unit (set RELAY_UPDATE_RESTART=systemd to override)'
    );
  }
  if (!info.restart) {
    return noSupervision(
      `could not read Restart= for ${info.unit} (set RELAY_UPDATE_RESTART=systemd to override)`
    );
  }
  if (!RESTART_ON_NONZERO_EXIT.has(info.restart)) {
    return noSupervision(
      `${info.unit} has Restart=${info.restart}, which would not restart this process`
    );
  }
  return {
    supervised: true,
    kind: 'systemd',
    reason: `${info.unit} has Restart=${info.restart}`,
  };
}

/**
 * Exit code that makes a supervisor restart this process.
 *
 * The two supervisors want opposite exits, so this is not a stylistic choice:
 *
 * - launchd with `KeepAlive=true` (the stock plist) restarts on *any* exit, so
 *   exit 0 restarts and keeps the log honest.
 * - systemd restarts a *nonzero* exit under `always` and `on-failure` only —
 *   including the stock Linux unit Relay writes, which is `Restart=on-failure`
 *   (`server/service.ts`). A clean exit there is a successful stop: the unit
 *   goes inactive and the hub stays down. `detectSupervision` only reports
 *   `systemd` after confirming one of those two policies, so exit 1 is always
 *   the code that unit acts on.
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
