import { removeRunScopedE2eConfigDir } from './isolated-config.js';

/**
 * Drop the temp config dir this run minted (#1214).
 *
 * Only a dir `playwright.config.ts` created is removed — the env var is set at
 * mint time and nowhere else, so an inherited path is never touched. Runs that
 * abort before teardown still leave one behind; the next mint sweeps those.
 */
export default function globalTeardown(): void {
  removeRunScopedE2eConfigDir(process.env.RELAY_IDE_E2E_MINTED_CONFIG);
}
