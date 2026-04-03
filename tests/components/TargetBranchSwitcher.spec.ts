import { test, expect } from '@playwright/test';

test.describe('TargetBranchSwitcher React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-target-branch-switcher.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders trigger button with current base branch', async ({ page }) => {
    const trigger = page.locator('.target-trigger').first();
    await expect(trigger).toBeVisible();
    await expect(trigger.locator('.target-name')).toContainText('main');
  });

  test('opens dropdown on click', async ({ page }) => {
    await page.locator('.target-trigger').first().click();
    await expect(page.locator('.target-dropdown')).toBeVisible();
    await expect(page.locator('.target-filter')).toBeVisible();
  });

  test('closes dropdown on Escape key', async ({ page }) => {
    await page.locator('.target-trigger').first().click();
    await expect(page.locator('.target-dropdown')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.target-dropdown')).toHaveCount(0);
  });

  test('disabled trigger does not open dropdown', async ({ page }) => {
    const disabledTrigger = page.locator('.target-disabled');
    await expect(disabledTrigger).toBeVisible();
    await disabledTrigger.click({ force: true });
    await expect(page.locator('.target-dropdown')).toHaveCount(0);
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('target-branch-switcher.png', { fullPage: true });
  });
});
