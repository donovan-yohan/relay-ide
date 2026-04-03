import { test, expect } from '@playwright/test';

test.describe('PrTopBar React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-pr-top-bar.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders PR top bar with branch switcher', async ({ page }) => {
    const bar = page.locator('.pr-top-bar').first();
    await expect(bar).toBeVisible();
    await expect(bar.locator('.bar-left')).toBeVisible();
    await expect(bar.locator('.bar-right')).toBeVisible();
  });

  test('shows branch switcher in bar-left', async ({ page }) => {
    const branchTrigger = page.locator('.pr-top-bar').first().locator('.branch-trigger');
    await expect(branchTrigger).toBeVisible();
    await expect(branchTrigger).toContainText('feat/auth');
  });

  test('shows refresh button', async ({ page }) => {
    await expect(page.locator('.refresh-btn').first()).toBeVisible();
  });

  test('disabled agent running state applies to rename button', async ({ page }) => {
    const disabledBar = page.locator('.pr-top-bar').nth(1);
    await expect(disabledBar).toBeVisible();
    const renameBtn = disabledBar.locator('.hover-icon').nth(1);
    await disabledBar.locator('.branch-with-actions').hover();
    await expect(renameBtn).toBeDisabled();
  });

  test('hover reveals copy and rename icons', async ({ page }) => {
    const bar = page.locator('.pr-top-bar').first();
    await bar.locator('.branch-with-actions').hover();
    await expect(bar.locator('.hover-icons')).toBeVisible();
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('pr-top-bar.png', { fullPage: true });
  });
});
