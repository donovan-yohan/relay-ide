import { test, expect } from '@playwright/test';

test.describe('ChangedFiles', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-changed-files.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders summary bar', async ({ page }) => {
    await page.waitForSelector('#test-container');
    const bar = page.locator('.summary-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.summary-label')).toContainText('changed files');
  });

  test('files content is hidden by default', async ({ page }) => {
    const content = page.locator('.files-content');
    await expect(content).not.toBeVisible();
  });

  test('expands on click', async ({ page }) => {
    await page.click('.summary-bar');
    const content = page.locator('.files-content');
    await expect(content).toBeVisible();
  });

  test('shows diff source toggle when expanded', async ({ page }) => {
    await page.click('.summary-bar');
    const toggle = page.locator('.diff-source-toggle');
    await expect(toggle).toBeVisible();
  });

  test('screenshot - collapsed', async ({ page }) => {
    const el = page.locator('#test-container');
    await expect(el).toHaveScreenshot('changed-files-collapsed.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
