import { test, expect } from '@playwright/test';

test.describe('PickerResultRow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-picker-result-row.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders label', async ({ page }) => {
    await expect(page.locator('.row-label').first()).toContainText(
      'feat/my-branch'
    );
  });

  test('renders sublabel when provided', async ({ page }) => {
    await expect(page.locator('.row-sublabel').first()).toContainText(
      '2 commits ahead'
    );
  });

  test('renders StatusDot when dotStatus is provided', async ({ page }) => {
    await expect(page.locator('.status-dot').first()).toBeVisible();
  });

  test('applies focused class', async ({ page }) => {
    await expect(page.locator('.picker-row.focused')).toBeVisible();
  });

  test('renders multiple intent buttons', async ({ page }) => {
    const multiRow = page.locator('.picker-row').last();
    const buttons = multiRow.locator('.tui-btn');
    await expect(buttons).toHaveCount(3);
  });

  test('screenshot - default', async ({ page }) => {
    const el = page.locator('#test-container');
    await expect(el).toHaveScreenshot('picker-result-row-default.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
