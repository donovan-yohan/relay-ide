import { test, expect } from '@playwright/test';

test.describe('WorkspaceSettingsDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-workspace-settings-dialog.html');
  });

  test('opens dialog', async ({ page }) => {
    await page.getByText('Open Workspace Settings').click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('has Save and Remove Workspace buttons', async ({ page }) => {
    await page.getByText('Open Workspace Settings').click();
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Workspace' })).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.getByText('Open Workspace Settings').click();
    await page.screenshot({ path: 'tests/screenshots/workspace-settings-dialog.png' });
  });
});
