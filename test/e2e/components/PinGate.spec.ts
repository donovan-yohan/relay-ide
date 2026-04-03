import { test, expect } from '@playwright/test';

test.describe('PinGate', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-pin-gate.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders unlock mode by default', async ({ page }) => {
    await expect(page.locator('.pin-container')).toBeVisible();
    await expect(page.locator('.pin-container p').first()).toContainText(
      'enter PIN to continue'
    );
  });

  test('renders setup mode when button clicked', async ({ page }) => {
    await page.getByText('setup mode').click();
    await expect(page.locator('.pin-container p').first()).toContainText(
      'set up a PIN'
    );
    await expect(page.locator('.tui-input-wrapper')).toHaveCount(2);
  });

  test('renders error state', async ({ page }) => {
    await page.getByText('error mode').click();
    await expect(page.locator('.error')).toContainText('incorrect PIN');
  });

  test('renders hint in unlock mode', async ({ page }) => {
    await expect(page.locator('.hint')).toBeVisible();
    await expect(page.locator('.hint')).toContainText('relay-ide pin reset');
  });

  test('screenshot - default', async ({ page }) => {
    const el = page.locator('#test-container');
    await expect(el).toHaveScreenshot('pin-gate-default.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
