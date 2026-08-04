import { test, expect } from '@playwright/test';

test.describe('BootScreen React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-boot-screen.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders loading state with app name and status text', async ({
    page,
  }) => {
    const screen = page.locator('#boot-loading .boot-screen');
    await expect(screen).toBeVisible();
    await expect(screen.locator('.boot-screen__logo')).toHaveText(
      'claude-remote'
    );
    await expect(screen.locator('.boot-screen__status')).toHaveText(
      'Connecting to server...'
    );
  });

  test('shows loading dots in loading state', async ({ page }) => {
    const dots = page.locator('#boot-loading .boot-screen__dot');
    await expect(dots).toHaveCount(3);
  });

  test('renders error state with error message', async ({ page }) => {
    const screen = page.locator('#boot-error .boot-screen');
    await expect(screen).toBeVisible();
    await expect(screen.locator('.boot-screen__error')).toContainText(
      'Unable to connect to the server.'
    );
    await expect(screen.locator('.boot-screen__dots')).toHaveCount(0);
  });

  test('ready state shows no loading indicators', async ({ page }) => {
    const screen = page.locator('#boot-ready .boot-screen');
    await expect(screen).toBeVisible();
    await expect(screen.locator('.boot-screen__dot')).toHaveCount(0);
    await expect(screen.locator('.boot-screen__error')).toHaveCount(0);
  });

  test('custom app name is displayed', async ({ page }) => {
    const logo = page.locator('#boot-custom-name .boot-screen__logo');
    await expect(logo).toHaveText('my-app-remote');
  });

  test('screenshot - loading state', async ({ page }) => {
    const container = page.locator('#boot-loading');
    await expect(container).toHaveScreenshot('boot-screen-loading.png', {
      maxDiffPixels: 120,
      threshold: 0.2,
    });
  });
});
