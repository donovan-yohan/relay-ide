import { test, expect } from '@playwright/test';

test.describe('SessionItem React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-session-item.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders active session with selected state', async ({ page }) => {
    const selectedItem = page.locator('.session-item.selected');
    await expect(selectedItem).toBeVisible();
    await expect(selectedItem).toHaveClass(/active-session/);
  });

  test('renders inactive worktree variant', async ({ page }) => {
    const inactiveItem = page.locator('.session-item.inactive-worktree');
    await expect(inactiveItem.first()).toBeVisible();
  });

  test('shows branch name in row 2', async ({ page }) => {
    const firstItem = page.locator('.session-item').first();
    await expect(firstItem.locator('.session-branch')).toBeVisible();
  });

  test('shows PR icon for open PR', async ({ page }) => {
    const prIcon = page.locator('.pr-icon.pr-open');
    await expect(prIcon).toBeVisible();
  });

  test('shows git diff stats', async ({ page }) => {
    await expect(page.locator('.diff-add').first()).toBeVisible();
    await expect(page.locator('.diff-del').first()).toBeVisible();
  });

  test('loading state disables pointer events', async ({ page }) => {
    const loadingItem = page.locator('.session-item.loading');
    await expect(loadingItem).toBeVisible();
    await expect(loadingItem).toHaveCSS('pointer-events', 'none');
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('session-item.png', { fullPage: true });
  });
});
