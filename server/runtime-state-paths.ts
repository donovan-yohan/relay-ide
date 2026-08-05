// Runtime-state path resolution (#961).
//
// All Relay runtime SQLite stores (`work-contexts.db`, `context-packets.db`,
// `workflow-runs.db`, `analytics.db`, ...) live in the *config directory* —
// `path.dirname(CONFIG_PATH)`. So wherever the config file lands, the runtime
// DBs land beside it.
//
// The published CLI bin and `dev:self` already point the config at app-data
// (`~/.config/relay-ide/...`), but two from-source launch paths historically
// defaulted the config into the repo checkout root:
//   - `npm run dev`          → `<repo>/config.dev.json`
//   - `node dist/server/index.js` (raw) → `<repo>/config.json`
// Both spilled the runtime DBs into the checkout. This module relocates those
// defaults to a stable per-checkout directory under app-data so source dev
// never pollutes the working tree, while still letting explicit
// `RELAY_IDE_CONFIG` / `--config` win.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Relay's app-data root for from-source launches: `$XDG_CONFIG_HOME/relay-ide`
 * when that var is an absolute path, else `~/.config/relay-ide`.
 *
 * `~/.config/relay-ide` matches the production root the CLI bin uses
 * (`server/service.ts`), except service.ts hardcodes `~/.config` and does NOT
 * honor `$XDG_CONFIG_HOME` — so when XDG is set, prod and from-source roots
 * intentionally differ rather than spilling source state into prod.
 *
 * A *relative* `XDG_CONFIG_HOME` is ignored per the XDG Base Directory spec:
 * honoring it would make the config path (and the runtime DBs beside it)
 * resolve against `process.cwd()` — i.e. back into the checkout — defeating the
 * point of #961. Mirrors the guard in `server/session-attachment.ts`
 * (security review #472).
 */
export function relayAppDataDir(
  env: Record<string, string | undefined> = process.env,
  homedir: string = os.homedir()
): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const base =
    xdgConfigHome && path.isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : path.join(homedir, '.config');
  return path.join(base, 'relay-ide');
}

/** Filesystem-safe, human-readable slug for a checkout path's basename. */
export function safePathSlug(inputPath: string): string {
  return (
    path
      .basename(path.resolve(inputPath))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  );
}

/** Short stable hash of the absolute checkout path (disambiguates same-named worktrees). */
export function pathHash(inputPath: string): string {
  return crypto
    .createHash('sha256')
    .update(path.resolve(inputPath))
    .digest('hex')
    .slice(0, 12);
}

export interface SourceLaunchConfigOptions {
  /** Config file name to use, e.g. `config.dev.json` or `config.json`. */
  fileName: string;
  /** App-data sub-namespace that isolates this launch mode, e.g. `dev` or `source`. */
  namespace: string;
  env?: Record<string, string | undefined> | undefined;
  homedir?: string | undefined;
}

export interface SourceLaunchConfigResolution {
  /** Resolved config path under app-data, keyed per checkout. */
  configPath: string;
  /**
   * The legacy in-checkout config path **if it still exists on disk**, else
   * `null`. Callers should warn (not silently honor) so users can migrate the
   * old file or pin it via `RELAY_IDE_CONFIG`. We never auto-read or delete it.
   */
  legacyConfigPath: string | null;
}

/**
 * Resolve the default config path for a from-source launch to a stable
 * per-checkout directory under app-data: `<app-data>/<namespace>/<slug>-<hash>/<fileName>`.
 *
 * This is only the *default*; callers must still let an explicit
 * `RELAY_IDE_CONFIG` / `--config` take precedence before calling this.
 */
export function resolveSourceLaunchConfigPath(
  checkoutRoot: string,
  options: SourceLaunchConfigOptions
): SourceLaunchConfigResolution {
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const resolvedCheckout = path.resolve(checkoutRoot);
  const legacyConfigPath = path.join(resolvedCheckout, options.fileName);
  const stateDir = path.join(
    relayAppDataDir(env, home),
    options.namespace,
    `${safePathSlug(resolvedCheckout)}-${pathHash(resolvedCheckout)}`
  );
  return {
    configPath: path.join(stateDir, options.fileName),
    legacyConfigPath: fs.existsSync(legacyConfigPath) ? legacyConfigPath : null,
  };
}

/** Env var that puts the server in Playwright fixture mode. */
export const E2E_FIXTURE_ENV_VAR = 'RELAY_IDE_E2E_FIXTURES';
/** Env var that pins the config file (and every runtime store beside it). */
export const CONFIG_PATH_ENV_VAR = 'RELAY_IDE_CONFIG';

/**
 * Config roots owned by a *hub someone deployed on this machine* (#1214).
 *
 * Two roots, because two code paths disagree on purpose:
 *   - `relayAppDataDir()` honors `$XDG_CONFIG_HOME` (from-source launches), and
 *   - `server/service.ts` hardcodes `~/.config/relay-ide` (the installed CLI).
 * A run with XDG set therefore has to treat both as off-limits, or the fixture
 * server can still land on the installed hub's config while looking isolated.
 *
 * Everything under these roots is shared state: the PIN, sessions, and every
 * runtime SQLite store live beside the config file.
 */
export function sharedConfigRoots(
  env: Record<string, string | undefined> = process.env,
  homedir: string = os.homedir()
): string[] {
  return [
    ...new Set([
      relayAppDataDir(env, homedir),
      path.join(homedir, '.config', 'relay-ide'),
    ]),
  ];
}

/** True when `candidate` is `root` itself or lives underneath it. */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface FixtureConfigIsolationInput {
  /** Raw `RELAY_IDE_CONFIG` value, exactly as the operator set it (if at all). */
  explicitConfigPath: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  homedir?: string | undefined;
}

/**
 * Why an e2e fixture boot must be refused, or `null` when the config is
 * isolated (#1214).
 *
 * The fixture web-server used to inherit the *default* config resolution, so on
 * any box that also runs a deployed hub it read that hub's config dir: a PIN
 * set by the deploy turned every smoke test into an auth-screen failure, and
 * the fixture run wrote its sessions/SQLite back into the deployed hub's state.
 * Defaulting is the bug, so fixture mode has no default at all — an explicit
 * per-run path outside every shared root, or no boot.
 */
export function findFixtureConfigIsolationViolation(
  input: FixtureConfigIsolationInput
): string | null {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const roots = sharedConfigRoots(env, homedir);
  const raw = input.explicitConfigPath?.trim();

  if (!raw) {
    return (
      `${E2E_FIXTURE_ENV_VAR}=1 requires an explicit isolated ${CONFIG_PATH_ENV_VAR}; ` +
      `refusing to fall back to the shared config root ${roots[0]}, which a deployed hub owns ` +
      `(its PIN and SQLite state would poison the run, and the run would poison the hub). ` +
      `Point ${CONFIG_PATH_ENV_VAR} at a fresh temp dir. (#1214)`
    );
  }
  if (!path.isAbsolute(raw)) {
    return (
      `${E2E_FIXTURE_ENV_VAR}=1 requires an absolute ${CONFIG_PATH_ENV_VAR}; got "${raw}". ` +
      `A relative path resolves against the launching cwd, which is not a run-scoped location. (#1214)`
    );
  }
  const resolved = path.resolve(raw);
  const sharedRoot = roots.find((root) => isInside(root, resolved));
  if (sharedRoot) {
    return (
      `${CONFIG_PATH_ENV_VAR}=${resolved} is inside the shared Relay config root ${sharedRoot}, ` +
      `so the fixture run would share a PIN, sessions, and every runtime SQLite store with a ` +
      `deployed hub. Point ${CONFIG_PATH_ENV_VAR} at a fresh temp dir instead. (#1214)`
    );
  }
  return null;
}
