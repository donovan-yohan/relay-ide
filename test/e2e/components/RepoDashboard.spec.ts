import { test, expect } from '@playwright/test';

test.describe('RepoDashboard React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-repo-dashboard.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders repo dashboard container', async ({ page }) => {
    const dashboard = page.locator('.repo-dashboard').first();
    await expect(dashboard).toBeVisible();
  });

  test('shows usage section', async ({ page }) => {
    const heading = page.getByText('usage this window').first();
    await expect(heading).toBeVisible();
  });

  test('shows CTA buttons', async ({ page }) => {
    const startBtn = page
      .getByRole('button', { name: /start session/i })
      .first();
    await expect(startBtn).toBeVisible();
  });

  test('shows new worktree button', async ({ page }) => {
    const worktreeBtn = page
      .getByRole('button', { name: /new worktree/i })
      .first();
    await expect(worktreeBtn).toBeVisible();
  });

  test('shows creating worktree disabled state', async ({ page }) => {
    const worktreeBtn = page.getByRole('button', { name: /creating/i }).first();
    await expect(worktreeBtn).toBeVisible();
    await expect(worktreeBtn).toBeDisabled();
  });

  test('shows open pull requests section', async ({ page }) => {
    const heading = page.getByText('open pull requests').first();
    await expect(heading).toBeVisible();
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('repo-dashboard.png', {
      fullPage: true,
    });
  });
});
