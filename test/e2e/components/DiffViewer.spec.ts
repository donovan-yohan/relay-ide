import { test, expect } from '@playwright/test';

test.describe('DiffViewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-diff-viewer.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders diff content', async ({ page }) => {
    await page.waitForSelector('#unified-view');
    const viewer = page.locator('#unified-view .diff-viewer');
    await expect(viewer).toBeVisible();
  });

  test('shows empty state when no diff', async ({ page }) => {
    const emptyViewer = page.locator('#empty-view .diff-empty');
    await expect(emptyViewer).toBeVisible();
    await expect(emptyViewer).toContainText('no changes');
  });

  test('shows loading state', async ({ page }) => {
    const loadingEl = page.locator('#loading-view .diff-loading');
    await expect(loadingEl).toBeVisible();
    await expect(loadingEl).toContainText('loading diff');
  });

  test('renders add and delete lines', async ({ page }) => {
    await page.waitForSelector('.diff-line');
    const addLine = page.locator('.diff-line.add').first();
    const deleteLine = page.locator('.diff-line.delete').first();
    await expect(addLine).toBeVisible();
    await expect(deleteLine).toBeVisible();
  });

  test('screenshot - unified view', async ({ page }) => {
    const el = page.locator('#test-container');
    await expect(el).toHaveScreenshot('diff-viewer-default.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
