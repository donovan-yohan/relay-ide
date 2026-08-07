import { test, expect } from '@playwright/test';

test.describe('SettingRow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-setting-row.html');
  });

  test('renders name and action slot', async ({ page }) => {
    await expect(page.getByText('Dark Mode')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle' })).toBeVisible();
  });

  test('renders description when provided', async ({ page }) => {
    await expect(
      page.getByText('Send alerts when sessions need attention')
    ).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.screenshot({ path: 'test/e2e/screenshots/setting-row.png' });
  });
});
