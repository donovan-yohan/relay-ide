import { test, expect } from '@playwright/test';

test.describe('ImageToast React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-image-toast.html');
  });

  test('shows insert action when requested', async ({ page }) => {
    await page.locator('#show-insert').click();

    const toast = page.locator('.image-toast');
    await expect(toast).toBeVisible();
    await expect(page.locator('.image-toast-text')).toHaveText('Image ready to insert');
    await expect(page.locator('.image-toast button', { hasText: 'Insert' })).toBeVisible();
  });

  test('hides when dismissed', async ({ page }) => {
    await page.locator('#show-no-insert').click();
    await page.locator('.image-toast-dismiss').click();

    await expect(page.locator('.image-toast')).toBeHidden();
  });

  test('auto-dismisses when there is no pending image path', async ({ page }) => {
    await page.locator('#auto-dismiss').click();

    await expect(page.locator('.image-toast')).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page.locator('.image-toast')).toBeHidden();
  });

  test('does not auto-dismiss while an image path is pending', async ({ page }) => {
    await page.locator('#blocked-auto-dismiss').click();

    await page.waitForTimeout(200);
    await expect(page.locator('.image-toast')).toBeVisible();
    await expect(page.locator('.image-toast-text')).toHaveText('Keeps open while image path exists');
  });
});
