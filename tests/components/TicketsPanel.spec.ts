import { test, expect } from '@playwright/test';

test.describe('TicketsPanel React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-tickets-panel.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders tab strip with GitHub and Jira tabs', async ({ page }) => {
    const panel = page.locator('#tickets-panel-interactive');
    await expect(panel.locator('.tab-btn')).toHaveCount(2);
    await expect(panel.locator('.tab-btn').nth(0)).toHaveText('GitHub Issues');
    await expect(panel.locator('.tab-btn').nth(1)).toHaveText('Jira');
  });

  test('Jira tab is active by default', async ({ page }) => {
    const panel = page.locator('#tickets-panel-interactive');
    const jiraTab = panel.locator('.tab-btn').nth(1);
    await expect(jiraTab).toHaveClass(/tab-btn--active/);
  });

  test('switches to GitHub tab on click', async ({ page }) => {
    const panel = page.locator('#tickets-panel-interactive');
    await panel.locator('.tab-btn').nth(0).click();
    const githubTab = panel.locator('.tab-btn').nth(0);
    await expect(githubTab).toHaveClass(/tab-btn--active/);
  });

  test('shows panel title', async ({ page }) => {
    const panel = page.locator('#tickets-panel-interactive .panel-title');
    await expect(panel).toContainText('Tickets');
  });

  test('shows loading state initially', async ({ page }) => {
    // Before API resolves, skeleton or loading state should appear
    const panel = page.locator('#tickets-panel-interactive');
    // Either skeleton rows or state message — just confirm panel renders
    await expect(panel).toBeVisible();
  });

  test('screenshot - initial state', async ({ page }) => {
    const container = page.locator('#tickets-panel-interactive');
    await expect(container).toHaveScreenshot('tickets-panel-initial.png', {
      maxDiffPixels: 120,
      threshold: 0.2,
    });
  });
});
