import { test, expect } from '@playwright/test';

test.describe('AutomationPanel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-automation-panel.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders panel header', async ({ page }) => {
    await page.waitForSelector('#test-container');
    const panel = page.locator('.automation-panel').first();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.panel-title')).toBeVisible();
  });

  test('shows loading or settings content', async ({ page }) => {
    await page.waitForSelector('.automation-panel');
    const panel = page.locator('.automation-panel').first();
    await expect(panel).toBeVisible();
    const loadingOrContent = page.locator('.panel-loading, .toggle-list, .panel-error');
    await expect(loadingOrContent.first()).toBeVisible();
  });

  test('screenshot - default', async ({ page }) => {
    const el = page.locator('#test-container');
    await expect(el).toHaveScreenshot('automation-panel-default.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
