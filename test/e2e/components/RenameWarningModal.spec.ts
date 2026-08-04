import { test, expect } from '@playwright/test';

test.describe('RenameWarningModal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-rename-warning-modal.html');
  });

  test('shows branch rename info', async ({ page }) => {
    await page.getByText('Show Rename Warning').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Branch Renamed')).toBeVisible();
    await expect(page.getByText('feat/old-branch')).toBeVisible();
    await expect(page.getByText('feat/new-branch')).toBeVisible();
  });

  test('has Push, Ignore, Cancel buttons', async ({ page }) => {
    await page.getByText('Show Rename Warning').click();
    await expect(page.getByRole('button', { name: 'Push' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ignore' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancel/ })).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.getByText('Show Rename Warning').click();
    await page.screenshot({
      path: 'test/e2e/screenshots/rename-warning-modal.png',
    });
  });
});
