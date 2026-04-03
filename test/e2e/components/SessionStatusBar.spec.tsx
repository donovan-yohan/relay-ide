import { test, expect } from '@playwright/test';

test.describe('SessionStatusBar React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-session-status-bar.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('renders telemetry and activity for active session', async ({
    page,
  }) => {
    const bar = page.locator('#active-root .session-status-bar').first();
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('claude-4.5');
    await expect(bar).toContainText('███████░░░ 67%');
    await expect(bar).toContainText('↓12k ↑3.2k');
    await expect(bar).toContainText('~$12.34');
    await expect(bar).toContainText('[edit: frontend/src/App.svelte]');
    await expect(bar.locator('.status-rate-limits')).toHaveText(
      '5h: 42% | 7d: 63%'
    );
  });

  test('applies warning and danger context classes', async ({ page }) => {
    const warningBar = page
      .locator('#warning-container .session-status-bar')
      .first();
    await expect(warningBar.locator('.status-context')).toHaveClass(
      /status-context--danger/
    );
  });

  test('renders placeholders when telemetry is missing', async ({ page }) => {
    const missingBar = page
      .locator('#missing-container .session-status-bar')
      .first();
    await expect(missingBar).toContainText('—');
    await expect(missingBar).toContainText('░░░░░░░░░░ —%');
    await expect(missingBar).toContainText('[idle]');
  });

  test('hides when keyboard is open', async ({ page }) => {
    const hiddenBar = page.locator('#hidden-root .session-status-bar').first();
    await expect(hiddenBar).toHaveAttribute('hidden', '');
  });

  test('screenshot - active status bar', async ({ page }) => {
    const bar = page.locator('#active-root .session-status-bar').first();
    await expect(bar).toBeVisible();

    await expect(bar).toHaveScreenshot('session-status-bar-active.png', {
      maxDiffPixels: 100,
      threshold: 0.2,
    });
  });
});
