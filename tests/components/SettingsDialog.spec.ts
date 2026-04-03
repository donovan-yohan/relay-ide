import { test, expect } from '@playwright/test';

test.describe('SettingsDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-settings-dialog.html');
  });

  test('opens fullscreen settings dialog', async ({ page }) => {
    await page.getByText('Open Settings').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('settings')).toBeVisible();
  });

  test('has general, integrations, advanced, about sections', async ({ page }) => {
    await page.getByText('Open Settings').click();
    await expect(page.getByText('general').first()).toBeVisible();
    await expect(page.getByText('integrations').first()).toBeVisible();
    await expect(page.getByText('advanced').first()).toBeVisible();
    await expect(page.getByText('about').first()).toBeVisible();
  });

  test('has search input', async ({ page }) => {
    await page.getByText('Open Settings').click();
    await expect(page.getByPlaceholder('Search...')).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.getByText('Open Settings').click();
    await page.screenshot({ path: 'tests/screenshots/settings-dialog.png' });
  });
});
