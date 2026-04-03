import { test, expect } from '@playwright/test';

test.describe('WebhookIntegration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-webhook-integration.html');
  });

  test('renders webhook integration rows', async ({ page }) => {
    const webhooksHeadings = page.getByText('Webhooks');
    await expect(webhooksHeadings.first()).toBeVisible();
  });

  test('shows "Connect GitHub first" when not connected', async ({ page }) => {
    await expect(page.getByText('Connect GitHub first')).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.screenshot({ path: 'tests/screenshots/webhook-integration.png' });
  });
});
