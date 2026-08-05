import { defineConfig, devices } from '@playwright/test';

import {
  e2eWebServerEnv,
  resolveE2eConfigPath,
} from './test/e2e/isolated-config.js';

// #1214: the fixture server gets a run-scoped config dir, never the shared one
// a deployed hub owns. Resolved once in the Playwright main process and pushed
// into `process.env` so re-loads of this config (workers, the webServer child)
// reuse that dir instead of minting more. `resolveE2eConfigPath` throws rather
// than honoring an inherited `RELAY_IDE_CONFIG` that points at a shared root,
// and the server refuses the same paths at boot.
const configPath = resolveE2eConfigPath();
process.env.RELAY_IDE_CONFIG = configPath;

// Not 3456: that is the default port of an *installed* hub (`relay-ide hub`),
// and `reuseExistingServer` would happily point the whole suite at it — the
// deployed hub, not a fixture build (#1214).
const port = Number(process.env.PLAYWRIGHT_PORT ?? 3466);
const baseURL = `http://localhost:${port}`;
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
    // a shell prefix loses to quoting. Playwright merges this over process.env.
    env: e2eWebServerEnv({ port, configPath }),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
