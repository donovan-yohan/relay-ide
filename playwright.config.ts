import { defineConfig, devices } from '@playwright/test';

import {
  lazyE2eWebServerEnv,
  resolveE2eConfig,
} from './test/e2e/isolated-config.js';

// #1214: the fixture server gets a run-scoped config dir, never the shared one
// a deployed hub owns. `resolveE2eConfig` throws rather than honoring an
// inherited `RELAY_IDE_CONFIG` that is not itself a run-scoped temp dir, and
// the server refuses the same paths at boot.
//
// Resolved lazily and memoised: this config module is loaded by every
// invocation, and `--list`/`--ui`/`--debug` never start a server. Minting at
// module scope left an orphan `mkdtemp` dir behind on each of those. The first
// read publishes the path into `process.env` so re-loads of this config
// (workers, the webServer child) reuse the dir instead of minting more.
let resolved: ReturnType<typeof resolveE2eConfig> | null = null;
function e2eConfigPath(): string {
  if (!resolved) {
    resolved = resolveE2eConfig();
    process.env.RELAY_IDE_CONFIG = resolved.configPath;
    // Only a dir this process created may be removed by globalTeardown.
    if (resolved.minted) {
      process.env.RELAY_IDE_E2E_MINTED_CONFIG = resolved.configPath;
    }
  }
  return resolved.configPath;
}

// Not 3456: that is the default port of an *installed* hub (`relay-ide hub`),
// and `reuseExistingServer` would happily point the whole suite at it — the
// deployed hub, not a fixture build (#1214). The port alone is not the
// safeguard though; `global-setup.ts` refuses to reuse any server whose
// `/healthz` does not report this run's config path.
const port = Number(process.env.PLAYWRIGHT_PORT ?? 3466);
const baseURL = `http://localhost:${port}`;
process.env.RELAY_IDE_E2E_BASE_URL = baseURL;
const startCommand =
  process.env.RELAY_IDE_E2E_SKIP_BUILD === '1'
    ? 'node dist/server/index.js'
    : 'npm run start';
const chromeChannel = process.env.PLAYWRIGHT_CHROME_CHANNEL;
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './test/e2e',
  // #1299: abort before launching a browser if any spec points at a fixture
  // page that does not exist or is not built. Such a spec reports green while
  // asserting nothing, which is worse than having no spec at all.
  globalSetup: './test/e2e/global-setup.ts',
  // #1214: drop this run's temp config dir, so an abandoned suite is the only
  // way one survives — and the next mint sweeps those.
  globalTeardown: './test/e2e/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: process.env.CI || executablePath ? 'off' : 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromeChannel ? { channel: chromeChannel } : {}),
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],

  webServer: {
    command: startCommand,
    // Env, not a `FOO=1 ... command` prefix: the config path is a temp dir and
    // a shell prefix loses to quoting. Playwright merges this over process.env
    // when it launches the server, which is also when the dir gets minted.
    env: lazyE2eWebServerEnv({ port, resolveConfigPath: e2eConfigPath }),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
