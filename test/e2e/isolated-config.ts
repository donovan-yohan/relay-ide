/**
 * Run-scoped config isolation for the Playwright fixture web-server (#1214).
 *
 * The fixture server used to start with no `RELAY_IDE_CONFIG`, so it inherited
 * Relay's *default* config resolution — a path under the shared app-data root
 * that a deployed hub on the same host also owns. After a deploy put a PIN in
 * that config, every `basic.spec.ts` smoke test hit a PIN-unlock screen, and
 * runs that "passed" only did so because `reuseExistingServer` recycled a
 * PIN-less server booted before the deploy. The fixture run also wrote its own
 * sessions and SQLite back into the deployed hub's state.
 *
 * So the harness never *falls back*: it mints a fresh temp config dir per run,
 * and any inherited `RELAY_IDE_CONFIG` is validated (not trusted) against the
 * same shared-root rule the server enforces at boot. Both sides share
 * `findFixtureConfigIsolationViolation` so the harness and the server cannot
 * drift into disagreeing about what "isolated" means.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIG_PATH_ENV_VAR,
  E2E_FIXTURE_ENV_VAR,
  findFixtureConfigIsolationViolation,
} from '../../server/runtime-state-paths.js';

/** Prefix for per-run config dirs, so stray ones are identifiable in tmp. */
export const E2E_CONFIG_DIR_PREFIX = 'relay-ide-e2e-';

/** Age past which an abandoned run's config dir is swept on the next mint. */
export const STALE_E2E_CONFIG_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

function assertIsolated(configPath: string, env: Env): void {
  const violation = findFixtureConfigIsolationViolation({
    explicitConfigPath: configPath,
    env,
  });
  if (violation) throw new Error(violation);
}

/** True when `dir` is a config dir this harness minted under `tmpRoot`. */
function isRunScopedConfigDir(dir: string, tmpRoot: string): boolean {
  const resolvedRoot = path.resolve(tmpRoot);
  const resolved = path.resolve(dir);
  return (
    path.dirname(resolved) === resolvedRoot &&
    path.basename(resolved).startsWith(E2E_CONFIG_DIR_PREFIX)
  );
}

/**
 * Remove abandoned run dirs older than `maxAgeMs`.
 *
 * `--list`, `--ui`, `--debug`, and any aborted run can leave a minted dir
 * behind — `globalTeardown` only fires for runs that actually start. On a
 * long-lived box those accumulate in `$TMPDIR`, and each one is a real config
 * dir a later run could be pointed at by accident. Best-effort by design: a
 * sweep failure must never take down the run it is trying to clean up after.
 */
export function sweepStaleE2eConfigDirs(
  tmpRoot: string = os.tmpdir(),
  maxAgeMs: number = STALE_E2E_CONFIG_DIR_MAX_AGE_MS,
  now: number = Date.now()
): string[] {
  const swept: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return swept;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(E2E_CONFIG_DIR_PREFIX)) continue;
    const dir = path.join(tmpRoot, entry.name);
    try {
      if (now - fs.statSync(dir).mtimeMs < maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      swept.push(dir);
    } catch {
      // A dir owned by another user, or already gone. Not this run's problem.
    }
  }
  return swept;
}

/**
 * Delete a config dir this harness minted. Anything else is left alone.
 *
 * The guard is the point: `globalTeardown` runs with whatever
 * `RELAY_IDE_CONFIG` ended up in the environment, and an inherited path must
 * never be removed just because a test run happened to use it.
 */
export function removeRunScopedE2eConfigDir(
  configPath: string | undefined,
  tmpRoot: string = os.tmpdir()
): boolean {
  if (!configPath) return false;
  const dir = path.dirname(path.resolve(configPath));
  if (!isRunScopedConfigDir(dir, tmpRoot)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a fresh config path under a per-run temp dir.
 *
 * Per *run*, not per checkout: a stable dir would carry a PIN (or any other
 * state a spec wrote) from the previous run into the next one, which is the
 * same class of failure as inheriting a deployed hub's config.
 */
export function createIsolatedE2eConfigPath(
  env: Env = process.env,
  tmpRoot: string = os.tmpdir()
): string {
  sweepStaleE2eConfigDirs(tmpRoot);
  const dir = fs.mkdtempSync(path.join(tmpRoot, E2E_CONFIG_DIR_PREFIX));
  const configPath = path.join(dir, 'config.json');
  // Paranoia that has actually paid off elsewhere: TMPDIR can be pointed
  // anywhere, including inside the shared config root.
  assertIsolated(configPath, env);
  return configPath;
}

export interface E2eConfigResolution {
  configPath: string;
  /** True when this call created the dir, so teardown may remove it. */
  minted: boolean;
}

/**
 * The config path the fixture web-server must boot with.
 *
 * An inherited `RELAY_IDE_CONFIG` is validated, never trusted. Two rules, both
 * enforced here and re-enforced by the server at boot:
 *
 *   - it must be outside every shared config root a deployed hub owns, and
 *   - it must be run-scoped: under `$TMPDIR`, in a `relay-ide-e2e-*` dir.
 *
 * The second rule is the one review asked for. "Not under ~/.config/relay-ide"
 * is not the same as isolated: a developer with
 * `RELAY_IDE_CONFIG=/srv/relay/hub/config.json` exported in their shell would
 * otherwise get exactly the silent override #1214 was about, one directory
 * over. Anything else aborts the run rather than quietly becoming the target.
 */
export function resolveE2eConfig(
  env: Env = process.env,
  tmpRoot: string = os.tmpdir()
): E2eConfigResolution {
  const inherited = env[CONFIG_PATH_ENV_VAR]?.trim();
  if (!inherited) {
    return { configPath: createIsolatedE2eConfigPath(env, tmpRoot), minted: true };
  }
  const configPath = path.resolve(inherited);
  assertIsolated(configPath, env);
  if (!isRunScopedConfigDir(path.dirname(configPath), tmpRoot)) {
    throw new Error(
      `${CONFIG_PATH_ENV_VAR}=${configPath} is not run-scoped: the e2e harness only accepts a ` +
        `config file inside a ${E2E_CONFIG_DIR_PREFIX}* directory under ${path.resolve(tmpRoot)}. ` +
        `Any other path is some hub's state — including one the shared-root check cannot see, ` +
        `such as a hub installed outside the Relay config roots. Unset ${CONFIG_PATH_ENV_VAR} and ` +
        `let the harness mint a fresh dir. (#1214)`
    );
  }
  return { configPath, minted: false };
}

/** `resolveE2eConfig`, for callers that only need the path. */
export function resolveE2eConfigPath(
  env: Env = process.env,
  tmpRoot: string = os.tmpdir()
): string {
  return resolveE2eConfig(env, tmpRoot).configPath;
}

export interface E2eWebServerEnvOptions {
  port: number;
  configPath: string;
  env?: Env | undefined;
}

/**
 * Environment for the fixture web-server command.
 *
 * Owning this here (rather than inlining `FOO=1 BAR=2 ...` in the Playwright
 * command string) keeps the isolation contract in one testable place and out of
 * shell quoting, where a temp path with a space would silently split.
 */
export function e2eWebServerEnv(
  options: E2eWebServerEnvOptions
): Record<string, string> {
  const env = options.env ?? process.env;
  assertIsolated(options.configPath, env);
  return {
    [E2E_FIXTURE_ENV_VAR]: '1',
    RELAY_IDE_PORT: String(options.port),
    [CONFIG_PATH_ENV_VAR]: path.resolve(options.configPath),
  };
}

export interface LazyE2eWebServerEnvOptions {
  port: number;
  /** Called the first time Playwright reads the config path off this object. */
  resolveConfigPath: () => string;
  env?: Env | undefined;
}

/**
 * The same environment, but the config path is resolved on first read.
 *
 * `playwright.config.ts` is loaded by every invocation, including ones that
 * never start a server: `--list` used to mint a `mkdtemp` dir and leave it
 * behind, and so did every aborted run. Playwright only reads `webServer.env`
 * when it is about to launch the server, so a getter defers the mint to the
 * point where a server actually exists to own it.
 */
export function lazyE2eWebServerEnv(
  options: LazyE2eWebServerEnvOptions
): Record<string, string> {
  const env = options.env ?? process.env;
  const serverEnv: Record<string, string> = {
    [E2E_FIXTURE_ENV_VAR]: '1',
    RELAY_IDE_PORT: String(options.port),
  };
  Object.defineProperty(serverEnv, CONFIG_PATH_ENV_VAR, {
    enumerable: true,
    configurable: true,
    get(): string {
      const configPath = path.resolve(options.resolveConfigPath());
      assertIsolated(configPath, env);
      return configPath;
    },
  });
  return serverEnv;
}
