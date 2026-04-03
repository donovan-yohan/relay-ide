import { test, expect } from '@playwright/test';

test.describe('Sidebar', () => {
  test('renders correctly', async ({ page }) => {
    await page.goto('/test-sidebar.html');
    await page.waitForSelector('#app');
  });

  test('shows sidebar element', async ({ page }) => {
    await page.goto('/test-sidebar.html');
    await page.waitForSelector('.sidebar');
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('shows sidebar header', async ({ page }) => {
    await page.goto('/test-sidebar.html');
    await page.waitForSelector('.sidebar-header');
    await expect(page.locator('.sidebar-header')).toBeVisible();
  });

  test('shows collapse button', async ({ page }) => {
    await page.goto('/test-sidebar.html');
    await page.waitForSelector('.sidebar-collapse-btn');
    await expect(page.locator('.sidebar-collapse-btn')).toBeVisible();
  });

  test('shows footer with add workspace button', async ({ page }) => {
    await page.goto('/test-sidebar.html');
    await page.waitForSelector('.sidebar-footer-row');
    await expect(page.locator('.sidebar-footer-row')).toBeVisible();
  });

  test('shows scanline overlay', async ({ page }) => {
    await page.goto('/test-sidebar.html');
    await page.waitForSelector('.sidebar');
    await expect(page.locator('.sidebar-scanline-overlay')).toBeAttached();
  });
});
