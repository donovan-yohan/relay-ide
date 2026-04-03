import { test, expect } from '@playwright/test';

test.describe('ContextMenu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-context-menu.html');
    await page.waitForLoadState('networkidle');
  });

  test('menu is closed by default', async ({ page }) => {
    await expect(page.locator('.context-menu')).toHaveCount(0);
  });

  test('opens on trigger click', async ({ page }) => {
    await page.locator('.context-menu-trigger').first().click();
    await expect(page.locator('.context-menu').first()).toBeVisible();
  });

  test('renders menu items', async ({ page }) => {
    await page.locator('.context-menu-trigger').first().click();
    const items = page.locator('.context-menu .tui-menu-item');
    await expect(items).toHaveCount(4);
  });

  test('danger item has danger class', async ({ page }) => {
    await page.locator('.context-menu-trigger').first().click();
    await expect(page.locator('.tui-menu-item--danger').first()).toBeVisible();
  });

  test('disabled item has disabled class', async ({ page }) => {
    await page.locator('.context-menu-trigger').first().click();
    await expect(
      page.locator('.tui-menu-item--disabled').first()
    ).toBeVisible();
  });

  test('closes on Escape key', async ({ page }) => {
    await page.locator('.context-menu-trigger').first().click();
    await expect(page.locator('.context-menu').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.context-menu')).toHaveCount(0);
  });

  test('screenshot - default', async ({ page }) => {
    const el = page.locator('#test-container');
    await expect(el).toHaveScreenshot('context-menu-default.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
