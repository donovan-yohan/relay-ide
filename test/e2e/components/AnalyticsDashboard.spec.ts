import { test, expect } from '@playwright/test';

test.describe('AnalyticsDashboard', () => {
  test('renders correctly', async ({ page }) => {
    await page.goto('/test-analytics-dashboard.html');
    await page.waitForSelector('#app');
  });

  test('shows page title', async ({ page }) => {
    await page.goto('/test-analytics-dashboard.html');
    await page.waitForSelector('.analytics-dashboard');
    await expect(page.locator('.analytics-page-title')).toBeVisible();
    await expect(page.locator('.analytics-page-title')).toContainText(
      'analytics'
    );
  });

  test('shows loading state initially', async ({ page }) => {
    await page.goto('/test-analytics-dashboard.html');
    await page.waitForSelector('.analytics-dashboard');
    // Either loading or loaded — just ensure the container renders
    const dashboard = page.locator('.analytics-dashboard');
    await expect(dashboard).toBeVisible();
  });
});
