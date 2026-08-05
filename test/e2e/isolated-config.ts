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

type Env = Record<string, string | undefined>;

function assertIsolated(configPath: string, env: Env): void {
  const violation = findFixtureConfigIsolationViolation({
    explicitConfigPath: configPath,
    env,
  });
  if (violation) throw new Error(violation);
}

/**
 * Create a fresh config path under a per-run temp dir.
 *
 * Per *run*, not per checkout: a stable dir would carry a PIN (or any other
 * state a spec wrote) from the previous run into the next one, which is the
 * same class of failure as inheriting a deployed hub's config. The OS reclaims
 * tmp; nothing here is meant to outlive the run.
 */
export function createIsolatedE2eConfigPath(
  env: Env = process.env,
  tmpRoot: string = os.tmpdir()
): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, E2E_CONFIG_DIR_PREFIX));
  const configPath = path.join(dir, 'config.json');
  // Paranoia that has actually paid off elsewhere: TMPDIR can be pointed
  // anywhere, including inside the shared config root.
  assertIsolated(configPath, env);
  return configPath;
}

/**
 * The config path the fixture web-server must boot with.
 *
 * An inherited `RELAY_IDE_CONFIG` (a developer pointing a shell at their dev or
 * deployed hub) is a hard failure, not a silent override — that is the exact
 * path that poisoned #1214.
 */
export function resolveE2eConfigPath(
  env: Env = process.env,
  tmpRoot: string = os.tmpdir()
): string {
  const inherited = env[CONFIG_PATH_ENV_VAR]?.trim();
  if (inherited) {
    assertIsolated(inherited, env);
    return path.resolve(inherited);
  }
  return createIsolatedE2eConfigPath(env, tmpRoot);
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
