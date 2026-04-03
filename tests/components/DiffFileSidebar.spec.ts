import { test, expect } from '@playwright/test';

test.describe('DiffFileSidebar React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-diff-file-sidebar.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders file list with status icons and diff stats', async ({ page }) => {
    const sidebar = page.locator('.diff-sidebar').first();
    await expect(sidebar).toBeVisible();
    const files = sidebar.locator('.sidebar-file');
    await expect(files).toHaveCount(8);
  });

  test('shows active file with highlight', async ({ page }) => {
    const activeFile = page.locator('.sidebar-file.active');
    await expect(activeFile).toBeVisible();
    await expect(activeFile).toContainText('SessionItem.tsx');
  });

  test('clicking a file makes it active', async ({ page }) => {
    const files = page.locator('.diff-sidebar').first().locator('.sidebar-file');
    await files.nth(0).click();
    await expect(files.nth(0)).toHaveClass(/active/);
  });

  test('shows addition and deletion counts', async ({ page }) => {
    const firstFile = page.locator('.diff-sidebar').first().locator('.sidebar-file').first();
    await expect(firstFile.locator('.stat-add')).toContainText('+');
    await expect(firstFile.locator('.stat-del')).toContainText('-');
  });

  test('empty state renders without error', async ({ page }) => {
    const emptySidebar = page.locator('.diff-sidebar').nth(1);
    await expect(emptySidebar).toBeVisible();
    await expect(emptySidebar.locator('.sidebar-file')).toHaveCount(0);
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('diff-file-sidebar.png', { fullPage: true });
  });
});
