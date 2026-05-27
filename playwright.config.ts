import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3456);
const baseURL = `http://localhost:${port}`;
const startCommand =
  process.env.RELAY_IDE_E2E_SKIP_BUILD === '1'
    ? 'node dist/server/index.js'
    : 'npm run start';
const chromeChannel = process.env.PLAYWRIGHT_CHROME_CHANNEL;
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './test/e2e',
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
    command: `RELAY_IDE_E2E_FIXTURES=1 RELAY_IDE_PORT=${port} ${startCommand}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
