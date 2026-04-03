import { test, expect } from '@playwright/test';

test.describe('DialogShell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-dialog-shell.html');
  });

  test('compact dialog opens and closes', async ({ page }) => {
    await page.getByText('Open Compact Dialog').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Compact Dialog')).toBeVisible();
    await page.getByLabel('Close').click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('fullscreen dialog opens', async ({ page }) => {
    await page.getByText('Open Fullscreen Dialog').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Fullscreen Dialog')).toBeVisible();
  });

  test('dialog with footer and header extra', async ({ page }) => {
    await page.getByText('Open Dialog with Footer').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('extra info')).toBeVisible();
    await page.screenshot({ path: 'tests/screenshots/dialog-shell.png' });
  });
});
