import { test, expect } from '@playwright/test';

test.describe('UpdateToast React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          current: '1.0.0',
          latest: '1.1.0',
          updateAvailable: true,
          channel: 'stable',
        }),
      });
    });

    await page.route('**/update', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, restarting: false }),
      });
    });

    const versionResponse = page.waitForResponse('**/version');
    await page.goto('/test-update-toast.html');
    await versionResponse;
  });

  test('shows the update toast when an update is available', async ({
    page,
  }) => {
    const toast = page.locator('.update-toast');
    await expect(toast).toBeVisible();
    await expect(page.locator('.update-toast-text')).toHaveText(
      'Update available: v1.0.0 → v1.1.0'
    );
    await expect(page.locator('.update-toast-actions')).toBeVisible();
    await expect(
      page.locator('.update-toast button', { hasText: 'Update Now' })
    ).toBeVisible();
  });

  test('hides the toast when dismissed', async ({ page }) => {
    await page.locator('.update-toast-dismiss').click();
    await expect(page.locator('.update-toast')).toBeHidden();
  });

  test('updates text and hides actions after triggering update', async ({
    page,
  }) => {
    await page
      .locator('.update-toast button', { hasText: 'Update Now' })
      .click();

    await expect(page.locator('.update-toast-text')).toHaveText(
      'Updated! Please restart the server manually.'
    );
    await expect(page.locator('.update-toast-actions')).toBeHidden();
  });
});
