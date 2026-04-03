import { test, expect } from '@playwright/test';

test.describe('TuiRow React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-tui-row.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders default row content', async ({ page }) => {
    const row = page.locator('#default-row');
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/tui-row/);
    await expect(row).toContainText('Default row');
    await expect(row).not.toHaveClass(/tui-row--interactive/);
  });

  test('renders icon and action slots', async ({ page }) => {
    const row = page.locator('#slot-row');
    await expect(row.locator('.tui-row__icon-slot')).toBeVisible();
    await expect(row.locator('.tui-row__icon-slot')).toContainText('◉');
    await expect(row.locator('.tui-row__action-slot')).toBeVisible();
    await expect(row.locator('.tui-row__action-slot')).toContainText('›');
  });

  test('applies interactive class and click handler', async ({ page }) => {
    const row = page.locator('#click-row');
    const clickCount = page.locator('#click-count');

    await expect(row).toHaveClass(/tui-row--interactive/);
    await expect(clickCount).toHaveText('0');

    await row.click();
    await expect(clickCount).toHaveText('1');

    await row.click();
    await expect(clickCount).toHaveText('2');
  });

  test('applies custom spacing via props', async ({ page }) => {
    const row = page.locator('#spaced-row');
    await expect(row).toHaveCSS('min-height', '60px');
    await expect(row).toHaveCSS('padding-left', '28px');
    await expect(row).toHaveCSS('padding-right', '28px');
  });

  test('applies custom className', async ({ page }) => {
    const row = page.locator('#click-row');
    await expect(row).toHaveClass(/custom-row/);
    await expect(row).toHaveClass(/tui-row/);
  });
});
