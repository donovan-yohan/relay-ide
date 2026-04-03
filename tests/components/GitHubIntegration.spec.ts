import { test, expect } from '@playwright/test';

test.describe('GitHubIntegration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-github-integration.html');
  });

  test('renders GitHub integration row', async ({ page }) => {
    await expect(page.getByText('GitHub').first()).toBeVisible();
  });

  test('shows reauth warning when needsReauth=true', async ({ page }) => {
    await expect(page.getByText('Re-connect to enable webhook management')).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.screenshot({ path: 'tests/screenshots/github-integration.png' });
  });
});
