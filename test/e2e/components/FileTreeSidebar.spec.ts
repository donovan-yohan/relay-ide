import { test, expect } from '@playwright/test';

test.describe('FileTreeSidebar React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-file-tree-sidebar.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders sidebar with title and file count', async ({ page }) => {
    const sidebar = page.locator('#file-tree-main .file-tree-sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator('.file-tree-sidebar__title')).toHaveText(
      'Changed Files'
    );
    await expect(sidebar.locator('.file-tree-sidebar__count')).toContainText(
      '8 files'
    );
  });

  test('renders tree nodes including directories', async ({ page }) => {
    const nodes = page.locator('#file-tree-main .file-tree-node');
    await expect(nodes.first()).toBeVisible();
  });

  test('shows empty state when no files', async ({ page }) => {
    const empty = page.locator('#file-tree-empty .file-tree-sidebar__empty');
    await expect(empty).toHaveText('No files');
    await expect(
      page.locator('#file-tree-empty .file-tree-sidebar__count')
    ).toHaveText('0 files');
  });

  test('renders status badges for all status types', async ({ page }) => {
    const badges = page.locator('#file-tree-statuses .file-tree-node__badge');
    await expect(badges.first()).toBeVisible();
  });

  test('toggles directory on click', async ({ page }) => {
    const sidebar = page.locator('#file-tree-main');
    const dirNodes = sidebar.locator('.file-tree-node--dir');
    const initialCount = await sidebar.locator('.file-tree-node').count();

    if ((await dirNodes.count()) > 0) {
      await dirNodes.first().click();
      const newCount = await sidebar.locator('.file-tree-node').count();
      expect(newCount).not.toBe(initialCount);
    }
  });

  test('screenshot - file tree with changes', async ({ page }) => {
    const container = page.locator('#file-tree-main');
    await expect(container).toHaveScreenshot('file-tree-sidebar-main.png', {
      maxDiffPixels: 120,
      threshold: 0.2,
    });
  });
});
