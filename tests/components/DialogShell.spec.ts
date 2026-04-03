import { test, expect } from '@playwright/test';

test.describe('DialogShell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-dialog-shell.html');
    await page.waitForLoadState('networkidle');
  });

  test('dialog is closed by default', async ({ page }) => {
    await expect(page.locator('.dialog-shell[open]')).toHaveCount(0);
  });

  test('opens compact dialog on button click', async ({ page }) => {
    await page.getByText('open compact').click();
    await expect(page.locator('.dialog-shell--compact[open]')).toBeVisible();
    await expect(page.locator('.dialog-shell__title')).toContainText('compact dialog');
  });

  test('closes dialog via close button', async ({ page }) => {
    await page.getByText('open compact').click();
    await expect(page.locator('.dialog-shell--compact[open]')).toBeVisible();
    await page.locator('.dialog-shell__close').click();
    await expect(page.locator('.dialog-shell[open]')).toHaveCount(0);
  });

  test('opens fullscreen dialog', async ({ page }) => {
    await page.getByText('open fullscreen').click();
    await expect(page.locator('.dialog-shell--fullscreen[open]')).toBeVisible();
  });

  test('renders footer when provided', async ({ page }) => {
    await page.getByText('open with footer').click();
    await expect(page.locator('.dialog-shell__footer')).toBeVisible();
  });

  test('screenshot - default', async ({ page }) => {
    const el = page.locator('#test-container');
    await expect(el).toHaveScreenshot('dialog-shell-default.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
