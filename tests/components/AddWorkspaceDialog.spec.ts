import { test, expect } from '@playwright/test';

test.describe('AddWorkspaceDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-add-workspace-dialog.html');
  });

  test('opens dialog with description', async ({ page }) => {
    await page.getByText('Add Workspace').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Add Workspace').nth(1)).toBeVisible();
    await expect(page.getByText('Browse for folders')).toBeVisible();
  });

  test('has Add Workspace and Cancel buttons', async ({ page }) => {
    await page.getByText('Add Workspace').click();
    await expect(page.getByRole('button', { name: /Add Workspace/ }).nth(1)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.getByText('Add Workspace').click();
    await page.screenshot({ path: 'tests/screenshots/add-workspace-dialog.png' });
  });
});
