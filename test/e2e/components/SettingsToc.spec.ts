import { test, expect } from '@playwright/test';

test.describe('SettingsToc', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-settings-toc.html');
  });

  test('renders section links', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'general' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'integrations' })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'advanced' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'about' })).toBeVisible();
  });

  test('renders child section links', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Webhooks' })).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.screenshot({ path: 'test/e2e/screenshots/settings-toc.png' });
  });
});
