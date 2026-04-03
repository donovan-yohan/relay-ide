import { test, expect } from '@playwright/test';

test.describe('WorkspaceItem React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-workspace-item.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders workspace header with initial block', async ({ page }) => {
    const header = page.locator('.workspace-header').first();
    await expect(header).toBeVisible();
    await expect(header.locator('.initial-block')).toBeVisible();
    await expect(header.locator('.workspace-name')).toContainText('my-project');
  });

  test('renders active session rows', async ({ page }) => {
    const firstItem = page.locator('.workspace-item').first();
    await expect(firstItem.locator('.session-row').first()).toBeVisible();
  });

  test('renders inactive worktree rows', async ({ page }) => {
    await expect(page.locator('.session-row.inactive').first()).toBeVisible();
  });

  test('shows selected session with accent border', async ({ page }) => {
    const selected = page.locator('.session-row.selected');
    await expect(selected).toBeVisible();
  });

  test('shows session count badge for multi-session groups', async ({ page }) => {
    await expect(page.locator('.session-count-badge')).toBeVisible();
  });

  test('shows add worktree button', async ({ page }) => {
    await expect(page.locator('.add-worktree-btn').first()).toBeVisible();
    await expect(page.locator('.add-worktree-btn').first()).toContainText('+ new worktree');
  });

  test('shows loading state for resuming worktree', async ({ page }) => {
    const loadingRow = page.locator('.session-row.loading');
    await expect(loadingRow).toBeVisible();
    await expect(loadingRow.locator('.session-name')).toContainText('resuming...');
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('workspace-item.png', { fullPage: true });
  });
});
