import { test, expect } from '@playwright/test';

test.describe('TuiMenuPanel React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-tui-menu-panel.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders children inside a styled panel', async ({ page }) => {
    const panel = page.locator('.tui-menu-panel');

    await expect(panel).toBeVisible();
    await expect(panel).toHaveText(/First item/);
    await expect(panel).toHaveText(/Second item/);
    await expect(panel).toHaveText(/Third item/);
    await expect(panel).toHaveCSS('border-top-width', '1px');
    await expect(panel).toHaveCSS('padding-top', '4px');
    await expect(panel).toHaveCSS('border-radius', '0px');
  });
});
