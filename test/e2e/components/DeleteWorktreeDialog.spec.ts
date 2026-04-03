import { test, expect } from '@playwright/test';

test.describe('DeleteWorktreeDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-delete-worktree-dialog.html');
  });

  test('opens with worktree info', async ({ page }) => {
    await page.getByText('Open Delete Dialog').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Delete Worktree')).toBeVisible();
    await expect(page.getByText('feat-new-feature')).toBeVisible();
    await expect(page.getByText('This action cannot be undone.')).toBeVisible();
  });

  test('has Delete and Cancel buttons', async ({ page }) => {
    await page.getByText('Open Delete Dialog').click();
    await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('closes on Cancel', async ({ page }) => {
    await page.getByText('Open Delete Dialog').click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.getByText('Open Delete Dialog').click();
    await page.screenshot({
      path: 'test/e2e/screenshots/delete-worktree-dialog.png',
    });
  });
});
