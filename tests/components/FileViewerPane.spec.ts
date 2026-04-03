import { test, expect } from '@playwright/test';

test.describe('FileViewerPane React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-file-viewer-pane.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders file viewer with tab bar', async ({ page }) => {
    const viewer = page.locator('.file-viewer');
    await expect(viewer).toBeVisible();
  });

  test('shows empty state when no tabs open', async ({ page }) => {
    const empty = page.locator('.empty-viewer');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('select a file from the sidebar');
  });

  test('renders tab bar actions row', async ({ page }) => {
    const tabBar = page.locator('.file-tab-bar');
    await expect(tabBar).toBeVisible();
  });

  test('shows word wrap toggle button', async ({ page }) => {
    const wrapBtn = page.locator('.diff-mode-btn');
    await expect(wrapBtn.first()).toBeVisible();
  });

  test('shows send-to pill', async ({ page }) => {
    const pill = page.locator('.send-to-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('send to:');
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('file-viewer-pane.png', { fullPage: true });
  });
});
