import path from 'node:path';

import type { FullConfig } from '@playwright/test';

import {
  findFixtureTargetViolations,
  findOrphanFixtures,
  formatFixtureTargetViolations,
  formatOrphanFixtures,
} from './fixture-targets.js';
import { CONFIG_PATH_ENV_VAR } from '../../server/runtime-state-paths.js';

/**
 * Playwright global setup: refuse to start a run that cannot mean anything.
 *
 * Two refusals, both about green runs that are not evidence:
 *
 *   1. A spec pointed at a missing fixture page reports "passed" for assertions
 *      it never reached (#1299). Failing here rather than inside each spec
 *      makes the breakage impossible to read as coverage.
 *   2. `reuseExistingServer` adopts whatever is already listening on the e2e
 *      port without asking what config it holds. A leftover server from an
 *      aborted run would serve the whole suite off a stale temp dir — the same
 *      "it only passed because a stale server got recycled" failure #1214 was
 *      about, relocated rather than closed. The port default (3466, not the
 *      installed hub's 3456) lowers the odds; this check removes them.
 */

const PROBE_TIMEOUT_MS = 2_000;

function expectedConfigPath(config: FullConfig): string | null {
  const webServer = Array.isArray(config.webServer)
    ? config.webServer[0]
    : config.webServer;
  const configured = webServer?.env?.[CONFIG_PATH_ENV_VAR];
  return typeof configured === 'string' ? path.resolve(configured) : null;
}

function baseUrl(config: FullConfig): string | null {
  return (
    config.projects[0]?.use?.baseURL ??
    process.env.RELAY_IDE_E2E_BASE_URL ??
    null
  );
}

/**
 * Refuse to reuse a server that is not this run's fixture server.
 *
 * Nothing listening is the normal case: Playwright starts ours next. Anything
 * that answers has to prove it booted with the config path this run resolved,
 * which only the fixture server reports (`fixtureConfigPath` on `/healthz`).
 */
async function assertNoForeignServer(config: FullConfig): Promise<void> {
  const url = baseUrl(config);
  const expected = expectedConfigPath(config);
  if (!url || !expected) return;

  let payload: unknown;
  try {
    const response = await fetch(new URL('/healthz', url), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    payload = await response.json();
  } catch {
    // Connection refused, or something that is not a Relay health endpoint and
    // did not answer with JSON. Either way there is nothing to adopt.
    return;
  }

  const reported = (payload as { fixtureConfigPath?: unknown } | null)
    ?.fixtureConfigPath;
  if (typeof reported === 'string' && path.resolve(reported) === expected) {
    return;
  }
  throw new Error(
    [
      `Something is already listening on ${url} and it is not this run's fixture server (#1214/#1299).`,
      `  expected ${CONFIG_PATH_ENV_VAR}=${expected}`,
      `  /healthz reported ${
        typeof reported === 'string'
          ? reported
          : '(no fixtureConfigPath — not a fixture-mode Relay server)'
      }`,
      '',
      'reuseExistingServer would have adopted it and run the whole suite against that config,',
      'so a green result would only prove a stale or foreign server answered. Stop that process,',
      'or point PLAYWRIGHT_PORT at a free port.',
    ].join('\n')
  );
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const violations = findFixtureTargetViolations();
  if (violations.length > 0) {
    throw new Error(formatFixtureTargetViolations(violations));
  }
  const orphans = findOrphanFixtures();
  if (orphans.length > 0) {
    throw new Error(formatOrphanFixtures(orphans));
  }
  await assertNoForeignServer(config);
}
