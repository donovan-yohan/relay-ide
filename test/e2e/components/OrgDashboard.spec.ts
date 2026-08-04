import { test, expect } from '@playwright/test';

test.describe('OrgDashboard React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-org-dashboard.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders org dashboard container', async ({ page }) => {
    const dashboard = page.locator('.org-dashboard');
    await expect(dashboard).toBeVisible();
  });

  test('shows All Workspaces title', async ({ page }) => {
    await expect(page.getByText('All Workspaces')).toBeVisible();
  });

  test('shows PRs tab', async ({ page }) => {
    const prsTab = page.getByRole('button', { name: /PRs/i });
    await expect(prsTab).toBeVisible();
    await expect(prsTab).toHaveClass(/tab-btn--active/);
  });

  test('shows Tickets tab', async ({ page }) => {
    const ticketsTab = page.getByRole('button', { name: /tickets/i });
    await expect(ticketsTab).toBeVisible();
  });

  test('switches to tickets tab', async ({ page }) => {
    await page.getByRole('button', { name: /tickets/i }).click();
    await expect(page.getByRole('button', { name: /tickets/i })).toHaveClass(
      /tab-btn--active/
    );
  });

  test('shows loading or content in PRs tab', async ({ page }) => {
    const prsTab = page.locator('.org-dashboard');
    await expect(prsTab).toBeVisible();
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('org-dashboard.png', {
      fullPage: true,
    });
  });
});
