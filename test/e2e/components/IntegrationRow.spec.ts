import { test, expect } from '@playwright/test';

test.describe('IntegrationRow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-integration-row.html');
  });

  test('renders integration name and status', async ({ page }) => {
    await expect(page.getByText('GitHub')).toBeVisible();
    await expect(page.getByText('Connected as @user')).toBeVisible();
  });

  test('shows expanded content when expanded=true', async ({ page }) => {
    await expect(
      page.getByText('Setup webhooks to get real-time updates.')
    ).toBeVisible();
  });

  test('shows loading state', async ({ page }) => {
    await expect(page.getByText('Jira')).toBeVisible();
    await expect(page.getByText('loading...')).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.screenshot({ path: 'test/e2e/screenshots/integration-row.png' });
  });
});
