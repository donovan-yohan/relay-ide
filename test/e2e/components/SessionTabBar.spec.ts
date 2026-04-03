import { test, expect } from '@playwright/test';

test.describe('SessionTabBar React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-session-tab-bar.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders tab bar with session tabs', async ({ page }) => {
    await expect(page.locator('.session-tab-bar').first()).toBeVisible();
    await expect(page.locator('.tab')).toHaveCount(3);
  });

  test('active tab has active class', async ({ page }) => {
    await expect(page.locator('.tab--active')).toBeVisible();
    await expect(page.locator('.tab--active')).toHaveCount(1);
  });

  test('clicking a tab selects it', async ({ page }) => {
    const tabs = page.locator('.session-tab-bar').first().locator('.tab');
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveClass(/tab--active/);
  });

  test('new session menu opens on plus button click', async ({ page }) => {
    await page.locator('.tab-new').first().click();
    await expect(page.locator('.new-menu')).toBeVisible();
    await expect(page.locator('.new-menu-item')).toHaveCount(3);
  });

  test('new menu closes on Escape', async ({ page }) => {
    await page.locator('.tab-new').first().click();
    await expect(page.locator('.new-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.new-menu')).toHaveCount(0);
  });

  test('renders terminal and agent icons', async ({ page }) => {
    const tabIcons = page.locator('.tab-icon');
    await expect(tabIcons.first()).toBeVisible();
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('session-tab-bar.png', {
      fullPage: true,
    });
  });
});
