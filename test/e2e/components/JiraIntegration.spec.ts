import { test, expect } from '@playwright/test';

test.describe('JiraIntegration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-jira-integration.html');
  });

  test('renders Jira integration row', async ({ page }) => {
    await expect(page.getByText('Jira')).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.screenshot({
      path: 'test/e2e/screenshots/jira-integration.png',
    });
  });
});
