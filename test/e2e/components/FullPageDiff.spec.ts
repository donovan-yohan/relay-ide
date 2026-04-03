import { test, expect } from '@playwright/test';

test.describe('FullPageDiff', () => {
  test('renders correctly', async ({ page }) => {
    await page.goto('/test-full-page-diff.html');
    await page.waitForSelector('#app');
  });

  test('shows header with close button', async ({ page }) => {
    await page.goto('/test-full-page-diff.html');
    await page.waitForSelector('.full-page-diff');
    await expect(page.locator('.fpd-header')).toBeVisible();
    await expect(page.locator('.fpd-close-btn')).toBeVisible();
    await expect(page.locator('.fpd-close-btn')).toContainText('[x] close');
  });

  test('shows footer with keyboard hints', async ({ page }) => {
    await page.goto('/test-full-page-diff.html');
    await page.waitForSelector('.full-page-diff');
    await expect(page.locator('.fpd-footer')).toBeVisible();
    const hints = page.locator('.fpd-hint');
    await expect(hints.first()).toBeVisible();
  });

  test('shows body with sidebar and main pane', async ({ page }) => {
    await page.goto('/test-full-page-diff.html');
    await page.waitForSelector('.full-page-diff');
    await expect(page.locator('.fpd-body')).toBeVisible();
    await expect(page.locator('.fpd-main')).toBeVisible();
  });

  test('mode toggle button is visible', async ({ page }) => {
    await page.goto('/test-full-page-diff.html');
    await page.waitForSelector('.full-page-diff');
    await expect(page.locator('.fpd-mode-toggle')).toBeVisible();
  });
});
