import { test, expect } from '@playwright/test';

test.describe('MobileInput', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-mobile-input.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders test container', async ({ page }) => {
    await expect(page.locator('#test-container')).toBeVisible();
  });

  test('renders control buttons', async ({ page }) => {
    await expect(page.getByText('enable devtools')).toBeVisible();
    await expect(page.getByText('focus input')).toBeVisible();
    await expect(page.getByText('clear input')).toBeVisible();
  });

  test('hidden input form is not visible to user', async ({ page }) => {
    // The mobile input form should be invisible (opacity 0) on non-mobile UA
    // and only renders on mobile devices — on desktop UA the form won't render
    const form = page.locator('.mobile-input-form');
    const count = await form.count();
    // On non-mobile UA, MobileInput renders null
    expect(count).toBe(0);
  });

  test('screenshot - default', async ({ page }) => {
    const el = page.locator('#test-container');
    await expect(el).toHaveScreenshot('mobile-input-default.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
