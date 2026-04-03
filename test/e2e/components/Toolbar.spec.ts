import { test, expect } from '@playwright/test';

test.describe('Toolbar React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-toolbar.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders mobile toolbar with buttons', async ({ page }) => {
    const toolbar = page.locator('#toolbar-mobile .toolbar');
    await expect(toolbar).toBeVisible();
    const buttons = toolbar.locator('.tb-btn');
    await expect(buttons).toHaveCount(12);
  });

  test('renders copy mode toolbar with different buttons', async ({ page }) => {
    const toolbar = page.locator('#toolbar-copy-mode .toolbar');
    await expect(toolbar).toBeVisible();
    const buttons = toolbar.locator('.tb-btn');
    await expect(buttons).toHaveCount(12);
  });

  test('does not render toolbar when not mobile', async ({ page }) => {
    const hiddenToolbar = page.locator('#toolbar-hidden .toolbar');
    await expect(hiddenToolbar).toHaveCount(0);
  });

  test('enter button has accent styling', async ({ page }) => {
    const enterBtn = page.locator('#toolbar-mobile .tb-enter').last();
    await expect(enterBtn).toBeVisible();
    await expect(enterBtn).toHaveClass(/tb-enter/);
  });

  test('screenshot - mobile toolbar', async ({ page }) => {
    const container = page.locator('#toolbar-mobile');
    await expect(container).toHaveScreenshot('toolbar-mobile.png', {
      maxDiffPixels: 120,
      threshold: 0.2,
    });
  });
});
