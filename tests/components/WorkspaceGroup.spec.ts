import { test, expect } from '@playwright/test';

test.describe('WorkspaceGroup React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-workspace-group.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders expanded group with repos', async ({ page }) => {
    const group = page.locator('.workspace-group').first();
    await expect(group).toBeVisible();
    await expect(group.locator('.group-header')).toBeVisible();
    await expect(group.locator('.group-body')).toBeVisible();
  });

  test('renders collapsed group with session count badge', async ({ page }) => {
    const collapsed = page.locator('.workspace-group.collapsed');
    await expect(collapsed.first()).toBeVisible();
    await expect(collapsed.first().locator('.session-count')).toBeVisible();
  });

  test('shows group name', async ({ page }) => {
    await expect(page.locator('.group-name').first()).toContainText('my-workspace');
  });

  test('shows launch button', async ({ page }) => {
    const launchBtn = page.locator('.launch-row .tui-btn').first();
    await expect(launchBtn).toBeVisible();
    await expect(launchBtn).toContainText('launch workspace session');
  });

  test('shows launching state with spinner', async ({ page }) => {
    // Third group has launching=true
    const launchingGroup = page.locator('.workspace-group').nth(2);
    await expect(launchingGroup.locator('.launch-row').locator('text=launching...')).toBeVisible();
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('workspace-group.png', { fullPage: true });
  });
});
